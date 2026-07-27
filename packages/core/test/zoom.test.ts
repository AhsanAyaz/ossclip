import { describe, expect, it } from "vitest";
import type { CaptionLine } from "../src/captions";
import { ZOOM_MAX_SCALE, buildZoomPlan, zoomScaleAt } from "../src/zoom";

/**
 * Caption lines as the pipeline really produces them: ≤3 words, ≤1.2 s, and
 * CONTIGUOUS word stamps — whisper `-ml 1` never leaves inter-word gaps, which
 * is the whole reason §18 existed. Any test built on gapped words would pass
 * against a driver that ships broken.
 */
function contiguousLines(duration: number, wordsPerLine = 3, wordSec = 0.4): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let t = 0;
  while (t < duration) {
    const words = [];
    for (let i = 0; i < wordsPerLine && t < duration; i++) {
      const end = Math.min(t + wordSec, duration);
      words.push({ text: `w${lines.length}-${i}`, start: t, end });
      t = end; // contiguous: this word's end IS the next word's start
    }
    if (words.length > 0) {
      lines.push({ words, start: words[0]!.start, end: words[words.length - 1]!.end });
    }
  }
  return lines;
}

const DURATION = 60;

describe("zoom boundaries (FINDINGS §18)", () => {
  it("uses measured pauses when they exist, and says so", () => {
    const pauses = [4, 11, 19, 26, 34, 41, 49].map((s) => ({ start: s, end: s + 0.2 }));
    const plan = buildZoomPlan(contiguousLines(DURATION), DURATION, { pauses });
    expect(plan.source).toBe("acoustic");
    expect(plan.boundaries).toBe(7);
  });

  it("reverses at the MIDDLE of a pause, not where speech stops", () => {
    const plan = buildZoomPlan([], 20, { pauses: [{ start: 9, end: 11 }] });
    const edges = plan.segments.map((s) => s.endSec);
    // The pause spans 9–11; the reversal belongs at 10, where the eased curve
    // is momentarily still — not at 9 (speech stops) or 11 (speech resumes).
    expect(edges.some((e) => Math.abs(e - 10) < 1e-6)).toBe(true);
    expect(edges.some((e) => Math.abs(e - 9) < 1e-6)).toBe(false);
  });

  it("falls back to caption lines when no pause was measured", () => {
    const plan = buildZoomPlan(contiguousLines(DURATION), DURATION, { pauses: [] });
    expect(plan.source).toBe("captions");
    expect(plan.boundaries).toBeGreaterThan(0);
  });

  it("reports the metronome instead of hiding it — the §18 regression guard", () => {
    const plan = buildZoomPlan([], DURATION);
    expect(plan.source).toBe("metronome");
    expect(plan.boundaries).toBe(0);
    expect(plan.segments.length).toBeGreaterThan(1); // still breathes
  });

  it("contiguous word stamps no longer starve the driver", () => {
    // The exact failing condition: real ASR output, no inter-word gaps.
    const lines = contiguousLines(DURATION);
    const everyGap = lines
      .flatMap((l) => l.words)
      .every((w, i, all) => i === 0 || Math.abs(w.start - all[i - 1]!.end) < 1e-9);
    expect(everyGap).toBe(true);
    const plan = buildZoomPlan(lines, DURATION, {
      pauses: [10, 22, 35, 47].map((s) => ({ start: s, end: s + 0.25 })),
    });
    expect(plan.source).toBe("acoustic");
    // Uniform pacing would make every segment the same length — this must not.
    const lengths = plan.segments.map((s) => +(s.endSec - s.startSec).toFixed(4));
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });
});

describe("zoom plan invariants", () => {
  const plan = buildZoomPlan(contiguousLines(DURATION), DURATION, {
    pauses: [7, 16, 28, 39, 50].map((s) => ({ start: s, end: s + 0.3 })),
  });

  it("covers the whole output contiguously with strictly increasing times", () => {
    expect(plan.segments[0]!.startSec).toBe(0);
    expect(plan.segments[plan.segments.length - 1]!.endSec).toBeCloseTo(DURATION, 6);
    for (const seg of plan.segments) {
      expect(seg.endSec).toBeGreaterThan(seg.startSec); // no zero-length segment
    }
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startSec).toBeCloseTo(plan.segments[i - 1]!.endSec, 6);
      expect(plan.segments[i]!.from).toBeCloseTo(plan.segments[i - 1]!.to, 6);
    }
  });

  it("a fully-cut pause cannot create an instant jump in scale", () => {
    // Both ends of a removed span map to the same output instant.
    const collapsed = [{ start: 12, end: 12 }, { start: 12, end: 12 }];
    const p = buildZoomPlan(contiguousLines(30), 30, { pauses: collapsed });
    for (const seg of p.segments) expect(seg.endSec - seg.startSec).toBeGreaterThan(0.5);
  });

  it("scale stays within [1, maxScale] and is continuous at boundaries", () => {
    for (let t = 0; t <= DURATION; t += 0.05) {
      const s = zoomScaleAt(plan.segments, t);
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(s).toBeLessThanOrEqual(ZOOM_MAX_SCALE + 1e-9);
    }
    for (const seg of plan.segments) {
      const before = zoomScaleAt(plan.segments, Math.max(0, seg.startSec - 1e-4));
      const after = zoomScaleAt(plan.segments, Math.min(DURATION, seg.startSec + 1e-4));
      expect(Math.abs(after - before)).toBeLessThan(0.002);
    }
  });

  it("no segment outlasts maxPhraseSec — long stretches still breathe", () => {
    const p = buildZoomPlan([], 40, { maxPhraseSec: 4.5 });
    for (const seg of p.segments) {
      expect(seg.endSec - seg.startSec).toBeLessThanOrEqual(4.5 + 1e-6);
    }
  });

  it("no segment is shorter than a phrase", () => {
    for (const seg of plan.segments) {
      expect(seg.endSec - seg.startSec).toBeGreaterThan(0.5);
    }
  });

  it("outside the plan the scale is exactly 1", () => {
    expect(zoomScaleAt(plan.segments, DURATION + 5)).toBe(1);
    expect(zoomScaleAt([], 3)).toBe(1);
  });

  it("a zero-length output produces no plan at all", () => {
    expect(buildZoomPlan([], 0).segments).toEqual([]);
  });
});
