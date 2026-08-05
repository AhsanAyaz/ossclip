import { normalizeToken } from "./analyze";
import { isSentenceEnd, isSentenceStart } from "./clip";
import { levenshtein } from "./phonetics";
import type { Analysis, Span, Transcript } from "./schema";

/**
 * Deterministic retake collapse (R27 §128) — the sibling of `findBloopSpans`
 * (§122) for the flub the speaker did NOT mark out loud. Consecutive
 * near-identical sentences in the raw transcript are a retake; keep the last
 * complete attempt, cut the rest. See PHASE1-FINDINGS.md §128 for the worked
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

/** A real instance reported without a cut/keep decision — see `RetakeGroup.kept`. */
export interface RetakeUndecided extends RetakeInstance {
  silenceFrac: number;
  /**
   * Present when the instance sat in a chain WITH a kept survivor but was
   * spared (§128): the report needs the number to say what the match to the
   * kept instance actually was, whichever rule spared it.
   */
  similarity?: number;
  /**
   * Why a chain member with a kept survivor was spared (§128):
   * `below-threshold` — scored under RETAKE_SIM_THRESHOLD against the kept
   * instance (the cut-validation rule); `clause-boundary` — matched, but is
   * a NON-final fragment whose same-sentence remainder survives, so the
   * "match" is parallel rhetoric around a mid-sentence pause, not an
   * abandoned take (the abandonment rule). Absent in the report-only
   * (`kept: null`) posture, where silenceFrac is the story.
   */
  reason?: "below-threshold" | "clause-boundary";
}

/**
 * One chain of matching attempts at the same line.
 *
 * `kept` is `null` when the chain's LAST complete instance fails the
 * RESTART_SPLIT_MIN_SIL survivor bar — including when no complete instance
 * exists at all. Never cut, never keep, the same posture the hallucination
 * guard already takes, and for the same reason: electing any OTHER survivor
 * silently inverts keep-last (audit fix, §128 — a last complete instance at
 * 0.375 silenceFrac was dropped in favor of an earlier cleaner attempt at a
 * printed 100% match, with no hint the documented convention had flipped).
 * `cuts` is empty in that case and every real instance in the chain is
 * listed in `undecided` instead, so the report can say WHY nothing was
 * decided rather than going silent. When a survivor IS kept, `undecided`
 * holds any chain member that scored below RETAKE_SIM_THRESHOLD against it
 * (see `buildGroup`) — reported, never cut.
 */
export interface RetakeGroup {
  kept: RetakeInstance | null;
  cuts: RetakeCut[];
  hallucinated: RetakeHallucination[];
  undecided: RetakeUndecided[];
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
  /**
   * The LAST fragment of its coarse sentence — nothing of that sentence
   * follows it. A non-final fragment always has a same-sentence remainder
   * after it, which is what the abandonment rule in `buildGroup` needs to
   * know (§128): cutting a non-final fragment whose remainder lives on
   * leaves that remainder grammatically orphaned mid-sentence.
   */
  finalFragment: boolean;
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
 * can never create a cut — but NOT because a spurious fragment can't match:
 * probe C1 (§128) proved parallel rhetoric makes a clause-boundary fragment
 * match an earlier sentence at a legitimate 1.0. The real backstop is
 * `buildGroup`'s abandonment rule: a non-final fragment whose kept match
 * sits earlier is never cut, so a spurious split ends at a report line,
 * not a shear through live audio.
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

  const toInstance = (s: number, e: number, complete: boolean, finalFragment: boolean): Instance => {
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
      finalFragment,
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
    const splitAfterSet = new Set<number>();
    if (wholeFrac < HALLUCINATION_SILENCE_FRAC) {
      // Gap-based boundary: a real inter-word gap, where one exists, is still
      // direct evidence of a pause. Kept even though it is nearly inert on
      // field transcripts (below): it costs nothing and the test fixtures
      // that predate the field probe still describe a legal input shape.
      for (let i = sent.start; i < sent.end; i++) {
        const gapDur = silenceOverlap(analysis.silences, words[i]!.end, words[i + 1]!.start);
        if (gapDur >= RESTART_SPLIT_MIN_SIL) splitAfterSet.add(i);
      }
      // Stamp-based boundary (§128, audit fix): whisper `-ml 1` emits
      // contiguous stamps — `parseWhisperJson` clamps `next.start = w.end` —
      // so on a real transcript ~95% of inter-word gaps are exactly zero and
      // the gap check above never sees a mid-sentence restart pause. The
      // pause is still in the audio: stamps stretch over dead air (the same
      // physics the hallucination guard exploits), so `analysis.silences` is
      // read directly against the STAMPED word intervals instead. A silence
      // span overlapping this sentence by at least RESTART_SPLIT_MIN_SIL
      // marks a candidate split after the last word whose stamp begins
      // before the silence does — that word's audio is the last thing said
      // before the pause, whether the dead air was stamped into its own
      // tail, across two contiguous stamps, or into the next word's head.
      const sentStartSec = words[sent.start]!.start;
      const sentEndSec = words[sent.end]!.end;
      for (const s of analysis.silences) {
        const lo = Math.max(s.start, sentStartSec);
        const hi = Math.min(s.end, sentEndSec);
        if (hi - lo < RESTART_SPLIT_MIN_SIL) continue;
        // The scan INCLUDES the sentence-final word: a trailing inter-
        // sentence pause is routinely stamped into that word's stretched
        // tail (the field probe's "Linux."/"gate." shape), and excluding it
        // would displace the split one word left — fragmenting a perfectly
        // good sentence around a pause that is actually AFTER it. A split
        // that lands after the final word is a no-op and is dropped.
        let after = -1;
        for (let i = sent.start; i <= sent.end; i++) {
          if (words[i]!.start < s.start) after = i;
          else break;
        }
        if (after >= sent.start && after < sent.end) splitAfterSet.add(after);
      }
    }
    const splitAfter = [...splitAfterSet].sort((a, b) => a - b);
    let fragStart = sent.start;
    for (const at of splitAfter) {
      instances.push(toInstance(fragStart, at, false, false));
      fragStart = at + 1;
    }
    // The final fragment is only "complete" if the coarse block itself ended
    // at REAL sentence punctuation — a transcript (or clip window) that just
    // runs out of words mid-sentence is a trailing abandoned partial, not a
    // finished take, whatever fragment boundary it happens to land on.
    instances.push(toInstance(fragStart, sent.end, isSentenceEnd(transcript, sent.end), true));
  }
  return instances;
}

// ---- matching -------------------------------------------------------------

/**
 * Raw similarity, no threshold — used for the report once a group exists,
 * and for the match gate below.
 *
 * The prefix rule only models one shape: a restart/abandoned partial says
 * FEWER words than the take it restarts. Picking "whichever instance has
 * fewer tokens" as the prefix role — instead of "whichever instance is
 * actually incomplete" — silently applies that same rule to the OPPOSITE
 * shape: an incomplete instance that says MORE words than its counterpart (a
 * continuation/elaboration, or a `--clip` slice that ends mid-sentence after
 * accumulating more words than some earlier complete sentence). Truncating
 * the shorter COMPLETE side's full text down to nothing extra and comparing
 * it against only the incomplete side's matching opening reports a spurious
 * near-1.0 score on two sentences that actually diverge in their second
 * half — verified against a real repro: "Let me show you this." (complete)
 * vs. the unpunctuated continuation "Let me show you this whole thing in
 * detail" scored 1.0 and got the LONGER, more complete continuation cut
 * instead of the short line. Full-sequence comparison scores that
 * divergence honestly instead, whenever the incomplete side is the LONGER
 * one.
 */
function rawSimilarity(a: Instance, b: Instance): number {
  if (a.complete && b.complete) return fullSimilarity(a.tokens, b.tokens);
  if (!a.complete && !b.complete) {
    const [shorter, longer] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
    return prefixSimilarity(shorter.tokens, longer.tokens);
  }
  const incomplete = a.complete ? b : a;
  const other = a.complete ? a : b;
  if (incomplete.tokens.length <= other.tokens.length) {
    return prefixSimilarity(incomplete.tokens, other.tokens);
  }
  return fullSimilarity(a.tokens, b.tokens);
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
 * Kept = the LAST live complete instance, and ONLY if its own silenceFrac
 * clears the stricter RESTART_SPLIT_MIN_SIL survivor bar. When it fails —
 * or the chain has no complete instance at all — the group goes report-only:
 * `kept` is null, nothing cuts, and every real instance is returned in
 * `undecided` with its own silenceFrac. Never fall back to an EARLIER
 * complete instance (audit fix, §128): electing one silently inverts
 * keep-last — a last complete take at silenceFrac 0.375 was dropped for an
 * earlier cleaner attempt at a printed 100% match, with nothing in the
 * report saying the documented convention had flipped. Keep-last is a
 * convention, not a proof (§128's known limits), so when the bar rejects
 * the one instance the convention names, the honest move is to decide
 * nothing and say why.
 *
 * Cut-validation rule (audit fix, §128 — the wildcard-bridge failure):
 * chain membership alone is NOT permission to cut. Matching is
 * non-transitive — a 3-token abandoned fragment scores 1.0 against ANY
 * sentence sharing its opening (the prefix rule), so a chain can drift or
 * bridge across genuinely different sentences. Every member is re-scored
 * against the actual KEPT instance, and only those clearing
 * RETAKE_SIM_THRESHOLD are cut; the rest go to `undecided` (report-only) —
 * executed proof: "Let me show you this." / "Let me show—" / "Let me show
 * you how deploys work here." cut the first REAL, DISTINCT sentence at a
 * printed 50% match before this rule existed.
 *
 * Abandonment rule (audit fix, §128 — probe C1, parallel-structure
 * rhetoric): a similarity gate cannot catch a fragment whose match is
 * GENUINELY 1.0. "If it fails, we retry. If it fails, [0.4s dramatic
 * pause] we give up." — the sub-split shears the second sentence at the
 * comma pause, and "If it fails," legitimately prefix-scores 1.0 against
 * the kept first sentence, because parallel rhetoric repeats the opening
 * on purpose. Cutting it hard-cuts live mid-sentence audio and leaves the
 * grammatically orphaned remainder "we give up." behind. So a fragment is
 * only ABANDONED — hence cuttable — when (a) the kept survivor starts
 * AFTER it (a restart superseded by a later attempt), or (b) it is the
 * FINAL fragment of its coarse sentence, i.e. nothing of its own sentence
 * survives past it. A NON-final fragment whose kept match sits EARLIER is
 * a clause boundary, not an abandoned take: its own sentence continues
 * without it, so it goes to `undecided` (report-only), never `cuts`.
 */
function buildGroup(chain: readonly Instance[], hallucinated: readonly Instance[]): RetakeGroup {
  const completes = chain.filter((i) => i.complete);
  const lastComplete = completes[completes.length - 1];
  const kept =
    lastComplete !== undefined && lastComplete.silenceFrac <= RESTART_SPLIT_MIN_SIL
      ? lastComplete
      : undefined;
  const hallu: RetakeHallucination[] = hallucinated.map((i) => ({
    ...toPublic(i),
    silenceFrac: i.silenceFrac,
  }));
  if (kept === undefined) {
    const undecided: RetakeUndecided[] = chain.map((i) => ({
      ...toPublic(i),
      silenceFrac: i.silenceFrac,
    }));
    return { kept: null, cuts: [], hallucinated: hallu, undecided };
  }
  const cuts: RetakeCut[] = [];
  const undecided: RetakeUndecided[] = [];
  for (const i of chain) {
    if (i === kept) continue;
    const sim = matchScore(i, kept);
    if (sim === null) {
      undecided.push({
        ...toPublic(i),
        silenceFrac: i.silenceFrac,
        similarity: rawSimilarity(i, kept),
        reason: "below-threshold",
      });
      continue;
    }
    // The abandonment rule (see block comment): a complete instance is
    // always its sentence's final fragment, so this only ever spares the
    // non-final sub-split fragments C1 is about.
    const abandoned = i.finalFragment || kept.startWord > i.endWord;
    if (abandoned) cuts.push({ ...toPublic(i), similarity: sim });
    else
      undecided.push({
        ...toPublic(i),
        silenceFrac: i.silenceFrac,
        similarity: sim,
        reason: "clause-boundary",
      });
  }
  return { kept: toPublic(kept), cuts, hallucinated: hallu, undecided };
}

/**
 * Finds retake chains in the transcript. `analysis` is `Pick<Analysis,
 * "silences" | "fillers">` deliberately narrow — this runs on the RAW,
 * pre-repair transcript at both `produce.ts` call sites, same ordering
 * reason as `findBloopSpans` (§122): the repair pass reads a stray restart as
 * an oddity and would rewrite the very pattern this is looking for.
 *
 * Chaining rule: comparison is always against the anchor — the last LIVE
 * (non-hallucinated, non-empty) COMPLETE instance in the chain, or the
 * instance that founded the chain when nothing complete has joined yet.
 * Anything that MATCHES the anchor extends the same chain, and becomes the
 * new anchor only if it is itself COMPLETE (three-take and beyond). An
 * incomplete fragment is matchable and cuttable but NEVER becomes the anchor
 * (audit fix, §128 — the wildcard-bridge failure): its 3-token opening
 * scores 1.0 against ANY sentence starting the same way, so letting it
 * anchor turned an abandoned "Let me show—" into a bridge that chained two
 * genuinely different sentences together and cut one of them. The
 * partial-then-complete ordering still works: a partial can FOUND a chain as
 * its original anchor, and the complete take arriving after it matches (the
 * prefix rule) and takes over as anchor. Anything that does NOT match the
 * anchor starts a fresh one, which is what
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
      // §128 wildcard-bridge fix: only a COMPLETE instance may take over as
      // anchor — an incomplete fragment's prefix-matched opening must not
      // become the thing the NEXT sentence is compared against.
      if (inst.complete) anchor = inst;
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
 *
 * `group.kept === null` is the report-only case: the LAST complete attempt
 * (or the whole chain, when nothing complete exists) failed the survivor
 * bar, so nothing was cut OR kept — every real instance is listed with its
 * own silenceFrac instead, same shape as the hallucination lines, so the
 * report says WHY nothing was decided rather than going silent. With a
 * survivor, `undecided` members (below-threshold against the kept — §128's
 * cut-validation rule) are listed with their similarity for the same reason:
 * a spared member the user can see beats a wrong cut nobody can.
 */
export function formatRetakeGroup(transcript: Transcript, group: RetakeGroup): string {
  const said = (i: RetakeInstance): string =>
    transcript.words
      .slice(i.startWord, i.endWord + 1)
      .map((w) => w.text)
      .join(" ");
  const lines: string[] = [];
  if (group.kept === null) {
    lines.push(
      "no cut: the last complete attempt's own dead-air fraction failed the survivor bar — reporting every attempt instead of guessing which one is real",
    );
    for (const u of group.undecided) {
      lines.push(`  attempt (${Math.round(u.silenceFrac * 100)}% silence): "${said(u)}"`);
    }
  } else {
    lines.push(`kept: "${said(group.kept)}"`);
    for (const c of group.cuts) {
      lines.push(`  cut (${Math.round(c.similarity * 100)}% match): "${said(c)}"`);
    }
    for (const u of group.undecided) {
      const pct = Math.round((u.similarity ?? 0) * 100);
      // The clause-boundary line must NOT read like a near-miss cut (§128,
      // probe C1): the match there is often a legitimate 100%, and the
      // reason it survived is grammatical, not numeric.
      lines.push(
        u.reason === "clause-boundary"
          ? `  not cut (${pct}% match, but its own sentence continues past it — a clause boundary, not an abandoned take): "${said(u)}"`
          : `  not cut (${pct}% match to the kept take — below the cut floor): "${said(u)}"`,
      );
    }
  }
  for (const h of group.hallucinated) {
    lines.push(
      `  ignored as hallucination (${Math.round(h.silenceFrac * 100)}% silence): "${said(h)}"`,
    );
  }
  return lines.join("\n");
}
