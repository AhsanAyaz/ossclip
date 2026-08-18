import { captionAnchorOf, type CaptionWord, type OverrideDoc } from "@ossclip/core/browser";

/**
 * The two things "delete these words" can mean — the same duality as
 * `deleteScene.ts`'s `DeleteTarget`, on the transcript axis (§59b revisited
 * 2026-08-18):
 *
 * - `caption` → `hideCaptionWords`: the words leave the rendered captions
 *   NOW (the hide layer previews instantly) but stay in the transcript and
 *   the audio. Restorable from the transcript itself.
 * - `caption-video` → `cutWords`: the hides above PLUS a `doc.cuts` entry
 *   removing the words' time range from the output on the next
 *   produce/Render — the live preview deliberately never applies `doc.cuts`
 *   (App.tsx's `live` memo has the why), so the modal copy must say "next
 *   Render".
 */
export type DeleteWordsTarget = "caption" | "caption-video";

export interface DeleteWordsPlan {
  /** The range `cutWords` removes — OUTPUT seconds of the current
   * render-props frame, exactly like a `cutChunk` window. */
  startSec: number;
  endSec: number;
  /** The anchorable selection words, LIVE (post-retype) text as `was` — the
   * same contract `hideCaptionWords` documents. */
  words: Array<{ srcStart: number; was: string }>;
  /** Offered in this order; `[0]` is the preselected default. `caption`
   * leads wherever it is offered because it is the recoverable one — the
   * same rationale as `deletePlanFor`'s graphic-first default. */
  targets: DeleteWordsTarget[];
}

/**
 * Which deletes are on the table for the current transcript selection — pure,
 * so the modal's contents are testable without a DOM (the `deletePlanFor`
 * precedent).
 *
 * Returns `null` when NOTHING is deletable, which is the signal not to open
 * the modal at all — `deletePlanFor`'s own rule.
 *
 * `selection` is the selected words in spoken order (TranscriptPanel's flat
 * range); `prevEnd` is the OUTPUT end of the flat word immediately BEFORE the
 * selection, or null when the selection starts the transcript. `synthetic`
 * marks a word MINTED by a count-changed range rewrite (the panel already
 * derives it for styling: no base word carries the anchor).
 */
export function deleteWordsPlanFor(
  selection: ReadonlyArray<{ word: CaptionWord; live: string; synthetic: boolean }>,
  prevEnd: number | null,
  doc: OverrideDoc,
): DeleteWordsPlan | null {
  // Only anchorable words can carry a hide key (§137) — the same
  // `captionAnchorOf` verdict every other caption surface keys on.
  const anchorable = selection.filter((s) => captionAnchorOf(s.word) !== null);
  if (anchorable.length === 0) return null;

  const first = selection[0]!.word;
  const last = selection[selection.length - 1]!.word;
  // Raw ASR word starts can be smeared FAR early by whisper's stamp-stretch
  // (transcribe.ts:150-155 bleeds each end into the next start — the §18
  // field case put a word on screen 21 seconds early), so the word's
  // display-clamped `start` (MAX_CAPTION_WORD_LEAD_SEC, captions.ts:147,169)
  // is the SAFE cut edge; ends are the trustworthy stamps
  // (captions.ts:137-146). Clamping to the PREVIOUS word's end on top of
  // that guarantees the cut never eats a kept word, whatever the stamps say.
  const startSec = Math.max(first.start, prevEnd ?? 0);
  const endSec = last.end;
  // Overlapping stamps can invert the window entirely — a zero/negative cut
  // is not a decision anyone made.
  if (endSec <= startSec) return null;

  const targets: DeleteWordsTarget[] = [];
  // A selection that is ALREADY entirely hidden has no caption left to
  // remove — offering it would be a confirm dialog for a no-op (the
  // `deletePlanFor` already-a-ghost rule).
  const allHidden = selection.every((s) => {
    const anchor = captionAnchorOf(s.word);
    return anchor !== null && anchor in doc.captionWordsHidden;
  });
  if (!allHidden) targets.push("caption");
  // Mirrors `cutChunk`'s own predicate in useEdits.ts (via `deletePlanFor`):
  // only a SRC-LESS entry at this exact window means "the user already cut
  // this" — a src-anchored entry sharing the window is produce's resolved
  // anchor for a DIFFERENT decision and must not suppress the offer.
  const alreadyCut = doc.cuts.some(
    (c) => c.src === undefined && c.startSec === startSec && c.endSec === endSec,
  );
  // NEVER cut video through a MINTED word: its stamps are interpolations
  // (`retimeCaptionTokens` spreads them across the rewritten run's window),
  // not measured ASR boundaries — so the "ends are the trustworthy stamps"
  // premise the window derivation above rests on does not hold, and the cut
  // would remove an arbitrary slice of real audio nobody decided to lose.
  // The caption-only hide stays on the table: it never touches time.
  const anySynthetic = selection.some((s) => s.synthetic);
  if (!alreadyCut && !anySynthetic) targets.push("caption-video");
  if (targets.length === 0) return null;

  return {
    startSec,
    endSec,
    words: anchorable.map((s) => ({ srcStart: s.word.srcStart, was: s.live })),
    targets,
  };
}
