import { describe, expect, it } from "vitest";
import { layoutSlotAspects } from "../src/produce";

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

const aspectOf = (frame: { width: number; height: number }, layout: string) => {
  const entry = layoutSlotAspects(frame).find((l) => l.layout === layout);
  expect(entry).toBeDefined();
  return entry!;
};

/**
 * The producer's framing brief must see the slot shapes of the frame the run
 * actually renders. The bug this pins: `layoutSlots(layout)` defaults to
 * PORTRAIT_FRAME while the aspect multiply used the run's real dims, so a
 * 16:9 run judged every layout against portrait geometry × landscape pixels
 * — latent since R15 landscape support, because the split layouts are the
 * ones whose GEOMETRY flips with orientation.
 */
describe("layoutSlotAspects", () => {
  it("split-left is a side panel in landscape: slotAspect ≈ 0.889", () => {
    // {w:0.5, h:1} of 1920x1080 → 960/1080. The buggy portrait-geometry
    // version was {w:1, h:0.5} × landscape pixels → 3.556, four times wider
    // than the slot the renderer actually draws.
    expect(aspectOf(LANDSCAPE, "split-left").slotAspect).toBeCloseTo(0.889, 3);
  });

  it("split-left stacks in portrait, so the two frames disagree", () => {
    // {w:1, h:0.5} of 1080x1920 → 1080/960 = 1.125 — the value every 16:9
    // brief was wrongly built from before the frame argument was passed.
    const portrait = aspectOf(PORTRAIT, "split-left").slotAspect;
    expect(portrait).toBeCloseTo(1.125, 3);
    expect(aspectOf(LANDSCAPE, "split-left").slotAspect).not.toBeCloseTo(portrait, 2);
  });

  it("keeps the PRIMARY_VIDEO_SLOT_AREA subject/inset split in both frames", () => {
    for (const frame of [LANDSCAPE, PORTRAIT]) {
      // A half-frame split IS the subject; the pip bubble (~5% of frame) and
      // the undrawn graphic-only slot never are.
      expect(aspectOf(frame, "split-left").primary).toBe(true);
      expect(aspectOf(frame, "full-bleed").primary).toBe(true);
      expect(aspectOf(frame, "pip-bubble").primary).toBe(false);
      expect(aspectOf(frame, "graphic-only").primary).toBe(false);
    }
  });
});
