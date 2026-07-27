import type React from "react";

/** Per-element nudges from the user's edit layer, keyed by `data-edit-id`. */
export type ElementEdits =
  | Record<string, { dx?: number; dy?: number; scale?: number }>
  | undefined;

/**
 * The style half of an editable leaf; the other half is the `data-edit-id`
 * attribute the editor hit-tests against.
 *
 * Spread LAST in a component's style object so a user nudge wins over the
 * component's own transform. Returns an empty object when untouched, so an
 * unedited element keeps whatever transform its entrance animation set.
 */
export function editStyle(edits: ElementEdits, id: string): React.CSSProperties {
  const e = edits?.[id];
  if (!e) return {};
  const parts = [`translate(${e.dx ?? 0}px, ${e.dy ?? 0}px)`];
  if (e.scale !== undefined && e.scale !== 1) parts.push(`scale(${e.scale})`);
  return { transform: parts.join(" ") };
}
