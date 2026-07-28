import React from "react";
import { z } from "zod/v4";
import { BulletListProps, type Theme } from "@ossclip/core/browser";
import { rise, useEnter } from "../anim";
import { bulletMetrics } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

/**
 * An enumeration (R16 §67): one bullet row per listed item, optional kicker
 * title. Self-fitting like StrikethroughReveal — rows are nowrap (a wrapped
 * bullet stops reading as a list), so the type solves against the slot in
 * `bulletMetrics` and the stage's uniform scale stays out of it.
 */
const Item: React.FC<{
  text: string;
  index: number;
  fontSize: number;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ text, index, fontSize, theme, edits }) => {
  const editId = `item-${index}`;
  const p = useEnter(index * 7);
  return (
    <div
      data-edit-id={editId}
      style={{
        ...rise(p, 26),
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
}> = ({ props, theme, widthPx, heightPx, edits }) => {
  const fontSize = bulletMetrics(props.items, widthPx, heightPx, Boolean(props.title));
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
        <Item key={i} text={text} index={i} fontSize={fontSize} theme={theme} edits={edits} />
      ))}
    </div>
  );
};
