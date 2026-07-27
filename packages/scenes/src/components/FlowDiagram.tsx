import React from "react";
import { z } from "zod/v4";
import { FlowDiagramProps, type Theme } from "@ossclip/core/browser";
import { pop, useEnter } from "../anim";
import { flowMetrics } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

const Chip: React.FC<{
  text: string;
  emphasized: boolean;
  delay: number;
  fontSize: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ text, emphasized, delay, fontSize, theme, editId, edits }) => {
  const p = useEnter(delay);
  return (
    <div
      data-edit-id={editId}
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
        ...editStyle(edits, editId),
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

/**
 * Row vs stack, decided from content (FINDINGS §1/§12): fit-to-width scales
 * the type down for a single row, and when real copy can't fit even at the
 * font floor — the golden fixture's short labels hid this — the diagram
 * becomes a vertical stack with downward arrows instead of ever wrapping.
 *
 * The width budget is the container's, not a constant: the stage now scales
 * every graphic to fill its slot (§23), so the diagram is laid out at a width
 * derived from that scale rather than against a hardcoded 820px that no longer
 * corresponds to any slot. The old row/stack font caps are gone with it —
 * capping the type here is exactly what left the diagram an 8%-tall strip.
 */
export function flowLayout(
  nodes: readonly string[],
  widthPx = DEFAULT_FLOW_WIDTH_PX,
  heightPx?: number,
): { mode: "row" | "stack"; fontSize: number } {
  return flowMetrics(nodes, widthPx, heightPx);
}

/** Fallback when the stage isn't supplying a budget (tests, direct use). */
const DEFAULT_FLOW_WIDTH_PX = 864;

export const FlowDiagram: React.FC<{
  props: z.infer<typeof FlowDiagramProps>;
  theme: Theme;
  /** The slot this component must fill — see flowMetrics (FINDINGS §23). */
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
}> = ({ props, theme, widthPx, heightPx, edits }) => {
  // The stage hands down the budget; no measurement needed because the slot
  // geometry is known up front.
  const { mode, fontSize } = flowLayout(props.nodes, widthPx, heightPx);
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
            editId={`node-${i}`}
            edits={edits}
          />
        </div>
      ))}
    </div>
  );
};
