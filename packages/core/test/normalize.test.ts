import { describe, expect, it } from "vitest";
import {
  assessCueFraming,
  FACE_ONLY_MIN_FRAC,
  HEAD_WINDOW_MARGIN,
  MAX_FACE_FRACTION,
  MAX_MEAN_AREA_DISCARD,
  MAX_NORMALIZE_UPSCALE,
  MAX_SCREEN_AREA_DISCARD,
  planNormalization,
  segmentIsFaceOnly,
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
    // Since 5a an all-null timeline is all SCREEN subjects, and cropping the
    // full-bleed stretches to the strip discards 68% of them — the geometry
    // above is still planned, but the screen-loss gate refuses to apply it.
    // The face-only motivating measurements (which do pass) are pinned in
    // "still passes the quality gate on the author's own measurements".
    expect(plan.ok).toBe(false);
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
    // crop everything to a close-up. The ceiling forbids it. The fractions
    // were 0.18-0.22 before 5a; sub-0.22 faces are SCREEN subjects now and
    // never face-cropped at all (pinned by the PiP tests below), so these are
    // small-but-real talking heads just past the face-only threshold.
    const faces = [sized(0.25), sized(0.23), sized(0.26)];
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
    // TRULY centred since 5a: an unmeasured segment is a screen subject and
    // gets no face placement at all. (Before 5a it was placed as if a face sat
    // 0.45 down the window — a guess about a face nobody measured.)
    expect(w.y).toBe(Math.floor((H - 808) / 2 / 2) * 2);
    expect(plan.subject[1]).toBe("screen");
    expect(plan.bias[1]).toEqual({ x: 0.5, y: 0.5 });
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

  it("the motivating clip's upscale of ×2.38 passes the softness ceiling", () => {
    const plan = planNormalization(timeline, [null, null, null], OUT);
    expect(plan.coverUpscale).toBeCloseTo(1920 / 808, 2);
    expect(plan.coverUpscale).toBeLessThanOrEqual(MAX_NORMALIZE_UPSCALE);
    // ok is nevertheless false since 5a: with no faces measured these are all
    // screen subjects, and the screen-loss gate refuses to crop the full-bleed
    // stretches to the strip. The clip's real (face-only) measurements pass in
    // "still passes the quality gate on the author's own measurements".
    expect(plan.ok).toBe(false);
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

describe("duration weighting + picture-loss gate (2026-08-16 incident)", () => {
  it("a sub-5% framing class cannot set the canvas aspect", () => {
    // The real take: 1435s of a 3456x2234 screen recording, almost all of it
    // at rect 3384x2234 (a 72px dark strip shaved off), plus one 15.4s dark
    // segment at 2848x2234. The face is the camera PiP (sizeFrac 0.119), so
    // every window clamps at its own rect height — and the old plain min let
    // the 1.1% outlier set canvas aspect 2848/2234 = 1.2748 for the whole
    // video, baking away 28% of source width.
    const wide = { x: 0, y: 0, w: 3384, h: 2234, full: false };
    const dark = { x: 0, y: 0, w: 2848, h: 2234, full: false };
    const pip = (): WindowFace => ({
      centerXFrac: 0.88,
      centerYFrac: 0.76,
      sizeFrac: 0.119,
      sizeFracMax: 0.119,
      framesDetected: 3,
      framesSampled: 4,
    });
    const plan = planNormalization(
      [seg(0, 700, wide), seg(700, 715.4, dark), seg(715.4, 1435, wide)],
      [pip(), pip(), pip()],
      { width: 1920, height: 1080 },
    );
    // The material class's own aspect (~1.515), not the outlier's 1.2748.
    expect(plan.canvas.width / plan.canvas.height).toBeGreaterThanOrEqual(1.5);
    // The outlier still gets a window — clamped inside its own rect.
    const outlier = plan.segments[1]!.window;
    expect(outlier.w).toBeLessThanOrEqual(2848);
    expect(outlier.h).toBeLessThanOrEqual(2234);
    expect(plan.areaDiscardWeighted).toBeLessThanOrEqual(MAX_MEAN_AREA_DISCARD);
    expect(plan.ok).toBe(true);
  });

  it("refuses a plan that discards more than half the picture", () => {
    // Constructed directly: a portrait class (1000x2000) holding 80% of the
    // runtime forced through a 2:1 canvas keeps only a 1000x500 band — 75% of
    // its area gone, 0.6 duration-weighted. coverUpscale is 2.16, a PASS
    // under the old gate: it measured softness, never loss.
    const portrait = { x: 0, y: 0, w: 1000, h: 2000, full: false };
    const wide = { x: 0, y: 0, w: 2000, h: 1000, full: false };
    const plan = planNormalization(
      [seg(0, 80, portrait), seg(80, 100, wide)],
      [null, null],
      { width: 1920, height: 1080 },
    );
    expect(plan.coverUpscale).toBeLessThanOrEqual(MAX_NORMALIZE_UPSCALE);
    expect(plan.areaDiscardWeighted).toBeGreaterThan(MAX_MEAN_AREA_DISCARD);
    expect(plan.ok).toBe(false);
  });
});

describe("face-only subjects + non-destructive screen windows (Task 5a)", () => {
  /** The incident source: 3456x2234 screen recording with a camera PiP. */
  const wide = { x: 0, y: 0, w: 3384, h: 2234, full: false };
  const dark = { x: 0, y: 0, w: 2848, h: 2234, full: false };
  const OUT_169 = { width: 1920, height: 1080 };
  const pip = (): WindowFace => ({
    centerXFrac: 0.88,
    centerYFrac: 0.76,
    sizeFrac: 0.119,
    sizeFracMax: 0.119,
    framesDetected: 3,
    framesSampled: 4,
  });
  const incident = [seg(0, 700, wide), seg(700, 715.4, dark), seg(715.4, 1435, wide)];

  const sized = (sizeFrac: number, centerYFrac = 0.4): WindowFace => ({
    centerXFrac: 0.5,
    centerYFrac,
    sizeFrac,
    sizeFracMax: sizeFrac,
    framesDetected: 3,
    framesSampled: 4,
  });

  it("segmentIsFaceOnly wants a real, confidently-detected talking head", () => {
    expect(segmentIsFaceOnly(null)).toBe(false);
    expect(segmentIsFaceOnly(pip())).toBe(false); // 0.119 < 0.22
    expect(segmentIsFaceOnly(sized(0.28))).toBe(true);
    expect(segmentIsFaceOnly(sized(FACE_ONLY_MIN_FRAC))).toBe(true); // inclusive
    // A big face the detector saw in 1 of 4 looks is not evidence to reframe on.
    expect(segmentIsFaceOnly({ ...sized(0.4), framesDetected: 1, framesSampled: 4 })).toBe(false);
  });

  it("a PiP face (0.119) never gets a face-anchored window (2026-08-16 incident)", () => {
    const plan = planNormalization(incident, [pip(), pip(), pip()], OUT_169);
    expect(plan.subject).toEqual(["screen", "screen", "screen"]);
    // Centered aspect clip of its own rect — for the material class that IS
    // the whole rect, not a window chasing the PiP into the bottom-right.
    expect(plan.segments[0]!.window).toMatchObject({ x: 0, y: 0, w: 3384, h: 2234 });
    expect(plan.segments[2]!.window).toMatchObject({ x: 0, y: 0, w: 3384, h: 2234 });
    for (const b of plan.bias) expect(b).toEqual({ x: 0.5, y: 0.5 });
  });

  it("a 0.28 talking head gets a face-anchored window", () => {
    const timeline = [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)];
    const faces = [sized(0.5), sized(0.28), sized(0.5)];
    const plan = planNormalization(timeline, faces, OUT);
    expect(plan.subject).toEqual(["face", "face", "face"]);
    // Sized on the face: 0.28 of the rect scaled to the 0.5 target, not the
    // rect-shaped fallback height.
    expect(plan.segments[1]!.window.h).toBe(2 * Math.floor((0.28 * H) / 0.5 / 2));
  });

  it("screen segments keep (essentially) their full rect", () => {
    const plan = planNormalization(incident, [pip(), pip(), pip()], OUT_169);
    // The material class loses nothing at all; only the 1.1% dark sliver is
    // clipped to the shared aspect, and the mean gate bounds that.
    for (const i of [0, 2]) {
      const r = incident[i]!.rect;
      const w = plan.segments[i]!.window;
      expect(1 - (w.w * w.h) / (r.w * r.h)).toBeLessThanOrEqual(MAX_SCREEN_AREA_DISCARD);
    }
    expect(plan.ok).toBe(true);
  });

  it("the head window keeps the 1% margin above crown and below chin", () => {
    // Strips put the face LOW (0.9), so the shared placement drags the
    // full-bleed window far above its face and the head slide must pull it
    // back down — past the chin AND the margin below it.
    const timeline = [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)];
    const faces = [sized(0.5, 0.9), sized(0.3, 0.5), sized(0.5, 0.9)];
    const plan = planNormalization(timeline, faces, OUT);
    const w = plan.segments[1]!.window;
    const faceY = 0.5 * H;
    const headTop = faceY - 0.85 * (0.3 * H);
    const headBottom = faceY + 0.7 * (0.3 * H);
    const margin = HEAD_WINDOW_MARGIN * w.h;
    // Whole head inside, with the ~1% breathing room on both sides (±2px for
    // yuv420 evenness). Without the margin the slide stops exactly at the
    // chin, ~15px short of this.
    expect(w.y).toBeLessThanOrEqual(headTop - margin + 2);
    expect(w.y + w.h).toBeGreaterThanOrEqual(headBottom + margin - 2);
  });

  it("bias reports the face position inside its own window", () => {
    const timeline = [seg(0, 10, STRIP), seg(10, 20, FULL), seg(20, 30, STRIP)];
    const faces = [sized(0.5, 0.9), sized(0.3, 0.5), sized(0.5, 0.9)];
    const plan = planNormalization(timeline, faces, OUT);
    const w = plan.segments[1]!.window;
    const faceX = 0.5 * W;
    const faceY = 0.5 * H;
    expect(plan.bias[1]!.x).toBeCloseTo((faceX - w.x) / w.w, 6);
    expect(plan.bias[1]!.y).toBeCloseTo((faceY - w.y) / w.h, 6);
    // The slide moved the window, so the face is NOT at the window centre —
    // bias is a measurement of the plan, not a constant.
    expect(plan.bias[1]!.y).toBeGreaterThan(0.55);
  });

  it("a screen window forced below 90% of its rect area refuses the plan", () => {
    // Two material screen classes whose aspects disagree: clipping the 1.6
    // rect to the shared 2.0 aspect keeps only 80% of it. The old gates both
    // pass (upscale 1.35, weighted mean 0.1) — only the per-segment screen
    // bound catches that a fifth of someone's screen content is gone.
    const wideRect = { x: 0, y: 0, w: 2000, h: 1000, full: false };
    const narrow = { x: 0, y: 0, w: 1600, h: 1000, full: false };
    const plan = planNormalization(
      [seg(0, 50, wideRect), seg(50, 100, narrow)],
      [null, null],
      OUT_169,
    );
    expect(plan.coverUpscale).toBeLessThanOrEqual(MAX_NORMALIZE_UPSCALE);
    expect(plan.areaDiscardWeighted).toBeLessThanOrEqual(MAX_MEAN_AREA_DISCARD);
    expect(plan.ok).toBe(false);
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
