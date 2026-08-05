import { normalizeToken } from "./analyze";
import { isSentenceEnd, isSentenceStart } from "./clip";
import { levenshtein } from "./phonetics";
import type { Analysis, Span, Transcript } from "./schema";

/**
 * Deterministic retake collapse (R27 §127) — the sibling of `findBloopSpans`
 * (§122) for the flub the speaker did NOT mark out loud. Consecutive
 * near-identical sentences in the raw transcript are a retake; keep the last
 * complete attempt, cut the rest. See PHASE1-FINDINGS.md §127 for the worked
 * examples and the guard rationale below.
 *
 * Deliberately NOT `soundsSimilar` (§125: `soundsSimilar("builds", "blooper")`
 * scored 0.500 on shared onset alone and cut 86.8% of a real video). A retake
 * pair needs to be *the same words*, not phonetically adjacent ones — token
 * equality here is exact-or-tiny-edit-distance on the ASR text itself, never
 * a sound-alike heuristic. Two independently recorded takes of one line are
 * also NOT guaranteed to differ by an edit distance of 1 or 2 at the phrase
 * level, which is why the comparison is a normalized SEQUENCE similarity
 * (edit distance over the token stream, not the letters) rather than a single
 * fuzzy-string threshold: it tolerates the fuzzy word or two `soundsSimilar`
 * chased, without opening the same phonetic false-positive channel.
 */

/** Sequence similarity floor for two attempts to count as the same line. */
export const RETAKE_SIM_THRESHOLD = 0.8;
/**
 * Below this many compared tokens, similarity is not evidence of a retake —
 * it's coincidence. "Yes. Yes. Yes." is deliberate emphasis, not three
 * attempts at one line, and at one token apiece it would otherwise clear
 * RETAKE_SIM_THRESHOLD trivially (identical single-token "sequences").
 */
export const RETAKE_MIN_TOKENS = 3;
/** A token must be at least this long before edit-distance fuzz applies. */
export const TOKEN_FUZZ_MIN_LEN = 5;
/** Max Levenshtein distance for two long tokens to still count equal. */
export const TOKEN_FUZZ_MAX_DIST = 1;
/**
 * Fraction of an instance's own span that must be covered by `analysis.silences`
 * before it is presumed a whisper hallucination rather than a real attempt —
 * the 2026-08-05 field failure: a real take early, then whisper repeating it
 * near-verbatim over dead air later. Read from `analysis.silences`, not
 * `cuttable`: `cuttable`'s transcript veto is exactly the thing that would
 * suppress the signal here (a "word" whisper invented over silence is the
 * conflict the veto exists to resolve the OTHER way), and it is defeated
 * outright in the `windowsDb: []` fallback path (`analyze.ts`) — `silences`
 * is measured straight from the audio and carries neither problem. Not
 * `LevelStats` either: it isn't persisted onto `Analysis`.
 */
export const HALLUCINATION_SILENCE_FRAC = 0.65;
/**
 * Two roles, one number, deliberately: (a) the minimum silence a mid-sentence
 * gap needs before it is treated as a candidate restart boundary — an
 * ordinary breath pause must not fragment one sentence into two "attempts";
 * (b) the max silenceFrac the KEPT survivor itself may carry (stricter than
 * the 0.65 hallucination bar — risk item 7 of the design). A last "complete"
 * instance that is this gappy is exactly as suspect as a fresh restart would
 * be at this boundary, so the same threshold gates both: not tuned twice.
 */
export const RESTART_SPLIT_MIN_SIL = 0.35;

/** A span of transcript, in word indices (inclusive) and source seconds. */
export interface RetakeInstance {
  startWord: number;
  endWord: number;
  startSec: number;
  endSec: number;
}

export interface RetakeCut extends RetakeInstance {
  /** Sequence similarity (0..1) to the kept instance — the audit trail. */
  similarity: number;
}

export interface RetakeHallucination extends RetakeInstance {
  /** Fraction of this span covered by `analysis.silences` — why it was spared. */
  silenceFrac: number;
}

/** One chain of matching attempts at the same line. */
export interface RetakeGroup {
  kept: RetakeInstance;
  cuts: RetakeCut[];
  hallucinated: RetakeHallucination[];
}

// ---- token comparison -------------------------------------------------

function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= TOKEN_FUZZ_MIN_LEN && b.length >= TOKEN_FUZZ_MIN_LEN) {
    return levenshtein(a, b) <= TOKEN_FUZZ_MAX_DIST;
  }
  return false;
}

/** Levenshtein distance over TOKENS (word equality, not letters). */
function tokenEditDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (tokensEqual(a[i - 1]!, b[j - 1]!) ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** Full-sequence similarity: two attempts presumed roughly the same length. */
function fullSimilarity(a: readonly string[], b: readonly string[]): number {
  const denom = Math.max(a.length, b.length);
  if (denom === 0) return 1;
  return 1 - tokenEditDistance(a, b) / denom;
}

/**
 * A partial's tokens against the same-length PREFIX of the other instance —
 * comparing a partial to the other's full length would count everything past
 * where the partial stopped as a mismatch, punishing an abandoned attempt for
 * not having said the rest of the sentence yet.
 */
function prefixSimilarity(shorter: readonly string[], longer: readonly string[]): number {
  const n = shorter.length;
  const truncated = longer.slice(0, n);
  const denom = Math.max(n, truncated.length);
  if (denom === 0) return 1;
  return 1 - tokenEditDistance(shorter, truncated) / denom;
}

// ---- segmentation -------------------------------------------------------

interface Instance {
  startWord: number;
  endWord: number;
  startSec: number;
  endSec: number;
  /** Normalized tokens, fillers and a lone `transparentMarker` word dropped. */
  tokens: string[];
  /** Ends at a real sentence-end, vs. a speculative silence sub-split. */
  complete: boolean;
  silenceFrac: number;
  hallucinated: boolean;
}

function silenceOverlap(silences: readonly Span[], start: number, end: number): number {
  let covered = 0;
  for (const s of silences) {
    const lo = Math.max(s.start, start);
    const hi = Math.min(s.end, end);
    if (hi > lo) covered += hi - lo;
  }
  return covered;
}

function silenceFraction(silences: readonly Span[], start: number, end: number): number {
  const dur = end - start;
  if (dur <= 0) return 0;
  return Math.min(1, silenceOverlap(silences, start, end) / dur);
}

/**
 * Punctuation sentences, sub-split at internal silence boundaries long enough
 * to be a candidate restart (RESTART_SPLIT_MIN_SIL) — the unpunctuated-partial
 * case: an abandoned attempt has no terminal punctuation of its own, so ASR
 * glues it onto whatever comes next until the NEXT real sentence-end. Only the
 * silence tells you where the restart actually happened. Over-splitting alone
 * can never create a cut: a fragment only ever matters once it MATCHES
 * something (`findRetakeGroups` below); a spurious split just sits there,
 * silently below RETAKE_MIN_TOKENS or simply unmatched.
 */
function buildInstances(
  transcript: Transcript,
  analysis: Pick<Analysis, "silences" | "fillers">,
  transparentMarker?: string,
): Instance[] {
  const words = transcript.words;
  if (words.length === 0) return [];
  const fillerIndices = new Set(analysis.fillers.map((f) => f.wordIndex));
  const marker = transparentMarker ? normalizeToken(transparentMarker) : undefined;

  const coarse: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 1; i < words.length; i++) {
    if (isSentenceStart(transcript, i)) {
      coarse.push({ start, end: i - 1 });
      start = i;
    }
  }
  coarse.push({ start, end: words.length - 1 });

  const toInstance = (s: number, e: number, complete: boolean): Instance => {
    const tokens: string[] = [];
    for (let i = s; i <= e; i++) {
      if (fillerIndices.has(i)) continue;
      const norm = normalizeToken(words[i]!.text);
      if (!norm) continue;
      if (marker && norm === marker) continue;
      tokens.push(norm);
    }
    const startSec = words[s]!.start;
    const endSec = words[e]!.end;
    const silenceFrac = silenceFraction(analysis.silences, startSec, endSec);
    return {
      startWord: s,
      endWord: e,
      startSec,
      endSec,
      tokens,
      complete,
      silenceFrac,
      hallucinated: silenceFrac >= HALLUCINATION_SILENCE_FRAC,
    };
  };

  const instances: Instance[] = [];
  for (const sent of coarse) {
    // A sentence that is ALREADY silence-dominated end-to-end is the
    // hallucination shape, not the restart shape: whisper sprinkles sparse
    // word stamps across dead air, which makes EVERY inter-word gap clear
    // RESTART_SPLIT_MIN_SIL. Sub-splitting on that basis would shred it into
    // one-or-two-token fragments, each too short to ever clear
    // RETAKE_MIN_TOKENS again — the hallucination becomes invisible to the
    // very guard built to catch it. So the restart split only runs on a
    // sentence whose OVERALL span isn't itself hallucination-shaped; a
    // hallucinated stretch is instead emitted whole, as one instance, and
    // caught by the ordinary per-instance hallucination check below.
    const wholeFrac = silenceFraction(analysis.silences, words[sent.start]!.start, words[sent.end]!.end);
    const splitAfter: number[] = [];
    if (wholeFrac < HALLUCINATION_SILENCE_FRAC) {
      for (let i = sent.start; i < sent.end; i++) {
        const gapDur = silenceOverlap(analysis.silences, words[i]!.end, words[i + 1]!.start);
        if (gapDur >= RESTART_SPLIT_MIN_SIL) splitAfter.push(i);
      }
    }
    let fragStart = sent.start;
    for (const at of splitAfter) {
      instances.push(toInstance(fragStart, at, false));
      fragStart = at + 1;
    }
    // The final fragment is only "complete" if the coarse block itself ended
    // at REAL sentence punctuation — a transcript (or clip window) that just
    // runs out of words mid-sentence is a trailing abandoned partial, not a
    // finished take, whatever fragment boundary it happens to land on.
    instances.push(toInstance(fragStart, sent.end, isSentenceEnd(transcript, sent.end)));
  }
  return instances;
}

// ---- matching -------------------------------------------------------------

/** Raw similarity, no threshold — used for the report once a group exists. */
function rawSimilarity(a: Instance, b: Instance): number {
  if (a.complete && b.complete) return fullSimilarity(a.tokens, b.tokens);
  const [shorter, longer] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  return prefixSimilarity(shorter.tokens, longer.tokens);
}

/** Similarity if it clears both the threshold and RETAKE_MIN_TOKENS, else null. */
function matchScore(a: Instance, b: Instance): number | null {
  const compareLen = Math.min(a.tokens.length, b.tokens.length);
  if (compareLen < RETAKE_MIN_TOKENS) return null;
  const sim = rawSimilarity(a, b);
  return sim >= RETAKE_SIM_THRESHOLD ? sim : null;
}

function toPublic(i: Instance): RetakeInstance {
  return { startWord: i.startWord, endWord: i.endWord, startSec: i.startSec, endSec: i.endSec };
}

/**
 * Kept = the LAST live complete instance whose own silenceFrac clears the
 * stricter RESTART_SPLIT_MIN_SIL survivor bar; falls back to the last
 * complete instance overall if none does (keep-last is a documented
 * convention, not a proof — PHASE1-FINDINGS.md §127's known limits). Every
 * other real instance in the chain — earlier completes, all partials — cuts.
 */
function buildGroup(chain: readonly Instance[], hallucinated: readonly Instance[]): RetakeGroup {
  const completes = chain.filter((i) => i.complete);
  const kept =
    [...completes].reverse().find((i) => i.silenceFrac <= RESTART_SPLIT_MIN_SIL) ??
    completes[completes.length - 1] ??
    chain[chain.length - 1]!;
  const cuts: RetakeCut[] = chain
    .filter((i) => i !== kept)
    .map((i) => ({ ...toPublic(i), similarity: rawSimilarity(i, kept) }));
  const hallu: RetakeHallucination[] = hallucinated.map((i) => ({
    ...toPublic(i),
    silenceFrac: i.silenceFrac,
  }));
  return { kept: toPublic(kept), cuts, hallucinated: hallu };
}

/**
 * Finds retake chains in the transcript. `analysis` is `Pick<Analysis,
 * "silences" | "fillers">` deliberately narrow — this runs on the RAW,
 * pre-repair transcript at both `produce.ts` call sites, same ordering
 * reason as `findBloopSpans` (§122): the repair pass reads a stray restart as
 * an oddity and would rewrite the very pattern this is looking for.
 *
 * Chaining rule: comparison is always against the last LIVE (non-hallucinated,
 * non-empty) real instance — call it the anchor. Anything that MATCHES the
 * anchor extends the same chain and becomes the new anchor (three-take and
 * beyond). Anything that does NOT match starts a fresh anchor, which is what
 * makes an unrelated sentence in between BLOCK a chain: the next candidate is
 * compared against the un-matching sentence, not the earlier attempt behind
 * it. Filler-only and marker-only instances (zero tokens after normalizing)
 * are skipped entirely — never compared, never become the anchor — so they
 * bridge a chain for free. A hallucinated instance is compared against the
 * anchor (so it can be recognized and reported) but never becomes the anchor
 * itself and never resets it: this is the field-case guard — the anchor
 * stays pinned to the real take, so a later hallucinated repeat can never be
 * elected "last" over it.
 */
export function findRetakeGroups(
  transcript: Transcript,
  analysis: Pick<Analysis, "silences" | "fillers">,
  opts: { transparentMarker?: string } = {},
): RetakeGroup[] {
  const instances = buildInstances(transcript, analysis, opts.transparentMarker);
  const groups: RetakeGroup[] = [];

  let anchor: Instance | null = null;
  let chain: Instance[] = [];
  let hallucinated: Instance[] = [];

  const finalize = (): void => {
    if (chain.length >= 2 || (chain.length >= 1 && hallucinated.length > 0)) {
      groups.push(buildGroup(chain, hallucinated));
    }
    chain = [];
    hallucinated = [];
  };

  for (const inst of instances) {
    if (inst.tokens.length === 0) continue; // filler-only / marker-only: transparent
    if (inst.hallucinated) {
      if (anchor && matchScore(anchor, inst) !== null) {
        if (chain.length === 0) chain.push(anchor);
        hallucinated.push(inst);
      }
      continue;
    }
    if (anchor && matchScore(anchor, inst) !== null) {
      if (chain.length === 0) chain.push(anchor);
      chain.push(inst);
      anchor = inst;
      continue;
    }
    finalize();
    anchor = inst;
  }
  finalize();

  return groups;
}

/**
 * One block per group for `report.txt`, beside the blooper lines (§122's
 * design): kept / cut (with similarity) / ignored-as-hallucination (with its
 * silence fraction), quoting the actual words — same audit-trail reasoning as
 * `formatBloopSpan`, sharper here because nothing SAID this was a retake.
 */
export function formatRetakeGroup(transcript: Transcript, group: RetakeGroup): string {
  const said = (i: RetakeInstance): string =>
    transcript.words
      .slice(i.startWord, i.endWord + 1)
      .map((w) => w.text)
      .join(" ");
  const lines: string[] = [`kept: "${said(group.kept)}"`];
  for (const c of group.cuts) {
    lines.push(`  cut (${Math.round(c.similarity * 100)}% match): "${said(c)}"`);
  }
  for (const h of group.hallucinated) {
    lines.push(
      `  ignored as hallucination (${Math.round(h.silenceFrac * 100)}% silence): "${said(h)}"`,
    );
  }
  return lines.join("\n");
}
