import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { StatCardProps, type Theme } from "@ossclip/core/browser";
import { enterFrames, pop, rise, useEnter } from "../anim";
import { editStyle, type ElementEdits } from "../editable";
import { countAt, parseCount } from "../motion";

/** The playbook's count-up length (motion.ts `countAt`'s default), named so both reads agree. */
export const STAT_COUNT_SEC = 1.0;

/**
 * What the value shows at `t` seconds into the cue, or null to draw it as
 * written (plan Task 8). Counting is the explainer look's motion only
 * (decision 4), and only for a value `parseCount` can reproduce exactly —
 * anything else ("×3", "5 min") keeps today's static string. The count
 * starts when the card's entrance spring has settled, `enterFrames` in, so
 * the number moves on a card that has stopped moving.
 */
export function statCountText(
  value: string,
  t: number,
  fps: number,
  explainer: boolean,
): string | null {
  if (!explainer) return null;
  const parsed = parseCount(value);
  if (parsed === null) return null;
  return countAt(parsed, t - enterFrames(fps) / fps, STAT_COUNT_SEC);
}

export const StatCard: React.FC<{
  props: z.infer<typeof StatCardProps>;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ props, theme, edits }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p0 = useEnter(0);
  const p1 = useEnter(6);
  const inverted = props.inverted;
  const counting = statCountText(props.value, frame / fps, fps, theme.motion === "explainer");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 30,
        fontFamily: theme.fontDisplay,
        width: "100%",
        padding: "0 30px",
      }}
    >
      <div
        style={{
          ...pop(p0),
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
          width: "100%",
          background: inverted ? theme.fg : theme.cardBg,
          color: inverted ? theme.bg : theme.fg,
          border: `2px solid ${inverted ? theme.fg : theme.cardBorder}`,
          borderRadius: theme.radiusPx,
          padding: "44px 52px",
        }}
      >
        <div
          data-edit-id="label"
          style={{
            fontSize: 42,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            lineHeight: 1.15,
            maxWidth: "55%",
            ...editStyle(edits, "label"),
          }}
        >
          {props.label}
        </div>
        <div
          data-edit-id="value"
          style={{
            fontSize: 110,
            fontWeight: 900,
            whiteSpace: "nowrap",
            // Counting only: tabular figures, so "1,999" and "4,494" are the
            // same width, and a grid cell sized by the final string drawn
            // invisibly beneath the count — the box is the settled value's
            // from the first frame, and the label beside it never reflows.
            // Classic gets neither: proportional figures are its pixels.
            ...(counting !== null
              ? { display: "grid", fontVariantNumeric: "tabular-nums", justifyItems: "end" }
              : {}),
            ...editStyle(edits, "value"),
          }}
        >
          {counting !== null ? (
            <>
              <span style={{ gridArea: "1 / 1", visibility: "hidden" }}>{props.value}</span>
              <span style={{ gridArea: "1 / 1" }}>{counting}</span>
            </>
          ) : (
            props.value
          )}
        </div>
      </div>
      {props.caption ? (
        <div
          data-edit-id="caption"
          style={{
            ...rise(p1),
            fontSize: 38,
            fontWeight: 800,
            color: theme.fg,
            background: theme.cardBg,
            border: `2px solid ${theme.cardBorder}`,
            borderRadius: theme.radiusPx / 2,
            padding: "16px 30px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            ...editStyle(edits, "caption"),
          }}
        >
          {props.caption}
        </div>
      ) : null}
    </div>
  );
};
