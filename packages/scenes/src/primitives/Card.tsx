import React from "react";
import type { Theme } from "@ossclip/core/browser";
import { SHADOW } from "./shadow";

/**
 * The pattern scenes' panel (§161): `theme.cardBg` with a 5 px border in
 * `border` and the theme's radius. The border is the caller's role, not
 * fixed to `cardBorder`, because the playbook colours it by meaning
 * (`accent2` for an item, `accent` for the chosen one). Without `widthPx`
 * the card sizes to its content.
 */
export const Card: React.FC<{
  theme: Theme;
  border: string;
  children?: React.ReactNode;
  widthPx?: number;
  editId?: string;
  style?: React.CSSProperties;
}> = ({ theme, border, children, widthPx, editId, style }) => (
  <div
    data-edit-id={editId}
    style={{
      boxSizing: "border-box",
      width: widthPx,
      background: theme.cardBg,
      color: theme.fg,
      border: `5px solid ${border}`,
      borderRadius: theme.radiusPx,
      padding: "36px 40px",
      fontFamily: theme.fontDisplay,
      boxShadow: SHADOW,
      ...style,
    }}
  >
    {children}
  </div>
);
