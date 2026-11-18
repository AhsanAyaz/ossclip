import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { PhoneDemoProps, type Theme } from "@ossclip/core/browser";
import { enterProgress, entranceStyle } from "../anim";
import {
  PHONE_CAP_LH,
  PHONE_EMPH_RADIUS_EM,
  PHONE_EMPH_TILT_DEG,
  phoneDemoMetrics,
  type PhoneDemoMetrics,
} from "../fit";
import { beatStarts, bobPx, popScale } from "../motion";
import { componentRevealFrames, isLegacyReveal, latestEntryFrame, type RevealTiming } from "../reveal";
import { type ElementEdits } from "../editable";
import { Editable } from "../primitives/Editable";
import { PhoneFrame } from "../primitives/PhoneFrame";
import { Pill } from "../primitives/Pill";

type Props = z.infer<typeof PhoneDemoProps>;

/** The playbook's pop length (motion.ts `popScale` default). */
const POP_SEC = 0.35;
/** The phone pops in here, and has settled one pop later. */
export const PHONE_IN_SEC = 0.25;
export const PHONE_SETTLED_SEC = PHONE_IN_SEC + POP_SEC;
/** An emphasised word's box pops this long after the phone has settled. */
export const PHONE_EMPH_AFTER_SEC = 0.15;
/** `beatStarts`' default gap: the stagger pills build at with no words to sync to. */
const BEAT_GAP_SEC = 0.7;
/**
 * With no word timings the pills start once the phone has settled and sat
 * a beat (0.75 s), one per 0.7 s; with them, they land on their words but
 * never before 0.6 s, so no pill appears before the phone it describes
 * (plan author, 2026-11-16).
 */
export const PHONE_PILLS_FIRST_SEC = 0.75;
export const PHONE_PILLS_EARLIEST_SEC = 0.6;

/**
 * When each pill enters, in frames from the cue's first frame: `cardRowDelays`
 * with the phone's floor. One pill is one reveal item
 * (`revealItemTexts("PhoneDemo")`). Every delay is held to the last frame an
 * entrance can still finish by when the cue's length is known.
 */
export function phoneDemoDelays(props: Pick<Props, "pills" | "reveal" | "pacing" | "revealSpeed">, fps: number, timing?: RevealTiming): number[] {
  const n = props.pills.length;
  if (n === 0) return [];
  const latest = timing === undefined ? Infinity : latestEntryFrame(fps, timing.durationInFrames);
  if (timing === undefined || isLegacyReveal(timing.itemAtSec, props)) {
    return beatStarts(n, BEAT_GAP_SEC, PHONE_PILLS_FIRST_SEC).map((s) => Math.min(Math.round(s * fps), latest));
  }
  const earliest = Math.round(PHONE_PILLS_EARLIEST_SEC * fps);
  return componentRevealFrames(n, Math.round(BEAT_GAP_SEC * fps), fps, props, timing).map((f) =>
    Math.min(Math.max(f, earliest), latest),
  );
}

/** What the phone shows at `t` seconds into the cue. */
export interface PhoneFrameState {
  phoneScale: number;
  /** Vertical drift once settled; 0 before. */
  bobPx: number;
  /** Every emphasis box's pop. */
  emphScale: number;
}

/**
 * Under "explainer" the phone pops at 0.25 s, its caption riding inside it
 * from that entrance; the emphasis boxes pop 0.15 s after it settles, and
 * from then on it bobs so the idle shot is not frozen (playbook). Under
 * "classic" nothing here moves: the classic entrance is the component's
 * `entranceStyle`, boxes are drawn from the start, and there is no bob.
 */
export function phoneFrameState(t: number, explainer: boolean): PhoneFrameState {
  if (!explainer) return { phoneScale: 1, bobPx: 0, emphScale: 1 };
  return {
    phoneScale: popScale(t - PHONE_IN_SEC, POP_SEC),
    bobPx: t > PHONE_SETTLED_SEC ? bobPx(t - PHONE_SETTLED_SEC) : 0,
    emphScale: popScale(t - PHONE_SETTLED_SEC - PHONE_EMPH_AFTER_SEC, POP_SEC),
  };
}

/** One caption word: white with a card-coloured outline, or ink on its tilted box. */
const CaptionWord: React.FC<{
  text: string;
  emphasis: "none" | "yellow" | "orange";
  m: PhoneDemoMetrics;
  theme: Theme;
  emphScale: number;
}> = ({ text, emphasis, m, theme, emphScale }) => {
  const base: React.CSSProperties = {
    fontFamily: theme.fontDisplay,
    fontSize: m.capPx,
    fontWeight: 900,
    lineHeight: PHONE_CAP_LH,
    whiteSpace: "nowrap",
  };
  const plain: React.CSSProperties = {
    ...base,
    color: theme.fg,
    // The caption look (BugCard's): the stroke painted under the fill, so it
    // widens the letter instead of eating into it.
    WebkitTextStroke: `${m.capStrokePx}px ${theme.cardBg}`,
    paintOrder: "stroke fill",
  };
  if (emphasis === "none") {
    return <div style={{ ...plain, padding: `${m.emphPadYPx}px 0` }}>{text}</div>;
  }
  // The box takes its space from the start, so the row never shifts when it
  // pops; until then the word reads as the plain caption it was.
  const boxed = emphScale > 0;
  return (
    <div style={{ position: "relative", padding: `${m.emphPadYPx}px ${m.emphPadXPx}px` }}>
      <div style={{ ...plain, opacity: boxed ? 0 : 1 }}>{text}</div>
      {boxed ? (
        <div
          style={{
            ...base,
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.ink,
            background: emphasis === "yellow" ? theme.highlight : theme.accent,
            borderRadius: Math.round(m.capPx * PHONE_EMPH_RADIUS_EM),
            transform: `rotate(${PHONE_EMPH_TILT_DEG}deg) scale(${emphScale})`,
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
};

/**
 * How captions sit on a phone (§161, plan Task 7). 16:9: a stand-in
 * vertical video on the left and checklist pills building on the right, one
 * centred group; 9:16: the phone at the top and the pills centred below.
 * The caption words sit on the phone's lower edge, laid out in rows by
 * `phoneDemoMetrics` and never re-wrapped by the browser.
 *
 * Full frame over the speaker with no scrim (plan decision 1): every box is
 * placed by the metric in the whole frame, margin and peak scales reserved,
 * and SceneLayer gives it the frame unscaled (`SELF_FITTING`) — or its
 * graphic box, with the margin scaled to the box's share of the frame (§163).
 *
 * Edit ids: `word-N` per caption entry and `pill-N` per pill, each on a box
 * whose only transform is the edit nudge (`Editable`); the motion is inside.
 * `emphasis` and `state` have no editor control (plan Task 7, a known gap).
 */
export const PhoneDemo: React.FC<{
  props: Props;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const w = widthPx ?? width;
  const h = heightPx ?? height;
  const m = phoneDemoMetrics(props, w, h, { width, height });
  const explainer = theme.motion === "explainer";
  const s = phoneFrameState(frame / fps, explainer);
  const delays = phoneDemoDelays(props, fps, timing);
  const phoneMotion: React.CSSProperties = explainer
    ? {
        opacity: s.phoneScale > 0 ? 1 : 0,
        transform: `translateY(${s.bobPx}px) scale(${s.phoneScale})`,
      }
    : entranceStyle(undefined, enterProgress(frame, fps, 0));

  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <div style={{ position: "absolute", left: m.phone.x, top: m.phone.y, ...phoneMotion }}>
        <PhoneFrame theme={theme} heightPx={m.phone.h}>
          <div
            style={{
              position: "absolute",
              left: m.capPadXPx,
              right: m.capPadXPx,
              bottom: m.capBottomPx,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {m.capRows.map((row, r) => (
              <div
                key={r}
                style={{
                  display: "flex",
                  flexWrap: "nowrap",
                  alignItems: "center",
                  gap: m.capWordGapPx,
                  marginTop: m.capRowGapsPx[r] ?? 0,
                }}
              >
                {row.map((i) => {
                  const word = props.caption[i];
                  if (!word) return null;
                  return (
                    <Editable key={i} editId={`word-${i}`} edits={edits} style={{ flexShrink: 0 }}>
                      <CaptionWord
                        text={word.text}
                        emphasis={word.emphasis}
                        m={m}
                        theme={theme}
                        emphScale={s.emphScale}
                      />
                    </Editable>
                  );
                })}
              </div>
            ))}
          </div>
        </PhoneFrame>
      </div>
      {m.pillColumn !== null ? (
        <div
          style={{
            position: "absolute",
            left: m.pillColumn.x,
            top: m.pillColumn.y,
            width: m.pillColumn.w,
            display: "flex",
            flexDirection: "column",
            alignItems: m.pillAlign === "left" ? "flex-start" : "center",
            gap: m.pillGapPx,
          }}
        >
          {props.pills.map((pill, i) => {
            const delay = delays[i] ?? 0;
            const t = (frame - delay) / fps;
            const k = popScale(t, POP_SEC);
            const motion: React.CSSProperties = explainer
              ? {
                  opacity: t > 0 ? 1 : 0,
                  transform: `scale(${k})`,
                  // 16:9 pops from the column's edge, so a pill never grows
                  // back towards the phone (the metric reserves it rightwards).
                  transformOrigin: m.pillAlign === "left" ? "left center" : "center",
                }
              : entranceStyle(props.entrance, enterProgress(frame, fps, delay));
            return (
              <Editable key={i} editId={`pill-${i}`} edits={edits}>
                <div style={motion}>
                  <Pill
                    text={pill.text}
                    theme={theme}
                    sizePx={m.pillPx}
                    border={
                      pill.state === "ok" ? theme.success : pill.state === "bad" ? theme.danger : theme.accent2
                    }
                    mark={pill.state === "ok" ? "tick" : pill.state === "bad" ? "cross" : undefined}
                  />
                </div>
              </Editable>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
