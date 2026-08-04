import {
  applyOverrides,
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
 * (`id@ms`) — `effectiveOverride`'s root-inheritance explicitly excludes
 * `hidden` from what a half inherits, so there is no fallback to find it by,
 * only a literal entry keyed to the half's own id. That id does not exist in
 * the cue array until `splitCues` runs. Filtering the PRE-split cues (the
 * previous shape of this function) could therefore never find a hidden
 * `id@ms` half at all: no ghost, no Restore, and the window it should have
 * shown (the half's OWN, post-split window, not the whole pre-split scene's)
 * was never even computed.
 */
export function ghostCues(cues: readonly SceneCue[], doc: OverrideDoc): SceneCue[] {
  const { cues: applied } = applyOverrides(cues, doc);
  const splitted = splitCues(applied, doc.splits);
  return splitted.filter((c) => doc.scenes[c.id]?.hidden === true);
}
