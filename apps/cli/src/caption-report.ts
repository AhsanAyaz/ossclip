import {
  applyCaptionEdits,
  applyCaptionRangeEdits,
  applyCaptionWordHides,
  applyCaptionLineTiming,
  applyCaptionLineWindows,
  captionEditsToKeep,
  isLegacyCaptionKey,
  migrateCaptionKeys,
  MIGRATION_SEARCH_RADIUS,
} from "@ossclip/core";
import type {
  AppliedCaptionEdits,
  CaptionEdit,
  CaptionKeyMigration,
  CaptionLine,
  OverrideDoc,
  TimeMap,
} from "@ossclip/core";

/**
 * What `produce` does with the user's retyped caption words, and what it says
 * about the ones that did not land (§137).
 *
 * Pure, and in its own module rather than inline in `produce.ts`, for the
 * house reason: this is a decision about the user's data (which edits are
 * re-anchored, which are applied, and why the others were not) and a
 * `produce()` run needs ffmpeg, a transcript and a workdir before it reaches
 * any of it. `produce.ts` keeps the `console.log` and the file writes.
 */

/** One drop, as a console line. Three cases, and the caller must not merge them. */
export function captionDropLine(drop: AppliedCaptionEdits["dropped"][number]): string {
  // `found: null` used to be interpolated straight into the sentence, so a
  // word the cut removed reported `the transcript now has "null"` — the one
  // case §137 exists for, described as a JSON literal. The three cases carry
  // genuinely different advice, so they get genuinely different sentences.
  if (drop.reason === "duplicate-anchor") {
    // NOT a stale edit: the edit almost certainly applied, to the FIRST word
    // carrying this anchor. Two words share one source instant by design
    // (captions.ts:44-50 — backfilled seam preimages and cut-clamped words),
    // so this is a note about reach, not a failure.
    return (
      `  ⚠ caption edit "${drop.expected}" (${drop.key}): a second word shares that ` +
      `source moment and was left as it is — only the first was retyped`
    );
  }
  if (drop.found === null) {
    // A key that is a POSITION, not a source anchor, never had a moment to
    // lose — it is a pre-§137 doc the migration could not upgrade. Saying "the
    // cut removed it" there sends the user to redo work that is sitting intact
    // on screen (§137 Task 6 review, Important 2). Reachable whenever an edit
    // reaches `applyCaptionEdits` without going through `migrateCaptionKeys`.
    if (isLegacyCaptionKey(drop.key)) {
      return (
        `  ⚠ caption edit "${drop.expected}" (position ${drop.key}) not applied: it is keyed ` +
        `by word POSITION, from a project saved before source anchors, and nothing ` +
        `re-anchored it — open the project in the editor, or retype it there`
      );
    }
    return (
      `  ⚠ caption edit "${drop.expected}" (${drop.key}) dropped: no word starts at that ` +
      `source moment any more — the cut removed the word it was typed over. ` +
      `Retype it in the editor if you still want it.`
    );
  }
  return (
    `  ⚠ caption edit "${drop.expected}" (${drop.key}) dropped: the transcript now says ` +
    `"${drop.found}" there`
  );
}

/**
 * One console line for a HIDE that did not land (§59b, revisited 2026-08-18).
 * Same three cases as `captionDropLine` — `applyCaptionWordHides` reports in
 * the identical shape — but its own function rather than a flag on that one:
 * "hidden word" has to lead every sentence (the user's gesture was a delete,
 * not a retype, and the fix is to re-select and hide, not to retype), and no
 * legacy-key branch exists here because `captionWordsHidden` never had a
 * positional-key era (`OverrideDocSchema`'s own note).
 */
export function captionHideDropLine(drop: AppliedCaptionEdits["dropped"][number]): string {
  if (drop.reason === "duplicate-anchor") {
    // A note about reach, not a failure — the hide applied, to the FIRST word
    // carrying this anchor (two words share one source instant by design,
    // captions.ts:44-50).
    return (
      `  ⚠ hidden word "${drop.expected}" (${drop.key}): a second word shares that ` +
      `source moment and was left visible — only the first was hidden`
    );
  }
  if (drop.found === null) {
    return (
      `  ⚠ hidden word "${drop.expected}" (${drop.key}) dropped: no word starts at that ` +
      `source moment any more — the cut removed the word it hid, so there is ` +
      `nothing left to hide`
    );
  }
  return (
    `  ⚠ hidden word "${drop.expected}" (${drop.key}) dropped: the transcript now says ` +
    `"${drop.found}" there — it was left visible rather than hiding a different word`
  );
}

/**
 * One console line for a RANGE rewrite that did not land (2026-08-18). Its
 * own function for the captionHideDropLine reason: the gesture was a
 * free-text rewrite and the fix is to re-select and Edit; `expected` is the
 * WHOLE run's joined `was` (the layer's whole-run guard drops the entire
 * entry rather than guessing at part of it), and `key` is the composite
 * `${fromKey}..${toKey}` pair. No legacy-key branch: `captionRangeEdits`
 * postdates §137, so a positional-key era never existed for it.
 */
export function captionRangeDropLine(drop: AppliedCaptionEdits["dropped"][number]): string {
  if (drop.reason === "duplicate-anchor") {
    return (
      `  ⚠ range edit "${drop.expected}" (${drop.key}): an earlier range edit already ` +
      `rewrote the word it starts on — only the first applied`
    );
  }
  if (drop.found === null) {
    return (
      `  ⚠ range edit "${drop.expected}" (${drop.key}) dropped: its words no longer sit at ` +
      `those source moments — a cut or re-plan removed the run it rewrote. Re-select and ` +
      `Edit in the editor if you still want it.`
    );
  }
  return (
    `  ⚠ range edit "${drop.expected}" (${drop.key}) dropped: the transcript now says ` +
    `"${drop.found}" there — the whole rewrite was left unapplied rather than guessing at part of it`
  );
}

/**
 * One console line for a LINE TIMING nudge that did not land (2026-08-18).
 * Its own function for the captionHideDropLine reason: the gesture was a
 * re-time of when a caption appears and the fix is to re-make the nudge, not
 * retype. Only TWO cases — `applyCaptionLineTiming` carries no `was` guard
 * (timing is text-orthogonal, its own doc comment), so the "transcript says
 * something else" sentence has no counterpart here, and `expected` is always
 * `""`, which is why these lines name the moment by key rather than quoting a
 * word. The key is the LINE's first word's source anchor, so the sentences
 * say "caption timing", not "word". No legacy-key branch:
 * `captionLineTiming` postdates §137.
 */
export function captionTimingDropLine(drop: AppliedCaptionEdits["dropped"][number]): string {
  if (drop.reason === "duplicate-anchor") {
    // A note about reach, not a failure — the nudge applied, to the FIRST
    // line starting on this anchor (two words share one source instant by
    // design, captions.ts:44-50).
    return (
      `  ⚠ caption timing (${drop.key}): a second caption starts on that source moment and ` +
      `kept its window — only the first was re-timed`
    );
  }
  return (
    `  ⚠ caption timing (${drop.key}) dropped: no caption starts at that source moment any ` +
    `more — the cut removed the caption whose timing was nudged`
  );
}

/**
 * How many stored edits actually landed.
 *
 * NOT `keys.length - dropped.length` (§137): `dropped` is not one entry per
 * key. A `duplicate-anchor` entry is pushed for every EXTRA word carrying an
 * anchor, so a single key can appear in `dropped` two or three times — and it
 * may have applied anyway. The old subtraction therefore undercounted, and
 * with enough duplicates went NEGATIVE, which the `> 0` guard then hid
 * entirely: the run printed nothing at all about edits that had applied.
 *
 * The rule comes straight from `applyCaptionEdits`' own contract: a key is
 * marked `seen` by the first word carrying it, and that word either applied
 * the edit or was reported with `reason` ABSENT. So an edit landed exactly
 * when nothing was reported for its key without a `reason`.
 *
 * `applyCaptionWordHides` and `applyCaptionLineTiming` are built to the same
 * contract (first claimant applies, extras get `duplicate-anchor`, unmatched
 * keys get a reason-less drop), so this counts for those layers too — hence
 * the record's value type is unconstrained: only the KEYS are read.
 */
export function appliedCaptionEditCount(
  edits: Readonly<Record<string, unknown>>,
  dropped: AppliedCaptionEdits["dropped"],
): number {
  const failed = new Set(dropped.filter((d) => d.reason === undefined).map((d) => d.key));
  return Object.keys(edits).filter((key) => !failed.has(key)).length;
}

/**
 * One console line for a legacy edit the migration would not place (§137).
 *
 * One sentence per CAUSE, like the editor's own notice: three of the four
 * leave the word sitting right there in the transcript, and a single message
 * blaming the cut would send the user hunting for it.
 */
export function captionMigrationLine(u: CaptionKeyMigration["unresolved"][number]): string {
  const head = `  ⚠ caption edit "${u.was}" (${u.key}) could not be re-anchored`;
  switch (u.reason) {
    case "out-of-range":
      // The word is ON SCREEN. Blaming the cut here (which the shared
      // `not-found` sentence did until the final review) sends the user to
      // retype something that is sitting intact in the transcript — and the
      // edit is kept in the doc, so the next run against a different cut may
      // place it without them doing anything at all.
      // No promise that retyping fixes it, either: the word this found may
      // itself be unanchorable (a pre-§137 render-props.json with nothing to
      // backfill from), and "re-anchors it for good" would be a guarantee this
      // line cannot make.
      return `${head}: the word is still here, but more than ${MIGRATION_SEARCH_RADIUS} words from where the edit was stored, so it was left alone rather than applied to the wrong one — it is kept in overrides.json, so retype it in the editor if that is the word you meant`;
    case "ambiguous":
      return `${head}: more than one word says it here, so it was left alone rather than applied to the wrong one — retype the one you meant in the editor`;
    case "unanchorable":
      return `${head}: the word is here but carries no source timing to key on`;
    case "collision":
      return `${head}: two stored edits point at the same word — neither was applied, retype the one you meant in the editor`;
    case "superseded":
      return `${head}: a newer edit already covers that word — the newer one was kept`;
    default:
      return `${head}: no word says it any more — the cut or a re-plan removed it. Retype it in the editor if you still want it.`;
  }
}

/**
 * How many edits came out under a key they did not go in under — the ones the
 * migration actually moved.
 *
 * NOT `Object.keys(migration.edits).length`, which is what the count in the log
 * line was first written as: a MIXED doc (`{"0": …, "w6000": …}` over one word)
 * keeps its already-source-keyed edit and retires the legacy one, so that
 * count announced "1 caption edit re-anchored" about a key nothing had
 * touched. A number the user can check against their own file has to be true
 * for the same reason the drop lines do.
 */
export function reanchoredKeyCount(
  before: Record<string, CaptionEdit>,
  migration: CaptionKeyMigration,
): number {
  return Object.keys(migration.edits).filter((key) => !(key in before)).length;
}

export interface CaptionReconciliation {
  /** The doc with its caption keys upgraded — what produce writes back. */
  doc: OverrideDoc;
  /** The caption lines with every edit, range rewrite, hide AND line-timing
   * nudge that could apply, applied — post-timing, exactly what the render
   * should show. */
  lines: CaptionLine[];
  /**
   * Whether the migration actually MOVED an edit onto a source anchor — the
   * write-back gate, and the only thing that earns spending the `.bak`.
   *
   * It used to be `captionKeysMigrated`: true whenever anything was
   * unresolved, including when nothing at all was placed. That is a write with
   * no repair in it, and on the field workdir (`cutResult.changed` false,
   * because the cut already carries `src`) it was a NEW write on a run that
   * previously touched nothing — spending `overrides.json.bak`, the user's
   * only surviving pre-cut save and the sole route back to the split half they
   * deleted, on a copy of the already-damaged document (final review, Critical
   * 2). A run that placed nothing has nothing to write and no business
   * touching the `.bak`. Renamed as well as re-defined, because "keys changed"
   * is no longer even true of it: a `superseded` retirement changes the keys
   * and deliberately does not fire this.
   */
  reanchored: boolean;
  /** Everything produce should print about this, in order. */
  log: string[];
}

/**
 * Migrate, then apply, then account for the difference — the whole caption
 * half of a produce run, in one pure pass.
 *
 * MIGRATE FIRST, and against these same lines: `applyCaptionEdits` addresses
 * words by source anchor, so a pre-§137 positional key matches nothing at all
 * and every retype in an old project would be silently absent from the render
 * (§137 Task 6 review, Critical 1). Nothing needs backfilling here — produce
 * builds these lines itself, with a real `srcStart` on every word — which is
 * exactly why this migration belongs in produce even though the same call in
 * the edit server would be inert.
 *
 * WHAT IS APPLIED AND WHAT IS KEPT ARE DIFFERENT SETS, deliberately (final
 * review, Critical 1). Only the edits the migration PLACED are applied — an
 * unresolved key addresses no word, so handing it to `applyCaptionEdits` would
 * buy nothing but a second, worse-worded report of the same edit. The doc
 * written back keeps them anyway (`captionEditsToKeep`), because a run that
 * cannot place an edit today is not a licence to delete it.
 *
 * The caller must hand a doc that has been through `OverrideDocSchema`
 * (`produce.ts` parses it at the top of the run). On raw `JSON.parse` output a
 * literal `"__proto__"` key would be assigned THROUGH rather than kept, and
 * the migration would report nothing lost while losing it.
 *
 * `map` is the run's own cutlist map — the one `baseLines` were built through
 * — and exists for the WINDOW layer alone (`applyCaptionLineWindows`): windows
 * are stored in source seconds and these lines speak output seconds. Taken as
 * a parameter rather than rebuilt here for the usual reason: two maps is how
 * this pass and the render would come to place a caption differently.
 */
export function reconcileCaptionEdits(
  doc: OverrideDoc,
  baseLines: readonly CaptionLine[],
  map: TimeMap,
): CaptionReconciliation {
  const log: string[] = [];
  const migration = migrateCaptionKeys(doc.captions, baseLines);
  // The MOVED count is both the log gate and the write gate. As a log gate:
  // announcing "0 caption edit(s) re-anchored" above the lines saying why is
  // noise on the one run where the user is reading carefully. As a write gate:
  // see `CaptionReconciliation.reanchored` — a run that placed nothing must
  // not spend the `.bak`.
  const reanchored = reanchoredKeyCount(doc.captions, migration);
  if (reanchored > 0) {
    log.push(
      `▸ ${reanchored} caption edit(s) re-anchored from word positions to source time (§137)`,
    );
  }
  for (const u of migration.unresolved) log.push(captionMigrationLine(u));
  const migrated = { ...doc, captions: captionEditsToKeep(doc.captions, migration) };
  const { lines, dropped } = applyCaptionEdits(baseLines, migration.edits);
  const live = appliedCaptionEditCount(migration.edits, dropped);
  if (live > 0) log.push(`▸ ${live} caption word(s) retyped by the editor`);
  for (const d of dropped) log.push(captionDropLine(d));
  // Range rewrites BETWEEN retypes and hides — `applyCaptionLayers`' one
  // authoritative order, still composed manually here because this path's
  // edits layer is the MIGRATED set (see the hides comment below). No key
  // migration for ranges either: `captionRangeEdits` postdates §137, and the
  // write-back above spreads it through untouched. The applied count is a
  // plain subtraction — unlike the per-word layers, `applyCaptionRangeEdits`
  // reports each entry at most once (its own doc comment), so the
  // `appliedCaptionEditCount` machinery is not needed.
  const ranges = applyCaptionRangeEdits(lines, doc.captionRangeEdits);
  const rewritten = doc.captionRangeEdits.length - ranges.dropped.length;
  if (rewritten > 0) log.push(`▸ ${rewritten} caption range(s) rewritten by the editor`);
  for (const d of ranges.dropped) log.push(captionRangeDropLine(d));
  // Hides AFTER retypes and range rewrites — `applyCaptionLayers`' one
  // authoritative order (a hide's `was` is the LIVE post-retype text),
  // composed manually here rather than through the composer because this
  // path's edits layer is the MIGRATED set, not `doc.captions` — the
  // composer takes a doc whole and would re-apply the unresolved legacy keys
  // the migration just set aside. No key migration for hides:
  // `captionWordsHidden` never had a positional-key era (`OverrideDocSchema`'s
  // own note), and the write-back above spreads it through untouched.
  const hides = applyCaptionWordHides(ranges.lines, doc.captionWordsHidden);
  for (const d of hides.dropped) log.push(captionHideDropLine(d));
  // LINE timing LAST — `applyCaptionLayers`' one authoritative order: nudges
  // move the seams between SURVIVING lines, so they run on the post-hide
  // lines. No key migration here either: `captionLineTiming` postdates §137,
  // and the write-back above spreads it through untouched.
  //
  // Counted with `appliedCaptionEditCount`, NOT by subtracting drops (§137's
  // lesson, re-learned in the 2026-08-19 review): `applyCaptionLineTiming`
  // pushes a `duplicate-anchor` drop per EXTRA line claiming the anchor
  // (overrides.ts), so one key with two claimants subtracted to `1 - 1 = 0`
  // and with three to `-1` — and the `> 0` gate below then erased the line
  // ENTIRELY for a nudge that had in fact applied to its first claimant. The
  // range layer's plain subtraction stays, because that layer reports each
  // entry at most once; this one does not.
  const timed = applyCaptionLineTiming(hides.lines, doc.captionLineTiming);
  const nudged = appliedCaptionEditCount(doc.captionLineTiming, timed.dropped);
  if (nudged > 0) log.push(`▸ ${nudged} caption timing nudge(s) applied`);
  for (const d of timed.dropped) log.push(captionTimingDropLine(d));
  // WINDOWS last of all — `applyCaptionLayers`' one authoritative order: an
  // absolute window is the user's final answer about when a caption is on
  // screen, so it runs after (and overrides) the nudge layer. Counted with
  // `appliedCaptionEditCount` for the same reason the nudges are: this layer
  // also reports a `duplicate-anchor` drop per EXTRA claimant, so a plain
  // subtraction would erase the line for a window that did apply. No key
  // migration: `captionLineWindows` postdates §137, and the write-back above
  // spreads it through untouched. Drops reuse `captionTimingDropLine` rather
  // than earning a fifth sentence: both records answer "when is this caption
  // on screen", both drop for the SAME two reasons (no line starts there any
  // more / a second claimant), and the fix — re-make it in the timing tool —
  // is one gesture, which is the test that function's docstring sets.
  const windowed = applyCaptionLineWindows(timed.lines, doc.captionLineWindows, map);
  const placed = appliedCaptionEditCount(doc.captionLineWindows, windowed.dropped);
  if (placed > 0) log.push(`▸ ${placed} caption window(s) placed by the editor`);
  for (const d of windowed.dropped) log.push(captionTimingDropLine(d));
  return { doc: migrated, lines: windowed.lines, reanchored: reanchored > 0, log };
}
