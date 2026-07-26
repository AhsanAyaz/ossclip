import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import {
  LAYOUT_TRANSITION_SEC,
  backdropOpacityAt,
  captionAnchorAt,
  layoutSlots,
  videoSlotAt,
} from "../src/stage";
import { LayoutSchema } from "@ossclip/core";

const cue = (layout: SceneCue["layout"], startSec: number, endSec: number): SceneCue => ({
  id: `${layout}-${startSec}`,
  layout,
  component: "TitleCard",
  props: { title: "X" },
  startSec,
  endSec,
});

describe("layoutSlots", () => {
  it("defines slots for every layout, inside the frame", () => {
    for (const layout of LayoutSchema.options) {
      const slots = layoutSlots(layout);
      for (const r of [slots.video.rect, slots.graphic].filter(Boolean) as Array<{
        x: number; y: number; w: number; h: number;
      }>) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("only full-bleed and video-top show captions", () => {
    expect(layoutSlots("full-bleed").captionAnchor).not.toBeNull();
    expect(layoutSlots("video-top").captionAnchor).not.toBeNull();
    expect(layoutSlots("pip-bubble").captionAnchor).toBeNull();
    expect(layoutSlots("graphic-only").captionAnchor).toBeNull();
    expect(layoutSlots("blurred-behind").captionAnchor).toBeNull();
  });

  it("pip video slot is square in pixels (a true circle)", () => {
    const { rect } = layoutSlots("pip-bubble").video;
    expect(rect.w * 1080).toBeCloseTo(rect.h * 1920, 3);
  });
});

describe("videoSlotAt", () => {
  const cues = [cue("pip-bubble", 2, 6)];

  it("is full-bleed outside any cue", () => {
    expect(videoSlotAt(cues, 0.5)).toEqual(layoutSlots("full-bleed").video);
    expect(videoSlotAt(cues, 7)).toEqual(layoutSlots("full-bleed").video);
  });

  it("reaches the target layout mid-cue and morphs at the edges", () => {
    const mid = videoSlotAt(cues, 4);
    expect(mid).toEqual(layoutSlots("pip-bubble").video);
    const entering = videoSlotAt(cues, 2 + LAYOUT_TRANSITION_SEC / 2);
    const full = layoutSlots("full-bleed").video;
    const pip = layoutSlots("pip-bubble").video;
    expect(entering.rect.w).toBeLessThan(full.rect.w);
    expect(entering.rect.w).toBeGreaterThan(pip.rect.w);
  });

  it("transitions cue→cue without snapping through full-bleed", () => {
    const chained = [cue("pip-bubble", 2, 6), cue("graphic-only", 6, 10)];
    const justBeforeBoundary = videoSlotAt(chained, 6 - 0.01);
    // Leaving pip toward graphic-only: opacity should be heading to 0,
    // but the rect stays pip-sized (both layouts share the pip rect).
    expect(justBeforeBoundary.opacity).toBeLessThan(0.2);
    expect(justBeforeBoundary.rect.w).toBeCloseTo(layoutSlots("pip-bubble").video.rect.w, 5);
  });
});

describe("caption + backdrop timelines", () => {
  const cues = [cue("graphic-only", 2, 6)];
  it("captions hidden while the graphic owns the frame, visible otherwise", () => {
    expect(captionAnchorAt(cues, 1)).not.toBeNull();
    expect(captionAnchorAt(cues, 4)).toBeNull();
    expect(captionAnchorAt(cues, 8)).not.toBeNull();
  });
  it("backdrop fades in and out around the cue", () => {
    expect(backdropOpacityAt(cues, 1)).toBe(0);
    expect(backdropOpacityAt(cues, 4)).toBe(1);
    const entering = backdropOpacityAt(cues, 2 + LAYOUT_TRANSITION_SEC / 2);
    expect(entering).toBeGreaterThan(0.2);
    expect(entering).toBeLessThan(0.8);
    expect(backdropOpacityAt(cues, 6.5)).toBe(0);
  });
});
