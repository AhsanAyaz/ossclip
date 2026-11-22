import {
  itemTimingRoots,
  resolveItemTimings,
  type ItemTimingRoot,
  type OverrideDoc,
  type SceneCue,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";

/**
 * The live preview's item step (graphic-editor-modal §4), pure so it is
 * tested without App's memo: the two calls App makes, with the null guards
 * that keep a project without the marker on the byte-identical path.
 * item-timing-parity.test.ts runs a case through exactly these, so App's
 * wiring and the harness's editor path are one code path, not two copies.
 */

/**
 * The `roots` for `previewItemTimings`, taken at the memo's FIRST
 * `applyOverrides` (App.tsx, `graphicCues`): the list is not split yet, so
 * each marked root is its own cue there, with its merged props. `pinMap` is
 * the old clock, the one a legacy output pin was written on (Terms, block
 * window rule 1); `liveMap` is `liveRecut?.newMap ?? oldClockMap`, the clock
 * a src pin must resolve on to set the window. `doc` is the RAW `edits.doc`,
 * never `resolveSrcTimingPins`' output, whose src pins already read as
 * output seconds (`blockWindow`).
 *
 * Null without a clock or a word list (`oldClockMap`/`sfxPlan.words` not
 * loaded yet, App.tsx's `spansMap`): the pass is skipped rather than run on
 * a guessed clock, and the modal says items cannot be placed yet (§4).
 */
export function previewItemRoots(
  cues: readonly SceneCue[],
  doc: OverrideDoc,
  words: readonly Word[] | null,
  pinMap: TimeMap | null,
  liveMap: TimeMap | null,
): ReadonlyMap<string, ItemTimingRoot> | null {
  if (words === null || pinMap === null || liveMap === null) return null;
  return itemTimingRoots(cues, doc, words, pinMap, liveMap);
}

/**
 * Item times resolved on the live clock, for `finishOnClock`'s two exits
 * (§4): its early exit, the ordinary session with nothing live, so G2 holds
 * before any veto exists; and its main path, after that path's
 * `applyOverrides` (a src timing pin that resolves only on the live clock
 * has applied by then) and before `withStagePreviews`.
 *
 * Returns the SAME `props` object when there is nothing to resolve: no
 * roots (no clock or words, or no marked root in the list) or no clock or
 * words here. The early exit has always handed its props through untouched
 * when nothing live changed, and a project without `itemPins` has to keep
 * that (AG1). `notes` are the resolver's, for that pass's `reports`.
 *
 * `doc` is the raw doc, as for the roots; `liveMap` is `finishOnClock`'s
 * `clockMap`, which is `liveRecut?.newMap ?? oldClockMap` by its two call
 * sites, the clock the roots' windows were judged on.
 */
export function previewItemTimings<P extends { sceneCues?: SceneCue[] }>(
  props: P,
  doc: OverrideDoc,
  roots: ReadonlyMap<string, ItemTimingRoot> | null,
  words: readonly Word[] | null,
  liveMap: TimeMap | null,
): { props: P; notes: string[] } {
  if (roots === null || roots.size === 0 || words === null || liveMap === null) {
    return { props, notes: [] };
  }
  const cues = props.sceneCues ?? [];
  const timed = resolveItemTimings(cues, doc, words, liveMap, roots);
  // `resolveItemTimings` hands back its own array when it wrote nothing.
  if (timed.cues === cues) return { props, notes: timed.notes };
  return { props: { ...props, sceneCues: timed.cues }, notes: timed.notes };
}
