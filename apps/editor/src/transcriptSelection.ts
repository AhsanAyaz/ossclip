import {
  captionAnchorOf,
  type CaptionRangeEdit,
  type CaptionWord,
} from "@ossclip/core/browser";

/**
 * "Apply to all" candidate search for the transcript's range editor
 * (2026-08-18). Pure — no DOM, no doc — so the window sweep and its four
 * exclusion rules are testable without mounting the panel. The panel calls
 * this with its own flattened word list; the shape below is that flatten's
 * entry, restated here so the module compiles standalone.
 */
export interface FlatWord {
  /** The panel's positional scroll/testid handle — never an edit anchor. */
  index: number;
  /** The pristine pre-edit text at this word's anchor (live fallback for
   * anchorless legacy words and minted synthetics — the panel's rule). */
  base: string;
  /** The merged text on screen, edits included. */
  live: string;
  /** Minted by a range rewrite — its srcStart is interpolated, not measured. */
  synthetic: boolean;
  /** The live word itself, so anchors key on SOURCE time (§137). */
  word: CaptionWord;
}

/** One re-keyable repetition of the selection's live text elsewhere in the
 * transcript. `fromSrcStart`/`toSrcStart` are the window ENDPOINTS' source
 * starts (§137 — the `patchCaptionRange` anchor contract); `was` is the
 * NFC-joined BASE run, never the live join — the reducer scrubs per-word
 * retypes inside each interval in the same commit, so the run the apply-time
 * whole-run guard reads IS the base run (the `captionEditWas` base-truth
 * rule; a live `was` carrying a retype would stale the entry forever). */
export interface Occurrence {
  fromSrcStart: number;
  toSrcStart: number;
  was: string;
  /** The same base run UN-normalized, for the SINGLE-word route only: that
   * one commits per-word entries, and `applyCaptionEdits` compares its `was`
   * to the caption word RAW (`w.text !== edit.was`) where
   * `applyCaptionRangeEdits` normalizes both sides. A decomposed-Arabic word
   * given an NFC `was` matches nothing and the retype can never apply
   * (2026-08-19 review). */
  rawWas: string;
}

/**
 * Find every OTHER place the selection's live text occurs, as re-keyable
 * word windows. A window of the selection's word COUNT slides over the flat
 * list; it matches when its NFC-joined live text equals the selection's
 * (NFC on both sides — the search box's composed/decomposed trap: آ and
 * ا+madda are one glyph but different bytes).
 *
 * Excluded windows — each one is a commit that could not honestly apply:
 *  - overlapping the selection itself (the selection is committed
 *    separately, under its own captured `was`);
 *  - containing an anchorless word (§137 — no source anchor, no key; the
 *    same refusal every caption gesture makes at the gesture);
 *  - containing a word covered by a LIVE range entry (minted anchors exist
 *    only while their entry does — re-keying under a new pair loses BOTH
 *    rewrites, the `openRangeEdit` covered-expansion lesson);
 *  - for a SINGLE-word selection, a candidate sharing the selection's own
 *    anchor (`backfillSrcStart` MANUFACTURES shared source instants,
 *    captions.ts:44-50 — two spans, one key, and the "occurrence" would
 *    just re-write the selection's own entry);
 *  - overlapping an ALREADY-ACCEPTED occurrence: the sweep is greedy and
 *    advances past each match, because two overlapping entries appended in
 *    one bulk commit would trip the reducer's overlap scrub — the second
 *    entry silently deleting the first inside the same gesture.
 */
export function findOccurrences(
  words: readonly FlatWord[],
  selLo: number,
  selHi: number,
  coveringRangeEntry: (w: CaptionWord) => CaptionRangeEdit | undefined,
): Occurrence[] {
  const count = selHi - selLo + 1;
  if (count <= 0 || selLo < 0 || selHi >= words.length) return [];
  const joinLive = (run: readonly FlatWord[]): string =>
    run
      .map((w) => w.live)
      .join(" ")
      .normalize("NFC");
  const selection = words.slice(selLo, selHi + 1);
  const target = joinLive(selection);
  const selectionAnchor = count === 1 ? captionAnchorOf(selection[0]!.word) : null;

  const out: Occurrence[] = [];
  for (let i = 0; i + count <= words.length; ) {
    // Overlaps the selection — skip past it wholesale rather than word by
    // word; every start inside [selLo - count + 1, selHi] overlaps.
    if (i > selLo - count && i <= selHi) {
      i = selHi + 1;
      continue;
    }
    const window = words.slice(i, i + count);
    const usable = window.every(
      (w) => captionAnchorOf(w.word) !== null && coveringRangeEntry(w.word) === undefined,
    );
    const sameWord =
      selectionAnchor !== null && captionAnchorOf(window[0]!.word) === selectionAnchor;
    if (usable && !sameWord && joinLive(window) === target) {
      out.push({
        fromSrcStart: window[0]!.word.srcStart,
        toSrcStart: window[count - 1]!.word.srcStart,
        // The BASE join — see `Occurrence.was` above.
        was: window
          .map((w) => w.base)
          .join(" ")
          .normalize("NFC"),
        rawWas: window.map((w) => w.base).join(" "),
      });
      // Greedy: never offer two windows claiming the same word (see the
      // exclusion list above).
      i += count;
      continue;
    }
    i++;
  }
  return out;
}
