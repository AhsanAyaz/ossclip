import React from "react";
import { z } from "zod/v4";
import { StrikethroughRevealProps, type Theme } from "@ossclip/core/browser";
import { rise, useEnter } from "../anim";
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
  delay: number;
  fontSize: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ text, struck, mark, delay, fontSize, theme, editId, edits }) => {
  const p = useEnter(delay);
  const strike = useEnter(delay + 8);
  return (
    <div
      data-edit-id={editId}
      style={{ ...rise(p, 30), position: "relative", display: "inline-block", ...editStyle(edits, editId) }}
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

export const StrikethroughReveal: React.FC<{
  props: z.infer<typeof StrikethroughRevealProps>;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
}> = ({ props, theme, widthPx, heightPx, edits }) => {
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
    })),
  );
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
          delay={i * 6}
          fontSize={fontSize}
          theme={theme}
          editId={`line-${row.lineIndex}`}
          edits={edits}
        />
      ))}
    </div>
  );
};
