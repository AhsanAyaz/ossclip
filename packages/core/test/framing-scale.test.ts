import { describe, expect, it } from "vitest";
import {
  scaleContentTimeline,
  scaleFramingWindows,
  type ContentRectSegment,
  type FramingSegment,
} from "../src/content-rect";

/**
 * 2026-08-17 render-speed pass. planNormalization keeps working in TRUE
 * source pixels (analysis runs on the source), but the renderer windows the
 * file it PLAYS — a display-sized mezzanine has resampled that pixel space.
 * These helpers are the one bridge, applied at render-props emission so
 * window space === played-file space, and their numbers have to be exact:
 * an off-by-factor window is precisely the crop the feature exists to avoid.
 */

const FRAMING: FramingSegment[] = [
  {
    startSec: 0,
    endSec: 5,
    window: { x: 100, y: 50, w: 800, h: 600 },
    subject: "face",
    bias: { x: 0.4, y: 0.3 },
  },
  {
    startSec: 5,
    endSec: 9.5,
    window: { x: 0, y: 0, w: 3456, h: 2234 },
    subject: "screen",
    bias: { x: 0.5, y: 0.5 },
  },
];

describe("scaleFramingWindows", () => {
  it("scales window pixels per axis and leaves times, subject and bias alone", () => {
    const scaled = scaleFramingWindows(FRAMING, { x: 0.5, y: 0.25 });
    expect(scaled[0]).toEqual({
      startSec: 0,
      endSec: 5,
      window: { x: 50, y: 12.5, w: 400, h: 150 },
      subject: "face",
      bias: { x: 0.4, y: 0.3 },
    });
  });

  it("the field factor: 3456x2234 → 2112x1366 keeps a full-frame window full-frame", () => {
    // Per-axis on purpose: even-rounding makes x (2112/3456 = 11/18) and
    // y (1366/2234) differ by a hair, and scaling both by one axis's factor
    // would push this window's bottom edge past the scaled file's height.
    const scaled = scaleFramingWindows(FRAMING, { x: 2112 / 3456, y: 1366 / 2234 });
    // toBeCloseTo on the y axis: 2234 × (1366/2234) round-trips through
    // binary floats to 1366.0000000000002 — sub-pixel, which CSS absorbs.
    expect(scaled[1]!.window.x).toBe(0);
    expect(scaled[1]!.window.y).toBe(0);
    expect(scaled[1]!.window.w).toBe(2112);
    expect(scaled[1]!.window.h).toBeCloseTo(1366, 9);
  });

  it("the identity factor is a no-op — the --no-mezzanine contract", () => {
    expect(scaleFramingWindows(FRAMING, { x: 1, y: 1 })).toEqual(FRAMING);
  });

  it("does not mutate its input — the same timeline also feeds plan-space consumers", () => {
    const before = structuredClone(FRAMING);
    scaleFramingWindows(FRAMING, { x: 0.5, y: 0.5 });
    expect(FRAMING).toEqual(before);
  });
});

describe("scaleContentTimeline", () => {
  const TIMELINE: ContentRectSegment[] = [
    { startSec: 0, endSec: 3, rect: { x: 0, y: 400, w: 1080, h: 608, full: false } },
    { startSec: 3, endSec: 8, rect: { x: 0, y: 0, w: 1080, h: 1920, full: true } },
  ];

  it("scales rect pixels and preserves the `full` flag", () => {
    const scaled = scaleContentTimeline(TIMELINE, { x: 0.5, y: 0.5 });
    expect(scaled[0]).toEqual({
      startSec: 0,
      endSec: 3,
      rect: { x: 0, y: 200, w: 540, h: 304, full: false },
    });
    expect(scaled[1]!.rect.full).toBe(true);
  });

  it("the identity factor is a no-op", () => {
    expect(scaleContentTimeline(TIMELINE, { x: 1, y: 1 })).toEqual(TIMELINE);
  });
});
