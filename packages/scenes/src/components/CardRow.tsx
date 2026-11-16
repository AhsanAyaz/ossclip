import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { CardRowProps, type Theme } from "@ossclip/core/browser";
import { enterProgress, entranceStyle } from "../anim";
import { CARD_SUB_LH, CARD_TITLE_LH, cardRowMetrics } from "../fit";
import { beatStarts, bump, popScale } from "../motion";
import {
  componentRevealFrames,
  isLegacyReveal,
  latestEntryFrame,
  type RevealTiming,
} from "../reveal";
import { editStyle, type ElementEdits } from "../editable";
import { Card } from "../primitives/Card";
import { Icon } from "../primitives/Icon";

type Props = z.infer<typeof CardRowProps>;

/**
 * `text` with each space-separated word unbreakable, when the metric says
 * every word fits a line (`titleWordsFit`/`subWordsFit`): line breaks then
 * fall only at spaces, as `cardRowMetrics` counts them. Without this the
 * browser breaks after a hyphen, and a sub-line read "npm publish --" /
 * "tag latest" in the first dense still. Exported for CtaCard, whose
 * metric makes the same promise.
 */
export const Words: React.FC<{ text: string; whole: boolean }> = ({ text, whole }) =>
  whole ? (
    <>
      {text.split(" ").map((word, i) => (
        <React.Fragment key={i}>
          {i > 0 ? " " : null}
          <span style={{ whiteSpace: "nowrap" }}>{word}</span>
        </React.Fragment>
      ))}
    </>
  ) : (
    <>{text}</>
  );

/** The playbook's pop length (motion.ts `popScale` default), in seconds. */
const POP_SEC = 0.35;
/** `beatStarts`' default gap: the stagger a card row builds at with no words to sync to. */
const BEAT_GAP_SEC = 0.7;

/**
 * When each card enters, in frames from the cue's first frame. One card is
 * one reveal item (`revealItemTexts("CardRow")`), so a cue whose items were
 * matched puts each card on its spoken words through the shared schedule.
 * With no word timings — no item times and no reveal prop touched, the
 * schedule's "legacy" test — the cards build one per beat at `beatStarts`
 * (plan Task 4), held to the last frame an entrance can still finish by when
 * the cue's length is known, the reveal schedule's own limit.
 */
export function cardRowDelays(props: Props, fps: number, timing?: RevealTiming): number[] {
  const n = props.cards.length;
  if (timing === undefined || isLegacyReveal(timing.itemAtSec, props)) {
    const frames = beatStarts(n).map((s) => Math.round(s * fps));
    if (timing === undefined) return frames;
    const latest = latestEntryFrame(fps, timing.durationInFrames);
    return frames.map((f) => Math.min(f, latest));
  }
  // The step argument is the schedule's legacy stagger, unused on this path
  // (legacy returned above); passed as the beat gap so it is never a lie.
  return componentRevealFrames(n, Math.round(BEAT_GAP_SEC * fps), fps, props, timing);
}

/**
 * The frame the highlighted card bumps on: once the LAST card has finished
 * popping in, so the viewer sees the whole set before the chosen one is
 * singled out. Null when nothing is highlighted, or the index names no card.
 */
export function cardRowBumpFrame(props: Props, delays: readonly number[], fps: number): number | null {
  if (props.highlight === undefined || props.highlight >= props.cards.length) return null;
  const last = delays.length > 0 ? Math.max(...delays) : 0;
  return last + Math.round(POP_SEC * fps);
}

/**
 * Two to four parallel things as one row of cards (§161, plan Task 4): one
 * centred row in 16:9, one column in 9:16. Full frame over the speaker with
 * no scrim (plan decision 1), so it lays itself out in the whole frame with
 * the 100 px margin reserved (`cardRowMetrics`), and SceneLayer gives it the
 * frame unscaled (`SELF_FITTING`).
 *
 * Under `theme.motion === "explainer"` a card pops in (`popScale`) and the
 * highlighted one bumps once the row has landed; under "classic" a card
 * enters with the author's `entrance` style, and nothing bumps — the
 * classic look has no emphasis motion to match. The highlight's colour is
 * the same in both.
 *
 * Each card is `card-N` (`data-edit-id`), edited in the Inspector as two
 * lines, `text` then `sub`. The entrance and the edit nudge share the card's
 * `transform`, the edit last, exactly as TerminalMock's windows do.
 */
export const CardRow: React.FC<{
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
  const m = cardRowMetrics(props.cards, w, h);
  const delays = cardRowDelays(props, fps, timing);
  const bumpFrame = cardRowBumpFrame(props, delays, fps);
  const explainer = theme.motion === "explainer";

  return (
    <div
      style={{
        width: w,
        height: h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: m.mode === "row" ? "row" : "column",
          // Equal heights in a row: a card with a sub-line and one without
          // still read as one set.
          alignItems: "stretch",
          gap: m.gapPx,
        }}
      >
        {props.cards.map((card, i) => {
          const chosen = props.highlight === i;
          const border = chosen ? theme.accent : theme.accent2;
          const delay = delays[i] ?? 0;
          let motion: React.CSSProperties;
          if (explainer) {
            const t = (frame - delay) / fps;
            const k =
              popScale(t, POP_SEC) *
              (chosen && bumpFrame !== null ? bump((frame - bumpFrame) / fps) : 1);
            motion = { opacity: t > 0 ? 1 : 0, transform: `scale(${k})` };
          } else {
            motion = entranceStyle(props.entrance, enterProgress(frame, fps, delay));
          }
          return (
            <Card
              key={i}
              theme={theme}
              border={border}
              // Inline template, not a variable: the edit-id audit
              // (edit-ids-resolve.test.ts) reads ids from this shape.
              editId={`card-${i}`}
              widthPx={m.cardWidthPx}
              style={{
                ...motion,
                minHeight: m.cardHeightPx,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                ...editStyle(edits, `card-${i}`),
              }}
            >
              {card.icon !== "none" ? (
                <div style={{ marginBottom: m.iconGapPx }}>
                  <Icon name={card.icon} sizePx={m.iconPx} color={border} />
                </div>
              ) : null}
              <div
                style={{
                  fontSize: m.titlePx,
                  fontWeight: 900,
                  lineHeight: CARD_TITLE_LH,
                  color: theme.fg,
                  // A single word longer than the card breaks rather than
                  // leaving it; the metric avoids needing this wherever a
                  // smaller font would do.
                  overflowWrap: "anywhere",
                  // Same line count as greedy wrapping, evener lines: no
                  // orphaned "OK" under "WRITE THE TESTS".
                  textWrap: "balance",
                }}
              >
                <Words text={card.text} whole={m.titleWordsFit} />
              </div>
              {card.sub ? (
                <div
                  style={{
                    marginTop: m.subGapPx,
                    fontFamily: theme.fontMono,
                    fontSize: m.subPx,
                    lineHeight: CARD_SUB_LH,
                    color: theme.muted,
                    overflowWrap: "anywhere",
                    textWrap: "balance",
                  }}
                >
                  <Words text={card.sub} whole={m.subWordsFit} />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
};
