import type { IconName } from "@ossclip/core/browser";

/**
 * Every icon as stroked SVG path data on a 24×24 grid (§161), keyed by
 * core's `ICON_NAMES`. A `Record` over the name union rather than a lookup
 * that may miss, so a name added to the schema without a drawing is a
 * compile error here instead of a blank square in a render. Pure data in its
 * own module so the test can check it without React.
 *
 * Drawn as plain strokes, not filled glyphs from a font: the bundled Inter
 * has no pictographs, and an emoji would render in whatever colour emoji
 * font the render machine happens to have. "none" draws nothing.
 */
export const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  none: [],
  chat: ["M4 5h16v11H10l-5 4v-4H4z"],
  doc: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 12h6", "M9 16h6"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M15.5 15.5L20 20"],
  terminal: ["M3 5h18v14H3z", "M7 9l3 3l-3 3", "M12 15h5"],
  code: ["M8 7l-5 5l5 5", "M16 7l5 5l-5 5", "M14 4l-4 16"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  bolt: ["M13 2L4 14h7l-1 8l9-12h-7z"],
  user: ["M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"],
  robot: ["M5 8h14v11H5z", "M12 4v4", "M9 12v2", "M15 12v2", "M9 16.5h6", "M2 12v4", "M22 12v4"],
};
