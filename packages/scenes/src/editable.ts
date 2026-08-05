import type React from "react";

/** Per-element nudges from the user's edit layer, keyed by `data-edit-id`.
 * `hidden` (PLAN Task 2) is a soft-delete flag, not a nudge — see `editStyle`
 * below for where it takes effect. */
export type ElementEdits =
  | Record<string, { dx?: number; dy?: number; scale?: number; hidden?: boolean }>
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
  // Soft-delete (PLAN Task 2), suppressed HERE — the one chokepoint every
  // component's leaf renders its edit style through, so no per-component
  // change is needed and the remaining siblings close the gap on their own
  // (a flex/stack layout just has one fewer box; a scale-to-fill layout's
  // sibling type still fills whatever it filled before — see SceneLayer.tsx
  // for the one place `fitScale` does NOT yet account for this). Also
  // suppresses ChatMock's synthetic CTA bubble (`message-0` in keyword
  // mode, `chatBubbles` in fit.ts) if the user chooses to hide it — that's
  // allowed, not special-cased away: it's their call what the CTA scene
  // shows.
  if (e.hidden) return { display: "none" };
  const parts = [`translate(${e.dx ?? 0}px, ${e.dy ?? 0}px)`];
  if (e.scale !== undefined && e.scale !== 1) parts.push(`scale(${e.scale})`);
  return { transform: parts.join(" ") };
}
