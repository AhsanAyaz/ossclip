import { describe, expect, it } from "vitest";
import {
  LANDSCAPE_FRAME,
  LANDSCAPE_SAFE_AREA,
  PORTRAIT_FRAME,
  SAFE_AREA,
  safeRectFor,
} from "../src/stage";
import {
  WATERMARK_OPACITY,
  WATERMARK_TEXT,
  showWatermark,
  watermarkLayout,
} from "../src/watermark-layout";

describe("watermarkLayout", () => {
  // TOP-LEFT is the design's one load-bearing position: 9:16 platform chrome
  // owns the right edge and the bottom, and captions own the lower third —
  // the wordmark must sit exactly on the safe area's top-left corner, per
  // shape, from the SAME safeAreaFor decision the stage uses.
  it("sits on the portrait safe area's top-left corner", () => {
    const l = watermarkLayout(PORTRAIT_FRAME);
    expect(l.xPx).toBe(Math.round(SAFE_AREA.left * PORTRAIT_FRAME.width));
    expect(l.yPx).toBe(Math.round(SAFE_AREA.top * PORTRAIT_FRAME.height));
  });

  it("uses the landscape margins for a 16:9 frame, not the portrait chrome insets", () => {
    const l = watermarkLayout(LANDSCAPE_FRAME);
    expect(l.xPx).toBe(Math.round(LANDSCAPE_SAFE_AREA.left * LANDSCAPE_FRAME.width));
    expect(l.yPx).toBe(Math.round(LANDSCAPE_SAFE_AREA.top * LANDSCAPE_FRAME.height));
  });

  // Both shapes share a 1080px short edge, so the credit renders at the same
  // physical size in either — the long edge must not balloon it.
  it("sizes the type off the short edge, identically for both shapes", () => {
    const portrait = watermarkLayout(PORTRAIT_FRAME);
    const landscape = watermarkLayout(LANDSCAPE_FRAME);
    expect(portrait.fontPx).toBe(landscape.fontPx);
    expect(portrait.fontPx).toBeGreaterThan(0);
  });

  // A credit, not a caption: it must read as subtle, and it must stay inside
  // the textual safe rect in both shapes (an overhang would collide with the
  // exact platform chrome the placement exists to dodge).
  it("is low-opacity and inside the safe rect in both shapes", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      const l = watermarkLayout(frame);
      expect(l.opacity).toBe(WATERMARK_OPACITY);
      expect(l.opacity).toBeGreaterThan(0);
      expect(l.opacity).toBeLessThan(1);
      // Pixel space with a half-pixel rounding allowance: the layout rounds
      // to whole pixels, so the corner can land up to 0.5px inside-or-out of
      // the exact fractional edge — never a whole pixel past it.
      const safe = safeRectFor(frame);
      expect(l.xPx).toBeGreaterThanOrEqual(Math.floor(safe.x * frame.width));
      // One line of type at the top edge: y + font height stays well inside.
      expect(l.yPx + l.fontPx).toBeLessThanOrEqual((safe.y + safe.h) * frame.height);
      expect(l.text).toBe(WATERMARK_TEXT);
    }
  });
});

describe("showWatermark (render-props back-compat)", () => {
  // Every pre-watermark render-props.json simply lacks the field — parsing
  // one and reading `.watermark` yields undefined, which must mean OFF.
  it("a pre-watermark render-props.json stays off", () => {
    const old = JSON.parse('{"videoFileName":"take.mp4","outputDurationSec":12}') as {
      watermark?: boolean;
    };
    expect(showWatermark(old.watermark)).toBe(false);
  });

  it("only a literal true turns the credit on — no truthiness coercion", () => {
    expect(showWatermark(true)).toBe(true);
    expect(showWatermark(false)).toBe(false);
    expect(showWatermark(undefined)).toBe(false);
    // A hand-edited render-props.json must not coerce a credit on.
    expect(showWatermark("yes")).toBe(false);
    expect(showWatermark(1)).toBe(false);
  });
});
