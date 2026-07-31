import { normalizeToken } from "./analyze";
import { isSentenceStart } from "./clip";
import type { Transcript } from "./schema";

/**
 * Blooper removal by SPOKEN MARKER (R27 §122).
 *
 * The ask is "drop the flubbed takes, not just the silences", and the general
 * form of that is semantic: a model reading the transcript deciding which
 * attempt was bad. The authoring roadmap flags exactly why that is expensive —
 * `buildCutlist` is today a pure function of (raw transcript, analysis,
 * duration, level), and a model in that path ends the guarantee that the same
 * input and `--cleanup` always produce the same edit.
 *
 * A marker the speaker says OUT LOUD is the deterministic subset. It needs no
 * judgement: the word is in the transcript or it is not. So this ships the
 * useful half of the feature and leaves the guarantee intact — the semantic
 * detector remains unbuilt, deliberately.
 *
 * The pattern, from the take that motivated it:
 *
 *     "That could be one of the cases where you can say"   flubbed attempt
 *     "blooper."                                            marker
 *     "That could be one of"                                flubbed again
 *     "blooper."                                            marker
 *     "That could be the exit condition."                   the good take
 *
 * The marker TERMINATES a bad attempt, so removal runs backwards from it to
 * the start of the sentence it spoiled, and consecutive marked attempts
 * collapse into one cut.
 */

/** A span of transcript to drop, in word indices (inclusive) and source seconds. */
export interface BloopSpan {
  startWord: number;
  endWord: number;
  startSec: number;
  endSec: number;
  /** How many marker words this span swallowed — 2+ means repeated attempts. */
  markers: number;
}

/**
 * Spans the speaker marked as bloopers.
 *
 * `marker` is matched with `normalizeToken`, the same normalizer the filler
 * detector uses, so case and trailing punctuation do not matter — ASR writes
 * the word as "blooper." with the period riding on it.
 *
 * Returns spans in transcript order, non-overlapping.
 */
export function findBloopSpans(transcript: Transcript, marker: string): BloopSpan[] {
  const want = normalizeToken(marker);
  if (!want) return [];
  const words = transcript.words;
  const isMarker = (i: number): boolean => normalizeToken(words[i]?.text ?? "") === want;

  const spans: BloopSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!isMarker(i)) continue;

    // Walk back over the attempt this marker spoiled, to the start of its
    // sentence. The marker's own text usually ENDS a sentence ("blooper."), so
    // the scan starts at the word before it.
    let start = i;
    while (start > 0 && !isSentenceStart(transcript, start)) start--;

    // Consecutive attempts: if everything between the previous span's end and
    // this attempt's start is already being dropped, merge rather than leave a
    // one-word island of a sentence nobody finished.
    const prev = spans[spans.length - 1];
    let markers = 1;
    if (prev && start <= prev.endWord + 1) {
      spans.pop();
      start = prev.startWord;
      markers = prev.markers + 1;
    }

    spans.push({
      startWord: start,
      endWord: i,
      startSec: words[start]!.start,
      endSec: words[i]!.end,
      markers,
    });
  }
  return spans;
}

/**
 * A one-line account per span, for `report.txt`. The cut report justifies every
 * other removal; a cut this aggressive — whole sentences, not dead air — owes
 * the user the words it took.
 */
export function formatBloopSpan(transcript: Transcript, span: BloopSpan): string {
  const said = transcript.words
    .slice(span.startWord, span.endWord + 1)
    .map((w) => w.text)
    .join(" ");
  const attempts = span.markers > 1 ? ` (${span.markers} attempts)` : "";
  return `"${said}"${attempts}`;
}
