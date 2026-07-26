import { describe, expect, it } from "vitest";
import { analyze, deriveThreshold, percentile, subtractSpans } from "../src/analyze";
import { buildCutlist } from "../src/cutlist";
import type { Span, Transcript, Word } from "../src/schema";

/**
 * Whisper `-ml 1` output as it actually arrives: word stamps are contiguous,
 * so a pause is absorbed into the preceding word's duration and NO transcript
 * gap exists where the silence is. Measured on real footage: 164/167
 * boundaries contiguous. Any rule requiring a transcript gap cuts nothing.
 */
function contiguousWords(triples: Array<[string, number]>, leadIn = 0): Word[] {
  const words: Word[] = [];
  let t = leadIn;
  for (const [text, dur] of triples) {
    words.push({ text, start: t, end: t + dur });
    t += dur;
  }
  return words;
}

describe("deriveThreshold", () => {
  it("tracks the speech level, not the noise-floor midpoint", () => {
    // Real footage: floor −45.7, speech −14.3. The midpoint (−30) sits BELOW
    // the room tone's peaks and finds nothing; speech − 12 clears them.
    expect(deriveThreshold(-45.7, -14.3)).toBeCloseTo(-26.3, 1);
  });

  it("tracks a hot take upward instead of no-opping at a fixed -35 dB", () => {
    // Loud lav mic: a fixed -35 dB threshold finds almost nothing.
    expect(deriveThreshold(-40, -10)).toBeGreaterThan(-35);
  });

  it("never lands above the speech level or on top of the noise floor", () => {
    expect(deriveThreshold(-30, -2)).toBe(-20); // ceiling
    expect(deriveThreshold(-100, -50)).toBe(-58); // speech − 8, not the −40 clamp
    // No usable dynamic range: fall back to the midpoint rather than a clamp
    // that would classify the speech itself as silence.
    expect(deriveThreshold(-90, -80)).toBe(-85);
  });

  it("always leaves the threshold below the speech level", () => {
    for (const [floor, speech] of [
      [-57.6, -14.3],
      [-45, -20],
      [-30, -12],
      [-70, -60],
    ] as const) {
      expect(deriveThreshold(floor, speech)).toBeLessThan(speech);
    }
  });
});

describe("percentile", () => {
  it("indexes a sorted series", () => {
    const s = [-60, -50, -40, -30, -20];
    expect(percentile(s, 0)).toBe(-60);
    expect(percentile(s, 1)).toBe(-20);
    expect(percentile(s, 0.5)).toBe(-40);
  });
});

describe("subtractSpans", () => {
  it("splits a span around a blocker", () => {
    expect(subtractSpans({ start: 0, end: 10 }, [{ start: 4, end: 6 }])).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ]);
  });

  it("ignores non-overlapping blockers and clips partial ones", () => {
    expect(subtractSpans({ start: 0, end: 10 }, [{ start: 10, end: 12 }])).toEqual([{ start: 0, end: 10 }]);
    expect(subtractSpans({ start: 0, end: 10 }, [{ start: -5, end: 3 }])).toEqual([{ start: 3, end: 10 }]);
  });
});

describe("analyze — acoustics decide, transcript vetoes", () => {
  it("finds cuttable silence even when whisper reports no gap at all", () => {
    // "before" is stretched across the 1.6 s pause, exactly as whisper does it.
    const words = contiguousWords([
      ["before", 2.0], // 0.4 s of speech + 1.6 s of silence, one stamp
      ["after", 0.4],
    ]);
    const transcript: Transcript = { language: "en", words };
    const silences: Span[] = [{ start: 0.4, end: 2.0 }];
    const analysis = analyze(transcript, silences, 2.4);

    expect(analysis.gaps).toHaveLength(0); // the old "agree" rule had nothing to agree with
    expect(analysis.cuttable).toEqual([{ start: 0.4, end: 2.0 }]);

    const cutlist = buildCutlist({ transcript, analysis, duration: 2.4, level: "standard" });
    const removals = cutlist.filter((s) => s.kind === "remove");
    expect(removals).toHaveLength(1);
    expect(removals[0]!.srcIn).toBeCloseTo(0.488, 3);
    expect(removals[0]!.srcOut).toBeCloseTo(1.868, 3);
  });

  it("vetoes a silence that wholly contains a non-filler word", () => {
    const words = contiguousWords([["yes", 0.3]], 1.0); // word at 1.0–1.3
    const analysis = analyze({ language: "en", words }, [{ start: 0.5, end: 2.5 }], 3.0);
    expect(analysis.cuttable).toEqual([
      { start: 0.5, end: 1.0 },
      { start: 1.3, end: 2.5 },
    ]);
  });

  it("does not veto for a filler word — that is the point of cutting it", () => {
    const words = contiguousWords([["um", 0.3]], 1.0);
    const analysis = analyze({ language: "en", words }, [{ start: 0.5, end: 2.5 }], 3.0);
    expect(analysis.fillers).toHaveLength(1);
    expect(analysis.cuttable).toEqual([{ start: 0.5, end: 2.5 }]);
  });

  it("overrides the veto when the region measures as dead air", () => {
    // Whisper stamping words over 3 s of room tone — observed on real footage
    // once lead-in silence was prepended. Mean energy says otherwise.
    const words = contiguousWords([["861%", 1.8], ["that", 0.6], ["is", 0.7]]);
    // 3.1 s of dead air, then the speech onset straddling the region's edge —
    // the window that makes an energy average read −26 dB instead of −49 dB.
    const windowsDb = Array.from({ length: 40 }, (_, i) => (i >= 31 ? -11 : -49));
    const analysis = analyze({ language: "en", words }, [{ start: 0, end: 3.12 }], 4.0, {
      windowsDb,
      windowSec: 0.1,
      speechDb: -14.9,
    });
    expect(analysis.cuttable).toEqual([{ start: 0, end: 3.12 }]);
  });

  it("keeps the veto when the region is merely quiet speech", () => {
    const words = contiguousWords([["softly", 0.5], ["spoken", 0.5]]);
    const windowsDb = Array.from({ length: 40 }, () => -28); // 13 dB under speech
    const analysis = analyze({ language: "en", words }, [{ start: 0, end: 2.0 }], 2.0, {
      windowsDb,
      windowSec: 0.1,
      speechDb: -14.9,
    });
    expect(analysis.cuttable).toEqual([{ start: 1.0, end: 2.0 }]);
  });

  it("drops slivers below the minimum cuttable length", () => {
    const analysis = analyze({ language: "en", words: [] }, [{ start: 0, end: 0.05 }], 1.0);
    expect(analysis.cuttable).toHaveLength(0);
  });

  it("keeps a safety pad at both ends of every silence-derived cut", () => {
    const words = contiguousWords([["a", 3.0], ["b", 0.4]]);
    const transcript: Transcript = { language: "en", words };
    const analysis = analyze(transcript, [{ start: 0.4, end: 3.0 }], 3.4);
    const cutlist = buildCutlist({ transcript, analysis, duration: 3.4, level: "aggressive" });
    const r = cutlist.find((s) => s.kind === "remove")!;
    expect(r.srcIn - 0.4).toBeGreaterThanOrEqual(0.06);
    expect(3.0 - r.srcOut).toBeGreaterThanOrEqual(0.1);
  });
});
