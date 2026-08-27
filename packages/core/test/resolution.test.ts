import { describe, expect, it } from "vitest";
import { resolveOutputFrame, smallestSource } from "../src/resolution";

// The caller's own frames (produce derives these from `--aspect`); stated
// here rather than imported so this suite pins the MATH, not a constant.
const PORTRAIT_FRAME = { width: 1080, height: 1920 };
const LANDSCAPE_FRAME = { width: 1920, height: 1080 };

/**
 * The output frame's SCALE, derived once and read by all three places that
 * would otherwise pre-downscale a 4K source to 1080p: the folder-concat
 * target, the mezzanine, and the render itself (2026-08-27).
 *
 * The composition stays 1080-wide whatever the scale — `captionFontSizeFor`
 * returns ABSOLUTE px (64/44), so a composition built at 2160 would draw
 * quarter-size captions. Remotion's own `scale` renders the same composition
 * larger, fonts and strokes included, which is why this returns a factor
 * rather than a pair of dimensions to build a stage from.
 */
describe("resolveOutputFrame", () => {
  const source4kPortrait = { width: 2160, height: 3840 };
  const source4kLandscape = { width: 3840, height: 2160 };
  const source1080Portrait = { width: 1080, height: 1920 };

  it("the default is 1080p at scale 1 — today's behaviour, byte-for-byte", () => {
    const out = resolveOutputFrame({
      frame: PORTRAIT_FRAME,
      source: source4kPortrait,
      resolution: "1080",
    });
    expect(out).toEqual({ scale: 1, width: 1080, height: 1920 });
  });

  it("an explicit height scales the frame by it, both dimensions even", () => {
    const at2160 = resolveOutputFrame({
      frame: PORTRAIT_FRAME,
      source: source4kPortrait,
      resolution: "2160",
    });
    expect(at2160).toEqual({ scale: 2, width: 2160, height: 3840 });
    const at1440 = resolveOutputFrame({
      frame: PORTRAIT_FRAME,
      source: source4kPortrait,
      resolution: "1440",
    });
    // 1080*4/3 = 1440, 1920*4/3 = 2560 — both even, no aspect drift.
    expect(at1440).toEqual({ scale: 4 / 3, width: 1440, height: 2560 });
  });

  it("auto keeps a portrait 4K source's own pixels — the case that started this", () => {
    expect(
      resolveOutputFrame({ frame: PORTRAIT_FRAME, source: source4kPortrait, resolution: "auto" }),
    ).toEqual({ scale: 2, width: 2160, height: 3840 });
  });

  it("auto never upscales: a 1080p source stays 1080p", () => {
    expect(
      resolveOutputFrame({ frame: PORTRAIT_FRAME, source: source1080Portrait, resolution: "auto" }),
    ).toEqual({ scale: 1, width: 1080, height: 1920 });
  });

  it("auto measures the pixels that SURVIVE the crop, not the source's raw count", () => {
    // A 4K landscape source cropped to 9:16 yields only 2160*(1080/1920) =
    // 1215px of width — barely over 1080, and not the 4K the file advertises.
    // Snapping DOWN (see the 0.5 step below) answers 1080p, which is honest:
    // rendering 2160 wide would be upscaling 1215px of real detail.
    expect(
      resolveOutputFrame({ frame: PORTRAIT_FRAME, source: source4kLandscape, resolution: "auto" }),
    ).toEqual({ scale: 1, width: 1080, height: 1920 });
    // The mirror case: a 4K LANDSCAPE source into a LANDSCAPE frame loses
    // nothing to the crop, so all 2160 lines survive.
    expect(
      resolveOutputFrame({ frame: LANDSCAPE_FRAME, source: source4kLandscape, resolution: "auto" }),
    ).toEqual({ scale: 2, width: 3840, height: 2160 });
  });

  it("auto snaps DOWN to a half step, so both dimensions stay even", () => {
    // 1080*1.5 = 1620 and 1920*1.5 = 2880: even. An arbitrary factor (1.125
    // → 1215) would be odd, which h264 cannot encode, and rounding to even
    // would drift the aspect off 9:16.
    expect(
      resolveOutputFrame({
        frame: PORTRAIT_FRAME,
        source: { width: 1700, height: 3022 },
        resolution: "auto",
      }),
    ).toEqual({ scale: 1.5, width: 1620, height: 2880 });
  });

  it("auto clamps at 2160 — one 8K file cannot trigger an overnight render", () => {
    expect(
      resolveOutputFrame({
        frame: PORTRAIT_FRAME,
        source: { width: 4320, height: 7680 },
        resolution: "auto",
      }),
    ).toEqual({ scale: 2, width: 2160, height: 3840 });
  });

  it("a folder's clips size by the SMALLEST — anything more upscales the rest", () => {
    // A folder concat letterboxes every clip into one frame, so the frame can
    // only honestly carry what the weakest clip has. Taking the largest would
    // upscale every other take and cost render time for invented pixels.
    expect(
      smallestSource([
        { width: 2160, height: 3840 },
        { width: 1080, height: 1920 },
        { width: 1440, height: 2560 },
      ]),
    ).toEqual({ width: 1080, height: 1920 });
  });

  it("smallestSource ignores clips that failed to probe, and answers null for none", () => {
    expect(
      smallestSource([{ width: 0, height: 0 }, { width: 2160, height: 3840 }]),
    ).toEqual({ width: 2160, height: 3840 });
    expect(smallestSource([])).toBeNull();
    expect(smallestSource([{ width: 0, height: 0 }])).toBeNull();
  });

  it("a source with no usable dimensions falls back to 1080p rather than throwing", () => {
    // Probe failures are a fact of life (§: parse, never coerce) and a render
    // that dies because ffprobe returned 0 helps nobody.
    expect(
      resolveOutputFrame({ frame: PORTRAIT_FRAME, source: { width: 0, height: 0 }, resolution: "auto" }),
    ).toEqual({ scale: 1, width: 1080, height: 1920 });
  });
});
