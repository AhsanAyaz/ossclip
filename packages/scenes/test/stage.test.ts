import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import {
  CAPTION_HALF_BAND,
  DEFAULT_FACE,
  HEAD_ABOVE_FACE,
  LAYOUT_TRANSITION_SEC,
  SAFE_AREA,
  SAFE_RECT,
  backdropOpacityAt,
  captionAnchorAt,
  headFitsSlot,
  layoutSlots,
  objectPosYFor,
  videoSlotAt,
} from "../src/stage";
import { LayoutSchema, SCENE_REGISTRY, SceneComponentIdSchema, ZOOM_MAX_SCALE } from "@ossclip/core";

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

  it("every graphic slot sits inside the platform safe area", () => {
    for (const layout of LayoutSchema.options) {
      const g = layoutSlots(layout).graphic;
      if (!g) continue;
      expect(g.x, layout).toBeGreaterThanOrEqual(SAFE_RECT.x - 1e-9);
      expect(g.y, layout).toBeGreaterThanOrEqual(SAFE_RECT.y - 1e-9);
      expect(g.x + g.w, layout).toBeLessThanOrEqual(SAFE_RECT.x + SAFE_RECT.w + 1e-9);
      expect(g.y + g.h, layout).toBeLessThanOrEqual(SAFE_RECT.y + SAFE_RECT.h + 1e-9);
    }
  });

  it("every layout shows captions, inside the safe area, clear of the graphic (FINDINGS §2/§6)", () => {
    for (const layout of LayoutSchema.options) {
      const slots = layoutSlots(layout);
      const a = slots.captionAnchor;
      const bandTop = a - CAPTION_HALF_BAND;
      const bandBottom = a + CAPTION_HALF_BAND;
      expect(bandTop, layout).toBeGreaterThanOrEqual(SAFE_AREA.top);
      expect(bandBottom, layout).toBeLessThanOrEqual(1 - SAFE_AREA.bottom + 1e-9);
      if (slots.graphic) {
        const overlap =
          Math.min(bandBottom, slots.graphic.y + slots.graphic.h) - Math.max(bandTop, slots.graphic.y);
        expect(overlap, `captions overlap graphic in ${layout}`).toBeLessThanOrEqual(0);
      }
    }
  });

  it("captions never cover a sharp, visible face", () => {
    // video-top: the face fills the top block — the caption band starts below it.
    const vt = layoutSlots("video-top");
    expect(vt.captionAnchor - CAPTION_HALF_BAND).toBeGreaterThanOrEqual(
      vt.video.rect.y + vt.video.rect.h,
    );
    // pip-bubble: band ends above the bubble.
    const pip = layoutSlots("pip-bubble");
    expect(pip.captionAnchor + CAPTION_HALF_BAND).toBeLessThanOrEqual(pip.video.rect.y);
    // full-bleed: face occupies the upper half — captions stay in the lower third.
    expect(layoutSlots("full-bleed").captionAnchor).toBeGreaterThanOrEqual(0.6);
  });

  it("pip video slot is square in pixels (a true circle)", () => {
    const { rect } = layoutSlots("pip-bubble").video;
    expect(rect.w * 1080).toBeCloseTo(rect.h * 1920, 3);
  });

  it("every alternate layout has a graphic slot at least as tall as the default's", () => {
    // FINDINGS §20 variety must not re-open §1/§12: components size their type
    // against their DEFAULT slot, so a shorter alternate would overflow.
    for (const id of SceneComponentIdSchema.options) {
      const meta = SCENE_REGISTRY[id];
      const base = layoutSlots(meta.defaultLayout).graphic;
      for (const alt of meta.altLayouts) {
        const slot = layoutSlots(alt).graphic;
        // full-bleed has no graphic slot — a scene assigned there renders nothing.
        expect(slot, `${id} alternate ${alt} has no graphic slot`).not.toBeNull();
        expect(slot!.h, `${id}: ${alt} is shorter than ${meta.defaultLayout}`).toBeGreaterThanOrEqual(
          base!.h,
        );
        expect(alt, `${id} lists its own default as an alternate`).not.toBe(meta.defaultLayout);
      }
    }
  });
});

describe("face-aware crop bias (FINDINGS §13/§19)", () => {
  const vtRect = layoutSlots("video-top").video.rect;

  /**
   * Where the head box lands inside the band, as fractions of slot height.
   * 0 is the top of the band, 1 the bottom — so `crown >= 0` means the top of
   * the head is visible and `chin <= 1` means the mouth is.
   */
  const headInSlot = (rect: typeof vtRect, face: { centerYFrac: number; sizeFrac?: number }) => {
    const slotH = rect.h * 1920;
    const displayedH = ((rect.w * 1080) * 1920) / 1080;
    const offset = objectPosYFor(rect, face) * (displayedH - slotH);
    const size = face.sizeFrac ?? DEFAULT_FACE.sizeFrac;
    const crownFrac = face.centerYFrac - size / 2 - HEAD_ABOVE_FACE * size;
    return {
      crown: (crownFrac * displayedH - offset) / slotH,
      chin: ((face.centerYFrac + size / 2) * displayedH - offset) / slotH,
      headFits: headFitsSlot(rect, face),
    };
  };

  it("a full-height slot needs no bias", () => {
    expect(objectPosYFor({ x: 0, y: 0, w: 1, h: 1 }, DEFAULT_FACE)).toBe(0.5);
  });

  it("never returns NaN when sizeFrac is absent (it is optional on the schema)", () => {
    for (const layout of LayoutSchema.options) {
      const p = objectPosYFor(layoutSlots(layout).video.rect, { centerYFrac: 0.38 });
      expect(Number.isFinite(p), layout).toBe(true);
    }
  });

  it("keeps the mouth in shot for every plausible framing", () => {
    // The §13 regression was a cut chin. It must be impossible, whether or
    // not the whole head fits.
    for (const centerYFrac of [0.25, 0.3, 0.38, 0.45, 0.55]) {
      for (const sizeFrac of [0.15, 0.22, 0.3, 0.4]) {
        const { chin } = headInSlot(vtRect, { centerYFrac, sizeFrac });
        expect(chin, `centre ${centerYFrac} size ${sizeFrac}`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("keeps the crown in shot whenever the head geometrically fits", () => {
    for (const centerYFrac of [0.25, 0.3, 0.38, 0.45, 0.55]) {
      for (const sizeFrac of [0.15, 0.22, 0.3, 0.4]) {
        const { crown, headFits } = headInSlot(vtRect, { centerYFrac, sizeFrac });
        if (headFits) {
          expect(crown, `centre ${centerYFrac} size ${sizeFrac}`).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
  });

  it("shows more headroom than centring the face box did (the §19 fix)", () => {
    // Reproduces the reported measurement: face centre 37.7% down the source.
    // The old formula seated the face centre at 0.42 of the band.
    const face = { centerYFrac: 0.377, sizeFrac: 0.2 };
    const slotH = vtRect.h * 1920;
    const displayedH = 1920;
    const previous = (face.centerYFrac * displayedH - 0.42 * slotH) / (displayedH - slotH);
    expect(objectPosYFor(vtRect, face)).toBeLessThan(previous);
  });

  it("is monotonic in the face position and clamped at the source edges", () => {
    expect(objectPosYFor(vtRect, { centerYFrac: 0.45 })).toBeGreaterThan(
      objectPosYFor(vtRect, { centerYFrac: 0.3 }),
    );
    expect(objectPosYFor(vtRect, { centerYFrac: 0.02 })).toBe(0);
    expect(objectPosYFor(vtRect, { centerYFrac: 0.98 })).toBe(1);
  });

  it("leaves room for the zoom to breathe without clipping the mouth", () => {
    // §15 scales slot content by up to ZOOM_MAX_SCALE about 50% 40%, eating
    // 0.6·(1−1/s) off the bottom of the band at its peak.
    const bite = 0.6 * (1 - 1 / ZOOM_MAX_SCALE);
    for (const sizeFrac of [0.15, 0.22]) {
      const { chin } = headInSlot(vtRect, { centerYFrac: 0.38, sizeFrac });
      expect(chin).toBeLessThanOrEqual(1 - bite + 1e-9);
    }
  });

  it("threads the measured face through videoSlotAt", () => {
    const cues = [cue("video-top", 2, 6)];
    const low = videoSlotAt(cues, 4, { centerYFrac: 0.45 });
    const high = videoSlotAt(cues, 4, { centerYFrac: 0.3 });
    expect(low.objectPosY).toBeGreaterThan(high.objectPosY);
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
  it("captions stay visible while a graphic owns the frame, in its reserved band", () => {
    expect(captionAnchorAt(cues, 1)).toBe(layoutSlots("full-bleed").captionAnchor);
    expect(captionAnchorAt(cues, 4)).toBe(layoutSlots("graphic-only").captionAnchor);
    expect(captionAnchorAt(cues, 8)).toBe(layoutSlots("full-bleed").captionAnchor);
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
