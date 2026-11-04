import React from "react";
import { useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { StrikethroughRevealProps, type Theme } from "@ossclip/core/browser";
import { entranceStyle, rise, useEnter } from "../anim";
import {
  componentRevealFrames,
  isLegacyReveal,
  latestEntryFrame,
  type RevealTiming,
} from "../reveal";
import { revealMetrics, revealRows } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

/**
 * One RENDERED row, with its own strike rule.
 *
 * The rule must be per rendered row, not per logical line: when a line wrapped,
 * the absolutely-positioned bar sat at 50% of the whole two-line block and so
 * struck the gap between the rows rather than either of them (FINDINGS §27).
 *
 * `editId` is keyed by the LOGICAL line (props.lines index), not the rendered
 * row: a wrapped line produces multiple rows here, and all of them share the
 * same id/edits so a user's nudge moves every row of that line together
 * rather than only the first fragment.
 */
const Row: React.FC<{
  text: string;
  struck: boolean;
  /** Verdict glyph (R16 §66) — ✗/✓ leading the row, none for plain lines. */
  mark: "none" | "cross" | "check";
  entrance: z.infer<typeof StrikethroughRevealProps>["entrance"];
  delay: number;
  /** From `strikeRowDelays` — held to the entry limit on the timed path. */
  strikeDelay: number;
  fontSize: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ text, struck, mark, entrance, delay, strikeDelay, fontSize, theme, editId, edits }) => {
  const p = useEnter(delay);
  const strike = useEnter(strikeDelay);
  // Unset — and an explicit `rise` — is this row's own 30px rise, not the
  // shared helper's 26px: picking the style it already has must not move it.
  const enter = entrance === undefined || entrance === "rise" ? rise(p, 30) : entranceStyle(entrance, p);
  return (
    <div
      data-edit-id={editId}
      style={{ ...enter, position: "relative", display: "inline-block", ...editStyle(edits, editId) }}
    >
      <span
        style={{
          fontSize,
          fontWeight: 900,
          textTransform: "uppercase",
          lineHeight: 1.08,
          whiteSpace: "nowrap",
          color: struck ? theme.muted : theme.fg,
        }}
      >
        {mark !== "none" ? (
          <span
            style={{
              color: mark === "cross" ? theme.danger : theme.success,
              marginRight: "0.3em",
            }}
          >
            {mark === "cross" ? "✗" : "✓"}
          </span>
        ) : null}
        {text}
      </span>
      {struck ? (
        <div
          style={{
            position: "absolute",
            left: "-2%",
            top: "50%",
            height: fontSize * 0.11,
            width: `${strike * 104}%`,
            background: theme.danger,
            borderRadius: fontSize * 0.055,
            transform: "translateY(-50%) rotate(-2deg)",
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * When each RENDERED row enters, and when its strike starts drawing. The
 * reveal item is the logical line (the plan matched `props.lines`), but a
 * wrapped line renders several rows:
 *  - legacy: row i at `i * 6` by ROW index, exactly as today — a wrapped
 *    line pushes every later line 6 frames back, and that must not change;
 *    the strike exactly 8 frames after its row, unclamped, as today;
 *  - timed: a line's first row on the line's scheduled frame, each further
 *    row of it the same 6 frames later as today, held to the entry limit so
 *    the tail of a late line still lands before the cut. The strike is held
 *    to the same limit: a row synced onto a word near the cut already sits
 *    AT the limit, and row + 8 would still be drawing on the last frame
 *    (spec §4 — every entrance finishes before the cut).
 */
export function strikeRowDelays(
  rows: ReadonlyArray<{ lineIndex: number; rowInLine: number }>,
  props: z.infer<typeof StrikethroughRevealProps>,
  fps: number,
  timing?: RevealTiming,
): Array<{ row: number; strike: number }> {
  if (timing === undefined || isLegacyReveal(timing.itemAtSec, props)) {
    return rows.map((_, i) => ({ row: i * 6, strike: i * 6 + 8 }));
  }
  const lines = componentRevealFrames(props.lines.length, 6, fps, props, timing);
  const latest = latestEntryFrame(fps, timing.durationInFrames);
  return rows.map(({ lineIndex, rowInLine }) => {
    const first = lines[lineIndex]!;
    const row =
      rowInLine === 0 ? first : Math.min(first + rowInLine * 6, Math.max(first, latest));
    return { row, strike: Math.min(row + 8, Math.max(row, latest)) };
  });
}

export const StrikethroughReveal: React.FC<{
  props: z.infer<typeof StrikethroughRevealProps>;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  // The verdict glyph rides in the width estimate ("✗ " ≈ its real footprint)
  // so a marked line shrinks with its glyph instead of overflowing. `mark` is
  // read defensively: baked render-props from before §66 carry no key.
  const texts = props.lines.map((l) =>
    (l.mark ?? "none") !== "none" ? `✗ ${l.text}` : l.text,
  );
  const fontSize = revealMetrics(texts, widthPx, heightPx);
  // Each logical line becomes one or more rows; a line only breaks at an
  // arrow, and the arrow leads the row it points into. lineIndex is kept
  // alongside so every row can carry its logical line's data-edit-id. The
  // glyph marks only the FIRST row of a wrapped line — one verdict per line.
  const rows = props.lines.flatMap((line, lineIndex) =>
    revealRows(line.text, fontSize, widthPx ?? 831).map((text, rowIdx) => ({
      text,
      struck: line.struck,
      mark: rowIdx === 0 ? (line.mark ?? "none") : ("none" as const),
      lineIndex,
      rowInLine: rowIdx,
    })),
  );
  const { fps } = useVideoConfig();
  const delays = strikeRowDelays(rows, props, fps, timing);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: fontSize * 0.2,
        textAlign: "center",
        fontFamily: theme.fontDisplay,
      }}
    >
      {rows.map((row, i) => (
        <Row
          key={i}
          text={row.text}
          struck={row.struck}
          mark={row.mark}
          entrance={props.entrance}
          delay={delays[i]!.row}
          strikeDelay={delays[i]!.strike}
          fontSize={fontSize}
          theme={theme}
          editId={`line-${row.lineIndex}`}
          edits={edits}
        />
      ))}
    </div>
  );
};
