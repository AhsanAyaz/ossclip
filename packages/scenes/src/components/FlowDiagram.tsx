import React from "react";
import { z } from "zod/v4";
import { FlowDiagramProps, type Theme } from "@ossclip/core/browser";
import { pop, useEnter } from "../anim";

const Chip: React.FC<{
  text: string;
  emphasized: boolean;
  delay: number;
  fontSize: number;
  theme: Theme;
}> = ({ text, emphasized, delay, fontSize, theme }) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        ...pop(p),
        background: emphasized ? theme.fg : theme.cardBg,
        color: emphasized ? theme.bg : theme.fg,
        border: `2px solid ${emphasized ? theme.fg : theme.cardBorder}`,
        borderRadius: theme.radiusPx / 2,
        padding: `${fontSize * 0.55}px ${fontSize * 0.8}px`,
        fontSize,
        fontWeight: 900,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        fontFamily: theme.fontDisplay,
      }}
    >
      {text}
    </div>
  );
};

const Arrow: React.FC<{ delay: number; fontSize: number; theme: Theme }> = ({
  delay,
  fontSize,
  theme,
}) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        opacity: p,
        color: theme.muted,
        fontSize: fontSize * 1.15,
        fontWeight: 700,
        paddingLeft: fontSize * 0.55,
      }}
    >
      →
    </div>
  );
};

/**
 * Fit a single row into the graphic slot (~820 px inside the safe area):
 * scale the type down with content instead of wrapping (FINDINGS §1).
 */
function fitFontSize(nodes: readonly string[]): number {
  const chars = nodes.reduce((acc, n) => acc + n.length, 0);
  const n = nodes.length;
  // chip text + chip padding + arrow glyphs + flex gaps, all ∝ fontSize
  const widthPerFontPx = 0.62 * chars + 1.9 * n + 1.5 * (n - 1);
  return Math.max(26, Math.min(44, Math.floor(820 / widthPerFontPx)));
}

export const FlowDiagram: React.FC<{ props: z.infer<typeof FlowDiagramProps>; theme: Theme }> = ({
  props,
  theme,
}) => {
  const fontSize = fitFontSize(props.nodes);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        rowGap: fontSize * 0.6,
        columnGap: 0,
        padding: "0 10px",
      }}
    >
      {props.nodes.map((node, i) => (
        // Arrow and its target chip are ONE flex item — if the row must
        // wrap, the arrow travels with the chip it points at, so a dangling
        // trailing arrow is impossible.
        <div key={i} style={{ display: "flex", alignItems: "center", gap: fontSize * 0.55 }}>
          {/* Arrow enters AFTER its chip — never a visible arrow into nothing. */}
          {i > 0 ? <Arrow delay={i * 6 + 3} fontSize={fontSize} theme={theme} /> : null}
          <Chip
            text={node}
            emphasized={props.emphasizeLast && i === props.nodes.length - 1}
            delay={i * 6}
            fontSize={fontSize}
            theme={theme}
          />
        </div>
      ))}
    </div>
  );
};
