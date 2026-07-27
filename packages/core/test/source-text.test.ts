import { describe, expect, it } from "vitest";
import {
  ASSUMED_EDITED_REGIONS,
  bandBimodality,
  bandEdgeDensity,
  regionsFromBands,
} from "../src/source-text";

const W = 240;
const H = 240;

/** A frame with a band of high-contrast glyph-like strokes at [y0, y1). */
function frameWithTextBand(y0: number, y1: number): Uint8Array {
  const px = new Uint8Array(W * H).fill(40);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      // Narrow bright strokes: many hard horizontal transitions, like glyphs.
      px[y * W + x] = x % 6 < 2 ? 250 : 30;
    }
  }
  return px;
}

/** Hard-edged MIDTONE stripes — a colour-bar pattern, blinds, a striped shirt. */
function frameWithTexture(): Uint8Array {
  const px = new Uint8Array(W * H);
  const tones = [76, 150, 29, 105, 60, 130];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) px[y * W + x] = tones[Math.floor(x / 8) % tones.length]!;
  }
  return px;
}

/** A soft luminance ramp — a face or a background, not text. */
function frameWithGradient(): Uint8Array {
  return Uint8Array.from({ length: W * H }, (_, i) => 40 + Math.floor((120 * (i % W)) / W));
}

describe("burned-in text detection (FINDINGS §26)", () => {
  it("finds a band of glyph-like strokes", () => {
    const density = bandEdgeDensity(frameWithTextBand(20, 60), W, H);
    const bandsHit = density.filter((d) => d >= 0.055).length;
    expect(bandsHit).toBeGreaterThan(0);
    expect(bandsHit).toBeLessThan(density.length); // not the whole frame
  });

  it("does not mistake a soft gradient for text", () => {
    const density = bandEdgeDensity(frameWithGradient(), W, H);
    expect(Math.max(...density)).toBeLessThan(0.055);
  });

  it("does not mistake hard-edged midtone texture for text", () => {
    // This is a REAL false positive: the colour-bar golden fixture scored two
    // "text" bands on edge density alone. Bimodality is what rejects it —
    // glyphs pile up at black and white, scenery spreads across the midtones.
    const px = frameWithTexture();
    expect(Math.max(...bandEdgeDensity(px, W, H))).toBeGreaterThan(0.055); // edges alone fire
    expect(Math.max(...bandBimodality(px, W, H))).toBeLessThan(0.5); // the second signal saves it
  });

  it("real burned-in text clears BOTH signals", () => {
    const px = frameWithTextBand(20, 60);
    const density = bandEdgeDensity(px, W, H);
    const bimodality = bandBimodality(px, W, H);
    const hit = density.findIndex((d) => d >= 0.055);
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(bimodality[hit]!).toBeGreaterThanOrEqual(0.5);
  });

  it("reports the band where the text actually is", () => {
    const density = bandEdgeDensity(frameWithTextBand(0, 48), W, H);
    const busy = density.map((d) => (d >= 0.055 ? 1 : 0));
    const regions = regionsFromBands(busy, 1);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.y).toBeLessThan(0.1); // near the top, where a title sits
    expect(regions[0]!.h).toBeGreaterThan(0);
  });

  it("ignores text that is only briefly on screen", () => {
    // A band busy in 1 of 10 frames is a passing gesture, not a burned-in title.
    const busy = new Array(24).fill(0);
    busy[3] = 1;
    expect(regionsFromBands(busy, 10)).toHaveLength(0);
  });

  it("keeps a band that persists across most frames", () => {
    const busy = new Array(24).fill(0);
    busy[3] = 8;
    busy[4] = 9;
    const regions = regionsFromBands(busy, 10);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.confidence).toBeGreaterThan(0.8);
  });

  it("merges adjacent busy bands into one region", () => {
    const busy = new Array(24).fill(0);
    for (const b of [5, 6, 7]) busy[b] = 10;
    const regions = regionsFromBands(busy, 10);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.h).toBeCloseTo(3 / 24, 6);
  });

  it("the conservative assumption covers the title and caption bands", () => {
    // --source-is-edited must protect where editors actually burn text in.
    const covers = (y: number) =>
      ASSUMED_EDITED_REGIONS.some((r) => y >= r.y && y <= r.y + r.h);
    expect(covers(0.2)).toBe(true); // upper-third title
    expect(covers(0.7)).toBe(true); // lower-middle caption
  });
});
