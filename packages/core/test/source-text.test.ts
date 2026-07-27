import { describe, expect, it } from "vitest";
import {
  ASSUMED_EDITED_REGIONS,
  bandIsText,
  bandScores,
  regionsFromSamples,
  type BandScore,
} from "../src/source-text";

const W = 240;
const H = 240;
const BANDS = 24;

/** White glyph-like strokes on a black box — a burned-in title. */
function frameWithTitle(y0: number, y1: number): Uint8Array {
  const px = new Uint8Array(W * H).fill(120); // midtone scenery elsewhere
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      // Narrow bright strokes with gaps: many short runs per row.
      px[y * W + x] = x % 8 < 3 ? 250 : 10;
    }
  }
  return px;
}

/** A colour-bar test pattern: bimodal, but a handful of enormous runs. */
function frameWithColourBars(): Uint8Array {
  const px = new Uint8Array(W * H);
  const tones = [255, 0, 255, 0, 255, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) px[y * W + x] = tones[Math.floor(x / 40) % tones.length]!;
  }
  return px;
}

/** A soft luminance ramp — a face or a background. */
function frameWithGradient(): Uint8Array {
  return Uint8Array.from({ length: W * H }, (_, i) => 40 + Math.floor((120 * (i % W)) / W));
}

const bandAt = (scores: BandScore[], y: number) => scores[Math.floor((y / H) * BANDS)]!;

describe("burned-in text detection (FINDINGS §26/§32)", () => {
  it("detects white-on-black glyph strokes", () => {
    const s = bandAt(bandScores(frameWithTitle(48, 96), W, H), 60);
    expect(bandIsText(s), JSON.stringify(s)).toBe(true);
  });

  it("rejects colour bars — bimodal, but a few enormous runs, not strokes", () => {
    // The false positive that broke the first detector: bars are every bit as
    // bimodal as white-on-black type, so only stroke structure separates them.
    const scores = bandScores(frameWithColourBars(), W, H);
    for (const s of scores) expect(bandIsText(s), JSON.stringify(s)).toBe(false);
    expect(Math.max(...scores.map((s) => s.bimodal))).toBeGreaterThan(0.9);
    expect(Math.max(...scores.map((s) => s.stroke))).toBeLessThan(0.25);
  });

  it("rejects a soft gradient", () => {
    for (const s of bandScores(frameWithGradient(), W, H)) expect(bandIsText(s)).toBe(false);
  });

  it("scores text far above the noise floor, not merely above it", () => {
    // The first threshold sat at 0.055, inside a background measuring
    // 0.021-0.069 on real footage — which is how it managed to both miss
    // titles and fire on a test pattern. Real text clears it by multiples.
    const scores = bandScores(frameWithTitle(48, 96), W, H);
    const text = bandAt(scores, 60).edge;
    // Bands entirely outside the title box — not the partial bands at its
    // edges, which are text by any reasonable reading.
    const background = [0, 1, 2, 14, 18, 22].map((b) => scores[b]!.edge);
    expect(text).toBeGreaterThan(Math.max(...background) * 3);
  });
});

describe("time-scoped regions (FINDINGS §32)", () => {
  const busyAt = (bands: number[]) => Array.from({ length: BANDS }, (_, b) => bands.includes(b));

  it("keeps a title that is only on screen for part of the clip", () => {
    // THE §32 bug: a title running 6s of 12s was voted out by the frames it
    // was never in. Transient is normal for a title, not disqualifying.
    const samples = [0, 1, 2, 3, 4, 5].map((i) => ({ timeSec: i + 0.5, busy: busyAt([4]) }));
    samples.push(...[6, 7, 8, 9, 10, 11].map((i) => ({ timeSec: i + 0.5, busy: busyAt([]) })));
    const regions = regionsFromSamples(samples, 0.5);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.startSec).toBeCloseTo(0, 6);
    expect(regions[0]!.endSec).toBeCloseTo(6, 6);
  });

  it("reports the band the text actually occupies", () => {
    const r = regionsFromSamples([{ timeSec: 1, busy: busyAt([4]) }], 0.5)[0]!;
    expect(r.y).toBeCloseTo(4 / BANDS, 6);
    expect(r.h).toBeCloseTo(1 / BANDS, 6);
  });

  it("merges vertically adjacent bands into one block", () => {
    const regions = regionsFromSamples([{ timeSec: 1, busy: busyAt([4, 5, 6]) }], 0.5);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.h).toBeCloseTo(3 / BANDS, 6);
  });

  it("keeps two separated bands apart", () => {
    expect(regionsFromSamples([{ timeSec: 1, busy: busyAt([3, 18]) }], 0.5)).toHaveLength(2);
  });

  it("splits a band that comes back later into two windows", () => {
    const regions = regionsFromSamples(
      [
        { timeSec: 0.5, busy: busyAt([4]) },
        { timeSec: 1.5, busy: busyAt([]) },
        { timeSec: 2.5, busy: busyAt([4]) },
      ],
      0.5,
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]!.endSec).toBeLessThanOrEqual(regions[1]!.startSec);
  });

  it("no text means no regions", () => {
    expect(regionsFromSamples([{ timeSec: 1, busy: busyAt([]) }], 0.5)).toEqual([]);
  });

  it("the conservative assumption spans the whole clip and covers both bands", () => {
    // Without detection there is no way to know WHEN, so assumed regions are
    // permanent — the safe reading.
    for (const r of ASSUMED_EDITED_REGIONS) {
      expect(r.startSec).toBe(0);
      expect(r.endSec).toBe(Number.POSITIVE_INFINITY);
    }
    const covers = (y: number) => ASSUMED_EDITED_REGIONS.some((r) => y >= r.y && y <= r.y + r.h);
    expect(covers(0.2)).toBe(true);
    expect(covers(0.7)).toBe(true);
  });
});
