import React, { type CSSProperties } from "react";
import { useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { BulletListProps, type Theme } from "@ossclip/core/browser";
import { entranceStyle, rise, useEnter } from "../anim";
import { componentRevealFrames, type RevealTiming } from "../reveal";
import { bulletMetrics } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

/**
 * When each bullet enters (graphic-editor-modal §1): the shared reveal
 * schedule at the historical 7-frame step, so a list with no item times and
 * no reveal props is `i * 7` exactly, as it was before it joined the system.
 */
export function bulletDelays(
  props: z.infer<typeof BulletListProps>,
  fps: number,
  timing?: RevealTiming,
): number[] {
  return componentRevealFrames(props.items.length, 7, fps, props, timing);
}

/**
 * How a bullet's progress is drawn. Unset is `rise`, this row's style since
 * day one, not the shared default `pop` (graphic-editor-modal §1): a list
 * nobody restyled renders as before. StrikethroughReveal keeps its own rise
 * the same way.
 */
export function bulletEnterStyle(
  entrance: z.infer<typeof BulletListProps>["entrance"],
  progress: number,
): CSSProperties {
  return entrance === undefined ? rise(progress, 26) : entranceStyle(entrance, progress);
}

/**
 * An enumeration (R16 §67): one bullet row per listed item, optional kicker
 * title. Self-fitting like StrikethroughReveal — rows are nowrap (a wrapped
 * bullet stops reading as a list), so the type solves against the slot in
 * `bulletMetrics` and the stage's uniform scale stays out of it.
 */
const Item: React.FC<{
  text: string;
  index: number;
  entrance: z.infer<typeof BulletListProps>["entrance"];
  delay: number;
  fontSize: number;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ text, index, entrance, delay, fontSize, theme, edits }) => {
  const editId = `item-${index}`;
  const p = useEnter(delay);
  return (
    <div
      data-edit-id={editId}
      style={{
        ...bulletEnterStyle(entrance, p),
        display: "flex",
        alignItems: "baseline",
        gap: fontSize * 0.35,
        ...editStyle(edits, editId),
      }}
    >
      <span style={{ fontSize: fontSize * 0.75, color: theme.accent, fontWeight: 900 }}>▸</span>
      <span
        style={{
          fontSize,
          fontWeight: 900,
          textTransform: "uppercase",
          lineHeight: 1.15,
          whiteSpace: "nowrap",
          color: theme.fg,
        }}
      >
        {text}
      </span>
    </div>
  );
};

export const BulletList: React.FC<{
  props: z.infer<typeof BulletListProps>;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  const fontSize = bulletMetrics(props.items, widthPx, heightPx, Boolean(props.title), props.title);
  const { fps } = useVideoConfig();
  const delays = bulletDelays(props, fps, timing);
  const titleEnter = useEnter(0);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: fontSize * 0.45,
        fontFamily: theme.fontDisplay,
      }}
    >
      {props.title ? (
        <div
          data-edit-id="title"
          style={{
            ...rise(titleEnter, 20),
            fontSize: fontSize * 0.36,
            fontWeight: 700,
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            color: theme.muted,
            ...editStyle(edits, "title"),
          }}
        >
          {props.title}
        </div>
      ) : null}
      {props.items.map((text, i) => (
        <Item
          key={i}
          text={text}
          index={i}
          entrance={props.entrance}
          delay={delays[i]!}
          fontSize={fontSize}
          theme={theme}
          edits={edits}
        />
      ))}
    </div>
  );
};
