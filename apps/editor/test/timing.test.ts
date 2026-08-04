import { describe, expect, it } from "vitest";
import {
  clampTiming,
  clampZoom,
  moveTiming,
  sourceToOutputClamped,
  timeAtX,
  zoomedScrollLeft,
} from "../src/timing";
import type { KeptSpan, SceneCue } from "@ossclip/core/browser";

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

describe("timeline zoom (R14 §53)", () => {
  it("clampZoom bounds the factor to [1, 16]", () => {
    expect(clampZoom(0.3)).toBe(1);
    expect(clampZoom(4)).toBe(4);
    expect(clampZoom(64)).toBe(16);
  });

  it("keeps the content under the anchor stationary through a zoom-in", () => {
    // Viewport 1000px, zoom 1→2, cursor at x=400: the content point at 400
    // maps to 800 in the doubled track, so scrollLeft must become 400 for it
    // to stay under the cursor.
    expect(zoomedScrollLeft(1, 2, 1000, 0, 400)).toBe(400);
  });

  it("inverts cleanly: zooming back out returns to the original scroll", () => {
    const inScroll = zoomedScrollLeft(1, 4, 1000, 0, 600);
    expect(zoomedScrollLeft(4, 1, 1000, inScroll, 600)).toBe(0);
  });

  it("clamps to the scrollable range at the NEW zoom", () => {
    // Fully scrolled right at 4×, zooming out to 2× must not leave scrollLeft
    // beyond the 2× track's maximum (1000px viewport → max 1000).
    expect(zoomedScrollLeft(4, 2, 1000, 3000, 500)).toBe(1000);
    // …and never negative.
    expect(zoomedScrollLeft(2, 1, 1000, 0, 0)).toBe(0);
  });

  it("is safe on a zero-width viewport", () => {
    expect(zoomedScrollLeft(1, 2, 0, 0, 0)).toBe(0);
  });
});

describe("plain takes never clamp a drag (PLAN 2026-07-30 Task A)", () => {
  // The fill butts a derived take flush against every graphic block; if the
  // clamp saw it as a neighbour, lo === the cue's own start and no drag
  // could ever move a scene again. Takes re-derive around wherever the
  // graphic lands, so only STORED (graphic) windows constrain it.
  const withTakes = [
    { id: "a", startSec: 0, endSec: 5 },
    { id: "take-0", kind: "plain", layout: "full-bleed", startSec: 5, endSec: 12 },
    { id: "b", startSec: 12, endSec: 16 },
  ] as SceneCue[];

  it("moveTiming slides through a flush plain neighbour", () => {
    const t = moveTiming(withTakes, "b", -4, 30)!;
    expect(t.startSec).toBeCloseTo(8, 9); // straight through take-0's window
    expect(t.endSec - t.startSec).toBeCloseTo(4, 9);
    // …and still stops against the GRAPHIC neighbour beyond it.
    const far = moveTiming(withTakes, "b", -8, 30)!;
    expect(far.startSec).toBeCloseTo(5.05, 9);
  });

  it("clampTiming likewise ignores the take", () => {
    const t = clampTiming(withTakes, "b", 8, 16, 30);
    expect(t.startSec).toBeCloseTo(8, 9);
  });
});

describe("sourceToOutputClamped (PLAN 2026-08-04 Task 4c fix wave, review finding 1)", () => {
  // Two kept spans with a 3s GAP between them (5-8 in source time) — the
  // shape produced by an automatic cut or an already-applied user cut sitting
  // between them, same fixture shape TimeMap's own tests use.
  const spans: KeptSpan[] = [
    { srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 },
    { srcIn: 8, srcOut: 12, outIn: 5, outOut: 9 },
  ];

  it("maps a source instant inside a kept span directly", () => {
    expect(sourceToOutputClamped(spans, 2)).toBeCloseTo(2, 9);
    expect(sourceToOutputClamped(spans, 10)).toBeCloseTo(7, 9); // 5 + (10-8)
  });

  it("clamps a source instant inside the GAP to the seam between the two spans", () => {
    // ANY point strictly between two adjacent kept spans lands on the SAME
    // output instant, not "whichever edge it's numerically nearer to" — kept
    // output time has no gap (TimeMap's own invariant, "contiguous in output
    // time"), so the first span's outOut and the second span's outIn are
    // literally the same number (5 here). 5.5 (near the first span) and 7.9
    // (near the second) both prove that, not two different clamp outcomes.
    expect(sourceToOutputClamped(spans, 5.5)).toBeCloseTo(5, 9);
    expect(sourceToOutputClamped(spans, 7.9)).toBeCloseTo(5, 9);
  });

  it("clamps before the first span and after the last", () => {
    expect(sourceToOutputClamped(spans, -3)).toBeCloseTo(0, 9); // first span's outIn
    expect(sourceToOutputClamped(spans, 99)).toBeCloseTo(9, 9); // last span's outOut
  });

  it("is 0 on an empty spans array — no crash, no NaN", () => {
    expect(sourceToOutputClamped([], 5)).toBe(0);
  });
});
