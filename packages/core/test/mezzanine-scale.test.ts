import { describe, expect, it } from "vitest";
import {
  MEZZANINE_SCALE_MARGIN,
  escapeFilterPath,
  mezzanineFileName,
  mezzanineScale,
  mezzanineVf,
} from "../src/ingest";

/**
 * 2026-08-17 render-speed pass. The field case: a 3456x2234@60 source fed a
 * 1920x1080@30 render at ~0.43x realtime — OffthreadVideo extracts every
 * frame via ffmpeg on CPU, so the render paid ~4.6x the pixels and 2x the
 * frames it ever displayed. The mezzanine is a re-encode anyway; encoding it
 * at display size (plus motion-driver headroom) is decode work removed from
 * every frame of the render.
 */

const OUT_LANDSCAPE = { width: 1920, height: 1080, fps: 30 };
const OUT_PORTRAIT = { width: 1080, height: 1920, fps: 30 };

describe("mezzanineScale", () => {
  it("the field case: 3456x2234@60 covered into 1920x1080@30", () => {
    const s = mezzanineScale({ width: 3456, height: 2234, fps: 60 }, OUT_LANDSCAPE, "cover");
    // cover scale = max(1920/3456, 1080/2234) = 5/9; ×1.1 margin = 11/18.
    expect(s).toEqual({ width: 2112, height: 1366, fps: 30 });
    // The margin is real: the exact displayed width is 1920, and 2112 is
    // 1920 × MEZZANINE_SCALE_MARGIN — headroom for the 1.05 × 1.015 ≈ 1.066
    // worst-case zoom+punch magnification.
    expect(s!.width).toBe(1920 * MEZZANINE_SCALE_MARGIN);
  });

  it("rounds dimensions EVEN for yuv420, not merely to the nearest integer", () => {
    const s = mezzanineScale({ width: 3456, height: 2234, fps: 60 }, OUT_LANDSCAPE, "cover");
    // 2234 × 11/18 = 1365.2 — nearest integer is 1365, which x264 rejects
    // for yuv420; nearest EVEN is 1366.
    expect(s!.height).toBe(1366);
    expect(s!.width % 2).toBe(0);
    expect(s!.height % 2).toBe(0);
  });

  it("contain targets the smaller displayed size — the whole frame fits inside", () => {
    const s = mezzanineScale({ width: 3456, height: 2234, fps: 60 }, OUT_LANDSCAPE, "contain");
    // contain scale = min axis ratio = 1080/2234; ×1.1 → height 1188 exactly.
    expect(s).toEqual({ width: 1838, height: 1188, fps: 30 });
    expect(s!.height).toBeLessThan(1366); // strictly less decode than cover
  });

  it("returns null when the source is already at the render's size and rate", () => {
    expect(mezzanineScale({ width: 1080, height: 1920, fps: 30 }, OUT_PORTRAIT, "cover")).toBeNull();
  });

  it("never upscales: a smaller-than-frame source keeps its native size", () => {
    // 720x1280 covered into 1080x1920 would need ×1.5 — softening every
    // frame for zero decode saved. fps 24 is already under the output's 30.
    expect(mezzanineScale({ width: 720, height: 1280, fps: 24 }, OUT_PORTRAIT, "cover")).toBeNull();
  });

  it("reduces fps alone when the dimensions are already right", () => {
    // Frames the render never samples are pure decode waste; EDL srcIn/srcOut
    // are SECONDS, so the 60→30 resample moves a cut boundary by ≤1/60s.
    expect(mezzanineScale({ width: 1080, height: 1920, fps: 60 }, OUT_PORTRAIT, "cover")).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
    });
  });

  it("keeps a below-output fps rather than resampling up", () => {
    const s = mezzanineScale({ width: 3456, height: 2234, fps: 23.976 }, OUT_LANDSCAPE, "cover");
    expect(s!.fps).toBe(23.976);
  });

  it("refuses degenerate source dimensions", () => {
    expect(mezzanineScale({ width: 0, height: 1080, fps: 30 }, OUT_LANDSCAPE, "cover")).toBeNull();
  });
});

describe("mezzanineFileName", () => {
  it("keeps the legacy names when unscaled, so existing workdir caches stay valid", () => {
    expect(mezzanineFileName(false, null)).toBe("mezzanine.mp4");
    expect(mezzanineFileName(true, null)).toBe("mezzanine-content.mp4");
  });

  it("embeds the scale decision so a full-res cache can never serve a scaled run", () => {
    expect(mezzanineFileName(false, { width: 2112, height: 1366, fps: 30 })).toBe(
      "mezzanine-2112x1366@30.mp4",
    );
    expect(mezzanineFileName(true, { width: 1838, height: 1188, fps: 23.976 })).toBe(
      "mezzanine-content-1838x1188@24.mp4",
    );
  });

  it("no LUT keeps names byte-for-byte identical to the pre-LUT era", () => {
    // Grading landed after scaled names shipped; an ungraded run must keep
    // resolving to the file a warm workdir already holds, or every existing
    // cache is silently invalidated.
    expect(mezzanineFileName(false, null, undefined)).toBe("mezzanine.mp4");
    expect(mezzanineFileName(true, null, undefined)).toBe("mezzanine-content.mp4");
    expect(mezzanineFileName(false, { width: 2112, height: 1366, fps: 30 }, undefined)).toBe(
      "mezzanine-2112x1366@30.mp4",
    );
  });

  it("folds the LUT hash in so an ungraded cache can never serve a graded run", () => {
    expect(mezzanineFileName(false, null, "abc123")).toBe("mezzanine-lutabc123.mp4");
    expect(mezzanineFileName(true, { width: 2112, height: 1366, fps: 30 }, "abc123")).toBe(
      "mezzanine-content-2112x1366@30-lutabc123.mp4",
    );
  });
});

describe("mezzanineVf", () => {
  const scale = { width: 2112, height: 1366, fps: 30 };
  const lut = { path: "/luts/teal.cube", hash: "abc123" };

  it("orders crop, then scale, then lut — grading runs on exactly the pixels the render sees", () => {
    expect(mezzanineVf({ cropVf: "crop=1920:800:0:140", scale, lut })).toBe(
      "crop=1920:800:0:140,scale=2112:1366,lut3d=file=/luts/teal.cube:interp=tetrahedral",
    );
  });

  it("emits an empty chain when there is nothing to do (caller drops -vf)", () => {
    expect(mezzanineVf({})).toBe("");
  });

  it("emits crop/scale alone, unchanged from the pre-LUT chain", () => {
    expect(mezzanineVf({ cropVf: "crop=1920:800:0:140" })).toBe("crop=1920:800:0:140");
    expect(mezzanineVf({ scale })).toBe("scale=2112:1366");
  });

  it("a lone LUT still forms a valid chain", () => {
    expect(mezzanineVf({ lut })).toBe("lut3d=file=/luts/teal.cube:interp=tetrahedral");
  });

  it("escapes the LUT path inside the chain", () => {
    expect(mezzanineVf({ lut: { path: "C:\\LUTs\\teal.cube", hash: "abc123" } })).toBe(
      "lut3d=file=C\\\\:\\\\\\\\LUTs\\\\\\\\teal.cube:interp=tetrahedral",
    );
  });
});

describe("escapeFilterPath", () => {
  it("colons get both escape levels — an unescaped `:` ends the option value", () => {
    // Level 1 makes `\:`, level 2 escapes that backslash: `\\:`.
    expect(escapeFilterPath("C:/luts/a.cube")).toBe("C\\\\:/luts/a.cube");
  });

  it("backslashes are doubled at each level", () => {
    expect(escapeFilterPath("C:\\a.cube")).toBe("C\\\\:\\\\\\\\a.cube");
  });

  it("single quotes survive both parse levels", () => {
    expect(escapeFilterPath("/luts/dee's.cube")).toBe("/luts/dee\\\\\\'s.cube");
  });

  it("spaces pass through untouched — argv reaches ffmpeg without a shell", () => {
    expect(escapeFilterPath("/my luts/warm look.cube")).toBe("/my luts/warm look.cube");
  });
});
