import React from "react";
import type { Theme } from "@ossclip/core/browser";
import { SHADOW } from "./shadow";

/**
 * The numbered-problem disc (§161): a `theme.danger` circle with the numeral
 * in `theme.fg`. Tabular figures and a line height of 1 so a 1 and an 8 sit
 * at the same optical centre — a proportional 1 drifts left in a circle.
 */
export const NumberBadge: React.FC<{
  n: number;
  theme: Theme;
  sizePx: number;
  style?: React.CSSProperties;
}> = ({ n, theme, sizePx, style }) => (
  <div
    style={{
      width: sizePx,
      height: sizePx,
      flexShrink: 0,
      borderRadius: "50%",
      background: theme.danger,
      color: theme.fg,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: theme.fontDisplay,
      fontSize: Math.round(sizePx * 0.58),
      fontWeight: 900,
      lineHeight: 1,
      fontVariantNumeric: "tabular-nums",
      boxShadow: SHADOW,
      ...style,
    }}
  >
    {n}
  </div>
);
