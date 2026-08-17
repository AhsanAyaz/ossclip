import { normalizeToken } from "./analyze";
import { isSentenceStart } from "./clip";
import { levenshtein } from "./phonetics";
import type { Span, Transcript } from "./schema";

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
 * useful half of the feature and leaves the guarantee intact.
 *
 * The OTHER half — the flub the speaker did NOT mark — turned out to have a
 * deterministic formulation too: `retake.ts` (R27 §128) collapses consecutive
 * near-identical sentences by token similarity, no LLM, same purity
 * guarantee. What's left unbuilt is narrower than this comment used to claim:
 * a genuinely REWORDED retake (different words, same idea) is still semantic,
 * and stays out of scope on purpose (ROADMAP.md).
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
  /**
   * True when the sentence-start backscan hit MAX_WALKBACK_SEC before it
   * found punctuation — the span was cut short of a real sentence boundary
   * and the report must say so out loud (`formatBloopSpan`).
   */
  truncated?: boolean;
}

/**
 * How far past the marker word's STAMPED end a silence may start and still be
 * treated as the marker's own trailing dead air. Whisper's `-ml 1` stamps
 * stretch over pauses (§18, PHASE1-FINDINGS.md), so the stamped end of a
 * spoken marker routinely lands BEFORE its acoustic end — the 2026-08-16
 * incident: "blooper." stamped to end at 670.0 while the audio ran to ~670.4
 * (proven by the bracketing silences 668.09–669.3 and 670.4–671.68), so 0.4s
 * of audible "blooper" leaked into the output at ~10:02. Extending the cut
 * through any silence starting within this window swallows the acoustic tail
 * — and the debris sliver ("And", 670.0–670.4) whisper stamped between the
 * marker and the pause. 0.75s is deliberately wider than the observed 0.4s
 * stretch but well under the shortest gap a speaker leaves before a real
 * next take.
 */
const MAX_MARKER_BLEED_SEC = 0.75;

/**
 * Ceiling on the sentence-start backscan, in source seconds. An ASR stretch
 * with no terminal punctuation (rambling delivery, a non-English fine-tune,
 * a hallucinated run-on) lets the scan walk back through MINUTES of good
 * take from one spoken marker — the same failure shape as §133's 7.08s fuzzy
 * cut, unbounded. 30s is longer than any real single-sentence flub and short
 * enough that a capped cut is reviewable in the report.
 */
const MAX_WALKBACK_SEC = 30;

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
  // A plain English inflection of the marker is a REAL word the speaker can
  // say on purpose — "it removes the bloopers", describing the feature, sits
  // at distance 1 from a "blooper" marker and the fuzzy arm cut 7.08s of a
  // good announce take back to its sentence start (FINDINGS §133). Fuzzy
  // exists for ASR mishearings of the SPOKEN marker; an inflection is far
  // more likely content, so it stays exact-only, in both directions.
  if (isPluralPair(norm, want)) return null;
  if (levenshtein(norm, want) <= FUZZY_MAX_DISTANCE) {
    return { surface: norm, exact: false };
  }
  return null;
}

/** Whether one token is the plain s/es plural of the other. */
function isPluralPair(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === `${short}s` || long === `${short}es`;
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
 * `silences` (source seconds, `analysis.silences`' shape) lets a span's end
 * extend through the marker's own trailing dead air — the §18 stamp-stretch
 * bleed `MAX_MARKER_BLEED_SEC` documents. Omitting it reproduces the
 * stamped-end behavior exactly.
 *
 * Returns spans in transcript order, non-overlapping.
 */
export function findBloopSpans(
  transcript: Transcript,
  marker: string,
  silences?: readonly Span[],
): BloopSpan[] {
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
    // the scan starts at the word before it. Capped at MAX_WALKBACK_SEC of
    // source time (rationale on the constant); a capped span is flagged so
    // the report can shout about it.
    let start = i;
    let truncated = false;
    while (start > 0 && !isSentenceStart(transcript, start)) {
      if (words[i]!.end - words[start - 1]!.start > MAX_WALKBACK_SEC) {
        truncated = true;
        break;
      }
      start--;
    }

    // Extend the end through the marker's trailing dead air (2026-08-16
    // incident, see MAX_MARKER_BLEED_SEC): repeatedly absorb any silence that
    // starts within the bleed window and ends past the current end. The loop
    // re-scans because absorbing one silence can bring the next within reach
    // — the chained-silence shape.
    let endSec = words[i]!.end;
    if (silences && silences.length > 0) {
      let extended = true;
      while (extended) {
        extended = false;
        for (const s of silences) {
          if (s.start <= endSec + MAX_MARKER_BLEED_SEC && s.end > endSec) {
            endSec = s.end;
            extended = true;
          }
        }
      }
    }

    // Consecutive attempts: if everything between the previous span's end and
    // this attempt's start is already being dropped, merge rather than leave a
    // one-word island of a sentence nobody finished. The seconds arm exists
    // because the previous span's EXTENDED end can reach past word stamps the
    // index arm never sees — the incident's "And" debris sat between two
    // attempts that were not word-index adjacent once the first end grew.
    const prev = spans[spans.length - 1];
    let markers = 1;
    let matched = match.exact ? [] : [match.surface];
    if (prev && (start <= prev.endWord + 1 || words[start]!.start <= prev.endSec)) {
      spans.pop();
      start = prev.startWord;
      markers = prev.markers + 1;
      matched = [...prev.matched, ...matched];
      truncated = truncated || prev.truncated === true;
      // A merged span must never shrink: the previous extension already
      // proved that audio dead.
      endSec = Math.max(endSec, prev.endSec);
    }

    spans.push({
      startWord: start,
      endWord: i,
      startSec: words[start]!.start,
      endSec,
      markers,
      marker: want,
      matched,
      ...(truncated ? { truncated: true } : {}),
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
  // A capped walk-back is a cut whose start the code chose by fiat, not by
  // punctuation — the one case where the span boundary is a guess, so the
  // report line must be loud about it.
  const capped = span.truncated
    ? " (walk-back capped at 30s — unpunctuated stretch; check this cut)"
    : "";
  return `"${said}"${attempts}${fuzzy}${capped}`;
}
