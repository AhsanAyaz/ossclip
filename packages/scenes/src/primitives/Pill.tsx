import React from "react";
import type { Theme } from "@ossclip/core/browser";
import { ICON_PATHS } from "./icon-paths";
import { SHADOW } from "./shadow";

/** The cross is a Pill mark only, not a card icon, so it is not in ICON_NAMES. */
const CROSS_PATHS = ["M6 6l12 12", "M18 6L6 18"] as const;

/**
 * A dark rounded label with a 3 px coloured border (§161) — the playbook's
 * checklist pill. `sizePx` defaults to 34, the minimum pill text size at
 * 1920×1080 (plan Global Constraints). `mark` draws a tick in
 * `theme.success` or a cross in `theme.danger` before the text, as SVG
 * strokes rather than ✓/✗ glyphs: the bundled Inter has neither, and the
 * fallback font's would sit on a different baseline per machine.
 *
 * `style` merges last so a component can add its entrance transform, and
 * `editId` becomes the `data-edit-id` the editor's hit-test looks for.
 */
export const Pill: React.FC<{
  text: string;
  border: string;
  theme: Theme;
  sizePx?: number;
  mark?: "tick" | "cross";
  editId?: string;
  style?: React.CSSProperties;
}> = ({ text, border, theme, sizePx = 34, mark, editId, style }) => {
  const markPaths = mark === "tick" ? ICON_PATHS.check : mark === "cross" ? CROSS_PATHS : null;
  return (
    <div
      data-edit-id={editId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(sizePx * 0.4),
        background: theme.cardBg,
        color: theme.fg,
        border: `3px solid ${border}`,
        borderRadius: 999,
        padding: `${Math.round(sizePx * 0.36)}px ${Math.round(sizePx * 0.75)}px`,
        fontFamily: theme.fontDisplay,
        fontSize: sizePx,
        fontWeight: 800,
        lineHeight: 1.1,
        whiteSpace: "nowrap",
        boxShadow: SHADOW,
        ...style,
      }}
    >
      {markPaths ? (
        <svg
          width={sizePx}
          height={sizePx}
          viewBox="0 0 24 24"
          fill="none"
          stroke={mark === "tick" ? theme.success : theme.danger}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ display: "block", flexShrink: 0 }}
        >
          {markPaths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : null}
      <span>{text}</span>
    </div>
  );
};
