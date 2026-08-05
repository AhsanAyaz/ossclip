import { normalizeToken } from "./analyze";
import { isSentenceStart } from "./clip";
import { levenshtein } from "./phonetics";
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
  /** The marker text this span was searched for, normalized — for the report line. */
  marker: string;
  /**
   * Surface forms in this span that matched by sound-alike or edit distance,
   * not exact text — e.g. ASR wrote "looker" for a "blooper" marker. Every
   * fuzzy hit must land here: it is what makes fuzzy matching safe to ship
   * on by default, since a false positive shows up in report.txt instead of
   * silently cutting a good take (Task 3, editor-dogfood-fixes plan).
   */
  matched: string[];
}

// Fuzzy matching only turns on once the marker is long enough that a false
// positive is unlikely — a short marker like "cut" sound-alikes ("cat") and
// sits within edit distance 2 of half the dictionary ("but", "gut", "cot"),
// so short markers stay exact-only (Task 3, editor-dogfood-fixes plan).
const FUZZY_MIN_MARKER_LEN = 6;
// "blooper" → "looker" is exactly this: 2 edits (drop the "b", substitute
// "p" for "k"). Found in the wild — see the guard test in blooper.test.ts.
const FUZZY_MAX_DISTANCE = 2;

interface MarkerMatch {
  /** Normalized text of the transcript word that matched. */
  surface: string;
  /** False when this needed sound-alike/edit-distance rather than an exact hit. */
  exact: boolean;
}

/**
 * Whether a transcript word counts as the marker, and how.
 *
 * Exact match (today's rule) always wins first. Past that, the only fuzzy
 * arm is a small edit distance — NOT `soundsSimilar` (§125,
 * PHASE1-FINDINGS.md). The first field run of this feature paired the two
 * arms as designed and got the worst of both: `soundsSimilar("builds",
 * "blooper")` is true (shared "b" onset, score over its 0.34 floor) and cut
 * 86.8% of a 125.9s video, while the pair `soundsSimilar` exists to catch —
 * "looker" for "blooper" — is REJECTED by its own onset test (b/l differ)
 * and only ever matched via Levenshtein anyway. Sound-alike was admitting
 * garbage and catching nothing real, so it is gone; Levenshtein alone still
 * catches "looker" (distance 2) and does not catch "builds" (distance 6).
 */
function matchMarker(wordText: string, want: string): MarkerMatch | null {
  const norm = normalizeToken(wordText);
  if (!norm) return null;
  if (norm === want) return { surface: norm, exact: true };
  if (want.length < FUZZY_MIN_MARKER_LEN) return null;
  if (levenshtein(norm, want) <= FUZZY_MAX_DISTANCE) {
    return { surface: norm, exact: false };
  }
  return null;
}

/**
 * Spans the speaker marked as bloopers.
 *
 * `marker` is matched with `normalizeToken`, the same normalizer the filler
 * detector uses, so case and trailing punctuation do not matter — ASR writes
 * the word as "blooper." with the period riding on it. Beyond exact text, a
 * marker of at least `FUZZY_MIN_MARKER_LEN` characters also matches an ASR
 * mishearing — see `matchMarker`.
 *
 * Returns spans in transcript order, non-overlapping.
 */
export function findBloopSpans(transcript: Transcript, marker: string): BloopSpan[] {
  const want = normalizeToken(marker);
  if (!want) return [];
  const words = transcript.words;
  const matchAt = (i: number): MarkerMatch | null => {
    const w = words[i];
    return w ? matchMarker(w.text, want) : null;
  };

  const spans: BloopSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const match = matchAt(i);
    if (!match) continue;

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
    let matched = match.exact ? [] : [match.surface];
    if (prev && start <= prev.endWord + 1) {
      spans.pop();
      start = prev.startWord;
      markers = prev.markers + 1;
      matched = [...prev.matched, ...matched];
    }

    spans.push({
      startWord: start,
      endWord: i,
      startSec: words[start]!.start,
      endSec: words[i]!.end,
      markers,
      marker: want,
      matched,
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
  // A fuzzy hit must never be silent — this line is the safety net that
  // makes on-by-default fuzzy matching acceptable (Task 3, editor-dogfood-fixes
  // plan): a false positive shows up here instead of quietly cutting a good
  // take.
  const fuzzy =
    span.matched.length > 0
      ? " " + span.matched.map((m) => `matched "${m}" ~ "${span.marker}"`).join(", ")
      : "";
  return `"${said}"${attempts}${fuzzy}`;
}
