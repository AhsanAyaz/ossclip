import { describe, expect, it } from "vitest";
import type { CaptionLine } from "../src/captions";
import { buildZoomPlan, zoomScaleAt } from "../src/zoom";

/** One caption line per phrase, with a real inter-word gap between phrases. */
function linesWithGapsAt(gapStarts: number[], duration: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const bounds = [0, ...gapStarts, duration];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]! + (i === 0 ? 0 : 0.3); // 0.3s of silence before each phrase
    const b = bounds[i + 1]!;
    const words = Array.from({ length: 4 }, (_, w) => ({
      text: `w${i}-${w}`,
      start: a + ((b - a) * w) / 4,
      end: a + ((b - a) * (w + 0.8)) / 4,
    }));
    lines.push({ words, start: words[0]!.start, end: words[words.length - 1]!.end });
  }
  return lines;
}

describe("micro zoom punches (FINDINGS §15)", () => {
  const duration = 20;
  const plan = buildZoomPlan(linesWithGapsAt([5, 9, 15], duration), duration);

  it("covers the whole output contiguously and alternates direction", () => {
    expect(plan[0]!.startSec).toBe(0);
    expect(plan[plan.length - 1]!.endSec).toBeCloseTo(duration, 6);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.startSec).toBeCloseTo(plan[i - 1]!.endSec, 6);
      expect(plan[i]!.from).toBeCloseTo(plan[i - 1]!.to, 6); // continuous
      expect(plan[i]!.to).not.toBeCloseTo(plan[i]!.from, 6); // always drifting
    }
  });

  it("scale stays within [1, maxScale] and is continuous at boundaries", () => {
    for (let t = 0; t <= duration; t += 0.05) {
      const s = zoomScaleAt(plan, t);
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(s).toBeLessThanOrEqual(1.08 + 1e-9);
    }
    for (const seg of plan) {
      const before = zoomScaleAt(plan, Math.max(0, seg.startSec - 1e-4));
      const after = zoomScaleAt(plan, Math.min(duration, seg.startSec + 1e-4));
      expect(Math.abs(after - before)).toBeLessThan(0.002);
    }
  });

  it("no segment outlasts maxPhraseSec — long stretches still breathe", () => {
    const longGapPlan = buildZoomPlan(linesWithGapsAt([], 30), 30, { maxPhraseSec: 4.5 });
    for (const seg of longGapPlan) {
      expect(seg.endSec - seg.startSec).toBeLessThanOrEqual(4.5 + 1e-6);
    }
  });

  it("a take with no captions still gets a gentle metronome", () => {
    const p = buildZoomPlan([], 12);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(zoomScaleAt(p, 6)).toBeGreaterThanOrEqual(1);
  });

  it("outside the plan the scale is exactly 1", () => {
    expect(zoomScaleAt(plan, duration + 5)).toBe(1);
    expect(zoomScaleAt([], 3)).toBe(1);
  });
});
