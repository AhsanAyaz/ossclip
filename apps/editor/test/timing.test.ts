import { describe, expect, it } from "vitest";
import { clampTiming, moveTiming, timeAtX } from "../src/timing";
import type { SceneCue } from "@ossclip/core/browser";

const cues = [
  { id: "a", startSec: 0, endSec: 5 },
  { id: "b", startSec: 6, endSec: 11 },
] as SceneCue[];

describe("clampTiming", () => {
  it("keeps a nudge inside the clip", () => {
    expect(clampTiming(cues, "a", -3, 5, 30).startSec).toBe(0);
    expect(clampTiming(cues, "b", 6, 99, 30).endSec).toBe(30);
  });

  it("does not let a scene overlap its neighbour — cues are exclusive", () => {
    expect(clampTiming(cues, "a", 0, 9, 30).endSec).toBeLessThanOrEqual(6);
  });

  it("enforces a minimum on-screen duration", () => {
    const t = clampTiming(cues, "a", 4.9, 5, 30);
    expect(t.endSec - t.startSec).toBeGreaterThanOrEqual(1.2);
  });
});


describe("timeAtX (PLAN Tasks 3+4 — one mapping for every seek gesture)", () => {
  it("maps a track position linearly to a time", () => {
    expect(timeAtX(150, 100, 200, 30)).toBeCloseTo(7.5, 9);
  });

  it("clamps at both ends of the clip", () => {
    expect(timeAtX(50, 100, 200, 30)).toBe(0);
    expect(timeAtX(500, 100, 200, 30)).toBe(30);
  });

  it("a click INSIDE a scene block lands inside that scene's window", () => {
    // The Task 4 defect: clicking mid-block seeked to the block's start. The
    // global mapping, applied to a click over block b (6-11s of 30s on a
    // 300px track: x 60-110), must land between 6 and 11 — nowhere else.
    const t = timeAtX(85, 0, 300, 30);
    expect(t).toBeGreaterThan(6);
    expect(t).toBeLessThan(11);
    expect(t).toBeCloseTo(8.5, 9);
  });

  it("is safe on a zero-width track", () => {
    expect(timeAtX(100, 0, 0, 30)).toBe(0);
  });
});

describe("moveTiming (PLAN Task 6 — drag a block to move it)", () => {
  it("shifts both edges by the delta, preserving duration", () => {
    expect(moveTiming(cues, "a", 0.5, 30)).toEqual({ startSec: 0.5, endSec: 5.5 });
  });

  it("stops against the next scene instead of overlapping or squashing", () => {
    // Distinct from clampTiming, which would squash: the block slides until
    // it rests against b's start (minus the gap) at its FULL length.
    const t = moveTiming(cues, "a", 10, 30)!;
    expect(t.endSec - t.startSec).toBeCloseTo(5, 9);
    expect(t.endSec).toBeLessThanOrEqual(6);
  });

  it("stops against the previous scene and the clip bounds", () => {
    const back = moveTiming(cues, "b", -10, 30)!;
    expect(back.endSec - back.startSec).toBeCloseTo(5, 9);
    expect(back.startSec).toBeGreaterThanOrEqual(5);
    const fwd = moveTiming(cues, "b", 99, 30)!;
    expect(fwd.endSec).toBe(30);
    expect(fwd.endSec - fwd.startSec).toBeCloseTo(5, 9);
  });

  it("returns null for an unknown scene", () => {
    expect(moveTiming(cues, "zzz", 1, 30)).toBeNull();
  });
});
