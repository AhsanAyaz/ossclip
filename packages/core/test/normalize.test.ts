import { describe, expect, it } from "vitest";
import {
  assessCueFraming,
  MAX_FACE_FRACTION,
  MAX_NORMALIZE_UPSCALE,
  normalizationFilterGraph,
  planNormalization,
} from "../src/normalize";
import { ZOOM_MAX_SCALE } from "../src/zoom";
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
  sizeFracMax: 0.4,
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
    sizeFracMax: sizeFrac,
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
    // Not exactly equal any more, and deliberately so: the strips sit above
    // the safety ceiling and are left alone rather than cropped to match.
    // What matters is that the 1.7x gap is gone.
    expect(Math.max(...subject) / Math.min(...subject)).toBeLessThan(1.1);
  });

  it("sizes the window by the face: a smaller face crops in, a larger one out", () => {
    const faces = [sized(0.57), sized(0.34), sized(0.57)];
    const plan = planNormalization(timeline, faces, OUT);
    // The strip is already past the ceiling, so its window is its whole rect.
    expect(plan.segments[0]!.window.h).toBe(808);
    // The full-bleed face is 0.34 of 2560 = 870px and must occupy the ceiling
    // fraction of its window, so the window grows well past the strip's 808
    // (staying at 808 is what cropped the head out of frame).
    expect(plan.segments[1]!.window.h).toBeGreaterThan(1500);
    expect(plan.segments[1]!.window.h).toBeLessThanOrEqual(2560);
  });

  it("never crops tighter than the safety ceiling, however small the faces", () => {
    // Every segment wide open: equalizing "up" to a big common fraction would
    // crop everything to a close-up. The ceiling forbids it.
    const faces = [sized(0.2), sized(0.18), sized(0.22)];
    const plan = planNormalization(timeline, faces, OUT);
    for (const s of subjectOnCanvas(plan, faces)) {
      expect(s).toBeLessThanOrEqual(MAX_FACE_FRACTION + 1e-9);
    }
  });

  it("the ceiling leaves the head inside the frame under the idle zoom", () => {
    // The contract the number is derived from: head is ~1.55x the face box,
    // and the zoom scales what is already there.
    expect(1.55 * MAX_FACE_FRACTION * ZOOM_MAX_SCALE).toBeLessThan(1);
  });

  it("sizes on the segment's LARGEST face, not its median", () => {
    // The author's clip ran 29%-48% inside one 12s stretch. Sizing on the
    // median put the head past the edge at the moment they leaned in.
    const moving: WindowFace = { ...sized(0.34), sizeFracMax: 0.48 };
    const still = [sized(0.5), moving, sized(0.5)];
    const plan = planNormalization(timeline, still, OUT);
    const w = plan.segments[1]!.window;
    // Sized against 0.48 x 2560 = 1229px, not 0.34 x 2560 = 870px.
    expect((0.48 * 2560) / w.h).toBeLessThanOrEqual(MAX_FACE_FRACTION + 1e-9);
  });

  it("keeps crown and chin inside the window at the segment's largest face", () => {
    // Head = 0.85x face above the box centre and 0.7x below (stage.ts §19).
    const faces = [
      { ...sized(0.3), centerYFrac: 0.2, sizeFracMax: 0.45 },
      { ...sized(0.3), centerYFrac: 0.8, sizeFracMax: 0.4 },
      sized(0.4),
    ];
    const plan = planNormalization(timeline, faces, OUT);
    plan.segments.forEach((s, i) => {
      const r = timeline[i]!.rect;
      const f = faces[i]!;
      const faceY = r.y + f.centerYFrac * r.h;
      const maxFace = f.sizeFracMax * r.h;
      const headTop = faceY - 0.85 * maxFace;
      const headBottom = faceY + 0.7 * maxFace;
      // Inside the window, unless the head runs past the SOURCE's own edge —
      // there is nothing to slide toward then.
      if (headTop >= r.y && headBottom <= r.y + r.h && headBottom - headTop <= s.window.h) {
        expect(s.window.y).toBeLessThanOrEqual(headTop + 2);
        expect(s.window.y + s.window.h).toBeGreaterThanOrEqual(headBottom - 2);
      }
    });
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

  it("pins SAR on every segment, or concat refuses the whole bake (R27 §125)", () => {
    // Segments are scaled to ONE canvas from DIFFERENT crops, and ffmpeg
    // derives a sample aspect from that ratio — 946x1682 -> 860x1530 gives SAR
    // 1683:1682, 932x1660 gives 1377:1376. concat requires identical SAR and
    // aborts when they disagree, so a take whose framing varies (the only
    // take normalization runs on) would not render at all.
    const plan = planNormalization(
      [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)],
      [null, null, null],
      OUT,
    );
    const graph = normalizationFilterGraph(plan);
    expect(graph.match(/setsar=1/g)).toHaveLength(plan.segments.length);
    // On each segment the pin must come AFTER the scale that introduced the skew.
    for (const part of graph.split(";").filter((p) => p.includes("scale="))) {
      expect(part.indexOf("setsar=1")).toBeGreaterThan(part.indexOf("scale="));
    }
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

describe("assessCueFraming (plan step D — per-scene framing)", () => {
  const canvas = { width: 450, height: 800 }; // portrait, as normalization bakes
  const segs = [{ startSec: 0, endSec: 30 }];
  const cue = (layout: string, w: number, h: number) => ({
    id: `c-${layout}`,
    layout,
    startSec: 5,
    endSec: 10,
    slot: { width: w, height: h },
  });

  it("a wide band shows less canvas height, so the face grows by the inverse", () => {
    // video-top is 1080x806 against a 450x800 canvas: cover binds on width and
    // shows canvasAspect/slotAspect = 0.42 of the canvas height.
    const [full] = assessCueFraming([cue("full-bleed", 1080, 1920)], segs, [0.44], canvas, 1);
    const [top] = assessCueFraming([cue("video-top", 1080, 806)], segs, [0.44], canvas, 1);
    expect(full!.faceFracOfSlot).toBeCloseTo(0.44, 6);
    expect(top!.faceFracOfSlot).toBeGreaterThan(1);
    expect(top!.headFracOfSlot).toBeGreaterThan(1);
  });

  it("flags exactly the crown-trimming case the render showed", () => {
    const issues = assessCueFraming(
      [cue("full-bleed", 1080, 1920), cue("video-top", 1080, 806)],
      segs,
      [0.44],
      canvas,
      1.05,
    );
    expect(issues.filter((f) => f.headFracOfSlot > 1).map((f) => f.layout)).toEqual(["video-top"]);
  });

  it("judges a cue by the TIGHTEST segment it spans, not an average", () => {
    const spanning = [{ ...cue("full-bleed", 1080, 1920), startSec: 8, endSec: 22 }];
    const two = [
      { startSec: 0, endSec: 10 },
      { startSec: 10, endSec: 30 },
    ];
    const [f] = assessCueFraming(spanning, two, [0.2, 0.5], canvas, 1);
    expect(f!.faceFracOfSlot).toBeCloseTo(0.5, 6);
  });

  it("a cue over an unmeasured stretch is not reported rather than guessed", () => {
    expect(assessCueFraming([cue("full-bleed", 1080, 1920)], segs, [0], canvas, 1)).toEqual([]);
    const none = assessCueFraming([cue("full-bleed", 1080, 1920)], segs, [0.4], { width: 0, height: 0 }, 1);
    expect(none).toEqual([]);
  });
});
