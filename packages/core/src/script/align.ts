/**
 * Anchoring script cues to the words as spoken (explainer design §1.2).
 *
 * The anti-goal this module answers to: a cue placed on the wrong words is
 * worse than a cue not placed, because the scene then states one line while
 * the speaker says another. So an uncertain match is SKIPPED and reported with
 * its best score, never placed at the least-bad span.
 *
 * PURE, with no node built-ins: `ScriptCue` is imported as a type only
 * (cues.ts uses `node:crypto` for ids), and `normalizeAlignToken` comes from
 * restamp.ts, which is browser-safe on purpose (its header).
 */
import { normalizeAlignToken } from "../restamp";
import type { Transcript } from "../schema";
import type { ScriptCue } from "./cues";

/** Below this share of a cue's tokens found in order, the cue is skipped (§1.2). */
export const ALIGN_FLOOR = 0.6;
/** A candidate span may hold at most this many kept words per script token (§1.2). */
export const ALIGN_SPAN_FACTOR = 2;

export interface AlignedCue {
  cue: ScriptCue;
  /** Index into the FULL `transcript.words` of the first matched word. */
  startWord: number;
  /** Index into the FULL `transcript.words` of the last matched word. */
  endWord: number;
  /** Script tokens matched in order ÷ script tokens, in [ALIGN_FLOOR, 1]. */
  score: number;
}

export interface SkippedCue {
  cue: ScriptCue;
  reason: "no-spoken-lines" | "screen" | "below-floor";
  /** The best score found, for `below-floor` only — the report prints it. */
  score?: number;
}

/**
 * A cue's spoken text as alignment tokens: the same normaliser restamp.ts and
 * analyze.ts use for whisper's words, so "AI." in the script and " AI" in the
 * transcript compare equal. Tokens that normalise to nothing (`→`, `…`) are
 * dropped on both sides; they were never spoken.
 */
function scriptTokens(spoken: readonly string[]): string[] {
  return spoken
    .join(" ")
    .split(/\s+/)
    .map(normalizeAlignToken)
    .filter((tok) => tok.length > 0);
}

/**
 * Longest in-order match between the script tokens and `window` — "script
 * tokens found in order within the candidate span" (§1.2). An LCS rather than
 * a single two-pointer walk: a walk that waits for the script's next token
 * scores a line whose FIRST word was dropped while recording at zero, and one
 * that skips ahead can spend a common word ("the") on a far-off script token
 * and miss the rest. Spans are at most 2n words, so the n×2n table is tiny.
 */
function inOrderMatches(script: readonly string[], window: readonly string[]): number {
  let row = new Array<number>(script.length + 1).fill(0);
  for (const tok of window) row = extendRow(row, script, tok);
  return row[script.length]!;
}

/** One more window word appended to an LCS row (`row[j]` = LCS of script[0..j) and the window so far). */
function extendRow(row: readonly number[], script: readonly string[], tok: string): number[] {
  const next = new Array<number>(script.length + 1).fill(0);
  for (let j = 0; j < script.length; j++) {
    next[j + 1] = script[j] === tok ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!);
  }
  return next;
}

/**
 * Place each cue on the words that say it, in script order.
 *
 * Only words NOT in `cut` are candidates (§1.2): a line flubbed in a blooper
 * and said again must anchor to the take that survives, or the scene would
 * point at footage that is not in the video. Indices returned are still into
 * the full `transcript.words`, because that is what `Moment.startWord` and the
 * cutlist index (`ProductionSchema.transcript`'s doctrine).
 *
 * Cues cannot cross: each search begins after the previous PLACED cue's
 * `endWord`. A skipped cue does not move the search position — its best span
 * was not trusted, so it must not fence off words the next cue may need.
 *
 * Scoring: every window of consecutive kept words, starting at each candidate,
 * of length up to `ALIGN_SPAN_FACTOR × n`. Highest score wins; ties go to the
 * earliest start (a repeated phrase resolves to its first occurrence after the
 * previous cue), then the shortest window. The chosen window may begin on
 * unmatched words — an earlier start that still contains the match wins the
 * tie — so the reported span is tightened to the matched words: `endWord` is
 * the window's last word (a shortest window always ends on a match) and
 * `startWord` is the latest kept word from which the same score is still
 * reached, which is the first matched word of the tightest such alignment.
 */
export function alignCues(
  cues: readonly ScriptCue[],
  transcript: Transcript,
  cut?: ReadonlySet<number>,
): { aligned: AlignedCue[]; skipped: SkippedCue[] } {
  const aligned: AlignedCue[] = [];
  const skipped: SkippedCue[] = [];

  // Kept, non-empty words, with their full-transcript index. Positions in
  // this list are what windows are measured in.
  const kept: Array<{ index: number; tok: string }> = [];
  transcript.words.forEach((w, index) => {
    if (cut?.has(index)) return;
    const tok = normalizeAlignToken(w.text);
    if (tok) kept.push({ index, tok });
  });

  let lastEndWord = -1;
  for (const cue of cues) {
    // A `screen:` cue is reported, never built (NG2), so it must not take
    // words from the cues around it either.
    if (cue.hint.kind === "screen") {
      skipped.push({ cue, reason: "screen" });
      continue;
    }
    const script = scriptTokens(cue.spoken);
    // Spoken lines that normalise to nothing give no tokens to score against;
    // to the report that is the same as having no spoken line.
    if (script.length === 0) {
      skipped.push({ cue, reason: "no-spoken-lines" });
      continue;
    }

    const n = script.length;
    const maxSpan = ALIGN_SPAN_FACTOR * n;
    let from = 0;
    while (from < kept.length && kept[from]!.index <= lastEndWord) from++;

    let best = 0;
    let bestStart = -1;
    let bestEnd = -1;
    for (let s = from; s < kept.length && best < n; s++) {
      let row = new Array<number>(n + 1).fill(0);
      const stop = Math.min(kept.length, s + maxSpan);
      for (let e = s; e < stop; e++) {
        row = extendRow(row, script, kept[e]!.tok);
        // Strictly greater: an equal score at a later start or a longer
        // window never displaces the earlier, shorter one.
        if (row[n]! > best) {
          best = row[n]!;
          bestStart = s;
          bestEnd = e;
        }
      }
    }

    const score = best / n;
    if (score < ALIGN_FLOOR) {
      skipped.push({ cue, reason: "below-floor", score });
      continue;
    }

    const toks = (a: number, b: number): string[] => kept.slice(a, b + 1).map((k) => k.tok);
    let first = bestStart;
    while (first < bestEnd && inOrderMatches(script, toks(first + 1, bestEnd)) === best) first++;

    aligned.push({ cue, startWord: kept[first]!.index, endWord: kept[bestEnd]!.index, score });
    lastEndWord = kept[bestEnd]!.index;
  }
  return { aligned, skipped };
}
