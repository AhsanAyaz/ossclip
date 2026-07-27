import React from "react";
import { z } from "zod/v4";
import { StrikethroughRevealProps, type Theme } from "@ossclip/core/browser";
import { rise, useEnter } from "../anim";
import { revealMetrics, revealRows } from "../fit";

/**
 * One RENDERED row, with its own strike rule.
 *
 * The rule must be per rendered row, not per logical line: when a line wrapped,
 * the absolutely-positioned bar sat at 50% of the whole two-line block and so
 * struck the gap between the rows rather than either of them (FINDINGS §27).
 */
const Row: React.FC<{
  text: string;
  struck: boolean;
  delay: number;
  fontSize: number;
  theme: Theme;
}> = ({ text, struck, delay, fontSize, theme }) => {
  const p = useEnter(delay);
  const strike = useEnter(delay + 8);
  return (
    <div style={{ ...rise(p, 30), position: "relative", display: "inline-block" }}>
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
}> = ({ props, theme, widthPx, heightPx }) => {
  const texts = props.lines.map((l) => l.text);
  const fontSize = revealMetrics(texts, widthPx, heightPx);
  // Each logical line becomes one or more rows; a line only breaks at an
  // arrow, and the arrow leads the row it points into.
  const rows = props.lines.flatMap((line) =>
    revealRows(line.text, fontSize, widthPx ?? 831).map((text) => ({
      text,
      struck: line.struck,
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
          delay={i * 6}
          fontSize={fontSize}
          theme={theme}
        />
      ))}
    </div>
  );
};
