import type { AppliedCaptionEdits, CaptionEdit } from "@ossclip/core";

/**
 * What `produce` says about the caption edits it could not apply (§137).
 *
 * Pure, and in its own module rather than inline in `produce.ts`, for the
 * house reason: this is a decision about the user's data (which edits landed,
 * and why the others did not) and it should be testable without standing up a
 * production. `produce.ts` keeps the `console.log`.
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
 */
export function appliedCaptionEditCount(
  edits: Record<string, CaptionEdit>,
  dropped: AppliedCaptionEdits["dropped"],
): number {
  const failed = new Set(dropped.filter((d) => d.reason === undefined).map((d) => d.key));
  return Object.keys(edits).filter((key) => !failed.has(key)).length;
}
