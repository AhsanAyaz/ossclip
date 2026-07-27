import { describe, expect, it } from "vitest";
import { cropFilter, parseCropdetect, stableContentRect } from "../src/content-rect";

const CROPDETECT_LINE =
  "[Parsed_cropdetect_1 @ 0x55e] x1:0 x2:1439 y1:874 y2:1683 w:1440 h:810 x:0 y:874 " +
  "pts:2 t:1.000000 limit:24.000000 crop=1440:810:0:874";

describe("parseCropdetect", () => {
  it("reads crop=W:H:X:Y lines out of ffmpeg stderr", () => {
    expect(parseCropdetect(`noise\n${CROPDETECT_LINE}\nframe= 12 fps=…`)).toEqual([
      { w: 1440, h: 810, x: 0, y: 874 },
    ]);
  });

  it("returns [] for stderr with no cropdetect output", () => {
    expect(parseCropdetect("frame=  100 fps=25 q=-0.0 size=N/A")).toEqual([]);
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

describe("cropFilter", () => {
  it("emits the ffmpeg crop for a letterboxed rect and nothing for a full frame", () => {
    expect(cropFilter({ x: 0, y: 874, w: 1440, h: 810, full: false })).toBe("crop=1440:810:0:874");
    expect(cropFilter({ x: 0, y: 0, w: 1440, h: 2560, full: true })).toBe("");
    expect(cropFilter(null)).toBe("");
  });
});
