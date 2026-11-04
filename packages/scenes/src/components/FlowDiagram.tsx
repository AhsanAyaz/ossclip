import React from "react";
import { useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { FlowDiagramProps, type Theme } from "@ossclip/core/browser";
import { entranceStyle, useEnter } from "../anim";
import { componentRevealFrames, type RevealTiming } from "../reveal";
import { flowMetrics } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

const Chip: React.FC<{
  text: string;
  emphasized: boolean;
  entrance: z.infer<typeof FlowDiagramProps>["entrance"];
  delay: number;
  fontSize: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ text, emphasized, entrance, delay, fontSize, theme, editId, edits }) => {
  const p = useEnter(delay);
  return (
    <div
      data-edit-id={editId}
      style={{
        // Unset is `pop`, this chip's style since day one (spec §4).
        ...entranceStyle(entrance, p),
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

/**
 * When each chip and the arrow into it enter. Chips take the shared reveal
 * schedule (spec §4) at the historical 6-frame step; the arrow stays a
 * component-local 3 frames after ITS chip on every path, so it still
 * follows the chip it points into once the chips are spoken-timed.
 */
export function flowDelays(
  props: z.infer<typeof FlowDiagramProps>,
  fps: number,
  timing?: RevealTiming,
): Array<{ chip: number; arrow: number }> {
  return componentRevealFrames(props.nodes.length, 6, fps, props, timing).map((chip) => ({
    chip,
    arrow: chip + 3,
  }));
}

export const FlowDiagram: React.FC<{
  props: z.infer<typeof FlowDiagramProps>;
  theme: Theme;
  /** The slot this component must fill — see flowMetrics (FINDINGS §23). */
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  // The stage hands down the budget; no measurement needed because the slot
  // geometry is known up front.
  const { mode, fontSize } = flowLayout(props.nodes, widthPx, heightPx);
  const { fps } = useVideoConfig();
  const delays = flowDelays(props, fps, timing);
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
          {i > 0 ? <Arrow delay={delays[i]!.arrow} fontSize={fontSize} theme={theme} down={!row} /> : null}
          <Chip
            text={node}
            emphasized={props.emphasizeLast && i === props.nodes.length - 1}
            entrance={props.entrance}
            delay={delays[i]!.chip}
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
