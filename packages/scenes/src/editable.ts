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
/**
 * Counter-scale stored nudges for a fill-scaled wrapper (PLAN Task 1).
 *
 * Stored `dx`/`dy` are COMPOSITION pixels — screen truth, what the editor
 * measured. But `editStyle` renders inside `SceneLayer`'s `scale(fitScale)`
 * wrapper (§23's fill contract), so an uncorrected translate moved the
 * element `dx × fitScale` on screen — overshoot proportional to distance,
 * which is exactly how the bug presented. The correction lives HERE, at the
 * one boundary that knows the wrapper scale, so the editor stays
 * scale-ignorant and a future change to the fill contract has the
 * compensation sitting right next to it.
 *
 * `scale` nudges pass through untouched: scale composes multiplicatively, so
 * the wrapper's factor cancels by itself.
 */
export function compensateEdits(edits: ElementEdits, renderScale: number): ElementEdits {
  if (!edits || renderScale === 1) return edits;
  return Object.fromEntries(
    Object.entries(edits).map(([id, e]) => [
      id,
      {
        ...e,
        ...(e.dx !== undefined ? { dx: e.dx / renderScale } : {}),
        ...(e.dy !== undefined ? { dy: e.dy / renderScale } : {}),
      },
    ]),
  );
}

export function editStyle(edits: ElementEdits, id: string): React.CSSProperties {
  const e = edits?.[id];
  if (!e) return {};
  const parts = [`translate(${e.dx ?? 0}px, ${e.dy ?? 0}px)`];
  if (e.scale !== undefined && e.scale !== 1) parts.push(`scale(${e.scale})`);
  return { transform: parts.join(" ") };
}
