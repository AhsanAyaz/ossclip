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
    // ordinary earlier duplicate, not flagged as hallucinated.
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
    // Second instance spans 2.0-3.4 (1.4s); pack it with 0.64 * 1.4 = 0.896s
    // of silence via one span landing inside it.
    const silences: Span[] = [{ start: 2.0, end: 2.896 }];
    const analysis = analyze(transcript, silences, duration);
    const g = findRetakeGroups(transcript, analysis)[0]!;
    expect(g.hallucinated).toEqual([]);
    expect(g.cuts).toHaveLength(1);
    expect(g.cuts[0]!.similarity).toBeGreaterThanOrEqual(RETAKE_SIM_THRESHOLD);
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
