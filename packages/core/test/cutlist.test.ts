import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze";
import { buildCutlist } from "../src/cutlist";
import { TimeMap } from "../src/timemap";
import type { Span, Transcript, Word } from "../src/schema";

/** Build words back-to-back with given (text, duration, gapAfter) triples. */
function makeWords(triples: Array<[string, number, number]>, leadIn = 0): Word[] {
  const words: Word[] = [];
  let t = leadIn;
  for (const [text, dur, gap] of triples) {
    words.push({ text, start: t, end: t + dur });
    t += dur + gap;
  }
  return words;
}

/** Acoustic silences that mirror the transcript gaps exactly (ideal detector). */
function silencesFromGaps(words: Word[], duration: number, leadIn: number): Span[] {
  const spans: Span[] = [];
  if (leadIn > 0) spans.push({ start: 0, end: words[0]!.start });
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (b.start - a.end > 0.05) spans.push({ start: a.end, end: b.start });
  }
  const last = words[words.length - 1]!;
  if (duration - last.end > 0.05) spans.push({ start: last.end, end: duration });
  return spans;
}

function setup(triples: Array<[string, number, number]>, opts: { leadIn?: number; tail?: number } = {}) {
  const leadIn = opts.leadIn ?? 0;
  const words = makeWords(triples, leadIn);
  const duration = words[words.length - 1]!.end + (opts.tail ?? 0);
  const transcript: Transcript = { language: "en", words };
  const silences = silencesFromGaps(words, duration, leadIn);
  const analysis = analyze(transcript, silences, duration);
  return { transcript, analysis, duration };
}

describe("buildCutlist", () => {
  it("exact level keeps everything", () => {
    const { transcript, analysis, duration } = setup([
      ["hello", 0.3, 0.1],
      ["world", 0.3, 0],
    ]);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "exact" });
    expect(cutlist).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });

  it("tightens a long mid-take pause at standard level", () => {
    const { transcript, analysis, duration } = setup([
      ["before", 0.4, 1.6], // 1.6 s pause — well above the 0.7 s threshold
      ["after", 0.4, 0],
    ]);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals).toHaveLength(1);
    const r = removals[0]!;
    expect(r.reason).toBe("silence");
    // Resulting gap should be ≈ tightenTo (0.22 s).
    const map = new TimeMap(cutlist);
    const removed = duration - map.outputDuration;
    expect(removed).toBeCloseTo(1.6 - 0.22, 5);
  });

  it("leaves short pauses alone at standard, cuts them at aggressive", () => {
    const { transcript, analysis, duration } = setup([
      ["a", 0.3, 0.6], // 0.6 s pause: below standard's 0.7, above aggressive's 0.5
      ["b", 0.3, 0],
    ]);
    const std = buildCutlist({ transcript, analysis, duration, level: "standard" });
    expect(std.filter((s) => s.kind === "remove")).toHaveLength(0);
    const agg = buildCutlist({ transcript, analysis, duration, level: "aggressive" });
    expect(agg.filter((s) => s.kind === "remove")).toHaveLength(1);
  });

  it("removes standalone fillers at standard but not at light", () => {
    const { transcript, analysis, duration } = setup([
      ["so", 0.2, 0.1],
      ["um", 0.3, 0.1],
      ["anyway", 0.4, 0],
    ]);
    expect(analysis.fillers).toHaveLength(1);
    const std = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const fillerCuts = std.filter((s) => s.kind === "remove" && s.reason === "filler");
    expect(fillerCuts).toHaveLength(1);
    const light = buildCutlist({ transcript, analysis, duration, level: "light" });
    expect(light.filter((s) => s.reason === "filler")).toHaveLength(0);
  });

  it("filler cuts never bite into neighboring words", () => {
    const { transcript, analysis, duration } = setup([
      ["tight", 0.3, 0.05],
      ["um", 0.25, 0.05],
      ["squeeze", 0.3, 0],
    ]);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const words = transcript.words;
    for (const r of cutlist.filter((s) => s.kind === "remove")) {
      for (const w of [words[0]!, words[2]!]) {
        const overlap = Math.min(r.srcOut, w.end) - Math.max(r.srcIn, w.start);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it("trims leading dead air to a fast start", () => {
    const { transcript, analysis, duration } = setup([["hello", 0.3, 0.1], ["there", 0.3, 0]], {
      leadIn: 2.0,
    });
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const firstSeg = cutlist[0]!;
    expect(firstSeg.kind).toBe("remove");
    const map = new TimeMap(cutlist);
    // First word should now start ≈ LEAD_KEEP (0.25 s) into the output.
    expect(map.toOutput(2.0)).toBeLessThanOrEqual(0.26);
  });

  it("trims trailing dead air", () => {
    const { transcript, analysis, duration } = setup([["bye", 0.3, 0]], { tail: 3.0 });
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const lastSeg = cutlist[cutlist.length - 1]!;
    expect(lastSeg.kind).toBe("remove");
    const map = new TimeMap(cutlist);
    expect(map.outputDuration).toBeCloseTo(0.3 + 0.35, 3);
  });

  it("cutlist is always a full, non-overlapping partition", () => {
    const { transcript, analysis, duration } = setup(
      [
        ["one", 0.3, 1.5],
        ["um", 0.2, 0.9],
        ["two", 0.3, 0.05],
        ["three", 0.3, 2.2],
        ["four", 0.3, 0],
      ],
      { leadIn: 1.0, tail: 2.0 },
    );
    for (const level of ["light", "standard", "aggressive"] as const) {
      const cutlist = buildCutlist({ transcript, analysis, duration, level });
      let cursor = 0;
      for (const s of cutlist) {
        expect(s.srcIn).toBeCloseTo(cursor, 6);
        expect(s.srcOut).toBeGreaterThan(s.srcIn);
        cursor = s.srcOut;
      }
      expect(cursor).toBeCloseTo(duration, 6);
    }
  });

  it("falls back to keep-everything when analysis would delete the whole take", () => {
    const transcript: Transcript = { language: "en", words: [] };
    const duration = 10;
    const analysis = analyze(transcript, [{ start: 0, end: duration }], duration);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "aggressive" });
    expect(cutlist).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });
});

/**
 * R27 §127. Lead and tail used to be identified by comparing the silence to a
 * word stamp, and whisper's `-ml 1` stamps stretch to fill gaps. On a real
 * take the first word was stamped 0.00-0.53 across silence that plainly starts
 * at 0.00, so `pause.end <= first.start` was false; the opening dead air fell
 * through to the interior rule, was shorter than `pauseMin`, and survived. The
 * tail failed the same way by a 0.07s overlap, leaving the speaker on screen
 * looking down after the last word.
 */
describe("lead and tail are decided by position in the file (§127)", () => {
  /** The measured shape of the real failure: stamps that cover the silence. */
  const stretched = (duration: number) => {
    const words: Word[] = [
      { text: "Video", start: 0, end: 0.53 }, // stamp covers the 0-0.53 silence
      { text: "editing", start: 0.53, end: 1.1 },
      { text: "is", start: 1.1, end: 1.4 },
      { text: "hard.", start: 1.4, end: duration - 0.53 },
    ];
    const transcript: Transcript = { language: "en", words };
    // Real dead air at both ends, overlapping those stretched stamps.
    const silences: Span[] = [
      { start: 0, end: 0.53 },
      { start: duration - 0.6, end: duration },
    ];
    // Levels, as the CLI supplies them: this is what lets `analyze` override
    // its own veto when a word is stamped over measurably dead air.
    const windowSec = 0.1;
    const windowsDb = Array.from({ length: Math.ceil(duration / windowSec) }, (_, i) => {
      const t = i * windowSec;
      return t < 0.53 || t >= duration - 0.6 ? -58 : -14;
    });
    return {
      transcript,
      analysis: analyze(transcript, silences, duration, { windowsDb, windowSec, speechDb: -14 }),
      duration,
    };
  };

  it("trims opening dead air even when the first word's stamp covers it", () => {
    const { transcript, analysis, duration } = stretched(10);
    const cut = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const lead = cut.find((s) => s.kind === "remove" && s.srcIn === 0);
    expect(lead, "opening silence was not cut").toBeDefined();
    // Speech starts at 0.53; LEAD_KEEP = 0.25 of run-up survives.
    expect(lead!.srcOut).toBeCloseTo(0.28, 2);
  });

  it("trims trailing dead air even when the last stamp bleeds into it", () => {
    const { transcript, analysis, duration } = stretched(10);
    const cut = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const tail = cut.find((s) => s.kind === "remove" && Math.abs(s.srcOut - duration) < 1e-6);
    expect(tail, "trailing silence was not cut").toBeDefined();
    // TAIL_KEEP = 0.35 past where speech actually stops.
    expect(tail!.srcIn).toBeCloseTo(duration - 0.6 + 0.35, 2);
  });

  it("aggressive breathes less at the ends than standard", () => {
    // A short that LOOPS shows every frame of post-speech dead air on repeat,
    // so "cut harder" has to reach the ends too — the fixed keeps were the one
    // thing --cleanup aggressive could not tighten.
    const tailStart = (level: "light" | "standard" | "aggressive"): number => {
      const { transcript, analysis, duration } = stretched(10);
      const cut = buildCutlist({ transcript, analysis, duration, level });
      return cut.find((s) => s.kind === "remove" && Math.abs(s.srcOut - duration) < 1e-6)!.srcIn;
    };
    expect(tailStart("aggressive")).toBeLessThan(tailStart("standard"));
    expect(tailStart("standard")).toBeLessThan(tailStart("light"));
  });

  it("cuts both ends regardless of cleanup level, since neither is a 'pause'", () => {
    // The bug's real sting: these are shorter than `standard`'s 0.7s pauseMin,
    // so misclassifying them as interior pauses silently kept them.
    for (const level of ["light", "standard", "aggressive"] as const) {
      const { transcript, analysis, duration } = stretched(10);
      const cut = buildCutlist({ transcript, analysis, duration, level });
      const removals = cut.filter((s) => s.kind === "remove");
      expect(removals.length, `${level} kept the ends`).toBeGreaterThanOrEqual(2);
    }
  });

  it("still leaves the take alone when there is no dead air at either end", () => {
    const { transcript, analysis, duration } = setup([["a", 0.4, 0], ["b", 0.4, 0]]);
    const cut = buildCutlist({ transcript, analysis, duration, level: "standard" });
    expect(cut).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });
});

/**
 * Findings §124. A 0.37s wordless sliver survived a real cleanup run between
 * two `silence` removals: the acoustic detector split one continuous 9.76s
 * dead-air stretch into two silences (a ~150ms transient inside it), and the
 * merge condition only asked `hasProtectedWordInside` when the resulting
 * keep-gap was already under MIN_KEEP — so a wordless gap that cleared
 * MIN_KEEP (0.37s > 0.25s) was never asked the question and shipped as a
 * `keep`, despite holding zero transcript words and sitting between two
 * `silence` cuts.
 */
describe("wordless slivers between removals fold in regardless of MIN_KEEP (§124)", () => {
  /**
   * Two acoustic silences with a small non-silent island between them, inside
   * one continuous transcript gap that holds zero words — the exact shape of
   * the field bug. `island` is the raw acoustic gap between the two silence
   * spans; standard-level tightening (pad 0.088s in, 0.132s out) turns it into
   * the surviving keep-gap the merge step must decide about.
   */
  function twoSilencesWithIsland(island: number) {
    const words: Word[] = [
      { text: "before", start: 0, end: 0.4 },
      { text: "after", start: 20, end: 20.3 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 20.3;
    // Silence spans deliberately NOT contiguous — mirrors `silencedetect`
    // finding two spans, not one, per §124's evidence chain.
    const silences: Span[] = [
      { start: 0.4, end: 9 },
      { start: 9 + island, end: 20 },
    ];
    const analysis = analyze(transcript, silences, duration);
    return { transcript, analysis, duration };
  }

  it("folds a wordless gap wider than MIN_KEEP into one continuous removal", () => {
    // island=0.4 -> post-tighten keep-gap = 0.62s (> MIN_KEEP's 0.25s, well
    // under standard's pauseMin of 0.7s) — same order of magnitude as the
    // field's 0.37s sliver, deliberately kept above MIN_KEEP to pin the bug.
    const { transcript, analysis, duration } = twoSilencesWithIsland(0.4);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals, "the two silences must merge into one removal, no keep sliver between them").toHaveLength(1);
    expect(removals[0]!.reason).toBe("silence");
  });

  it("still leaves a short gap alone when a protected word sits inside it", () => {
    // Two filler cuts bracketing a real word ("no") in a window under
    // MIN_KEEP — the paired guard: word protection must still beat the
    // length gate, exactly as before this fix (unchanged behavior).
    const words: Word[] = [
      { text: "um", start: 0, end: 0.2 },
      { text: "no", start: 0.22, end: 0.24 },
      { text: "um", start: 0.26, end: 0.46 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 0.46;
    const analysis = analyze(transcript, [], duration);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const kept = cutlist.filter((s) => s.kind === "keep");
    const survivor = kept.find((s) => s.srcIn > 0 && s.srcIn < 0.46 && s.srcOut - s.srcIn < 0.25);
    expect(survivor, "the sliver holding the real word 'no' must survive as its own keep").toBeDefined();
  });

  it("does NOT fold a wordless gap longer than the level's pauseMin", () => {
    // island=1.4 -> post-tighten keep-gap = 1.62s, above standard's 0.7s
    // pauseMin. If this whole gap were genuinely silent, the interior-pause
    // branch above would already have cut it as its own removal (a `pauseDur
    // > pauseMin` silence is the only case that branch doesn't `continue`
    // past) — so a wordless-per-transcript gap this long, surviving as bare
    // space between two OTHER removals, means the acoustic detector measured
    // real audio there and declined to call it silence. Folding it anyway,
    // on the transcript's word-count alone, would eat that live content.
    // Pins the outer sanity bound decided in Task 6's report (§124's fix
    // task, judgment point (a)).
    const { transcript, analysis, duration } = twoSilencesWithIsland(1.4);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals, "a >pauseMin wordless gap must stay a separate keep, not fold away").toHaveLength(2);
  });

  it("folds a gap that lands exactly on the pauseMin boundary (inclusive)", () => {
    // Aggressive level (pauseMin=0.5, tightenTo=0.18) hits the boundary with
    // exact float equality: island=0.32 -> pad-in 0.072, pad-out 0.108 ->
    // post-tighten gap = 9.392 - 8.892 = 0.5 === policy.pauseMin exactly.
    // The merge condition is `gap <= pauseMin`, so equality must still fold.
    const { transcript, analysis, duration } = twoSilencesWithIsland(0.32);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "aggressive" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals, "a gap exactly at pauseMin must still fold (inclusive boundary)").toHaveLength(1);
  });

  it("chains a fold across three removals with two consecutive wordless gaps", () => {
    // before/silence/silence/silence/after — the same wordless-transcript-gap
    // shape as the field bug, but the acoustic detector split it into THREE
    // silences (two transient islands) instead of two. Both post-tighten
    // gaps (0.52s and 0.42s) are wordless and under standard's 0.7s pauseMin,
    // so the merge loop must chain both folds into a single removal, not
    // stop after merging only the first pair.
    const words: Word[] = [
      { text: "before", start: 0, end: 0.4 },
      { text: "after", start: 30, end: 30.3 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 30.3;
    const silences: Span[] = [
      { start: 0.4, end: 9 },
      { start: 9.3, end: 18 },
      { start: 18.2, end: 30 },
    ];
    const analysis = analyze(transcript, silences, duration);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals, "all three silences must chain into one removal, not stop at the first merge").toHaveLength(1);
    expect(removals[0]!.reason).toBe("silence");
  });
});

describe("§124's fold does not eat a filler light promises to keep (fix wave final review)", () => {
  it("does not fold a lone filler between two silences at light, where removeFillers is false", () => {
    // Two acoustic silences, each independently longer than light's 1.2s
    // pauseMin (so both become their own removal via the interior-pause
    // branch), bracketing a single spoken "um" that neither silence span
    // overlaps — the field shape "…[pause] um [pause]…". At `light`,
    // `removeFillers` is false: the filler is never scheduled for removal at
    // all, so the §124 wordless-gap fold (widened by Task 6 to reach up to
    // `pauseMin`, 1.2s here) must not treat the gap holding it as wordless.
    const words: Word[] = [
      { text: "before", start: 0, end: 0.4 },
      { text: "um", start: 2.0, end: 2.2 },
      { text: "after", start: 4.0, end: 4.3 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 4.3;
    const silences: Span[] = [
      { start: 0.4, end: 1.9 }, // duration 1.5s > light's pauseMin (1.2s)
      { start: 2.3, end: 3.9 }, // duration 1.6s > light's pauseMin (1.2s)
    ];
    const analysis = analyze(transcript, silences, duration);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "light" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(
      removals,
      "the two silences must stay separate removals — folding them merges away the kept 'um'",
    ).toHaveLength(2);
    const survivor = cutlist.find(
      (s) => s.kind === "keep" && s.srcIn <= 2.0 && s.srcOut >= 2.2,
    );
    expect(
      survivor,
      "the kept sliver holding 'um' must survive — light's contract is removeFillers: false",
    ).toBeDefined();
  });

  it("still folds the same wordless-gap shape at standard, where the filler IS removed anyway", () => {
    // Same acoustic geometry, standard level: `removeFillers` is true, so
    // "um" gets its own filler removal and the whole stretch collapses to
    // one continuous cut — regression guard that the light-only carve-out
    // above doesn't change already-correct behavior at other levels.
    const words: Word[] = [
      { text: "before", start: 0, end: 0.4 },
      { text: "um", start: 2.0, end: 2.2 },
      { text: "after", start: 4.0, end: 4.3 },
    ];
    const transcript: Transcript = { language: "en", words };
    const duration = 4.3;
    const silences: Span[] = [
      { start: 0.4, end: 1.9 },
      { start: 2.3, end: 3.9 },
    ];
    const analysis = analyze(transcript, silences, duration);
    const cutlist = buildCutlist({ transcript, analysis, duration, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals).toHaveLength(1);
  });
});
