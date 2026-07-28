import { describe, expect, it } from "vitest";
import {
  MAX_NORMALIZE_UPSCALE,
  normalizationFilterGraph,
  planNormalization,
} from "../src/normalize";
import { pickTransition, type ContentRectSegment } from "../src/content-rect";
import type { WindowFace } from "../src/face";

/**
 * The motivating geometry throughout: the author's 1440×2560 clip whose
 * letterboxed stretches hold a 1440×808 strip at y=876.
 */
const W = 1440;
const H = 2560;
const STRIP = { x: 0, y: 876, w: 1440, h: 808, full: false };
const FULL = { x: 0, y: 0, w: W, h: H, full: true };
const OUT = { width: 1080, height: 1920 };

const seg = (startSec: number, endSec: number, rect: typeof STRIP): ContentRectSegment => ({
  startSec,
  endSec,
  rect,
});

const face = (centerYFrac: number, centerXFrac = 0.5): WindowFace => ({
  centerXFrac,
  centerYFrac,
  sizeFrac: 0.4,
  framesDetected: 3,
  framesSampled: 4,
});

describe("planNormalization (option (a) — one framing for the whole take)", () => {
  const timeline = [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)];

  it("picks the tightest field of view as the canvas", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    expect(plan.canvas).toEqual({ width: 1440, height: 808 });
    expect(plan.ok).toBe(true);
  });

  it("every window has the canvas aspect — a boundary cannot change the framing", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    const aspect = plan.canvas.width / plan.canvas.height;
    for (const s of plan.segments) {
      expect(s.window.w / s.window.h).toBeCloseTo(aspect, 2);
    }
  });

  it("strip segments keep their own rect as the window", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    expect(plan.segments[0]!.window).toMatchObject({ x: 0, y: 876, w: 1440, h: 808 });
    expect(plan.segments[2]!.window).toMatchObject({ x: 0, y: 876, w: 1440, h: 808 });
  });

  /** A face of `sizeFrac` height, centred, in its segment's own fractions. */
  const sized = (sizeFrac: number): WindowFace => ({
    centerXFrac: 0.5,
    centerYFrac: 0.4,
    sizeFrac,
    framesDetected: 3,
    framesSampled: 4,
  });

  /** Face height as a fraction of the CANVAS, per segment — the thing a
   * viewer actually reads as "how far away is the camera". */
  const subjectOnCanvas = (plan: ReturnType<typeof planNormalization>, fs: WindowFace[]) =>
    plan.segments.map(
      (s, i) => (fs[i]!.sizeFrac * timeline[i]!.rect.h) / s.window.h,
    );

  it("equalizes SUBJECT size, not canvas size — the defect the render exposed", () => {
    // Measured on the author's clip: the same camera shot appears as a whole
    // landscape frame in the strips (face 0.57 of their height) and as a
    // ZOOMED CROP of it in the full-bleed stretches (face 0.34 of theirs).
    // Sizing every window to a constant height therefore put the face at 108%
    // of output height in full-bleed — head taller than the frame — against
    // 57% in the strips. Same subject, two sizes, at every boundary.
    const faces = [sized(0.57), sized(0.34), sized(0.57)];
    const plan = planNormalization(timeline, faces, OUT);
    const subject = subjectOnCanvas(plan, faces);
    expect(Math.max(...subject) / Math.min(...subject)).toBeLessThan(1.02);
  });

  it("sizes the window by the face: a smaller face crops in, a larger one out", () => {
    const faces = [sized(0.57), sized(0.34), sized(0.57)];
    const plan = planNormalization(timeline, faces, OUT);
    // The strip's face already matches the target, so its window is its rect.
    expect(plan.segments[0]!.window.h).toBe(808);
    // The full-bleed face is 0.34 of 2560 = 870px and must occupy the same
    // 0.57 of its window, so the window grows to ~1527 rather than staying
    // at the strip's 808 (which is what cropped the head out of frame).
    expect(plan.segments[1]!.window.h).toBeGreaterThan(1400);
    expect(plan.segments[1]!.window.h).toBeLessThan(1600);
  });

  it("clamps at the rect rather than inventing pixels to zoom out into", () => {
    // A face far larger than the target would need a window taller than its
    // own rect. There is nothing there to show, so the window stops at the
    // rect and that segment stays a little tighter than the rest.
    const faces = [sized(0.3), sized(0.95), sized(0.3)];
    const plan = planNormalization(timeline, faces, OUT);
    for (const [i, s] of plan.segments.entries()) {
      expect(s.window.h).toBeLessThanOrEqual(timeline[i]!.rect.h);
      expect(s.window.w).toBeLessThanOrEqual(timeline[i]!.rect.w);
    }
  });

  it("still passes the quality gate on the author's own measurements", () => {
    // The whole fix is worthless if equalizing pushes the upscale past the
    // gate and silently drops to the fit fallback.
    const faces = [sized(0.57), sized(0.34), sized(0.51)];
    const plan = planNormalization(timeline, faces, OUT);
    expect(plan.ok).toBe(true);
    expect(plan.coverUpscale).toBeLessThanOrEqual(MAX_NORMALIZE_UPSCALE);
  });

  it("clamps the window inside the frame for a face near the edge", () => {
    const faces = [face(0.5), face(0.02), face(0.5)]; // face at the very top
    const plan = planNormalization(timeline, faces, OUT);
    const w = plan.segments[1]!.window;
    expect(w.y).toBeGreaterThanOrEqual(0);
    expect(w.y + w.h).toBeLessThanOrEqual(H);
  });

  it("an unmeasured segment centres its window rather than guessing", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    const w = plan.segments[1]!.window;
    // Face defaults to the rect centre, target defaults to 0.45 high.
    expect(w.y).toBe(Math.floor((H / 2 - 0.45 * 808) / 2) * 2);
  });

  it("keeps offsets and sizes even for yuv420 encoders", () => {
    const odd = { x: 1, y: 877, w: 1437, h: 807, full: false };
    const plan = planNormalization([seg(0, 10, odd), seg(10, 20, FULL)], [null, null], OUT);
    for (const s of plan.segments) {
      expect(s.window.x % 2).toBe(0);
      expect(s.window.y % 2).toBe(0);
      expect(s.window.w % 2).toBe(0);
      expect(s.window.h % 2).toBe(0);
    }
  });

  it("the motivating clip passes the quality gate at ×2.38", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    expect(plan.coverUpscale).toBeCloseTo(1920 / 808, 2);
    expect(plan.ok).toBe(true);
  });

  it("refuses a strip too small to fake a full-frame shot from", () => {
    // A 1440×300 sliver would need ×6.4 — visibly soft; option (b) instead.
    const sliver = { x: 0, y: 1100, w: 1440, h: 300, full: false };
    const plan = planNormalization([seg(0, 10, sliver), seg(10, 20, FULL)], [null, null], OUT);
    expect(plan.coverUpscale).toBeGreaterThan(MAX_NORMALIZE_UPSCALE);
    expect(plan.ok).toBe(false);
  });

  it("refuses rather than crashes on a timeline with nothing letterboxed", () => {
    expect(planNormalization([seg(0, 20, FULL)], [null], OUT).ok).toBe(false);
  });
});

describe("normalizationFilterGraph", () => {
  it("trims, crops, scales and concats every segment in order", () => {
    const plan = planNormalization(
      [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)],
      [null, null, null],
      OUT,
    );
    const graph = normalizationFilterGraph(plan);
    expect(graph).toContain("trim=start=0.000:end=10.000");
    expect(graph).toContain("trim=start=10.000:end=20.000");
    expect(graph).toContain("crop=1440:808:0:876");
    expect(graph).toContain("scale=1440:808");
    expect(graph).toContain("[v0][v1][v2]concat=n=3:v=1:a=0[v]");
    // Every trim resets its timestamps, or concat would stack the offsets.
    expect(graph.match(/setpts=PTS-STARTPTS/g)).toHaveLength(3);
  });
});

describe("pickTransition (boundary refinement)", () => {
  const sample = (tSec: number, rect: { x: number; y: number; w: number; h: number }) => ({
    ...rect,
    tSec,
  });
  const stripPx = { x: 0, y: 876, w: 1440, h: 808 };
  const fullPx = { x: 0, y: 0, w: W, h: H };

  it("finds the midpoint of the two frames that disagree", () => {
    const t = pickTransition(
      [sample(2.9, stripPx), sample(2.933, stripPx), sample(2.966, fullPx), sample(3.0, fullPx)],
      STRIP,
      FULL,
      W,
      H,
    );
    expect(t).toBeCloseTo((2.933 + 2.966) / 2, 6);
  });

  it("skips transition-wipe frames that match neither side", () => {
    const smear = { x: 0, y: 400, w: 1440, h: 1600 };
    const t = pickTransition(
      [sample(1.0, stripPx), sample(1.033, smear), sample(1.066, fullPx)],
      STRIP,
      FULL,
      W,
      H,
    );
    expect(t).toBeCloseTo((1.0 + 1.066) / 2, 6);
  });

  it("returns null when the window never straddles the change", () => {
    // All after-framed: the window started past the boundary — keep coarse.
    expect(
      pickTransition([sample(1, fullPx), sample(1.1, fullPx)], STRIP, FULL, W, H),
    ).toBeNull();
    // All before-framed: the change is later than the window.
    expect(
      pickTransition([sample(1, stripPx), sample(1.1, stripPx)], STRIP, FULL, W, H),
    ).toBeNull();
    expect(pickTransition([], STRIP, FULL, W, H)).toBeNull();
  });
});
