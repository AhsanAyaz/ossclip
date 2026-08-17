import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { findBloopSpans } from "../src/blooper";
import { buildCutlist } from "../src/cutlist";
import {
  HALLUCINATION_SILENCE_FRAC,
  RETAKE_MIN_TOKENS,
  RETAKE_SIM_THRESHOLD,
  findRetakeGroups,
  formatRetakeGroup,
} from "../src/retake";
import { TimeMap } from "../src/timemap";
import type { Analysis, Span, Transcript, Word } from "../src/schema";

/**
 * R27 §128. Deterministic retake collapse — a sibling of `findBloopSpans`
 * (§122), for the take the speaker did NOT mark: consecutive near-identical
 * sentences, keep the last complete one, cut the rest. See PHASE1-FINDINGS.md
 * §128 for the predicate, the worked examples, and why keep-last is a
 * documented convention rather than a proof.
 */

/**
 * `speak()`, extended with gaps (blooper.test.ts's fixture style). Default
 * word spacing is 0.5s stride (0.4s word + 0.1s gap), same as blooper's
 * `speak`. `gaps` overrides the pause AFTER word index i with a longer one —
 * long enough (>= RESTART_SPLIT_MIN_SIL) to register as a candidate restart
 * boundary, or just a plain acoustic silence between two attempts. Returns a
 * ready-to-use `Analysis` (via the real `analyze()`, exactly as `produce.ts`
 * builds it) rather than a hand-rolled stand-in, so `fillers` is real too.
 */
function speak(text: string, gaps: Record<number, number> = {}): { transcript: Transcript; analysis: Analysis; duration: number } {
  const raw = text.split(/\s+/);
  const words: Word[] = [];
  const silences: Span[] = [];
  let t = 0;
  for (let i = 0; i < raw.length; i++) {
    const start = t;
    const end = t + 0.4;
    words.push({ text: raw[i]!, start, end });
    const gap = gaps[i] ?? 0.1;
    if (gap > 0.05) silences.push({ start: end, end: end + gap });
    t = end + gap;
  }
  const transcript: Transcript = { language: "en", words };
  const duration = Math.max(t, words[words.length - 1]!.end + 0.5);
  const analysis = analyze(transcript, silences, duration);
  return { transcript, analysis, duration };
}

/** Word text for a [start, end] inclusive range, for asserting what survived. */
function wordsIn(t: Transcript, start: number, end: number): string {
  return t.words.slice(start, end + 1).map((w) => w.text).join(" ");
}

describe("findRetakeGroups: matching complete attempts", () => {
  it("identical: two verbatim takes collapse, last kept", () => {
    const { transcript, analysis } = speak(
      "Fix at most three issues. That is the exit condition. That is the exit condition.",
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That is the exit condition.");
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That is the exit condition.");
    // The line before the retake pair is untouched — no group for it.
    expect(g.kept!.startWord).toBeGreaterThan(4);
  });

  it("three-take: keeps only the last, cuts both earlier attempts", () => {
    const { transcript, analysis } = speak(
      "That is the exit condition. That is the exit condition. That is the exit condition.",
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(2);
    // Kept is the LAST sentence in the transcript.
    expect(g.kept!.endWord).toBe(transcript.words.length - 1);
  });

  it("unrelated: two different sentences never group", () => {
    const { transcript, analysis } = speak("This is the intro. This is a totally different closing line.");
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("rephrased: a reworded retake does not match (semantic residual stays out of scope)", () => {
    // Same idea, different words — deliberately below the token-similarity
    // floor. This residual is documented, not solved (ROADMAP.md).
    const { transcript, analysis } = speak(
      "That could be the exit condition. So basically we stop right there when it happens.",
    );
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("short-line-emphasis: repeated short lines stay below RETAKE_MIN_TOKENS and never collapse", () => {
    // "Yes. Yes. Yes." is emphasis, not a retake — each attempt is a single
    // token, under RETAKE_MIN_TOKENS (3), so it must never be treated as one.
    const { transcript, analysis } = speak("Yes. Yes. Yes.");
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });
});

describe("findRetakeGroups: partial attempts", () => {
  it("partial-before: an abandoned partial ahead of the complete take is cut, the complete kept", () => {
    // No terminal punctuation on the abandoned partial — ASR just runs on —
    // so the restart boundary has to come from the silence, not a period.
    // The speaker stalls mid-sentence and starts the SAME sentence over.
    // Word indices: 0 That 1 could 2 be 3 the 4 exit | (0.5s pause after 4) 5 That 6 could 7 be 8 the 9 exit 10 condition.
    const { transcript, analysis } = speak("That could be the exit That could be the exit condition.", {
      4: 0.5,
    });
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That could be the exit");
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That could be the exit condition.");
  });

  it("trailing-partial: a complete take followed by an abandoned restart is cut, the earlier complete kept", () => {
    const { transcript, analysis } = speak("That could be the exit condition. That could be the exit", {
      5: 0.5,
    });
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That could be the exit condition.");
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That could be the exit");
  });

  /**
   * Audit fix (Important 2): the tests above manufacture real inter-word
   * gaps, but whisper `-ml 1` emits CONTIGUOUS stamps (`parseWhisperJson`
   * clamps `next.start = w.end`; FINDINGS §18) — a field probe of a real
   * transcript measured 241 of 254 inter-word gaps at exactly zero, so the
   * gap-based restart trigger alone never fires mid-sentence there. The
   * pause survives in `analysis.silences` instead, stamped INSIDE a
   * stretched word interval. These fixtures build words the way
   * `parseWhisperJson` emits them — zero gaps, dead air absorbed into the
   * stamps — and prove the partial-restart case still fires.
   */
  it("contiguous stamps: a restart pause stamped into a word's own tail still splits and collapses", () => {
    // "That could be the exit [0.5s pause] That could be the exit condition."
    // — word 4's stamp stretches over the dead air (audio ~1.6-2.0, silence
    // 2.0-2.5), and every inter-word gap is exactly zero.
    const words: Word[] = [
      { text: "That", start: 0.0, end: 0.4 },
      { text: "could", start: 0.4, end: 0.8 },
      { text: "be", start: 0.8, end: 1.2 },
      { text: "the", start: 1.2, end: 1.6 },
      { text: "exit", start: 1.6, end: 2.5 },
      { text: "That", start: 2.5, end: 2.9 },
      { text: "could", start: 2.9, end: 3.3 },
      { text: "be", start: 3.3, end: 3.7 },
      { text: "the", start: 3.7, end: 4.1 },
      { text: "exit", start: 4.1, end: 4.5 },
      { text: "condition.", start: 4.5, end: 4.9 },
    ];
    for (let i = 1; i < words.length; i++) expect(words[i]!.start).toBe(words[i - 1]!.end);
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 2.0, end: 2.5 }], 5.4);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That could be the exit");
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That could be the exit condition.");
  });

  it("contiguous stamps: a pause straddling the boundary of two zero-gap stamps splits after the earlier word", () => {
    const words: Word[] = [
      { text: "That", start: 0.0, end: 0.4 },
      { text: "could", start: 0.4, end: 0.8 },
      { text: "be", start: 0.8, end: 1.2 },
      { text: "the", start: 1.2, end: 1.6 },
      { text: "exit", start: 1.6, end: 2.5 },
      { text: "That", start: 2.5, end: 2.9 },
      { text: "could", start: 2.9, end: 3.3 },
      { text: "be", start: 3.3, end: 3.7 },
      { text: "the", start: 3.7, end: 4.1 },
      { text: "exit", start: 4.1, end: 4.5 },
      { text: "condition.", start: 4.5, end: 4.9 },
    ];
    const transcript: Transcript = { language: "en", words };
    // 0.4s of dead air crossing the word-4/word-5 stamp boundary at 2.5 —
    // neither side alone holds RESTART_SPLIT_MIN_SIL of it.
    const analysis = analyze(transcript, [{ start: 2.2, end: 2.6 }], 5.4);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That could be the exit");
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That could be the exit condition.");
  });

  it("contiguous stamps: a trailing pause stamped into the sentence-final word's tail does NOT fragment the sentence", () => {
    // The field probe's "Linux."/"gate." shape: the pause AFTER a finished
    // sentence gets absorbed into the final word's stretched stamp. A split
    // displaced one word left here would shear "condition." off the second
    // take, cut the take's body against the first, and leave the orphaned
    // final word behind — a wrong cut in the middle of a legitimate retake.
    const words: Word[] = [
      { text: "That", start: 0.0, end: 0.4 },
      { text: "is", start: 0.4, end: 0.8 },
      { text: "the", start: 0.8, end: 1.2 },
      { text: "exit", start: 1.2, end: 1.6 },
      { text: "condition.", start: 1.6, end: 2.0 },
      { text: "That", start: 2.0, end: 2.4 },
      { text: "is", start: 2.4, end: 2.8 },
      { text: "the", start: 2.8, end: 3.2 },
      { text: "exit", start: 3.2, end: 3.6 },
      // Final word's stamp stretches over the 0.5s pause that follows the
      // finished sentence (audio ~3.6-4.0, dead air 4.0-4.5).
      { text: "condition.", start: 3.6, end: 4.5 },
    ];
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 4.0, end: 4.5 }], 5.0);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    // The whole second take is kept intact — not sheared before "condition."
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That is the exit condition.");
    expect(g.kept!.startWord).toBe(5);
    expect(g.kept!.endWord).toBe(9);
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That is the exit condition.");
    expect(g.undecided).toEqual([]);
  });
});

/**
 * Review fix: `rawSimilarity` picked the "partial" role by raw token count,
 * not by which instance was actually incomplete. A restart says FEWER words
 * than the take it restarts — that's the only shape the prefix rule models —
 * but an incomplete instance that says MORE words (a continuation/
 * elaboration, or a `--clip` slice ending mid-sentence after accumulating
 * more words) hit the same prefix rule backwards: the shorter COMPLETE
 * side's tokens were truncated down and compared against only the longer
 * incomplete side's matching opening, scoring a spurious near-1.0 and
 * getting the fuller, more-complete continuation CUT instead of the short
 * line.
 */
describe("findRetakeGroups: a longer continuation is not a retake of a shorter line", () => {
  it("reviewer repro: an unpunctuated continuation is not mistaken for a retry of the shorter line", () => {
    // "Let me show you this." (5 tokens, complete) followed by an
    // unpunctuated continuation that says MORE (9 tokens, incomplete). Before
    // the fix this scored 1.0 and cut the continuation; the true similarity
    // (first 5 tokens match, 4 extra tokens unaccounted for) is
    // 1 - 4/9 ≈ 0.56, under RETAKE_SIM_THRESHOLD — no match, nothing cut.
    const { transcript, analysis } = speak(
      "Let me show you this. Let me show you this whole thing in detail",
    );
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("--clip-flavored: a trailing incomplete slice that says MORE than an earlier complete line is not collapsed into it", () => {
    // Simulates a --clip window boundary landing mid-sentence: the transcript
    // (or its slice) just stops before real punctuation, and what's left
    // over happens to open the same way as an earlier complete sentence but
    // continues on with real additional content.
    const { transcript, analysis } = speak(
      "That is the exit condition. That is the exit condition and there is more context here",
    );
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });
});

/**
 * Audit fix (Critical, verified by execution) — the wildcard-bridge failure.
 * Matching is non-transitive: an abandoned 3-token fragment prefix-scores 1.0
 * against ANY sentence sharing its opening, so with the old rules it could
 * become the anchor and bridge two genuinely different sentences into one
 * chain, and `buildGroup` then cut every chain member without re-checking any
 * of them against the instance actually kept. Two layers of defense, both
 * pinned here: (a) an incomplete fragment never becomes the anchor, and (b)
 * a member is only CUT if it clears RETAKE_SIM_THRESHOLD against the KEPT
 * instance — below that it goes to `undecided`, report-only.
 */
describe("findRetakeGroups: wildcard-bridge and chain-drift (non-transitive matching)", () => {
  it("bridge shape: an abandoned fragment must not chain two distinct sentences — the distinct one survives", () => {
    // Executed proof shape: "Let me show you this." / "Let me show" (abandoned,
    // 0.5s pause) / "Let me show you how deploys work here." — the old anchor
    // rule made the fragment the anchor, the prefix rule scored the distinct
    // closing sentence 1.0 against it, and the first REAL sentence was cut at
    // a printed 50% match.
    //
    // C1 follow-up: the fragment itself is now SPARED, not cut. It is a
    // non-final fragment whose kept match (the first sentence) sits EARLIER
    // — the abandonment rule can't distinguish it from parallel-structure
    // rhetoric (probe C1's exact geometry), and in truth it's a false start
    // of the sentence FOLLOWING it, which the S1 match never proved.
    // Report-only is the honest disposition on both readings.
    const { transcript, analysis } = speak(
      "Let me show you this. Let me show Let me show you how deploys work here.",
      { 7: 0.5 },
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("Let me show you this.");
    // Zero cuts: the fragment goes to report-only undecided instead.
    expect(g.cuts).toEqual([]);
    expect(g.undecided).toHaveLength(1);
    expect(wordsIn(transcript, g.undecided[0]!.startWord, g.undecided[0]!.endWord)).toBe("Let me show");
    expect(g.undecided[0]!.reason).toBe("clause-boundary");
    // The DISTINCT sentence never enters the group at all — untouched.
    const touched = [...g.cuts, ...g.undecided];
    for (const t of touched) expect(t.startWord).toBeLessThan(8);
  });

  it("drift shape: no chain member is ever cut below RETAKE_SIM_THRESHOLD against the KEPT instance", () => {
    // Each adjacent pair clears 0.8, but the endpoints score 0.4 — with the
    // old buildGroup the first take was cut at a printed 40% match.
    const { transcript, analysis } = speak(
      "Alpha bravo charlie delta echo. Alpha bravo charlie delta foxtrot. " +
        "Alpha bravo charlie golf foxtrot. Alpha bravo hotel golf foxtrot.",
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    // Keep-last still holds: the final take is the survivor.
    expect(g.kept!.endWord).toBe(transcript.words.length - 1);
    // Every actual cut cleared the threshold against the kept instance.
    for (const c of g.cuts) expect(c.similarity).toBeGreaterThanOrEqual(RETAKE_SIM_THRESHOLD);
    // The first take (0.4 vs kept) was NOT cut — it drifted out of range and
    // is reported as undecided instead, with its similarity for the report.
    expect(g.cuts.some((c) => c.startWord === 0)).toBe(false);
    const first = g.undecided.find((u) => u.startWord === 0);
    expect(first).toBeDefined();
    expect(first!.similarity).toBeLessThan(RETAKE_SIM_THRESHOLD);
    // The report spares them out loud rather than going silent.
    const report = formatRetakeGroup(transcript, g);
    expect(report).toContain("not cut");
  });
});

/**
 * Audit fix (Critical, probe C1) — parallel-structure rhetoric with a
 * mid-sentence pause. The finding-1 defenses cannot catch this: the
 * fragment's match to the kept sentence is a GENUINE 1.0, because parallel
 * rhetoric repeats the opening on purpose. Field-reachable once the stamp-
 * based sub-split went live on real transcripts. The abandonment rule in
 * `buildGroup` is the fix: a fragment is only cuttable when the kept
 * survivor starts AFTER it (restart superseded later) or it is the FINAL
 * fragment of its coarse sentence; a non-final fragment whose kept match
 * sits earlier is a clause boundary and goes to report-only undecided.
 */
describe("findRetakeGroups: abandonment rule (probe C1 — parallel rhetoric across a pause)", () => {
  it("C1: 'If it fails, we retry. If it fails, [pause] we give up.' — zero cuts, second sentence survives whole", () => {
    // Word indices: 0 If 1 it 2 fails, 3 we 4 retry. | 5 If 6 it 7 fails,
    // [0.4s dramatic pause] 8 we 9 give 10 up.
    const shape = speak("If it fails, we retry. If it fails, we give up.", { 7: 0.4 });
    const groups = findRetakeGroups(shape.transcript, shape.analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toEqual([]);
    // The fragment is reported, with its (legitimate) 100% match and the
    // grammatical reason it survived.
    expect(g.undecided).toHaveLength(1);
    expect(g.undecided[0]!.reason).toBe("clause-boundary");
    expect(g.undecided[0]!.similarity).toBe(1);
    const report = formatRetakeGroup(shape.transcript, g);
    expect(report).toContain("clause boundary");
    // End-to-end: through buildCutlist + TimeMap, every word of the second
    // sentence — fragment AND remainder — survives to the output.
    const cut = buildCutlist({
      transcript: shape.transcript,
      analysis: shape.analysis,
      duration: shape.duration,
      level: "standard",
      retakes: groups.flatMap((gr) => gr.cuts),
    });
    const map = new TimeMap(cut);
    for (let i = 5; i <= 10; i++) {
      expect(map.mapWord(shape.transcript.words[i]!)).not.toBeNull();
    }
  });

  it("C2: a lone sentence with an internal dramatic pause forms no group at all", () => {
    const { transcript, analysis } = speak("If it fails, we give up.", { 2: 0.4 });
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("C3: pause-sentence first, parallel sentence second — no group either", () => {
    // Reversed C1 order: the fragment founds its own anchor, its remainder
    // does not match it, and the following parallel sentence does not match
    // the remainder — nothing chains.
    const { transcript, analysis } = speak("If it fails, we give up. If it fails, we retry.", {
      2: 0.4,
    });
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("does NOT block the legitimate restart-superseded-later case: two abandoned partials before the kept take still cut", () => {
    // Both fragments are non-final, but the kept survivor starts AFTER them
    // — the (a) arm of the abandonment rule. Word indices: 0-4 first
    // partial, 5-8 second partial, 9-14 the complete take.
    const { transcript, analysis } = speak(
      "That could be the exit That could be the That could be the exit condition.",
      { 4: 0.5, 8: 0.5 },
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe(
      "That could be the exit condition.",
    );
    expect(g.cuts).toHaveLength(2);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe("That could be the exit");
    expect(wordsIn(transcript, g.cuts[1]!.startWord, g.cuts[1]!.endWord)).toBe("That could be the");
    expect(g.undecided).toEqual([]);
  });
});

describe("findRetakeGroups: VO-paced retakes — a pause INSIDE both takes (§135 field case)", () => {
  // The 2026-08-11 voice-over recording: "The kernel I optimized takes half
  // [3s pause] a second." then the corrected "…half [0.8s pause] a
  // millisecond." Whole-sentence similarity is 0.875 — comfortably a retake —
  // but the restart split shredded each take into fragments ("…takes half" /
  // "a second") that never matched across takes, and the detector reported
  // "no retakes found" on a pair it was built for. Deliberate mid-sentence
  // pauses are normal read-aloud delivery, not an exotic input.
  it("field case: mid-sentence pauses in BOTH takes still collapse the pair", () => {
    const { transcript, analysis } = speak(
      "The kernel I optimized takes half a second. " +
        "The kernel I optimized takes half a millisecond. " +
        "This is the good take.",
      { 5: 3.0, 7: 2.0, 13: 0.8 },
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe(
      "The kernel I optimized takes half a second.",
    );
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe(
      "The kernel I optimized takes half a millisecond.",
    );
  });

  it("a kept take whose deliberate pauses put it over the FRAGMENT survivor bar still wins at sentence level", () => {
    // The full field shape: the real run's kept candidate carried 36% dead
    // air — over RESTART_SPLIT_MIN_SIL (0.35), the fragment-pass survivor
    // bar — purely from deliberate read-aloud pauses, and the group went
    // report-only. At sentence level a pause is ordinary delivery (§135's
    // whole premise), so the survivor gate is the HALLUCINATION bar (0.65),
    // not the fragment bar. Gaps here are sized to land the kept sentence's
    // silence fraction between the two bars.
    const { transcript, analysis } = speak(
      "The kernel I optimized takes half a second. " +
        "The kernel I optimized takes half a millisecond. " +
        "This is the good take.",
      { 5: 3.0, 7: 2.0, 13: 1.6 },
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kept).not.toBeNull();
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe(
      "The kernel I optimized takes half a second.",
    );
  });

  it("a pause inside only ONE of the two takes also collapses the pair", () => {
    const { transcript, analysis } = speak(
      "The kernel I optimized takes half a second. " +
        "The kernel I optimized takes half a millisecond. " +
        "This is the good take.",
      { 5: 3.0, 7: 2.0 },
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe(
      "The kernel I optimized takes half a second.",
    );
  });

  it("C1 stays intact: parallel rhetoric across a pause still cuts nothing at sentence level", () => {
    // The §128 probe C1 shape — genuinely different sentences whose openings
    // repeat on purpose. The sentence-level pass must not resurrect the cut
    // the fragment pass's abandonment rule exists to prevent: whole-sentence
    // similarity between "If it fails, we retry." and "If it fails, we give
    // up." is 0.8-adjacent by construction, so this pins that the pair stays
    // un-cut whatever the pass ordering does.
    const { transcript, analysis } = speak("If it fails, we retry. If it fails, we give up.", {
      8: 0.4,
    });
    const groups = findRetakeGroups(transcript, analysis);
    for (const g of groups) {
      expect(g.cuts).toHaveLength(0);
    }
  });
});

describe("findRetakeGroups: chaining — what may sit between two attempts", () => {
  it("filler-vs-blocking-sentence: a lone filler bridges the chain, a real sentence blocks it", () => {
    const filler = speak("That is the exit condition. um That is the exit condition.");
    const bridged = findRetakeGroups(filler.transcript, filler.analysis);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.cuts).toHaveLength(1);

    const blocked = speak("That is the exit condition. Anyway let's move on. That is the exit condition.");
    // A real, unrelated sentence in between breaks the chain: neither
    // instance may match across it.
    expect(findRetakeGroups(blocked.transcript, blocked.analysis)).toEqual([]);
  });

  it("marker-transparency: a lone --blooper-marker word bridges the chain like a filler", () => {
    const { transcript, analysis } = speak("That is the exit condition. blooper. That is the exit condition.");
    const groups = findRetakeGroups(transcript, analysis, { transparentMarker: "blooper" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cuts).toHaveLength(1);
  });

  /**
   * Review fix: both produce.ts call sites invoked `findRetakeGroups(t,
   * analysis)` with no third argument, so `--blooper-marker` + `--collapse-
   * retakes` together silently blocked most collapsing — the marker sentence
   * read as an ordinary blocking sentence instead of transparent, exactly
   * like the "blocked" half of the test above. Reproduces the exact combined-
   * flags shape produce.ts wires: both detectors running on the same raw
   * transcript, `findRetakeGroups` given `{ transparentMarker: <the same
   * word findBloopSpans is searching for> }`.
   */
  it("combined flags: --collapse-retakes still bridges a marker sentence when --blooper-marker is also set", () => {
    const { transcript, analysis } = speak(
      "Wrong words blooper. That is the exit condition. blooper. That is the exit condition.",
    );
    // The marker also does its own job — cutting the flub it terminates.
    const bloops = findBloopSpans(transcript, "blooper");
    expect(bloops.length).toBeGreaterThan(0);
    // Without the fix, this returned [] — the marker sentence blocked the
    // chain instead of bridging it.
    const groups = findRetakeGroups(transcript, analysis, { transparentMarker: "blooper" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cuts).toHaveLength(1);
  });

  it("bridged chaining: a chain survives a hallucinated instance sitting between two real attempts", () => {
    // Real take, then a long dead-air stretch where whisper hallucinates a
    // near-verbatim repeat (silence-dominated span), then a genuine second
    // real attempt. The hallucination must not block the real-to-real match.
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      // Hallucinated repeat: stamps sprinkled across a long silent stretch.
      { text: "That", start: 3.0, end: 3.1 },
      { text: "is", start: 8.0, end: 8.1 },
      { text: "the", start: 13.0, end: 13.1 },
      { text: "exit", start: 18.0, end: 18.1 },
      { text: "condition.", start: 23.0, end: 23.1 },
      // Real second attempt, back at normal cadence.
      { text: "That", start: 24.0, end: 24.3 },
      { text: "is", start: 24.3, end: 24.5 },
      { text: "the", start: 24.5, end: 24.7 },
      { text: "exit", start: 24.7, end: 25.0 },
      { text: "condition.", start: 25.0, end: 25.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 25.9;
    // The whole 1.4s-23.1s stretch is genuinely silent audio.
    const silences: Span[] = [{ start: 1.4, end: 23.9 }];
    const analysis = analyze(transcript, silences, duration);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.hallucinated).toHaveLength(1);
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe(
      "That is the exit condition.",
    );
    expect(g.kept!.startWord).toBe(10);
  });
});

describe("findRetakeGroups: token matching (fuzz, §125-ghost guard)", () => {
  it("token-fuzz: an ASR mishearing of one long word still matches (Levenshtein <=1, len>=5)", () => {
    // "condition." mis-transcribed as "condiiton." — one transposition, both
    // >=5 chars, so token equality still holds and the sentence still matches.
    const { transcript, analysis } = speak(
      "That is the exit condition. That is the exit condiiton.",
    );
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
  });

  it("§125-ghost guard: no phonetic/onset matching — same-onset unrelated sentences never group", () => {
    // The exact §125 shape, ported to the retake detector: same opening
    // sound, unrelated content. soundsSimilar("builds", "blooper") was the
    // bug; this detector must never reach for it at all.
    const { transcript, analysis } = speak(
      "Blooper stories are always funny to hear. Builders start their day early every morning.",
    );
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });
});

describe("findRetakeGroups: hallucination guard", () => {
  it("a silence-dominated instance is flagged hallucinated, never kept, never cut", () => {
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      // Stamped across dead air — over 65% of its own span is silence.
      { text: "That", start: 2.0, end: 2.1 },
      { text: "is", start: 5.0, end: 5.1 },
      { text: "the", start: 8.0, end: 8.1 },
      { text: "exit", start: 11.0, end: 11.1 },
      { text: "condition.", start: 14.0, end: 14.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 14.9;
    const silences: Span[] = [{ start: 1.4, end: 14.9 }];
    const analysis = analyze(transcript, silences, duration);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.cuts).toEqual([]);
    expect(g.hallucinated).toHaveLength(1);
    expect(g.hallucinated[0]!.silenceFrac).toBeGreaterThanOrEqual(HALLUCINATION_SILENCE_FRAC);
    // The real, early take is what survives.
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That is the exit condition.");
  });

  it("field case: a real take early, hallucinated repeats later — keep-last must not elect the hallucination", () => {
    // The 2026-08-05 field failure, reproduced directly: without the guard,
    // naive keep-last would pick the LAST matching instance — here, the
    // hallucinated one — and cut the only real take that exists.
    const words: Word[] = [
      { text: "Fix", start: 0, end: 0.3 },
      { text: "at", start: 0.3, end: 0.5 },
      { text: "most", start: 0.5, end: 0.8 },
      { text: "three", start: 0.8, end: 1.1 },
      { text: "issues.", start: 1.1, end: 1.5 },
      { text: "That", start: 1.6, end: 1.9 },
      { text: "is", start: 1.9, end: 2.1 },
      { text: "the", start: 2.1, end: 2.3 },
      { text: "exit", start: 2.3, end: 2.6 },
      { text: "condition.", start: 2.6, end: 3.0 },
      // Long dead air, over which whisper hallucinates two more "attempts".
      { text: "That", start: 5.0, end: 5.1 },
      { text: "is", start: 9.0, end: 9.1 },
      { text: "the", start: 13.0, end: 13.1 },
      { text: "exit", start: 17.0, end: 17.1 },
      { text: "condition.", start: 21.0, end: 21.1 },
      { text: "That", start: 24.0, end: 24.1 },
      { text: "is", start: 27.0, end: 27.1 },
      { text: "the", start: 30.0, end: 30.1 },
      { text: "exit", start: 33.0, end: 33.1 },
      { text: "condition.", start: 36.0, end: 36.1 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 36.6;
    const silences: Span[] = [{ start: 3.0, end: 36.6 }];
    const analysis = analyze(transcript, silences, duration);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    // Nothing is cut: the sole real take is correctly kept, not treated as an
    // earlier duplicate of the hallucinated "last" instance.
    expect(g.cuts).toEqual([]);
    expect(g.hallucinated).toHaveLength(2);
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That is the exit condition.");
    expect(g.kept!.startWord).toBe(5);
  });

  it("boundary pin: silenceFrac just under HALLUCINATION_SILENCE_FRAC is a normal retake, not a hallucination", () => {
    // 0.64 fraction silence — a real (if gappy) attempt, must be cut as an
    // ordinary earlier duplicate, not flagged as hallucinated. The gappy
    // instance is the EARLIER one here (audit fix, §128): a gappy LAST
    // instance now fails the survivor bar and goes report-only instead — the
    // shape the survivor-bar tests below pin — so this test keeps the
    // hallucination boundary itself isolated from that rule.
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      { text: "That", start: 2.0, end: 2.3 },
      { text: "is", start: 2.3, end: 2.5 },
      { text: "the", start: 2.5, end: 2.7 },
      { text: "exit", start: 2.7, end: 3.0 },
      { text: "condition.", start: 3.0, end: 3.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 3.9;
    // First instance spans 0-1.4 (1.4s); pack it with 0.64 * 1.4 = 0.896s of
    // silence via four sub-0.35s spans, so none of them is itself a restart-
    // split candidate — the fraction is the thing under test, not the split.
    const silences: Span[] = [
      { start: 0.05, end: 0.274 },
      { start: 0.35, end: 0.574 },
      { start: 0.65, end: 0.874 },
      { start: 0.95, end: 1.174 },
    ];
    const analysis = analyze(transcript, silences, duration);
    const g = findRetakeGroups(transcript, analysis)[0]!;
    expect(g.hallucinated).toEqual([]);
    expect(g.cuts).toHaveLength(1);
    expect(g.cuts[0]!.similarity).toBeGreaterThanOrEqual(RETAKE_SIM_THRESHOLD);
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe("That is the exit condition.");
    expect(g.kept!.startWord).toBe(5);
  });

  it("boundary pin: silenceFrac just over HALLUCINATION_SILENCE_FRAC is hallucinated, not cut", () => {
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      { text: "That", start: 2.0, end: 2.3 },
      { text: "is", start: 2.3, end: 2.5 },
      { text: "the", start: 2.5, end: 2.7 },
      { text: "exit", start: 2.7, end: 3.0 },
      { text: "condition.", start: 3.0, end: 3.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 3.9;
    // 0.66 * 1.4 = 0.924s of silence inside the second instance's span.
    const silences: Span[] = [{ start: 2.0, end: 2.924 }];
    const analysis = analyze(transcript, silences, duration);
    const g = findRetakeGroups(transcript, analysis)[0]!;
    expect(g.hallucinated).toHaveLength(1);
    expect(g.cuts).toEqual([]);
  });

  /**
   * Review fix (Important 3, decided resolution): when NO complete instance
   * clears RESTART_SPLIT_MIN_SIL (0.35), the group goes report-only — same
   * never-cut-never-keep posture as the hallucination guard, and for the
   * same reason. Both instances here clear 0.35 but neither is hallucinated
   * (both under 0.65): the old "fall back to last complete regardless"
   * behavior would have kept the GAPPIER 0.60-frac instance and cut the
   * cleaner 0.40-frac one — backwards from what the bar exists to prevent.
   */
  it("survivor-bar edge: neither instance clears 0.35 (0.40 vs 0.60) — report-only, nothing cut", () => {
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      { text: "That", start: 2.0, end: 2.3 },
      { text: "is", start: 2.3, end: 2.5 },
      { text: "the", start: 2.5, end: 2.7 },
      { text: "exit", start: 2.7, end: 3.0 },
      { text: "condition.", start: 3.0, end: 3.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 3.9;
    // First instance 0-1.4 (1.4s): 0.40 * 1.4 = 0.56s of silence.
    // Second instance 2.0-3.4 (1.4s): 0.60 * 1.4 = 0.84s of silence.
    const silences: Span[] = [
      { start: 0, end: 0.56 },
      { start: 2.0, end: 2.84 },
    ];
    const analysis = analyze(transcript, silences, duration);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kept).toBeNull();
    expect(g.cuts).toEqual([]);
    expect(g.hallucinated).toEqual([]);
    expect(g.undecided).toHaveLength(2);
    const fracs = g.undecided.map((u) => Math.round(u.silenceFrac * 100)).sort((a, b) => a - b);
    expect(fracs).toEqual([40, 60]);
    // The report says why, and quotes both attempts.
    const report = formatRetakeGroup(transcript, g);
    expect(report).toContain("no cut");
    expect(report).toMatch(/attempt.*"That is the exit condition\."/);
  });

  /**
   * Audit fix (Important 3, executed shape): the old survivor scan fell back
   * to an EARLIER complete instance when the last one failed the bar —
   * silently inverting keep-last at a printed 100% match, with no report
   * hint. Decided resolution: when the LAST complete instance fails the bar,
   * the group goes report-only even if an earlier instance passes — zero
   * cuts, every instance listed with its silenceFrac and a line saying why
   * nothing was decided.
   */
  it("survivor-bar inversion: last complete at 0.375 with a clean earlier attempt — report-only, nothing cut", () => {
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      { text: "That", start: 2.0, end: 2.3 },
      { text: "is", start: 2.3, end: 2.5 },
      { text: "the", start: 2.5, end: 2.7 },
      { text: "exit", start: 2.7, end: 3.0 },
      { text: "condition.", start: 3.0, end: 3.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 3.9;
    // Last instance spans 2.0-3.4 (1.4s): 0.375 * 1.4 = 0.525s of silence,
    // split across two sub-0.35s spans so neither is a restart-split
    // candidate — just over the survivor bar. The earlier attempt is clean.
    const silences: Span[] = [
      { start: 2.05, end: 2.3125 },
      { start: 2.6, end: 2.8625 },
    ];
    const analysis = analyze(transcript, silences, duration);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kept).toBeNull();
    expect(g.cuts).toEqual([]);
    expect(g.undecided).toHaveLength(2);
    const fracs = g.undecided.map((u) => Math.round(u.silenceFrac * 100)).sort((a, b) => a - b);
    expect(fracs).toEqual([0, 37]); // 0.525/1.4 rounds down a hair in float — still over the 0.35 bar
    const report = formatRetakeGroup(transcript, g);
    expect(report).toContain("no cut");
    expect(report).toMatch(/attempt \(0% silence\): "That is the exit condition\."/);
    expect(report).toMatch(/attempt \(37% silence\): "That is the exit condition\."/);
  });
});

/**
 * Exact-prefix restart pass (2026-08-16 field case, output ~3:18): the
 * speaker flubbed "You can use OpenAI." — ASR punctuated the abandoned
 * attempt as COMPLETE — paused, and restarted with "You can use OpenAI
 * models and whatnot." Complete-vs-complete comparison scores the pair
 * honestly divergent (1 − 3/7 ≈ 0.57) and the §128 protection (module doc)
 * correctly refuses the match, so the flub shipped. The pass cuts only the
 * strictly-shorter EARLIER sentence, only on an exact token prefix, and only
 * with a ≥RESTART_SPLIT_MIN_SIL silence in [A.end, B.start +
 * PREFIX_RESTART_SIL_WINDOW] — the window reaches INTO B's stamped words
 * because the incident's pause (silence 201.52–201.93) sat inside B's
 * stretched opening stamps (201.0–203.08), stamp-stretch physics again.
 */
describe("findRetakeGroups: exact-prefix restart pass (2026-08-16 incident)", () => {
  /** The incident fixture, verbatim geometry. */
  function incident(silences: Span[]) {
    const words: Word[] = [
      // A: "You can use OpenAI." 200.0–200.53, complete per ASR.
      { text: "You", start: 200.0, end: 200.13 },
      { text: "can", start: 200.13, end: 200.27 },
      { text: "use", start: 200.27, end: 200.4 },
      { text: "OpenAI.", start: 200.4, end: 200.53 },
      // B: "You can use OpenAI models and whatnot." 201.0–203.08.
      { text: "You", start: 201.0, end: 201.297 },
      { text: "can", start: 201.297, end: 201.594 },
      { text: "use", start: 201.594, end: 201.891 },
      { text: "OpenAI", start: 201.891, end: 202.188 },
      { text: "models", start: 202.188, end: 202.485 },
      { text: "and", start: 202.485, end: 202.782 },
      { text: "whatnot.", start: 202.782, end: 203.08 },
    ];
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, silences, 204);
    return { transcript, analysis };
  }

  it("incident verbatim: cuts the shorter earlier A, keeps B, tagged exact-prefix", () => {
    const { transcript, analysis } = incident([{ start: 201.52, end: 201.93 }]);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.rule).toBe("exact-prefix");
    expect(wordsIn(transcript, g.kept!.startWord, g.kept!.endWord)).toBe(
      "You can use OpenAI models and whatnot.",
    );
    expect(g.cuts).toHaveLength(1);
    expect(wordsIn(transcript, g.cuts[0]!.startWord, g.cuts[0]!.endWord)).toBe(
      "You can use OpenAI.",
    );
    // The report prints the structural evidence, never a bogus "100% match".
    const report = formatRetakeGroup(transcript, g);
    expect(report).toContain('cut (exact-prefix restart, ≥0.35s pause): "You can use OpenAI."');
    expect(report).toContain('kept: "You can use OpenAI models and whatnot."');
  });

  it("no pause, no cut: the same pair without the silence stays untouched", () => {
    const { transcript, analysis } = incident([]);
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("a pause OUTSIDE [A.end, B.start + 1.0s] does not license the cut", () => {
    // Silence entirely after B — real dead air, wrong place: the restart
    // evidence has to sit at the A→B boundary, not anywhere nearby.
    const { transcript, analysis } = incident([{ start: 203.3, end: 203.9 }]);
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("a non-prefix earlier sentence is never cut, pause or not", () => {
    const words: Word[] = [
      { text: "You", start: 200.0, end: 200.13 },
      { text: "can", start: 200.13, end: 200.27 },
      { text: "use", start: 200.27, end: 200.4 },
      { text: "Claude.", start: 200.4, end: 200.53 },
      { text: "You", start: 201.0, end: 201.297 },
      { text: "can", start: 201.297, end: 201.594 },
      { text: "use", start: 201.594, end: 201.891 },
      { text: "OpenAI", start: 201.891, end: 202.188 },
      { text: "models", start: 202.188, end: 202.485 },
      { text: "and", start: 202.485, end: 202.782 },
      { text: "whatnot.", start: 202.782, end: 203.08 },
    ];
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 201.52, end: 201.93 }], 204);
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("equal token counts are never an exact-prefix pair — strictly shorter only", () => {
    // Same length, one differing final token: 0.75 similarity keeps the
    // ordinary passes out, and the equal length keeps the prefix pass out.
    const words: Word[] = [
      { text: "You", start: 200.0, end: 200.13 },
      { text: "can", start: 200.13, end: 200.27 },
      { text: "use", start: 200.27, end: 200.4 },
      { text: "OpenAI.", start: 200.4, end: 200.53 },
      { text: "You", start: 201.0, end: 201.3 },
      { text: "can", start: 201.3, end: 201.94 },
      { text: "use", start: 201.94, end: 202.2 },
      { text: "Claude.", start: 202.2, end: 202.5 },
    ];
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 201.52, end: 201.93 }], 203);
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  /**
   * The §128 protection this pass NARROWS but must not repeal: the verified
   * repro where the prefix rule's old misuse cut the LONGER continuation.
   * The exact-prefix pass points the other way (it can only cut the shorter
   * EARLIER side), and its pause requirement isn't met by ordinary breath
   * gaps — the reviewer-repro test above ("a longer continuation is not a
   * retake of a shorter line") stays green alongside this pin.
   */
  it("§128 pin: 'Let me show you this.' followed by its longer continuation still cuts NOTHING", () => {
    const { transcript, analysis } = speak(
      "Let me show you this. Let me show you this whole thing in detail",
    );
    expect(findRetakeGroups(transcript, analysis)).toEqual([]);
  });

  it("claimed dedupe: a sentence already decided by the similarity pass is not re-decided", () => {
    // A1 and A2 are verbatim retakes — the ordinary pass cuts A1 and keeps
    // A2, claiming both. A2 is ALSO an exact prefix of B with a pause in the
    // window, but a word an earlier pass decided (even as "kept") is not
    // re-decidable: one group, no exact-prefix rule, B untouched.
    const words: Word[] = [
      { text: "You", start: 100.0, end: 100.13 },
      { text: "can", start: 100.13, end: 100.27 },
      { text: "use", start: 100.27, end: 100.4 },
      { text: "OpenAI.", start: 100.4, end: 100.53 },
      { text: "You", start: 100.8, end: 100.93 },
      { text: "can", start: 100.93, end: 101.07 },
      { text: "use", start: 101.07, end: 101.2 },
      { text: "OpenAI.", start: 101.2, end: 101.33 },
      { text: "You", start: 102.0, end: 102.297 },
      { text: "can", start: 102.297, end: 102.594 },
      { text: "use", start: 102.594, end: 102.891 },
      { text: "OpenAI", start: 102.891, end: 103.188 },
      { text: "models", start: 103.188, end: 103.485 },
      { text: "and", start: 103.485, end: 103.782 },
      { text: "whatnot.", start: 103.782, end: 104.08 },
    ];
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 102.52, end: 102.93 }], 105);
    const groups = findRetakeGroups(transcript, analysis);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rule).toBeUndefined();
    expect(wordsIn(transcript, groups[0]!.kept!.startWord, groups[0]!.kept!.endWord)).toBe(
      "You can use OpenAI.",
    );
    // B never enters any group.
    for (const g of groups) {
      const members = [g.kept, ...g.cuts, ...g.hallucinated, ...g.undecided];
      for (const m of members) {
        if (m) expect(m.endWord).toBeLessThan(8);
      }
    }
  });

  it("exact-prefix cuts flow through buildCutlist like any other retake", () => {
    const { transcript, analysis } = incident([{ start: 201.52, end: 201.93 }]);
    const groups = findRetakeGroups(transcript, analysis);
    const cut = buildCutlist({
      transcript,
      analysis,
      duration: 204,
      level: "standard",
      retakes: groups.flatMap((g) => g.cuts),
    });
    const map = new TimeMap(cut);
    // A is gone; B survives whole.
    for (let i = 0; i <= 3; i++) expect(map.mapWord(transcript.words[i]!)).toBeNull();
    for (let i = 4; i <= 10; i++) expect(map.mapWord(transcript.words[i]!)).not.toBeNull();
  });
});

describe("formatRetakeGroup", () => {
  it("quotes kept, cut (with similarity) and hallucinated (with silenceFrac) lines", () => {
    const { transcript, analysis } = speak(
      "That is the exit condition. That is the exit condition.",
    );
    const g = findRetakeGroups(transcript, analysis)[0]!;
    const report = formatRetakeGroup(transcript, g);
    expect(report).toContain('kept: "That is the exit condition."');
    expect(report).toMatch(/cut.*"That is the exit condition\."/);
  });

  it("reports the hallucination line with its silence fraction", () => {
    const words: Word[] = [
      { text: "That", start: 0, end: 0.3 },
      { text: "is", start: 0.3, end: 0.5 },
      { text: "the", start: 0.5, end: 0.7 },
      { text: "exit", start: 0.7, end: 1.0 },
      { text: "condition.", start: 1.0, end: 1.4 },
      { text: "That", start: 2.0, end: 2.1 },
      { text: "is", start: 5.0, end: 5.1 },
      { text: "the", start: 8.0, end: 8.1 },
      { text: "exit", start: 11.0, end: 11.1 },
      { text: "condition.", start: 14.0, end: 14.4 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 14.9;
    const analysis = analyze(transcript, [{ start: 1.4, end: 14.9 }], duration);
    const g = findRetakeGroups(transcript, analysis)[0]!;
    const report = formatRetakeGroup(transcript, g);
    expect(report).toMatch(/hallucination.*"That is the exit condition\."/);
  });
});

describe("retake groups through buildCutlist", () => {
  const { transcript, analysis, duration } = speak(
    "That is the exit condition. That is the exit condition.",
  );

  it("injection: emits the reserved retake reason via the new retakes arg", () => {
    const groups = findRetakeGroups(transcript, analysis);
    const cut = buildCutlist({
      transcript,
      analysis,
      duration,
      level: "standard",
      retakes: groups.flatMap((g) => g.cuts),
    });
    const retakeSegs = cut.filter((s) => s.kind === "remove" && s.reason === "retake");
    expect(retakeSegs).toHaveLength(1);
  });

  it("--cleanup exact still means exact, even with a retake found", () => {
    const groups = findRetakeGroups(transcript, analysis);
    const cut = buildCutlist({
      transcript,
      analysis,
      duration,
      level: "exact",
      retakes: groups.flatMap((g) => g.cuts),
    });
    expect(cut).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });

  it("stays a full partition of [0, duration] and the TimeMap invariant holds", () => {
    const groups = findRetakeGroups(transcript, analysis);
    const cut = buildCutlist({
      transcript,
      analysis,
      duration,
      level: "standard",
      retakes: groups.flatMap((g) => g.cuts),
    });
    let cursor = 0;
    for (const s of cut) {
      expect(s.srcIn).toBeCloseTo(cursor, 9);
      cursor = s.srcOut;
    }
    expect(cursor).toBeCloseTo(duration, 9);
    const map = new TimeMap(cut);
    const kept = cut.filter((s) => s.kind === "keep").reduce((a, s) => a + (s.srcOut - s.srcIn), 0);
    expect(map.outputDuration).toBeCloseTo(kept, 9);
  });

  /**
   * Review fix (Important 4): the previous version of this test used the
   * describe block's shared fixture, whose default speak() gap (0.1s) is
   * under standard's 0.7s pauseMin — no silence removal was ever produced,
   * so there was nothing to merge with and the assertion could not fail for
   * the reason its own comment claimed. Rebuilt with its own fixture: a real
   * 1.2s pause (standard's `silence`-reason interior branch) sitting directly
   * against the retake cut it follows — §124's exact shape, now actually
   * exercised.
   */
  it("silence-merge shape (§124): a retake cut merges with the acoustic silence bracketing it, no wordless sliver survives", () => {
    const shape = speak("That is the exit condition. That is the exit condition.", {
      4: 1.2, // pause after "condition." (index 4) — well above standard's 0.7s pauseMin
    });
    const groups = findRetakeGroups(shape.transcript, shape.analysis);
    const retakes = groups.flatMap((g) => g.cuts);
    expect(retakes).toHaveLength(1);
    const cut = buildCutlist({
      transcript: shape.transcript,
      analysis: shape.analysis,
      duration: shape.duration,
      level: "standard",
      retakes,
    });
    const removals = cut.filter((s) => s.kind === "remove");
    // The retake cut and the acoustic pause right after it fold into ONE
    // removal — not two removals with a wordless keep-sliver between them.
    expect(removals).toHaveLength(1);
    expect(removals[0]!.srcIn).toBeCloseTo(retakes[0]!.startSec, 5);
    // The merged removal extends past the retake's own end — proof the
    // silence actually folded in rather than surviving as its own removal.
    expect(removals[0]!.srcOut).toBeGreaterThan(retakes[0]!.endSec);
    // The kept take, on the far side of the merged cut, survives intact.
    const map = new TimeMap(cut);
    const kept = groups[0]!.kept!;
    const survives = shape.transcript.words
      .slice(kept.startWord, kept.endWord + 1)
      .every((w) => map.mapWord(w) !== null);
    expect(survives).toBe(true);
  });

  it("sanity valve: an over-broad retake span still falls back to keep-everything", () => {
    // Mirrors cutlist.test.ts's own valve test, but the thing claiming the
    // whole take is a `retakes` entry instead of a giant silence — the valve
    // must not care WHICH reason nearly emptied the timeline.
    const emptyTranscript: Transcript = { language: "en", words: [] };
    const emptyDuration = 10;
    const emptyAnalysis = analyze(emptyTranscript, [], emptyDuration);
    const cut = buildCutlist({
      transcript: emptyTranscript,
      analysis: emptyAnalysis,
      duration: emptyDuration,
      level: "standard",
      retakes: [{ startWord: 0, endWord: 0, startSec: 0, endSec: emptyDuration }],
    });
    expect(cut).toEqual([{ srcIn: 0, srcOut: emptyDuration, kind: "keep" }]);
  });
});
