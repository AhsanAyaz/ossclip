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
