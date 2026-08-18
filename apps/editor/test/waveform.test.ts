import { describe, expect, it } from "vitest";
import { peaksForWindow } from "../src/waveform";

/**
 * The pure half of the timing popover's waveform strip. The properties under
 * test are the ones the overlay math leans on: a bucket's x position means
 * one instant whether or not audio exists there (out-of-range is ZERO, not a
 * clamped window), and no degenerate input can throw in a paint path.
 */
describe("peaksForWindow", () => {
  it("takes the max-abs per bucket — a step signal lands each level in its own bucket", () => {
    // 1s at 100Hz: first half quiet (0.2), second half loud and NEGATIVE
    // (-0.8) — abs, not max, or the loud half would read as silence.
    const channel = new Float32Array(100);
    channel.fill(0.2, 0, 50);
    channel.fill(-0.8, 50, 100);
    const { buckets, fromSec, toSec } = peaksForWindow(channel, 100, 0, 1, 2);
    expect(Array.from(buckets)).toEqual([expect.closeTo(0.2, 6), expect.closeTo(0.8, 6)]);
    expect(fromSec).toBe(0);
    expect(toSec).toBe(1);
  });

  it("finds the sine amplitude in every bucket that spans full periods", () => {
    // 1s of a 50Hz sine at 0.5 amplitude, 1000Hz: each of 10 buckets covers
    // 5 periods, so every bucket's peak is a near-crest sample (20 samples
    // per period puts one within π/20 of the crest).
    const sr = 1000;
    const channel = new Float32Array(sr);
    for (let i = 0; i < sr; i++) channel[i] = 0.5 * Math.sin((2 * Math.PI * 50 * i) / sr);
    const { buckets } = peaksForWindow(channel, sr, 0, 1, 10);
    expect(buckets).toHaveLength(10);
    for (const b of buckets) {
      expect(b).toBeGreaterThan(0.48);
      expect(b).toBeLessThanOrEqual(0.5);
    }
  });

  it("zero-fills the out-of-range portions instead of clamping the window", () => {
    // 1s of full-scale audio, asked for [-1s, 2s]: the pad buckets must be
    // silent ZEROS at their own x positions — clamping the window would
    // shear the popover's span overlay against the strip.
    const channel = new Float32Array(10).fill(1);
    const { buckets } = peaksForWindow(channel, 10, -1, 2, 3);
    expect(Array.from(buckets)).toEqual([0, 1, 0]);
  });

  it("returns zero buckets for a degenerate window", () => {
    const channel = new Float32Array(10).fill(1);
    // Empty and inverted windows alike — both are "nothing to show".
    expect(Array.from(peaksForWindow(channel, 10, 1, 1, 4).buckets)).toEqual([0, 0, 0, 0]);
    expect(Array.from(peaksForWindow(channel, 10, 2, 1, 4).buckets)).toEqual([0, 0, 0, 0]);
    // A zero bucket count is an empty result, not a throw.
    expect(peaksForWindow(channel, 10, 0, 1, 0).buckets).toHaveLength(0);
  });

  it("returns zero buckets for an empty channel — the decode-failed flat strip", () => {
    const { buckets } = peaksForWindow(new Float32Array(0), 48000, 0, 2, 5);
    expect(Array.from(buckets)).toEqual([0, 0, 0, 0, 0]);
  });
});
