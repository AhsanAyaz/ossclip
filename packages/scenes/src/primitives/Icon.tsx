import React from "react";
import type { IconName } from "@ossclip/core/browser";
import { ICON_PATHS } from "./icon-paths";

/**
 * A plain line icon from `ICON_PATHS` (§161), stroked in `color` — callers
 * pass a theme role, so the icon recolours with the look. `"none"` renders
 * nothing at all, not an empty box, so a card without an icon keeps no gap
 * where one would be.
 */
export const Icon: React.FC<{ name: IconName; sizePx: number; color: string }> = ({
  name,
  sizePx,
  color,
}) => {
  const paths = ICON_PATHS[name];
  if (paths.length === 0) return null;
  return (
    <svg
      width={sizePx}
      height={sizePx}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: "block", flexShrink: 0 }}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
};
