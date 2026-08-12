import { splitRootId, type OverrideDoc, type SceneCue } from "@ossclip/core/browser";

/**
 * The two things "delete this scene" can mean, and they are genuinely
 * different edits — not two spellings of one (§139):
 *
 * - `graphic` → `hideScene`: the block goes ghost, its WINDOW survives as a
 *   plain take, the video underneath keeps playing. Restorable from the
 *   Inspector.
 * - `take` → `cutChunk`: the window itself is removed from the output on the
 *   next produce/Render. Applies to a take as readily as to a scene.
 */
export type DeleteTarget = "graphic" | "take";

export interface DeletePlan {
  /** The id to dispatch `hideScene` against — the SPLIT HALF's own id when
   * the selection is a half, never the root (§137/§139). */
  sceneId: string;
  /** The scene this cue belongs to, `@<split id>` suffix stripped. Shown to
   * the user instead of the raw id: that suffix is an opaque minted id, and
   * putting it on screen invites reading it as a time (§137). */
  rootId: string;
  isSplitHalf: boolean;
  /** The half's OWN window — what `cutChunk` removes. */
  startSec: number;
  endSec: number;
  /** Offered in this order; `[0]` is the preselected default. */
  targets: DeleteTarget[];
}

/**
 * Which deletes are on the table for the current selection, and which one is
 * preselected — pure, so the modal's contents are testable without a DOM the
 * way `ghostCues`/`renderCompleteReload` are.
 *
 * Returns `null` when NOTHING is deletable, which is the signal not to open
 * the modal at all: a confirm dialog whose every option is unavailable is
 * worse than the keypress doing nothing.
 *
 * The graphic is the default wherever it is offered because it is the
 * recoverable one — one Inspector click brings the block back, whereas a cut
 * window is only visibly struck through until the next produce.
 */
export function deletePlanFor(cue: SceneCue | undefined | null, doc: OverrideDoc): DeletePlan | null {
  if (!cue) return null;
  const targets: DeleteTarget[] = [];
  // A plain take has no graphic to drop, and an already-hidden scene is
  // already a ghost — offering either would be a confirm dialog for a no-op
  // (the reducer's `hideScene` would happily push one onto the undo stack).
  if (cue.kind !== "plain" && doc.scenes[cue.id]?.hidden !== true) targets.push("graphic");
  // Mirrors `cutChunk`'s own predicate in useEdits.ts: only a SRC-LESS entry
  // at this exact window means "the user already cut this". A src-anchored
  // entry sharing the window is produce's resolved anchor for a DIFFERENT
  // decision and must not suppress the offer — see that reducer case.
  const alreadyCut = doc.cuts.some(
    (c) => c.src === undefined && c.startSec === cue.startSec && c.endSec === cue.endSec,
  );
  if (!alreadyCut) targets.push("take");
  if (targets.length === 0) return null;
  const rootId = splitRootId(cue.id);
  return {
    sceneId: cue.id,
    rootId,
    isSplitHalf: rootId !== cue.id,
    startSec: cue.startSec,
    endSec: cue.endSec,
    targets,
  };
}
