import { describe, expect, it } from "vitest";
import {
  contentRectAt,
  contentRectTimeline,
  cropFilter,
  parseCropdetect,
  stableContentRect,
} from "../src/content-rect";

const CROPDETECT_LINE =
  "[Parsed_cropdetect_1 @ 0x55e] x1:0 x2:1439 y1:874 y2:1683 w:1440 h:810 x:0 y:874 " +
  "pts:2 t:1.000000 limit:24.000000 crop=1440:810:0:874";

describe("parseCropdetect", () => {
  it("reads crop=W:H:X:Y lines out of ffmpeg stderr, with their timestamps", () => {
    // The timestamp is what makes a TIMELINE possible: a source whose framing
    // changes mid-take needs to know WHEN, not just that two rects were seen.
    expect(parseCropdetect(`noise\n${CROPDETECT_LINE}\nframe= 12 fps=…`)).toEqual([
      { w: 1440, h: 810, x: 0, y: 874, tSec: 1 },
    ]);
  });

  it("returns [] for stderr with no cropdetect output", () => {
    expect(parseCropdetect("frame=  100 fps=25 q=-0.0 size=N/A")).toEqual([]);
  });
});

describe("stableContentRect — a measurement in another orientation is refused (R27 §119)", () => {
  it("refuses a rect that does not fit the frame rather than clamping it", () => {
    // The real defect: a portrait take (rotation 90) stored as a 3840x2160
    // stream. cropdetect auto-rotates and honestly reports the full 2160x3840
    // frame; the caller believed 3840x2160. Clamping the two together produced
    // a 2160x2160 square that was never on screen, logged as a letterbox, and
    // cropped away the bottom 44% of the picture.
    expect(stableContentRect([{ x: 0, y: 0, w: 2160, h: 3840 }], 3840, 2160)).toEqual({
      x: 0,
      y: 0,
      w: 3840,
      h: 2160,
      full: true,
    });
  });

  it("still measures normally once the frame agrees with the rect", () => {
    // Same footage after the probe fix: the frame is the displayed 2160x3840,
    // the rect fits, and a full-frame source is correctly left alone.
    expect(stableContentRect([{ x: 0, y: 0, w: 2160, h: 3840 }], 2160, 3840)).toEqual({
      x: 0,
      y: 0,
      w: 2160,
      h: 3840,
      full: true,
    });
  });

  it("refuses a rect that overhangs on only one side", () => {
    expect(stableContentRect([{ x: 100, y: 0, w: 1400, h: 800 }], 1440, 810).full).toBe(true);
  });
});

describe("stableContentRect (PLAN Task 7)", () => {
  const W = 1440;
  const H = 2560;

  it("finds the inner rect of the real letterboxed clip", () => {
    // The motivating source: probes 1440×2560 portrait, but the picture is a
    // landscape strip with black baked in above and below.
    const rect = stableContentRect([{ x: 0, y: 874, w: 1440, h: 810 }], W, H);
    expect(rect.full).toBe(false);
    expect(rect.y).toBe(874);
    expect(rect.h).toBe(810);
    expect(rect.w).toBe(W);
  });

  it("a full-frame source stays the full frame", () => {
    expect(stableContentRect([{ x: 0, y: 0, w: W, h: H }], W, H)).toEqual({
      x: 0, y: 0, w: W, h: H, full: true,
    });
  });

  it("unions across samples — a bar must be black in EVERY frame to count", () => {
    // Frame 2 has content where frame 1 had black: that region is content.
    const rect = stableContentRect(
      [
        { x: 0, y: 800, w: W, h: 900 },
        { x: 0, y: 400, w: W, h: 1300 },
      ],
      W,
      H,
    );
    expect(rect.y).toBe(400);
    expect(rect.y + rect.h).toBe(1700);
  });

  it("does not crop a legitimately dark shot to a sliver", () => {
    // A fade-from-black or night scene where cropdetect finds almost nothing:
    // refusing the measurement beats cropping the video on bad evidence.
    const rect = stableContentRect([{ x: 600, y: 1100, w: 200, h: 300 }], W, H);
    expect(rect.full).toBe(true);
  });

  it("ignores hairline bars — encoder padding is not a letterbox", () => {
    const rect = stableContentRect([{ x: 2, y: 4, w: W - 4, h: H - 8 }], W, H);
    expect(rect.full).toBe(true);
  });

  it("snaps sides independently, so a real top bar survives clean left/right edges", () => {
    const rect = stableContentRect([{ x: 2, y: 874, w: W - 4, h: 810 }], W, H);
    expect(rect.full).toBe(false);
    expect(rect.x).toBe(0);
    expect(rect.w).toBe(W);
    expect(rect.y).toBe(874);
  });

  it("no samples means no crop", () => {
    expect(stableContentRect([], W, H).full).toBe(true);
  });

  it("keeps offsets and sizes even, expanding outward, for yuv420 encoders", () => {
    const rect = stableContentRect([{ x: 0, y: 875, w: W, h: 809 }], W, H);
    expect(rect.y % 2).toBe(0);
    expect(rect.h % 2).toBe(0);
    // Outward: the rounded rect still contains every content pixel.
    expect(rect.y).toBeLessThanOrEqual(875);
    expect(rect.y + rect.h).toBeGreaterThanOrEqual(875 + 809);
  });
});

/**
 * Task C (2026-07-28). Task 7 assumed a source is uniformly letterboxed. The
 * author's own clip is not: 24.0s of 63.5s is a landscape strip and the rest is
 * full-bleed portrait, alternating five times. `stableContentRect`'s union
 * correctly refused to crop it — a bar has to be black in EVERY sample — so the
 * bars rendered as bars, and the hook frame carried a 13% black band.
 *
 * The fix is to stop modelling framing as one constant per source.
 */
describe("contentRectTimeline (PLAN Task C — mixed framing)", () => {
  const W = 1440;
  const H = 2560;
  const BOX = { x: 0, y: 876, w: W, h: 808 };
  const FULL = { x: 0, y: 0, w: W, h: H };

  /** Samples every `step` seconds, from a list of per-sample rects. */
  const at = (rects: Array<{ x: number; y: number; w: number; h: number }>, step = 1) =>
    rects.map((r, i) => ({ ...r, tSec: i * step }));

  it("splits a source whose framing changes mid-take", () => {
    const timeline = contentRectTimeline(
      at([BOX, BOX, BOX, FULL, FULL, FULL, BOX, BOX, BOX]),
      W,
      H,
      9,
    );
    expect(timeline).toHaveLength(3);
    expect(timeline[0]!.rect.full).toBe(false);
    expect(timeline[1]!.rect.full).toBe(true);
    expect(timeline[2]!.rect.full).toBe(false);
    // Contiguous cover of the whole source, no gaps to fall through.
    expect(timeline[0]!.startSec).toBe(0);
    expect(timeline[2]!.endSec).toBeCloseTo(9, 6);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]!.startSec).toBeCloseTo(timeline[i - 1]!.endSec, 6);
    }
  });

  it("a uniformly letterboxed source is still ONE segment — Task 7 unregressed", () => {
    const timeline = contentRectTimeline(at([BOX, BOX, BOX, BOX, BOX]), W, H, 5);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rect).toMatchObject({ y: 876, h: 808, full: false });
  });

  it("a uniformly full-bleed source is one full segment", () => {
    const timeline = contentRectTimeline(at([FULL, FULL, FULL, FULL]), W, H, 4);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rect.full).toBe(true);
  });

  it("one anomalous dark sample does not become its own crop segment", () => {
    // THE risk this design reintroduces. `stableContentRect` unions precisely
    // because a dim frame can 'detect' a false crop; per-segment detection
    // would let a single such frame carve a bogus segment out of a good run.
    const timeline = contentRectTimeline(
      at([FULL, FULL, FULL, BOX, FULL, FULL, FULL]),
      W,
      H,
      7,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rect.full).toBe(true);
  });

  it("a run too short in WALL TIME is absorbed even with enough samples", () => {
    // Densely sampled: three samples spanning 0.3s is not a framing change.
    const dense = at([FULL, FULL, FULL, BOX, BOX, BOX, FULL, FULL, FULL], 0.1);
    const timeline = contentRectTimeline(dense, W, H, 0.9);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rect.full).toBe(true);
  });

  it("no samples means one full-frame segment, never an empty timeline", () => {
    const timeline = contentRectTimeline([], W, H, 30);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rect.full).toBe(true);
    expect(timeline[0]!.endSec).toBe(30);
  });

  it("boundaries land between the samples that disagree, not on top of one", () => {
    const timeline = contentRectTimeline(
      at([BOX, BOX, BOX, FULL, FULL, FULL]),
      W,
      H,
      6,
    );
    // Last BOX at t=2, first FULL at t=3 → the change is somewhere in (2,3).
    expect(timeline[0]!.endSec).toBeGreaterThan(2);
    expect(timeline[0]!.endSec).toBeLessThan(3);
  });
});

describe("contentRectAt", () => {
  const W = 1440;
  const H = 2560;
  const timeline = [
    { startSec: 0, endSec: 10, rect: { x: 0, y: 876, w: W, h: 808, full: false } },
    { startSec: 10, endSec: 20, rect: { x: 0, y: 0, w: W, h: H, full: true } },
  ];

  it("returns the rect active at a source time", () => {
    expect(contentRectAt(timeline, 5).full).toBe(false);
    expect(contentRectAt(timeline, 15).full).toBe(true);
  });

  it("is half-open, so a boundary belongs to the segment starting there", () => {
    expect(contentRectAt(timeline, 10).full).toBe(true);
  });

  it("clamps outside the timeline rather than inventing a full frame", () => {
    expect(contentRectAt(timeline, -5).full).toBe(false);
    expect(contentRectAt(timeline, 999).full).toBe(true);
  });

  it("an empty timeline is the full frame", () => {
    expect(contentRectAt([], 3, { width: W, height: H }).full).toBe(true);
  });
});

describe("cropFilter", () => {
  it("emits the ffmpeg crop for a letterboxed rect and nothing for a full frame", () => {
    expect(cropFilter({ x: 0, y: 874, w: 1440, h: 810, full: false })).toBe("crop=1440:810:0:874");
    expect(cropFilter({ x: 0, y: 0, w: 1440, h: 2560, full: true })).toBe("");
    expect(cropFilter(null)).toBe("");
  });
});
