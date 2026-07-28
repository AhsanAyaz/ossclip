import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import {
  CAPTION_HALF_BAND,
  COVER_GRID_RECT,
  COVER_TEXT_RECT,
  COVER_GRID_SAFE,
  DEFAULT_FACE,
  coverTextRect,
  freeBands,
  headBand,
  objectPosXFor,
  HEAD_ABOVE_FACE,
  LAYOUT_TRANSITION_SEC,
  SAFE_AREA,
  SAFE_RECT,
  avoidSlicingText,
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

describe("cover geometry (FINDINGS §31)", () => {
  it("the grid-safe band is inside the centre square the profile grid keeps", () => {
    // A 1080×1920 cover cropped to a centre square keeps the middle 56.25%;
    // text outside that is simply gone from the profile grid.
    const squareTop = (1 - 1080 / 1920) / 2;
    expect(COVER_GRID_SAFE.top).toBeGreaterThanOrEqual(squareTop);
    expect(1 - COVER_GRID_SAFE.bottom).toBeLessThanOrEqual(1 - squareTop);
  });

  it("is a DIFFERENT constraint from the player safe area — neither contains the other", () => {
    // The grid crop is tighter top and bottom; the player's action rail eats a
    // right edge the grid tile does not have. That is why cover text uses the
    // INTERSECTION rather than either one.
    expect(COVER_GRID_RECT.y).toBeGreaterThan(SAFE_RECT.y);
    expect(COVER_GRID_RECT.x + COVER_GRID_RECT.w).toBeGreaterThan(SAFE_RECT.x + SAFE_RECT.w);
  });

  it("cover text sits inside BOTH constraints", () => {
    for (const r of [COVER_GRID_RECT, SAFE_RECT]) {
      expect(COVER_TEXT_RECT.x).toBeGreaterThanOrEqual(r.x - 1e-9);
      expect(COVER_TEXT_RECT.y).toBeGreaterThanOrEqual(r.y - 1e-9);
      expect(COVER_TEXT_RECT.x + COVER_TEXT_RECT.w).toBeLessThanOrEqual(r.x + r.w + 1e-9);
      expect(COVER_TEXT_RECT.y + COVER_TEXT_RECT.h).toBeLessThanOrEqual(r.y + r.h + 1e-9);
    }
  });

  it("leaves a usable band for a banner", () => {
    expect(COVER_TEXT_RECT.h).toBeGreaterThan(0.4);
    expect(COVER_TEXT_RECT.w).toBeGreaterThan(0.7);
  });
});

describe("cover banner placement (FINDINGS §33)", () => {
  // The reported measurement from the shipped cover: face 36% down, 38% tall.
  const face = { centerYFrac: 0.36, sizeFrac: 0.38 };

  const clearOfHead = (r: { y: number; h: number }) => {
    const head = headBand(face);
    return Math.min(r.y + r.h, head.end) - Math.max(r.y, head.start) <= 1e-9;
  };

  it("keeps the banner off the face — the §33 defect", () => {
    expect(clearOfHead(COVER_TEXT_RECT)).toBe(false); // the shipped behaviour
    expect(clearOfHead(coverTextRect(face))).toBe(true);
  });

  it("stays inside the grid-safe band it started from", () => {
    const r = coverTextRect(face);
    expect(r.y).toBeGreaterThanOrEqual(COVER_TEXT_RECT.y - 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(COVER_TEXT_RECT.y + COVER_TEXT_RECT.h + 1e-9);
    expect(r.x).toBe(COVER_TEXT_RECT.x);
  });

  it("takes the TALLER free band, not simply the one below", () => {
    // Face low in the frame ⇒ the room is above it.
    const low = { centerYFrac: 0.72, sizeFrac: 0.3 };
    const r = coverTextRect(low);
    expect(r.y + r.h).toBeLessThanOrEqual(headBand(low).start + 1e-9);
  });

  it("expands the box to a HEAD — a banner on the hair is still on the subject", () => {
    const head = headBand(face);
    expect(head.start).toBeLessThan(face.centerYFrac - face.sizeFrac / 2);
    expect(head.end).toBeGreaterThan(face.centerYFrac + face.sizeFrac / 2);
  });

  it("falls back to the full rect when a close-up leaves no usable band", () => {
    // A banner over the face beats a cover with no headline at all.
    expect(coverTextRect({ centerYFrac: 0.5, sizeFrac: 0.9 })).toEqual(COVER_TEXT_RECT);
  });

  it("no face measured means no constraint", () => {
    expect(coverTextRect(null)).toEqual(COVER_TEXT_RECT);
    expect(coverTextRect(undefined)).toEqual(COVER_TEXT_RECT);
  });
});

describe("freeBands", () => {
  const range = { start: 0, end: 1 };

  it("returns the whole range when nothing blocks it", () => {
    expect(freeBands(range, [])).toEqual([{ start: 0, end: 1 }]);
  });

  it("orders bands tallest first, which is what every caller wants", () => {
    const bands = freeBands(range, [{ y: 0.2, h: 0.1 }]);
    expect(bands[0]!.start).toBeCloseTo(0.3, 9);
    expect(bands[0]!.end).toBe(1);
    expect(bands[1]).toEqual({ start: 0, end: 0.2 });
  });

  it("merges overlapping blockers instead of emitting a phantom gap", () => {
    const bands = freeBands(range, [{ y: 0.2, h: 0.3 }, { y: 0.3, h: 0.3 }]);
    expect(bands).toHaveLength(2);
    expect(bands[0]!.start).toBeCloseTo(0.6, 9);
    expect(bands[1]!.end).toBeCloseTo(0.2, 9);
  });

  it("clips blockers to the range and drops ones entirely outside it", () => {
    expect(freeBands({ start: 0.4, end: 0.8 }, [{ y: 0, h: 0.1 }])).toEqual([
      { start: 0.4, end: 0.8 },
    ]);
  });

  it("a fully blocked range has no free band at all", () => {
    expect(freeBands(range, [{ y: -0.5, h: 2 }])).toEqual([]);
  });
});

describe("non-portrait sources (generalization)", () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const LANDSCAPE = 16 / 9;
  const TALL_PHONE = 1080 / 2340; // 19.5:9, what a modern phone actually shoots

  it("a landscape source has no vertical overflow to bias", () => {
    // `cover` scales it to the slot's HEIGHT, so the whole source height shows
    // and there is nothing to slide. The old math assumed 9:16 outright and
    // would have computed a bias against a height the element never has.
    const face = { centerYFrac: 0.3, sizeFrac: 0.3, sourceAspect: LANDSCAPE };
    expect(objectPosYFor(full, face)).toBe(0.5);
  });

  it("…and is biased HORIZONTALLY instead, toward the measured face", () => {
    const left = { centerYFrac: 0.3, centerXFrac: 0.2, sourceAspect: LANDSCAPE };
    const right = { centerYFrac: 0.3, centerXFrac: 0.8, sourceAspect: LANDSCAPE };
    expect(objectPosXFor(full, left)).toBeLessThan(objectPosXFor(full, right));
    // A face against the source's own edge clamps — there is nothing further
    // out to show, and sliding past it would letterbox the slot.
    expect(objectPosXFor(full, { ...left, centerXFrac: 0.02 })).toBe(0);
    expect(objectPosXFor(full, { ...right, centerXFrac: 0.98 })).toBe(1);
  });

  it("a portrait source is never biased horizontally", () => {
    // The 9:16 case must be untouched by any of this.
    expect(objectPosXFor(full, { centerYFrac: 0.38, centerXFrac: 0.2 })).toBe(0.5);
    expect(objectPosXFor(full, DEFAULT_FACE)).toBe(0.5);
  });

  it("an unmeasured horizontal position stays centred rather than guessing", () => {
    expect(objectPosXFor(full, { centerYFrac: 0.3, sourceAspect: LANDSCAPE })).toBe(0.5);
  });

  it("a taller-than-9:16 phone source still keeps the chin in a short band", () => {
    const rect = { x: 0, y: 0, w: 1, h: 0.42 }; // video-top
    const face = { centerYFrac: 0.38, sizeFrac: 0.22, sourceAspect: TALL_PHONE };
    const slotH = 0.42 * 1920;
    const displayedH = 1080 / TALL_PHONE;
    const offset = objectPosYFor(rect, face) * (displayedH - slotH);
    const chin = (face.centerYFrac + face.sizeFrac / 2) * displayedH;
    expect(chin - offset).toBeLessThanOrEqual(slotH);
  });

  it("omitting sourceAspect reproduces the old portrait-only behaviour exactly", () => {
    const rect = { x: 0, y: 0, w: 1, h: 0.42 };
    const face = { centerYFrac: 0.38, sizeFrac: 0.22 };
    expect(objectPosYFor(rect, face)).toBe(objectPosYFor(rect, { ...face, sourceAspect: 1080 / 1920 }));
  });
});

describe("crop avoids slicing burned-in text (FINDINGS §36)", () => {
  const VIDEO_TOP = { x: 0, y: 0, w: 1, h: 0.42 };
  const FACE = { centerYFrac: 0.36, sizeFrac: 0.38, sourceAspect: 720 / 1280 };
  /** The real reel's title: a black box at 13-24% of the source. */
  const TITLE = { y: 0.13, h: 0.11 };

  /** Where the crop window sits in the source, as fractions of source height. */
  function window(posY: number, rect: { h: number }, face: typeof FACE) {
    const slotH = rect.h * 1920;
    const displayedH = Math.max(slotH, (1 * 1080) / face.sourceAspect);
    const winH = slotH / displayedH;
    const top = posY * (1 - winH);
    return { top, bottom: top + winH };
  }

  function slices(posY: number, band: { y: number; h: number }) {
    const { top, bottom } = window(posY, VIDEO_TOP, FACE);
    const cutsTop = band.y < top && top < band.y + band.h;
    const cutsBottom = band.y < bottom && bottom < band.y + band.h;
    return cutsTop || cutsBottom;
  }

  it("the unadjusted crop does slice the real clip's title", () => {
    // Guards the premise: without this the fix would be untestable.
    expect(slices(objectPosYFor(VIDEO_TOP, FACE), TITLE)).toBe(true);
  });

  it("adjusts so the title is either whole or absent, never cut", () => {
    const posY = avoidSlicingText(objectPosYFor(VIDEO_TOP, FACE), VIDEO_TOP, FACE, [TITLE]);
    expect(slices(posY, TITLE)).toBe(false);
  });

  it("moves as little as it can", () => {
    const before = objectPosYFor(VIDEO_TOP, FACE);
    const after = avoidSlicingText(before, VIDEO_TOP, FACE, [TITLE]);
    expect(Math.abs(after - before)).toBeLessThan(0.35);
  });

  it("is a no-op without bands, and when the whole source is visible", () => {
    const before = objectPosYFor(VIDEO_TOP, FACE);
    expect(avoidSlicingText(before, VIDEO_TOP, FACE, [])).toBe(before);
    const full = { x: 0, y: 0, w: 1, h: 1 };
    const posY = objectPosYFor(full, DEFAULT_FACE);
    expect(avoidSlicingText(posY, full, DEFAULT_FACE, [TITLE])).toBe(posY);
  });

  it("keeps the original when no shift can resolve the band", () => {
    // A band taller than the window can neither be excluded nor included.
    const huge = { y: 0.05, h: 0.9 };
    const before = objectPosYFor(VIDEO_TOP, FACE);
    expect(avoidSlicingText(before, VIDEO_TOP, FACE, [huge])).toBe(before);
  });

  it("layoutSlots applies it, and videoSlotAt only while the text is up", () => {
    const plain = layoutSlots("video-top", FACE).video.objectPosY;
    const avoided = layoutSlots("video-top", FACE, [TITLE]).video.objectPosY;
    expect(avoided).not.toBe(plain);

    const cues: SceneCue[] = [
      { id: "a", layout: "video-top", component: "StatCard", props: {}, startSec: 0, endSec: 8 },
    ];
    const regions = [{ ...TITLE, startSec: 0, endSec: 3 }];
    expect(videoSlotAt(cues, 1.5, FACE, regions).objectPosY).toBeCloseTo(avoided, 6);
    expect(videoSlotAt(cues, 5, FACE, regions).objectPosY).toBeCloseTo(plain, 6);
  });
});

describe("plain cues are invisible to the stage morph (PLAN 2026-07-30 Task A)", () => {
  // A full-bleed plain cue butts FLUSH against its graphic neighbour (the
  // fill leaves no assembler gap), so without the morph filter the ±1e-3
  // neighbour probes would see it where they used to see a gap — and the
  // slot would finish its end-of-scene morph to base, snap back to the
  // graphic layout, and morph a second time. This is the no-regression pin
  // for the whole task: unedited plain must be indistinguishable from a gap.
  const graphic = cue("video-top", 2, 5);
  const plain: SceneCue = { id: "take-0", kind: "plain", layout: "full-bleed", startSec: 5, endSec: 12 };

  it("videoSlotAt with a flush plain neighbour matches today's cue↔gap everywhere", () => {
    for (let t = 0; t <= 12; t += 0.05) {
      expect(videoSlotAt([graphic, plain], t), `t=${t}`).toEqual(videoSlotAt([graphic], t));
    }
  });

  it("backdropOpacityAt likewise", () => {
    for (let t = 0; t <= 12; t += 0.05) {
      expect(backdropOpacityAt([graphic, plain], t), `t=${t}`).toBe(backdropOpacityAt([graphic], t));
    }
  });

  it("a plain cue whose layout was overridden away from full-bleed DOES stage", () => {
    const asPip: SceneCue = { ...plain, layout: "pip-bubble" };
    const graphicPip = cue("pip-bubble", 5, 12);
    expect(videoSlotAt([asPip], 8)).toEqual(videoSlotAt([graphicPip], 8));
    expect(backdropOpacityAt([asPip], 8)).toBe(backdropOpacityAt([graphicPip], 8));
  });
});
