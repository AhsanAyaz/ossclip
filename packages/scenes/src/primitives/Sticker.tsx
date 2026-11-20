import React from "react";
import type { Theme } from "@ossclip/core/browser";
import { SHADOW } from "./shadow";

/**
 * A tilted tag slapped on a card (§161), filled in `color` with a rim in
 * `theme.fg` — the playbook's white rim, which is what lifts it off a card of
 * any colour. Text is `theme.ink` because every sticker fill the playbook
 * uses (yellow, orange, red) is light enough to need dark type. `sizePx`
 * defaults to 34, the pill minimum.
 */
export const Sticker: React.FC<{
  text: string;
  theme: Theme;
  color: string;
  tiltDeg?: number;
  sizePx?: number;
  editId?: string;
  style?: React.CSSProperties;
}> = ({ text, theme, color, tiltDeg = -4, sizePx = 34, editId, style }) => (
  <div
    data-edit-id={editId}
    style={{
      display: "inline-block",
      background: color,
      color: theme.ink,
      border: `5px solid ${theme.fg}`,
      borderRadius: Math.round(sizePx * 0.3),
      padding: `${Math.round(sizePx * 0.25)}px ${Math.round(sizePx * 0.55)}px`,
      fontFamily: theme.fontDisplay,
      fontSize: sizePx,
      fontWeight: 900,
      lineHeight: 1.1,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
      boxShadow: SHADOW,
      transform: `rotate(${tiltDeg}deg)`,
      ...style,
    }}
  >
    {text}
  </div>
);
