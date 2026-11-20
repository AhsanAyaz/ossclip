/**
 * Retakes found with the script (FINDINGS §166; docs/designs/script-guided-retakes.md).
 *
 * A script run knows what the speaker meant to say, so two stretches that
 * both say the same script sentence are two takes of it, however reworded.
 * That catches the two EGM retakes no other rule could (§165): reworded, so
 * the similarity detector (§128) scores them under its bar, and no marker
 * was said (§122). The later take is kept, §128's convention (NG2).
 *
 * PURE: no I/O, no LLM (G5). Same input, same cut, so a `--scenes` replay
 * cuts what the reviewed run cut (G6). `ScriptCue`, `BloopSpan` and
 * `RetakeGroup` are imported as types only, the align.ts posture (cues.ts
 * uses `node:crypto` for ids).
 *
 * Every limit below was chosen on one recording (design, "How strong the
 * evidence is"). They are pinned on both sides in script-retakes.test.ts.
 */
import type { BloopSpan } from "../blooper";
import { isSentenceStart } from "../clip";
import { normalizeAlignToken } from "../restamp";
import type { RetakeGroup } from "../retake";
import type { Span, Transcript } from "../schema";
import { ALIGN_FLOOR, ALIGN_SPAN_FACTOR, extendRow, inOrderMatches, scriptTokens } from "./align";
import type { ScriptCue } from "./cues";

/**
 * A sentence shorter than this is not a unit, and an occurrence needs this
 * many matched tokens (design, Terms and §3): "Three steps." is said a dozen
 * ways in any recording and proves nothing about a take.
 */
export const SCRIPT_RETAKE_MIN_TOKENS = 4;
/**
 * An occurrence is dead air when this share of its words have their midpoint
 * inside a measured silence (design §3).
 */
export const SCRIPT_RETAKE_DEAD_AIR_WORDS = 0.5;
/** Two units scoring this against each other, either way, are both dropped (design §2). */
export const SCRIPT_RETAKE_TWIN = 0.6;
/**
 * An occurrence must contain this many distinct content tokens of its unit
 * (design §3): without it a match made of "so", "I", "was", "the" counts.
 */
export const SCRIPT_RETAKE_MIN_CONTENT = 2;
/** Letters a token needs to be a content token (design, Terms). */
export const SCRIPT_RETAKE_CONTENT_LEN = 4;
/**
 * The kept (later) take must score this (design §4). The EGM "So first of
 * all" take kept at 0.75: the margin is small, on purpose not tuned.
 */
export const SCRIPT_RETAKE_KEPT_FLOOR = 0.7;
/**
 * At most this many candidate words between two takes (design §4, NG4). The
 * cut runs A to B, so this is also the most unscripted speech one cut can
 * take with it (Decision 3).
 */
export const SCRIPT_RETAKE_MAX_GAP_WORDS = 25;
/**
 * A cut end moves back to its sentence start only within this many words
 * (design §5). The first draft walked back without a bound and could run
 * through an unpunctuated stretch ("What the reviews changed").
 */
export const SCRIPT_RETAKE_SNAP_WORDS = 3;
/** Confidence of these cuts in `buildCutlist`'s `retakes` (design §1). */
export const SCRIPT_RETAKE_CONFIDENCE = 0.8;

export interface ScriptUnit {
  text: string;
  tokens: string[];
}

// After `.`, `?` or `!` and any closing quote or bracket. `…` is not a
// sentence end here: in a script it marks a trailing-off inside a line.
const SENTENCE_BREAK = /(?<=[.?!]["'”’)\]]*)\s+/u;

/**
 * Sentences of the cues' spoken lines (split after . ? !), ≥ 4 tokens, twins
 * removed, script order.
 *
 * Each `🗣️` line is split on its own: a line without closing punctuation is
 * still one sentence, not glued onto the next line. `screen:` cues count
 * (design, Terms): what is said over a screen recording can be retaken too.
 *
 * Twins (design §2): "One flag for the theme." and "One flag for the AI."
 * are each said once on purpose, and each would register as a take of the
 * other. The score is the unit's tokens found in order in the other unit's
 * tokens over its own count; either direction at 0.6 drops both. Identical
 * sentences repeated in the script score 1.0 and are dropped the same way.
 */
export function scriptUnits(cues: readonly ScriptCue[]): ScriptUnit[] {
  const all: ScriptUnit[] = [];
  for (const cue of cues) {
    for (const line of cue.spoken) {
      for (const raw of line.split(SENTENCE_BREAK)) {
        const text = raw.trim();
        if (!text) continue;
        const tokens = scriptTokens([text]);
        if (tokens.length >= SCRIPT_RETAKE_MIN_TOKENS) all.push({ text, tokens });
      }
    }
  }
  const twin = new Array<boolean>(all.length).fill(false);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!.tokens;
      const b = all[j]!.tokens;
      const lcs = inOrderMatches(a, b);
      if (lcs / a.length >= SCRIPT_RETAKE_TWIN || lcs / b.length >= SCRIPT_RETAKE_TWIN) {
        twin[i] = true;
        twin[j] = true;
      }
    }
  }
  return all.filter((_, i) => !twin[i]);
}

export interface ScriptRetake {
  /** The unit's text, for the report: script line numbers for spoken lines do not exist. */
  unit: string;
  /** Inclusive word indices into the full `transcript.words`, and their source seconds. */
  cut: { startWord: number; endWord: number; startSec: number; endSec: number };
  /** The later take's matched span. */
  kept: { startWord: number; endWord: number };
  /** Candidate words between the takes. */
  wordsBetween: number;
}

/**
 * Word indices no occurrence may use: every bloop span word, every word of
 * every member of every retake group (kept, cuts, undecided, hallucinated).
 *
 * Whatever a group decided (design §3): what §128 declined to cut, it
 * declined for a reason recorded in its audit history (a clause boundary, a
 * hallucination over dead air), and a second detector must not overrule it.
 */
export function scriptRetakeExcluded(
  bloops: readonly BloopSpan[],
  groups: readonly RetakeGroup[],
): Set<number> {
  const out = new Set<number>();
  const add = (span: { startWord: number; endWord: number }): void => {
    for (let i = span.startWord; i <= span.endWord; i++) out.add(i);
  };
  for (const b of bloops) add(b);
  for (const g of groups) {
    if (g.kept) add(g.kept);
    for (const m of [...g.cuts, ...g.undecided, ...g.hallucinated]) add(m);
  }
  return out;
}

/** One stretch saying a unit, in CANDIDATE positions (inclusive). */
interface Occurrence {
  unit: number;
  s: number;
  e: number;
  /** Unit tokens matched in order. */
  m: number;
  score: number;
}

const letters = (tok: string): number => tok.match(/\p{L}/gu)?.length ?? 0;

/**
 * The occurrences of one unit among the candidates (design §3), ascending.
 *
 * A window is recorded where it starts and ends on a matched word: the match
 * count rises at its last word, and dropping its first word loses a match.
 * Every window from each start is scored once (an LCS row per word, align.ts's
 * helper), and the row maxima are kept so the "dropping its first word" test
 * reads the next start's table instead of re-running the LCS. A start whose
 * token is not in the unit can never be tight, so it is never scored.
 *
 * Overlaps: density first (matched tokens per window word), then score, then
 * earlier start. On score alone, one window spanning two adjacent takes holds
 * every token and hides the pair; the prototype showed it ("So first off").
 */
function occurrencesOf(
  unitIndex: number,
  unit: ScriptUnit,
  cand: ReadonlyArray<{ index: number; tok: string }>,
  transcript: Transcript,
  silences: readonly Span[],
): Occurrence[] {
  const n = unit.tokens.length;
  const maxSpan = ALIGN_SPAN_FACTOR * n;
  const inUnit = new Set(unit.tokens);
  const content = new Set(unit.tokens.filter((tok) => letters(tok) >= SCRIPT_RETAKE_CONTENT_LEN));

  // scores(s)[k] = in-order matches of window [s, s + k].
  const memo = new Map<number, number[]>();
  const scores = (s: number): number[] => {
    let got = memo.get(s);
    if (got) return got;
    got = [];
    let row = new Array<number>(n + 1).fill(0);
    const stop = Math.min(cand.length, s + maxSpan);
    for (let e = s; e < stop; e++) {
      row = extendRow(row, unit.tokens, cand[e]!.tok);
      got.push(row[n]!);
    }
    memo.set(s, got);
    return got;
  };

  const windows: Occurrence[] = [];
  for (let s = 0; s < cand.length; s++) {
    if (!inUnit.has(cand[s]!.tok)) continue;
    const here = scores(s);
    for (let k = 0; k < here.length; k++) {
      const m = here[k]!;
      if (m <= (k > 0 ? here[k - 1]! : 0)) continue;
      const e = s + k;
      const withoutFirst = k > 0 ? scores(s + 1)[k - 1]! : 0;
      if (withoutFirst >= m) continue;
      const score = m / n;
      if (score < ALIGN_FLOOR || m < SCRIPT_RETAKE_MIN_TOKENS) continue;
      const seen = new Set<string>();
      for (let i = s; i <= e; i++) if (content.has(cand[i]!.tok)) seen.add(cand[i]!.tok);
      if (seen.size < SCRIPT_RETAKE_MIN_CONTENT) continue;
      // A line whisper repeated over dead air must not become the kept take
      // (design §3). Counted in WORDS, not as a share of the span: the span
      // measure of retake.ts dropped both real takes of "The elephant [7 s
      // pause] never forgets." on the EGM recording (§166), because a
      // speaker who stops mid-line leaves a span that is mostly silence. A
      // hallucinated line has its words stamped inside the silence; a real
      // one has them around it.
      let inSilence = 0;
      for (let i = s; i <= e; i++) {
        const w = transcript.words[cand[i]!.index]!;
        const mid = (w.start + w.end) / 2;
        if (silences.some((sil) => sil.start <= mid && mid < sil.end)) inSilence++;
      }
      if (inSilence / (e - s + 1) >= SCRIPT_RETAKE_DEAD_AIR_WORDS) continue;
      windows.push({ unit: unitIndex, s, e, m, score });
    }
  }

  const density = (w: Occurrence): number => w.m / (w.e - w.s + 1);
  windows.sort((a, b) => density(b) - density(a) || b.score - a.score || a.s - b.s);
  const taken: Occurrence[] = [];
  for (const w of windows) {
    if (taken.some((t) => w.s <= t.e && t.s <= w.e)) continue;
    taken.push(w);
  }
  return taken.sort((a, b) => a.s - b.s);
}

/**
 * The nearest sentence start at or before `i`, if it is at most
 * SCRIPT_RETAKE_SNAP_WORDS back; else `i` (design §5). So "Now, the
 * elephant…" is cut from "Now", and a later take opening "And the
 * elephant…" keeps its "And".
 */
function snapBack(transcript: Transcript, i: number): number {
  for (let j = i; j >= Math.max(0, i - SCRIPT_RETAKE_SNAP_WORDS); j--) {
    if (isSentenceStart(transcript, j)) return j;
  }
  return i;
}

/**
 * The earlier take of every unit said twice in a row, ascending by
 * `cut.startWord`. All word indices are into the full `transcript.words`.
 *
 * `transcript` is the RAW transcript, as the marker and similarity passes
 * read it (design §1); `excluded` is `scriptRetakeExcluded` of their results.
 * Candidate words are those not excluded whose token is non-empty; windows
 * and the 25-word gap are measured in candidate positions.
 *
 * For consecutive occurrences A, B of one unit (design §4): B scores at
 * least SCRIPT_RETAKE_KEPT_FLOOR and at least A (a restart that trails off
 * never replaces a fuller take); at most SCRIPT_RETAKE_MAX_GAP_WORDS
 * candidates lie between; and every occurrence of another unit wholly
 * between them occurs again at or after B's start. That last rule is G3: a
 * sentence said once between two takes is the speaker moving on, and
 * cutting A to B would take it out of the video.
 *
 * The cut runs from A's first word to the word before B's first word, each
 * end snapped (design §5), so the earlier take's unscripted tail goes with
 * it (G2, Decision 3) and nothing past B's start is touched.
 */
export function findScriptRetakes(
  cues: readonly ScriptCue[],
  transcript: Transcript,
  silences: readonly Span[],
  excluded: ReadonlySet<number>,
): ScriptRetake[] {
  const units = scriptUnits(cues);
  if (units.length === 0) return [];

  const cand: Array<{ index: number; tok: string }> = [];
  transcript.words.forEach((w, index) => {
    if (excluded.has(index)) return;
    const tok = normalizeAlignToken(w.text);
    if (tok) cand.push({ index, tok });
  });

  const occ = units.map((u, i) => occurrencesOf(i, u, cand, transcript, silences));
  const all = occ.flat();
  const words = transcript.words;
  const out: ScriptRetake[] = [];

  occ.forEach((list, u) => {
    for (let k = 0; k + 1 < list.length; k++) {
      const a = list[k]!;
      const b = list[k + 1]!;
      if (b.score < SCRIPT_RETAKE_KEPT_FLOOR || b.score < a.score) continue;
      const wordsBetween = b.s - a.e - 1;
      if (wordsBetween > SCRIPT_RETAKE_MAX_GAP_WORDS) continue;
      const blocked = all.some(
        (o) =>
          o.unit !== u &&
          o.s > a.e &&
          o.e < b.s &&
          !occ[o.unit]!.some((again) => again.s >= b.s),
      );
      if (blocked) continue;

      const startWord = snapBack(transcript, cand[a.s]!.index);
      const endWord = snapBack(transcript, cand[b.s]!.index) - 1;
      if (endWord < startWord) continue;
      out.push({
        unit: units[u]!.text,
        cut: { startWord, endWord, startSec: words[startWord]!.start, endSec: words[endWord]!.end },
        kept: { startWord: cand[b.s]!.index, endWord: cand[b.e]!.index },
        wordsBetween,
      });
    }
  });
  return out.sort((x, y) => x.cut.startWord - y.cut.startWord);
}

/**
 * Two lines for `report.txt` (design §6, G4): the take kept, then the take
 * cut with the unit it was matched to. Nothing SAID these were retakes, so
 * the report owes the user both sets of words, as `formatRetakeGroup` does.
 */
export function formatScriptRetake(transcript: Transcript, r: ScriptRetake): string {
  const said = (a: number, b: number): string =>
    transcript.words
      .slice(a, b + 1)
      .map((w) => w.text)
      .join(" ");
  return (
    `kept: "${said(r.kept.startWord, r.kept.endWord)}"\n` +
    `  cut (said again ${r.wordsBetween} word${r.wordsBetween === 1 ? "" : "s"} later; script: "${r.unit}"): "${said(r.cut.startWord, r.cut.endWord)}"`
  );
}
