import {
  applyOverrides,
  atSplitPoints,
  splitCues,
  type OverrideDoc,
  type SceneCue,
} from "@ossclip/core/browser";

/**
 * Deleted cues, split-aware, at their override-applied timing (PLAN
 * 2026-08-04 fix wave, final review finding 2) — pulled out pure, same
 * reason `renderCompleteReload` (renderStatus.ts) is: testable without
 * mounting `<App>`/`<Player>` in jsdom just to prove a list.
 *
 * The Timeline draws these as restorable ghosts, and Restore has exactly one
 * call site (`Inspector.tsx`'s `restoreScene`), reached only through this
 * list — a hidden id that never appears here has no way back except
 * hand-editing overrides.json.
 *
 * SPLITS BEFORE filtering for hidden, same reasoning
 * `splitThenDropHidden` (`packages/core/src/overrides.ts`) documents for the
 * live cues: a deleted split half's `hidden` flag lives under its OWN id
 * (`id@<split id>`, the split's minted id since §137 — NOT its time, which is
 * the belief that produced that field bug) — `effectiveOverride`'s
 * root-inheritance explicitly excludes
 * `hidden` from what a half inherits, so there is no fallback to find it by,
 * only a literal entry keyed to the half's own id. That id does not exist in
 * the cue array until `splitCues` runs. Filtering the PRE-split cues (the
 * previous shape of this function) could therefore never find a hidden
 * `id@<split id>` half at all: no ghost, no Restore, and the window it should have
 * shown (the half's OWN, post-split window, not the whole pre-split scene's)
 * was never even computed.
 *
 * `toLive` (cut review step 4 follow-up): the base cues are timed against the
 * LAST RENDER's output clock, but under a live cleanup re-cut the Timeline
 * draws — and the player plays — the NEW clock, so an unmapped ghost sat
 * exactly the revived seconds off its true window. App threads
 * `previewClockMappers(liveRecut).toLive`, which is the literal identity when
 * no re-cut is live — the default here, so a two-argument call (and every
 * pre-step-4 test) keeps today's values bit for bit. Under vetoes alone the
 * two ends map exactly — vetoes only ADD time back, so every old-clock moment
 * survives on the new clock (the `retimeForPreview` direction argument) — but
 * since the cut-review rework a LIVE user cut (`cuts[].src`) can remove one,
 * and a ghost end inside such a cut CLAMPS to the nearest surviving edge
 * (`toLive`'s own doc). A hidden scene the user then cut away collapses to a
 * zero-width ghost rather than drawing at a stale window: honest, and the
 * Restore it offers still works, since `hidden` is keyed by id, not by time.
 */
export function ghostCues(
  cues: readonly SceneCue[],
  doc: OverrideDoc,
  toLive: (sec: number) => number = (sec) => sec,
): SceneCue[] {
  const { cues: applied } = applyOverrides(cues, doc);
  const splitted = splitCues(applied, atSplitPoints(doc.splits));
  return splitted
    .filter((c) => doc.scenes[c.id]?.hidden === true)
    .map((c) => ({ ...c, startSec: toLive(c.startSec), endSec: toLive(c.endSec) }));
}
