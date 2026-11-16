import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { BugCardProps, terminalColors, type Theme } from "@ossclip/core/browser";
import { enterProgress, entranceStyle } from "../anim";
import {
  BUG_BADGE_GAP_PX,
  BUG_CAP_LH,
  BUG_CAP_ROW_GAP_PX,
  BUG_HEAD_LH,
  BUG_LINE_GAP_PX,
  BUG_LINE_LH,
  BUG_MARK_GAP_PX,
  BUG_STICKER_TILT_DEG,
  BUG_STRIKE_EM,
  BUG_SUB_GAP_PX,
  BUG_SUB_LH,
  bugCardMetrics,
  bugStickerText,
  type BugCardMetrics,
} from "../fit";
import { bump, easeInOut, popScale } from "../motion";
import { PATTERN_DEFAULT_SCENE_SEC, patternSceneSec, type RevealTiming } from "../reveal";
import { editStyle, type ElementEdits } from "../editable";
import { Card } from "../primitives/Card";
import { Editable } from "../primitives/Editable";
import { NumberBadge } from "../primitives/NumberBadge";
import { CROSS_PATHS } from "../primitives/Pill";
import { Sticker } from "../primitives/Sticker";
import { Words } from "./CardRow";

type Props = z.infer<typeof BugCardProps>;

/** The playbook's pop length (motion.ts `popScale` default). */
const POP_SEC = 0.35;
/**
 * The build, in seconds from the cue's start (plan Task 6's order: badge,
 * headline, sub, mock, sticker). Fixed slots rather than packed ones, so a
 * card without a sub keeps its mock on the same beat as one with it.
 */
export const BUG_BADGE_SEC = 0.25;
export const BUG_HEADLINE_SEC = 0.55;
export const BUG_SUB_SEC = 0.95;
export const BUG_MOCK_SEC = 1.35;
/** The fault plays once the mock has popped and been read for a beat. */
export const BUG_FAULT_AFTER_SEC = 0.6;
/** The sticker never lands on top of the fault it comments on. */
export const BUG_STICKER_AFTER_SEC = 0.5;
/** "The sticker lands in the last third of the scene" (plan Task 6). */
const BUG_STICKER_AT = 2 / 3;
/** A headline or sub fades and rises in over this. */
const TEXT_IN_SEC = 0.3;
const TEXT_RISE_PX = 18;
/** The strike being drawn, the clipped word sliding, the wrong line shaking. */
export const BUG_FAULT_SEC = 0.4;
/** The shake: px either side, and its period — four swings, decaying to rest. */
const SHAKE_PX = 10;
const SHAKE_PERIOD_SEC = 0.1;

/** Seconds from the cue's start; null where the card has no such moment. */
export interface BugTimeline {
  badgeSec: number;
  headlineSec: number;
  subSec: number | null;
  mockSec: number | null;
  /** Only when the mock is drawn AND marks an entry: a mock with nothing wrong has no fault to play. */
  faultSec: number | null;
  stickerSec: number | null;
}

/**
 * When each part of the card arrives (plan Task 6), a pure function of what
 * it shows and how long it runs, so a still at frame N is deterministic. The
 * sticker lands at two thirds of the scene, or half a second after the last
 * thing before it when that is later, so it never covers a fault mid-play. A
 * cue too short for the sticker ends before it, as CtaCard's press does.
 */
export function bugTimeline(
  parts: { sub: boolean; mock: boolean; fault: boolean; sticker: boolean },
  durationSec: number = PATTERN_DEFAULT_SCENE_SEC,
): BugTimeline {
  const subSec = parts.sub ? BUG_SUB_SEC : null;
  const mockSec = parts.mock ? BUG_MOCK_SEC : null;
  const faultSec = mockSec !== null && parts.fault ? mockSec + BUG_FAULT_AFTER_SEC : null;
  const last = faultSec ?? mockSec ?? subSec ?? BUG_HEADLINE_SEC;
  return {
    badgeSec: BUG_BADGE_SEC,
    headlineSec: BUG_HEADLINE_SEC,
    subSec,
    mockSec,
    faultSec,
    stickerSec: parts.sticker
      ? Math.max(BUG_STICKER_AT * durationSec, last + BUG_STICKER_AFTER_SEC)
      : null,
  };
}

/**
 * The wrong line's shake at `dt` seconds into the fault: a sine decaying
 * linearly to 0 over `BUG_FAULT_SEC`, and exactly 0 outside it, so the line
 * settles where it was laid out. 10 px each way stays inside the panel's
 * 40 px padding.
 */
export function shakePx(dt: number): number {
  if (dt <= 0 || dt >= BUG_FAULT_SEC) return 0;
  return SHAKE_PX * Math.sin((2 * Math.PI * dt) / SHAKE_PERIOD_SEC) * (1 - dt / BUG_FAULT_SEC);
}

/** What one frame shows. */
export interface BugFrameState {
  /** The text panel's pop, and the badge's own on top of it. */
  panelScale: number;
  badgeScale: number;
  /** 0..1 entrance progress of the headline and the sub. */
  headline: number;
  sub: number;
  mockScale: number;
  /** 0..1: the strike drawn across, the clipped word's slide. */
  fault: number;
  /** The fault has happened: the wrong line is red and carries its cross. */
  faultOn: boolean;
  shakePx: number;
  stickerOn: boolean;
  stickerScale: number;
}

/**
 * The card at `t` seconds into the cue. Under `motion: "classic"` nothing
 * here moves (plan Task 6, CtaCard's rule): every part is present from the
 * entrance, the fault is drawn in its final state, nothing bumps or shakes —
 * the classic look has no emphasis motion to match.
 */
export function bugFrameState(t: number, tl: BugTimeline, explainer: boolean): BugFrameState {
  if (!explainer) {
    return {
      panelScale: 1,
      badgeScale: 1,
      headline: 1,
      sub: 1,
      mockScale: 1,
      fault: tl.faultSec !== null ? 1 : 0,
      faultOn: tl.faultSec !== null,
      shakePx: 0,
      stickerOn: tl.stickerSec !== null,
      stickerScale: 1,
    };
  }
  const textIn = (start: number | null) => (start === null ? 0 : easeInOut(t - start, TEXT_IN_SEC));
  return {
    panelScale: popScale(t - tl.badgeSec, POP_SEC),
    badgeScale: popScale(t - tl.badgeSec, POP_SEC),
    headline: textIn(tl.headlineSec),
    sub: textIn(tl.subSec),
    mockScale: tl.mockSec === null ? 0 : popScale(t - tl.mockSec, POP_SEC),
    fault: tl.faultSec === null ? 0 : easeInOut(t - tl.faultSec, BUG_FAULT_SEC),
    faultOn: tl.faultSec !== null && t >= tl.faultSec,
    shakePx: tl.faultSec === null ? 0 : shakePx(t - tl.faultSec),
    stickerOn: tl.stickerSec !== null && t >= tl.stickerSec,
    stickerScale: tl.stickerSec === null ? 1 : bump(t - tl.stickerSec),
  };
}

/**
 * How far along each word's strike is when a struck entry's words are
 * struck in turn, left to right, by total progress `p` — weighted by each
 * word's length, so the line travels at one speed across the entry.
 */
export function strikeProgress(wordLengths: readonly number[], p: number): number[] {
  const total = wordLengths.reduce((a, n) => a + n, 0);
  if (total <= 0) return wordLengths.map(() => (p >= 1 ? 1 : 0));
  let before = 0;
  return wordLengths.map((n) => {
    const at = (p * total - before) / Math.max(1e-9, n);
    before += n;
    return at <= 0 ? 0 : at >= 1 ? 1 : at;
  });
}

/** The strike line across a box, drawn left to right to `p` (0..1). */
const StrikeBar: React.FC<{ p: number; px: number; color: string }> = ({ p, px, color }) => {
  const thick = Math.max(4, Math.round(px * BUG_STRIKE_EM));
  const over = Math.round(px * 0.08);
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: -over,
        top: `calc(54% - ${thick / 2}px)`,
        height: thick,
        width: `calc(${p} * (100% + ${2 * over}px))`,
        background: color,
        borderRadius: thick / 2,
        opacity: p > 0 ? 1 : 0,
      }}
    />
  );
};

const CrossMark: React.FC<{ sizePx: number; color: string; on: boolean }> = ({ sizePx, color, on }) => (
  <svg
    width={sizePx}
    height={sizePx}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={3.5}
    strokeLinecap="round"
    aria-hidden
    style={{ display: "block", flexShrink: 0, opacity: on ? 1 : 0 }}
  >
    {CROSS_PATHS.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

/** The caption mock: rows exactly as `bugCardMetrics` laid them out, never re-wrapped by the browser. */
const CaptionMock: React.FC<{
  lines: readonly string[];
  m: BugCardMetrics;
  theme: Theme;
  fault: "struck" | "clipped";
  s: BugFrameState;
  edits?: ElementEdits;
}> = ({ lines, m, theme, fault, s, edits }) => {
  const wrong = m.wrongIndex;
  const text: React.CSSProperties = {
    fontSize: m.capPx,
    fontWeight: 900,
    lineHeight: BUG_CAP_LH,
    color: theme.fg,
    // The caption look: white with a card-coloured outline, the stroke
    // painted under the fill so it widens the letter rather than eating it.
    WebkitTextStroke: `${m.capStrokePx}px ${theme.cardBg}`,
    paintOrder: "stroke fill",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: BUG_CAP_ROW_GAP_PX }}>
      {m.capRows.map((row, r) => (
        <div
          key={r}
          style={{
            display: "flex",
            flexWrap: "nowrap",
            alignItems: "flex-start",
            gap: m.capWordGapPx,
            // The clipped row is wider than the panel: its far end is where
            // the slide settles (`clipRowWidthPx`), and the panel's
            // `overflow: hidden` cuts what passes the edge.
            ...(r === m.clipRow ? { width: m.clipRowWidthPx, flexShrink: 0 } : {}),
          }}
        >
          {row.flatMap((i) => {
            const unit = lines[i] ?? "";
            const fits = m.capUnitFits[i] ?? true;
            const isWrong = wrong === i;
            const slides = fault === "clipped" && wrong !== null && i >= wrong;
            const struck = fault === "struck" && isWrong;
            const words = unit.split(" ").filter((w) => w.length > 0);
            const perWord = struck && !fits ? strikeProgress(words.map((w) => w.length), s.fault) : null;
            // The slide: a spacer before the wrong word takes `fault` of the
            // row's free space (flex-grow under 1 distributes only that
            // share), so the run settles against the row's far end, which
            // the metric sets from the panel's edge. The modelled word is a
            // little wider than the drawn one, so a little less than
            // `BUG_CLIP_VISIBLE` of it stays in view ("mig" of "migration"
            // in the dense still). Its negative margin cancels the gap it adds.
            const spacer =
              fault === "clipped" && isWrong ? (
                <div
                  key={`slide-${i}`}
                  aria-hidden
                  style={{ flexGrow: s.fault, flexShrink: 0, flexBasis: 0, marginLeft: -m.capWordGapPx }}
                />
              ) : null;
            const el = (
              <Editable
                key={i}
                editId={`mock-${i}`}
                edits={edits}
                style={{ flexShrink: 0, minWidth: 0, maxWidth: slides ? undefined : "100%" }}
              >
                <div
                  style={{
                    ...text,
                    position: "relative",
                    whiteSpace: fits || slides ? "nowrap" : "normal",
                    overflowWrap: fits || slides ? undefined : "anywhere",
                  }}
                >
                  {perWord
                    ? words.map((w, j) => (
                        <React.Fragment key={j}>
                          {j > 0 ? " " : null}
                          <span style={{ position: "relative", display: "inline-block" }}>
                            {w}
                            <StrikeBar p={perWord[j] ?? 0} px={m.capPx} color={theme.danger} />
                          </span>
                        </React.Fragment>
                      ))
                    : unit}
                  {struck && !perWord ? <StrikeBar p={s.fault} px={m.capPx} color={theme.danger} /> : null}
                </div>
              </Editable>
            );
            return spacer ? [spacer, el] : [el];
          })}
        </div>
      ))}
    </div>
  );
};

/**
 * The lines mock: mono, one entry a line, the wrong one turning red with a
 * cross and a shake. It never reads `mockFault`: clipping is a caption's
 * fault, so `lines` with `clipped` (the acceptance run's planner wrote it,
 * §161) plays as a marked line, the same as `struck`.
 */
const LinesMock: React.FC<{
  lines: readonly string[];
  m: BugCardMetrics;
  theme: Theme;
  s: BugFrameState;
  edits?: ElementEdits;
}> = ({ lines, m, theme, s, edits }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: BUG_LINE_GAP_PX }}>
    {lines.map((line, i) => {
      const isWrong = m.wrongIndex === i;
      const red = isWrong && s.faultOn;
      return (
        <Editable key={i} editId={`mock-${i}`} edits={edits}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: BUG_MARK_GAP_PX,
              transform: isWrong && s.shakePx !== 0 ? `translateX(${s.shakePx}px)` : undefined,
            }}
          >
            {m.gutterPx > 0 ? (
              <div
                style={{
                  width: m.markPx,
                  height: Math.round(m.linePx * BUG_LINE_LH),
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {isWrong ? <CrossMark sizePx={m.markPx} color={theme.danger} on={red} /> : null}
              </div>
            ) : null}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: theme.fontMono,
                fontSize: m.linePx,
                lineHeight: BUG_LINE_LH,
                fontWeight: red ? 700 : 400,
                color: red ? theme.danger : theme.fg,
                whiteSpace: (m.lineFits[i] ?? true) ? "pre" : "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {/* A blank line keeps its height, as a terminal's does. */}
              {line.length > 0 ? line : " "}
            </div>
          </div>
        </Editable>
      );
    })}
  </div>
);

/**
 * One numbered problem, shown failing (§161, plan Task 6). 16:9: a text
 * panel on the left — the red number badge beside the headline's first
 * line, the consequence under it in `danger` — and on the right a mock of
 * the failure: a caption with the wrong word struck through or run off the
 * panel's edge, or code lines with the wrong one turning red. A sticker
 * lands last, over the lower right corner of the mock (of the text panel
 * when there is none). 9:16: the text panel alone (`bugMockVisible`).
 *
 * Full frame over the speaker with no scrim (plan decision 1): every box is
 * placed by `bugCardMetrics` in the whole frame, margin and peak scales
 * reserved, and SceneLayer gives it the frame unscaled (`SELF_FITTING`).
 * The wrapper only fades it out, so the card owns its entrance: the build in
 * `bugTimeline` under the explainer look, `entranceStyle`'s default under
 * classic.
 *
 * Edit ids: `headline`, `sub`, `sticker` (the props themselves) and
 * `mock-N`, one per `mockLines` entry. Each id sits on a box whose only
 * transform is the edit nudge; the motion is on the box inside it.
 */
export const BugCard: React.FC<{
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
  const m = bugCardMetrics(props, w, h);
  const explainer = theme.motion === "explainer";
  const t = frame / fps;
  const sub = props.sub ? props.sub : null;
  // Not a sticker that repeats the sub: the metric reserves no box for one.
  const sticker = bugStickerText(props);
  const tl = bugTimeline(
    { sub: sub !== null, mock: m.mockPanel !== null, fault: m.wrongIndex !== null, sticker: sticker !== null },
    patternSceneSec(fps, timing),
  );
  const s = bugFrameState(t, tl, explainer);
  const classic = explainer ? null : entranceStyle(undefined, enterProgress(frame, fps, 0));
  const popped = (scale: number): React.CSSProperties =>
    classic ?? { opacity: scale > 0 ? 1 : 0, transform: `scale(${scale})` };
  const textIn = (p: number): React.CSSProperties =>
    explainer ? { opacity: p, transform: p < 1 ? `translateY(${(1 - p) * TEXT_RISE_PX}px)` : undefined } : {};
  const box = (r: { x: number; y: number; w: number; h: number }): React.CSSProperties => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    height: r.h,
  });

  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <Card
        theme={theme}
        border={theme.danger}
        widthPx={m.textPanel.w}
        style={{ ...box(m.textPanel), display: "flex", alignItems: "center", ...popped(s.panelScale) }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: BUG_BADGE_GAP_PX, width: "100%" }}>
          <div
            style={{
              marginTop: m.badgeOffsetPx,
              flexShrink: 0,
              transform: explainer && s.badgeScale !== 1 ? `scale(${s.badgeScale})` : undefined,
            }}
          >
            <NumberBadge n={props.number} theme={theme} sizePx={m.badgePx} />
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingTop: m.headOffsetPx }}>
            <div data-edit-id="headline" style={editStyle(edits, "headline")}>
              <div
                style={{
                  fontSize: m.headPx,
                  fontWeight: 900,
                  lineHeight: BUG_HEAD_LH,
                  color: theme.fg,
                  overflowWrap: "anywhere",
                  textWrap: "balance",
                  ...textIn(s.headline),
                }}
              >
                <Words text={props.headline} whole={m.headWordsFit} />
              </div>
            </div>
            {sub !== null ? (
              <div data-edit-id="sub" style={{ marginTop: BUG_SUB_GAP_PX, ...editStyle(edits, "sub") }}>
                <div
                  style={{
                    fontSize: m.subPx,
                    fontWeight: 800,
                    lineHeight: BUG_SUB_LH,
                    color: theme.danger,
                    overflowWrap: "anywhere",
                    textWrap: "balance",
                    ...textIn(s.sub),
                  }}
                >
                  <Words text={sub} whole={m.subWordsFit} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </Card>
      {m.mockPanel !== null ? (
        <Card
          theme={theme}
          border={theme.cardBorder}
          widthPx={m.mockPanel.w}
          style={{
            ...box(m.mockPanel),
            background: terminalColors(theme).bg,
            // The clipped fault's edge: a word slid past it is cut here.
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            ...popped(s.mockScale),
          }}
        >
          {props.mock === "caption" ? (
            <CaptionMock lines={props.mockLines} m={m} theme={theme} fault={props.mockFault} s={s} edits={edits} />
          ) : (
            <LinesMock lines={props.mockLines} m={m} theme={theme} s={s} edits={edits} />
          )}
        </Card>
      ) : null}
      {m.sticker !== null && sticker !== null ? (
        <div
          data-edit-id="sticker"
          style={{
            position: "absolute",
            left: m.sticker.cx - m.sticker.w / 2,
            top: m.sticker.cy - m.sticker.h / 2,
            width: m.sticker.w,
            height: m.sticker.h,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...editStyle(edits, "sticker"),
          }}
        >
          <div
            style={
              classic ?? {
                opacity: s.stickerOn ? 1 : 0,
                transform: s.stickerScale !== 1 ? `scale(${s.stickerScale})` : undefined,
              }
            }
          >
            <Sticker
              text={sticker}
              theme={theme}
              color={theme.accent}
              tiltDeg={BUG_STICKER_TILT_DEG}
              sizePx={m.sticker.sizePx}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
