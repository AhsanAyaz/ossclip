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

const Arrow: React.FC<{ delay: number; fontSize: number; theme: Theme; down?: boolean }> = ({
  delay,
  fontSize,
  theme,
  down = false,
}) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        opacity: p,
        color: theme.muted,
        fontSize: fontSize * 1.15,
        fontWeight: 700,
        lineHeight: 1,
        paddingLeft: down ? 0 : fontSize * 0.55,
      }}
    >
      {down ? "↓" : "→"}
    </div>
  );
};

/** Width budget inside the safe area; height budget of the graphic-only slot. */
const ROW_WIDTH_PX = 820;
const STACK_HEIGHT_PX = 900;
/** Below this the chips stop reading on a phone — switch shape, don't shrink. */
const MIN_ROW_FONT = 26;

/**
 * Row vs stack, decided from content (FINDINGS §1/§12): fit-to-width scales
 * the type down for a single row, and when real copy can't fit even at the
 * font floor — the golden fixture's short labels hid this — the diagram
 * becomes a vertical stack with downward arrows instead of ever wrapping.
 */
export function flowLayout(nodes: readonly string[]): {
  mode: "row" | "stack";
  fontSize: number;
} {
  const chars = nodes.reduce((acc, n) => acc + n.length, 0);
  const n = nodes.length;
  // Conservative width model, all ∝ fontSize. Uppercase 900-weight runs
  // ~0.74em/char + 0.04em letter-spacing; chip padding 2×0.8em; arrow =
  // pad 0.55 + glyph ~0.7 + gap 0.55. The old 0.62em/char model was what
  // let real copy wrap at a font the math said fit (FINDINGS §12) —
  // overestimating costs a couple of font px, underestimating breaks layout.
  const CHAR_W = 0.78;
  const CHIP_PAD = 1.6;
  const ARROW_W = 1.8;
  const rowWidthPerFontPx = CHAR_W * chars + CHIP_PAD * n + ARROW_W * (n - 1);
  const rowFont = ROW_WIDTH_PX / rowWidthPerFontPx;
  if (rowFont >= MIN_ROW_FONT) {
    return { mode: "row", fontSize: Math.min(44, Math.floor(rowFont)) };
  }
  const longest = Math.max(...nodes.map((node) => node.length));
  const widthBound = ROW_WIDTH_PX / (CHAR_W * longest + CHIP_PAD);
  // chip ≈ 2.1em tall (text + padding), arrow row ≈ 1.15em glyph + 2×0.45em gaps
  const heightBound = STACK_HEIGHT_PX / (2.1 * n + 2.05 * (n - 1));
  return {
    mode: "stack",
    fontSize: Math.max(22, Math.min(40, Math.floor(Math.min(widthBound, heightBound)))),
  };
}

export const FlowDiagram: React.FC<{ props: z.infer<typeof FlowDiagramProps>; theme: Theme }> = ({
  props,
  theme,
}) => {
  const { mode, fontSize } = flowLayout(props.nodes);
  const row = mode === "row";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: row ? "row" : "column",
        flexWrap: "nowrap",
        alignItems: "center",
        justifyContent: "center",
        gap: row ? 0 : fontSize * 0.45,
        padding: "0 10px",
      }}
    >
      {props.nodes.map((node, i) => (
        // Arrow and its target chip are ONE flex item, and the arrow enters
        // AFTER its chip — an arrow into nothing is impossible in either shape.
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: row ? "row" : "column",
            alignItems: "center",
            gap: row ? fontSize * 0.55 : fontSize * 0.45,
          }}
        >
          {i > 0 ? <Arrow delay={i * 6 + 3} fontSize={fontSize} theme={theme} down={!row} /> : null}
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
