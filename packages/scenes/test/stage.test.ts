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
  backdropColorAt,
  backdropOpacityAt,
  captionAnchorAt,
  captionFontSizeFor,
  clampGraphicRect,
  clampToFrame,
  graphicClampFor,
  contentTransformFor,
  FULL_BLEED_GRAPHIC_SLOT,
  FULL_FRAME_SLOT,
  LANDSCAPE_FRAME,
  LANDSCAPE_SAFE_AREA,
  PORTRAIT_FRAME,
  safeAreaFor,
  safeRectFor,
  graphicSlotFor,
  headFitsSlot,
  layoutSlots,
  objectPosYFor,
  videoSlotAt,
  CONTENT_TRANSFORM_ORIGIN,
  PIP_RECT,
  clearOfPicture,
  pictureZoomAt,
  pictureZoomStateFor,
  pipPanFor,
  pipRectFor,
  pipZoomFor,
  placedPictureFor,
  belowFaceBox,
  graphicBoundsFor,
  storedGraphicBox,
} from "../src/stage";
import { captionAnchorAvoiding } from "../src/source-fit";
import {
  LANDSCAPE_LAYOUTS,
  LayoutSchema,
  SCENE_REGISTRY,
  SCRIPT_LANDSCAPE_RECT,
  SceneComponentIdSchema,
  ZOOM_MAX_SCALE,
} from "@ossclip/core";

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

  // Frame-aware loops (R15 §54): the invariants hold per FRAME, not per
  // layout in the abstract. Portrait checks every layout (all are reachable
  // from the editor's layout switch in a 9:16 project); landscape checks the
  // layouts landscape actually stages (LANDSCAPE_LAYOUTS — produce remaps
  // everything else away), against the landscape safe margins.
  const FRAME_CASES = [
    { name: "portrait", frame: PORTRAIT_FRAME, layouts: LayoutSchema.options },
    { name: "landscape", frame: LANDSCAPE_FRAME, layouts: LANDSCAPE_LAYOUTS },
  ] as const;

  it("every graphic slot sits inside its frame's safe area", () => {
    for (const { name, frame, layouts } of FRAME_CASES) {
      const safe = safeRectFor(frame);
      for (const layout of layouts) {
        const g = layoutSlots(layout, DEFAULT_FACE, [], frame).graphic;
        if (!g) continue;
        const tag = `${layout} (${name})`;
        expect(g.x, tag).toBeGreaterThanOrEqual(safe.x - 1e-9);
        expect(g.y, tag).toBeGreaterThanOrEqual(safe.y - 1e-9);
        expect(g.x + g.w, tag).toBeLessThanOrEqual(safe.x + safe.w + 1e-9);
        expect(g.y + g.h, tag).toBeLessThanOrEqual(safe.y + safe.h + 1e-9);
      }
    }
  });

  it("every layout shows captions, inside its frame's safe area, clear of the graphic (§2/§6)", () => {
    for (const { name, frame, layouts } of FRAME_CASES) {
      const safe = safeAreaFor(frame);
      for (const layout of layouts) {
        const slots = layoutSlots(layout, DEFAULT_FACE, [], frame);
        const a = slots.captionAnchor;
        const bandTop = a - CAPTION_HALF_BAND;
        const bandBottom = a + CAPTION_HALF_BAND;
        const tag = `${layout} (${name})`;
        expect(bandTop, tag).toBeGreaterThanOrEqual(safe.top);
        expect(bandBottom, tag).toBeLessThanOrEqual(1 - safe.bottom + 1e-9);
        if (slots.graphic) {
          const overlap =
            Math.min(bandBottom, slots.graphic.y + slots.graphic.h) -
            Math.max(bandTop, slots.graphic.y);
          expect(overlap, `captions overlap graphic in ${tag}`).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it("the split layouts split along the frame's LONG edge (§54)", () => {
    // Landscape: side-by-side halves, mirrored — the side is the point.
    const left = layoutSlots("split-left", DEFAULT_FACE, [], LANDSCAPE_FRAME);
    const right = layoutSlots("split-right", DEFAULT_FACE, [], LANDSCAPE_FRAME);
    expect(left.video.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(right.video.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(left.graphic!.x).toBeGreaterThan(0.5);
    expect(right.graphic!.x + right.graphic!.w).toBeLessThan(0.5 + 1e-9);
    // Portrait: the same idea stacks — a literal half-width slot in 9:16
    // would be a sliver, so both sides share one stacked geometry.
    for (const l of ["split-left", "split-right"] as const) {
      const p = layoutSlots(l, DEFAULT_FACE, [], PORTRAIT_FRAME);
      expect(p.video.rect, l).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
      expect(p.graphic!.y, l).toBeGreaterThan(0.5);
    }
  });

  it("lower-third keeps the picture whole and the card in the bottom band (§54)", () => {
    for (const frame of [LANDSCAPE_FRAME, PORTRAIT_FRAME]) {
      const slots = layoutSlots("lower-third", DEFAULT_FACE, [], frame);
      expect(slots.video.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      expect(slots.video.blurPx).toBe(0);
      // The band sits in the frame's lower half and above the safe floor.
      expect(slots.graphic!.y).toBeGreaterThan(0.5);
      // Captions clear the band from above.
      expect(slots.captionAnchor + CAPTION_HALF_BAND).toBeLessThanOrEqual(slots.graphic!.y);
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
        // full-bleed has no slot of its own (graphics there use the R13
        // fallback band) — the registry should never PLAN a scene onto it.
        expect(slot, `${id} alternate ${alt} has no graphic slot`).not.toBeNull();
        expect(slot!.h, `${id}: ${alt} is shorter than ${meta.defaultLayout}`).toBeGreaterThanOrEqual(
          base!.h,
        );
        expect(alt, `${id} lists its own default as an alternate`).not.toBe(meta.defaultLayout);
      }
    }
  });
});

describe("landscape caption anchors (user screenshot 2026-08-16)", () => {
  // The frame-agnostic anchors put landscape captions mid-frame — 0.7 of a
  // 16:9 frame is chest height, not a lower third. Pin BOTH sides of every
  // branch: the portrait literals must stay byte-identical, and each
  // landscape anchor sits lower but under the legal ceiling
  // 0.835 = 1 − LANDSCAPE_SAFE_AREA.bottom − CAPTION_HALF_BAND.
  const CEILING = 1 - LANDSCAPE_SAFE_AREA.bottom - CAPTION_HALF_BAND;
  const CASES = [
    { layout: "full-bleed", portrait: 0.7, landscape: 0.8 },
    { layout: "pip-bubble", portrait: 0.61, landscape: 0.78 },
    { layout: "graphic-only", portrait: 0.73, landscape: 0.8 },
    { layout: "blurred-behind", portrait: 0.69, landscape: 0.8 },
  ] as const;

  it("pins the portrait literals and the lowered landscape anchors", () => {
    for (const { layout, portrait, landscape } of CASES) {
      expect(layoutSlots(layout, DEFAULT_FACE, [], PORTRAIT_FRAME).captionAnchor, layout).toBe(
        portrait,
      );
      const l = layoutSlots(layout, DEFAULT_FACE, [], LANDSCAPE_FRAME).captionAnchor;
      expect(l, layout).toBe(landscape);
      expect(l, layout).toBeGreaterThanOrEqual(portrait);
    }
  });

  it("EVERY layout's landscape anchor stays under the ceiling — branched or not", () => {
    // lower-third and the splits branched before this change; the ceiling is
    // the shared invariant all of them answer to.
    for (const layout of LayoutSchema.options) {
      const a = layoutSlots(layout, DEFAULT_FACE, [], LANDSCAPE_FRAME).captionAnchor;
      expect(a, layout).toBeLessThanOrEqual(CEILING + 1e-9);
    }
  });
});

describe("captionFontSizeFor", () => {
  it("keeps the historical 64 in portrait and drops to 44 in landscape", () => {
    // 64 ≈ 3.3% of a 1080x1920 frame's height; the same 64 in 1920x1080 is
    // 5.9% and reads as a billboard (user complaint 2026-08-16). 44 ≈ 4% of
    // 1080 — lower-third scale, not billboard scale.
    expect(captionFontSizeFor(PORTRAIT_FRAME)).toBe(64);
    expect(captionFontSizeFor(LANDSCAPE_FRAME)).toBe(44);
  });
});

describe("graphicSlotFor (R13 — layout never vetoes the component)", () => {
  it("resolves a non-null slot for EVERY layout — switching layouts can't hide a graphic", () => {
    for (const layout of LayoutSchema.options) {
      const slot = graphicSlotFor({ layout });
      expect(slot, layout).not.toBeNull();
      expect(slot.w, layout).toBeGreaterThan(0);
      expect(slot.h, layout).toBeGreaterThan(0);
    }
  });

  it("full-bleed falls back to the dedicated band, which is safe-area legal as-is", () => {
    expect(graphicSlotFor({ layout: "full-bleed" })).toEqual(FULL_BLEED_GRAPHIC_SLOT);
    // The fallback must already satisfy the same invariant every layout's own
    // slot is pinned to — clamping it is a no-op.
    expect(clampGraphicRect(FULL_BLEED_GRAPHIC_SLOT)).toEqual(FULL_BLEED_GRAPHIC_SLOT);
  });

  it("full-bleed's fallback band stays clear of its caption band", () => {
    // The slot table deliberately keeps full-bleed's graphic null (plain cues
    // must not make captions dodge an empty band), so the §2/§6 loop above
    // never checks this pair — pin it here.
    const anchor = layoutSlots("full-bleed").captionAnchor;
    expect(anchor - CAPTION_HALF_BAND).toBeGreaterThanOrEqual(
      FULL_BLEED_GRAPHIC_SLOT.y + FULL_BLEED_GRAPHIC_SLOT.h,
    );
  });

  it("a cue's own rect wins over the layout slot, clamped into the safe area", () => {
    const slot = graphicSlotFor({
      layout: "blurred-behind",
      graphicRect: { x: 0, y: 0, w: 0.5, h: 0.3 },
    });
    expect(slot.x).toBeGreaterThanOrEqual(SAFE_RECT.x);
    expect(slot.y).toBeGreaterThanOrEqual(SAFE_RECT.y);
  });

  it("every non-full-bleed layout resolves to its own slot table entry", () => {
    for (const layout of LayoutSchema.options) {
      if (layout === "full-bleed") continue;
      expect(graphicSlotFor({ layout })).toEqual(layoutSlots(layout).graphic);
    }
  });
});

describe("SCRIPT_LANDSCAPE_RECT: the centred slot of a 16:9 script run (§161)", () => {
  it("is inside the landscape safe area, so the draw-time clamp leaves it exactly as planned", () => {
    expect(clampGraphicRect(SCRIPT_LANDSCAPE_RECT, LANDSCAPE_FRAME)).toEqual(SCRIPT_LANDSCAPE_RECT);
    const { x, y, w, h } = SCRIPT_LANDSCAPE_RECT;
    expect(x).toBeGreaterThanOrEqual(LANDSCAPE_SAFE_AREA.left);
    expect(1 - (x + w)).toBeGreaterThanOrEqual(LANDSCAPE_SAFE_AREA.right);
    expect(y).toBeGreaterThanOrEqual(LANDSCAPE_SAFE_AREA.top);
    expect(1 - (y + h)).toBeGreaterThanOrEqual(LANDSCAPE_SAFE_AREA.bottom);
  });

  it("is the slot a full-bleed TitleCard, TerminalMock or StatCard draws in", () => {
    for (const component of ["TitleCard", "TerminalMock", "StatCard"] as const) {
      expect(
        graphicSlotFor({ layout: "full-bleed", component, graphicRect: SCRIPT_LANDSCAPE_RECT }, LANDSCAPE_FRAME),
      ).toEqual(SCRIPT_LANDSCAPE_RECT);
    }
  });

  // Replaced deliberately (§163): this case pinned "a CardRow still gets the
  // frame" with the box set. A full-frame component now draws in its box;
  // the placement never gives it one (`scriptLandscapePlacement` returns a
  // full-frame scene as is), so a planned CardRow still gets the frame.
  it("a CardRow given the same box by hand draws in it", () => {
    expect(
      graphicSlotFor({ layout: "full-bleed", component: "CardRow", graphicRect: SCRIPT_LANDSCAPE_RECT }, LANDSCAPE_FRAME),
    ).toEqual(SCRIPT_LANDSCAPE_RECT);
    expect(graphicSlotFor({ layout: "full-bleed", component: "CardRow" }, LANDSCAPE_FRAME)).toEqual(
      FULL_FRAME_SLOT,
    );
  });
});

describe("graphicSlotFor: fullFrame components (explainer plan, Task 8)", () => {
  // A clip is authored at frame size with its own margins; in the full-bleed
  // band it played at 0.77 x 0.36 of the frame.
  const frames = [PORTRAIT_FRAME, LANDSCAPE_FRAME];

  // Narrowed deliberately (§163): this case was "for every layout" in both
  // aspects. A 16:9 pip-bubble now cuts every box back to keep clear of the
  // speaker picture, the whole frame included ("the speaker picture in
  // 16:9" below); every other layout, and every portrait one, still fills
  // the frame.
  it("a ClipScene cue fills the whole frame in both aspects, for every layout but a 16:9 pip-bubble", () => {
    expect(FULL_FRAME_SLOT).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    for (const frame of frames) {
      for (const layout of LayoutSchema.options) {
        if (layout === "pip-bubble" && frame === LANDSCAPE_FRAME) continue;
        expect(graphicSlotFor({ layout, component: "ClipScene" }, frame), layout).toEqual(
          FULL_FRAME_SLOT,
        );
      }
    }
    const cut = graphicSlotFor({ layout: "pip-bubble", component: "ClipScene" }, LANDSCAPE_FRAME);
    expect(cut.w).toBeCloseTo(pipRectFor(LANDSCAPE_FRAME).x - 0.03, 9);
  });

  // Replaced deliberately (§163): this case was "ignores a routed or
  // hand-set rect and skips the safe-area clamp". The box is honoured now;
  // what survives is the second half — no safe-area clamp — and routing no
  // longer writes a box onto a full-frame cue (source-fit.test.ts).
  it("draws in a hand-set rect and skips the safe-area clamp", () => {
    const box = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    const atEdge = { x: 0, y: 0.01, w: 0.5, h: 0.4 };
    for (const frame of frames) {
      expect(
        graphicSlotFor({ layout: "full-bleed", component: "ClipScene", graphicRect: box }, frame),
      ).toEqual(box);
      // Outside every safe area (portrait's 0.04 left, landscape's 0.05 and
      // 0.06 top), still inside the frame: kept exactly.
      expect(
        graphicSlotFor({ layout: "full-bleed", component: "ClipScene", graphicRect: atEdge }, frame),
      ).toEqual(atEdge);
    }
  });

  it("a TitleCard in full-bleed keeps the slot it had before the flag", () => {
    for (const frame of frames) {
      expect(graphicSlotFor({ layout: "full-bleed", component: "TitleCard" }, frame)).toEqual(
        graphicSlotFor({ layout: "full-bleed" }, frame),
      );
    }
    expect(graphicSlotFor({ layout: "full-bleed", component: "TitleCard" })).toEqual(
      FULL_BLEED_GRAPHIC_SLOT,
    );
  });

  it("only ClipScene and the script-only cards set the flag, so no planner component's geometry moves", () => {
    const flagged = SceneComponentIdSchema.options.filter((id) => SCENE_REGISTRY[id].fullFrame);
    expect(flagged).toEqual(["CardRow", "CtaCard", "BugCard", "PhoneDemo", "ClipScene"]);
  });

  // Narrowed deliberately (§163): "with no box". With one, see the next block.
  it("a CardRow, a CtaCard, a BugCard or a PhoneDemo with no box gets the whole frame in every layout and aspect (plan decision 1)", () => {
    for (const frame of frames) {
      expect(graphicSlotFor({ layout: "full-bleed", component: "CardRow" }, frame)).toEqual(FULL_FRAME_SLOT);
      expect(graphicSlotFor({ layout: "full-bleed", component: "CtaCard" }, frame)).toEqual(FULL_FRAME_SLOT);
      expect(graphicSlotFor({ layout: "full-bleed", component: "BugCard" }, frame)).toEqual(FULL_FRAME_SLOT);
      expect(graphicSlotFor({ layout: "full-bleed", component: "PhoneDemo" }, frame)).toEqual(FULL_FRAME_SLOT);
    }
  });
});

describe("a full-frame component in a graphic box (§163)", () => {
  const LS = LANDSCAPE_FRAME;

  it("draws in its box when it has one, on the whole frame when it has none", () => {
    const band = { x: 0.1, y: 0.5, w: 0.8, h: 0.4 };
    expect(graphicSlotFor({ layout: "full-bleed", component: "CardRow", graphicRect: band }, LS)).toEqual(band);
    expect(graphicSlotFor({ layout: "full-bleed", component: "CardRow" }, LS)).toEqual(FULL_FRAME_SLOT);
    expect(graphicSlotFor({ layout: "full-bleed", component: "CardRow", graphicRect: null }, LS)).toEqual(
      FULL_FRAME_SLOT,
    );
  });

  it("a box hanging off the right edge is moved inside the frame at the same size (Review Focus 4)", () => {
    const off = { x: 0.7, y: 0.5, w: 0.4, h: 0.3 };
    const slot = graphicSlotFor({ layout: "graphic-only", component: "CardRow", graphicRect: off }, LS);
    expect(slot.x).toBeCloseTo(0.6, 9);
    expect(slot.y).toBe(0.5);
    expect(slot.w).toBe(0.4);
    expect(slot.h).toBe(0.3);
  });

  it("a box the size of the whole safe area is NOT shrunk to it", () => {
    const big = { x: 0, y: 0, w: 1, h: 0.95 };
    expect(graphicSlotFor({ layout: "full-bleed", component: "BugCard", graphicRect: big }, LS)).toEqual(big);
    // The control: a slot component's box is held to the caption-safe area.
    const safe = safeRectFor(LS);
    const slotted = graphicSlotFor({ layout: "full-bleed", component: "TitleCard", graphicRect: big }, LS);
    expect(slotted.w).toBeCloseTo(safe.w, 9);
    expect(slotted.h).toBeCloseTo(safe.h, 9);
  });
});

describe("clampToFrame (§163)", () => {
  it("keeps a rect inside the frame: moved first, shrunk only when bigger than the frame", () => {
    expect(clampToFrame({ x: 0.8, y: 0.9, w: 0.4, h: 0.3 })).toEqual({ x: 0.6, y: 0.7, w: 0.4, h: 0.3 });
    expect(clampToFrame({ x: -0.2, y: -0.1, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(clampToFrame({ x: -0.5, y: 0.3, w: 3, h: 2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("enforces the schema's minimum size (w 0.08, h 0.05)", () => {
    expect(clampToFrame({ x: 0.99, y: 0.99, w: 0.01, h: 0.001 })).toEqual({
      x: 0.92,
      y: 0.95,
      w: 0.08,
      h: 0.05,
    });
  });

  it("is the identity on the whole frame and on any rect already inside it", () => {
    expect(clampToFrame(FULL_FRAME_SLOT)).toEqual(FULL_FRAME_SLOT);
    const inside = { x: 0.04, y: 0.56, w: 0.92, h: 0.4 };
    expect(clampToFrame(inside)).toEqual(inside);
  });
});

describe("graphicClampFor: the editor's one clamp for a drag, a resize and the Inspector (§163)", () => {
  const off = { x: 0.7, y: 0.02, w: 0.4, h: 0.3 };

  it("is clampToFrame for every full-frame component", () => {
    for (const component of ["CardRow", "CtaCard", "BugCard", "PhoneDemo", "ClipScene"] as const) {
      for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
        expect(graphicClampFor(component, frame)(off), component).toEqual(clampToFrame(off));
      }
    }
  });

  it("is clampGraphicRect, in the given frame, for a slot component and for no component", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      expect(graphicClampFor("TitleCard", frame)(off)).toEqual(clampGraphicRect(off, frame));
      expect(graphicClampFor(undefined, frame)(off)).toEqual(clampGraphicRect(off, frame));
    }
    // The default frame is portrait, as clampGraphicRect's is.
    expect(graphicClampFor("StatCard")(off)).toEqual(clampGraphicRect(off));
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

describe("pip override (R14 §52 — roundness and placement per scene)", () => {
  const base = layoutSlots("pip-bubble").video;

  it("moves the bubble and reshapes its mask mid-cue", () => {
    const cues = [{ ...cue("pip-bubble", 2, 6), pip: { cornerRadius: 0.25, x: 0.1, y: 0.3 } }];
    const mid = videoSlotAt(cues, 4);
    expect(mid.rect.x).toBe(0.1);
    expect(mid.rect.y).toBe(0.3);
    expect(mid.cornerRadius).toBe(0.25);
    // Size is not the override's to change — only placement and roundness.
    expect(mid.rect.w).toBe(base.rect.w);
    expect(mid.rect.h).toBe(base.rect.h);
  });

  it("partial override keeps the layout's own values for the rest", () => {
    const cues = [{ ...cue("pip-bubble", 2, 6), pip: { cornerRadius: 0 } }];
    const mid = videoSlotAt(cues, 4);
    expect(mid.cornerRadius).toBe(0);
    expect(mid.rect).toEqual(base.rect);
  });

  it("clamps placement so the bubble stays on-frame", () => {
    const cues = [{ ...cue("pip-bubble", 2, 6), pip: { x: 1, y: 1 } }];
    const mid = videoSlotAt(cues, 4);
    expect(mid.rect.x + mid.rect.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(mid.rect.y + mid.rect.h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("is IGNORED under any other layout — a bubble property must not bend a full frame", () => {
    const cues = [{ ...cue("blurred-behind", 2, 6), pip: { cornerRadius: 0.5, y: 0.1 } }];
    expect(videoSlotAt(cues, 4)).toEqual(layoutSlots("blurred-behind").video);
  });

  it("the morph eases toward the OVERRIDDEN bubble, not the stock one", () => {
    const cues = [{ ...cue("pip-bubble", 2, 6), pip: { y: 0.2 } }];
    const entering = videoSlotAt(cues, 2 + LAYOUT_TRANSITION_SEC / 2);
    // Halfway in from full-bleed (y=0): easing toward y=0.2 keeps the rect's
    // y strictly below the STOCK bubble's midpoint path (stock y=0.66).
    expect(entering.rect.y).toBeLessThan(0.66 / 2);
    expect(entering.rect.y).toBeGreaterThan(0);
  });
});

describe("caption + backdrop timelines", () => {
  const cues = [cue("graphic-only", 2, 6)];
  it("captions stay visible while a graphic owns the frame, in its reserved band", () => {
    expect(captionAnchorAt(cues, 1)).toBe(layoutSlots("full-bleed").captionAnchor);
    expect(captionAnchorAt(cues, 4)).toBe(layoutSlots("graphic-only").captionAnchor);
    expect(captionAnchorAt(cues, 8)).toBe(layoutSlots("full-bleed").captionAnchor);
  });
  it("captionAnchorAt honors the frame; omitting it still means portrait", () => {
    expect(captionAnchorAt(cues, 4, LANDSCAPE_FRAME)).toBe(
      layoutSlots("graphic-only", DEFAULT_FACE, [], LANDSCAPE_FRAME).captionAnchor,
    );
    expect(captionAnchorAt(cues, 8, LANDSCAPE_FRAME)).toBe(
      layoutSlots("full-bleed", DEFAULT_FACE, [], LANDSCAPE_FRAME).captionAnchor,
    );
    expect(captionAnchorAt(cues, 4)).toBe(layoutSlots("graphic-only").captionAnchor);
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

describe("backdropColorAt (backdrop-color §3)", () => {
  const themeBg = "#000000";
  const at = (
    id: string,
    kind: "plain" | "graphic",
    layout: SceneCue["layout"],
    startSec: number,
    endSec: number,
    backdropColor?: string,
  ): SceneCue => ({
    ...cue(layout, startSec, endSec),
    id,
    kind,
    ...(backdropColor ? { backdropColor } : {}),
  });
  // The spec's fixture: the plain take is filtered by morphCues, C draws no
  // backdrop yet stores a colour that must be ignored (round 2, SF2).
  const cues = [
    at("take", "plain", "full-bleed", 0, 4),
    at("A", "graphic", "graphic-only", 4, 8, "#ff0000"),
    at("B", "graphic", "graphic-only", 8, 12, "#00ff00"),
    at("C", "graphic", "full-bleed", 12, 16, "#123456"),
    at("D", "graphic", "graphic-only", 16, 20, "#0000ff"),
  ];
  const expected: [number, string][] = [
    [6, "#ff0000"], // rule 1: A draws the backdrop
    [4.1, "#ff0000"], // rule 1, inside A's fade-in from nothing
    [7.99, "#ff0000"], // the A/B snap (call 2) …
    [8.01, "#00ff00"], // … with no cross-fade
    [12.1, "#00ff00"], // rule 2: C fades in from B, which draws it (call 3)
    [11.8, "#00ff00"], // rule 1 holds inside B's own fade-out
    [15.9, "#0000ff"], // rule 2 with next: C fades out into D (SF1)
    [2, "#000000"], // rule 3: no active morph cue
    [3.9, "#000000"], // would be A's colour without the morphCues filter (SF1)
    [14, "#000000"], // C outside its fades; its #123456 is ignored
  ];

  it("follows the graphic that draws the backdrop, through its fades", () => {
    for (const [t, colour] of expected) expect(backdropColorAt(cues, t, themeBg), `t=${t}`).toBe(colour);
  });

  it("rule 2 borrows only from a neighbour that draws the backdrop", () => {
    // prev stores a colour but is full-bleed, so it paints nothing; without
    // the drawsSolidBackdrop(prev) gate the fade-in would read its #ff0000.
    const pair = [
      at("P", "graphic", "full-bleed", 0, 4, "#ff0000"),
      at("Q", "graphic", "full-bleed", 4, 8),
    ];
    expect(backdropColorAt(pair, 4.1, themeBg)).toBe("#000000");
  });

  it("is themeBg at every sample when no cue carries a colour", () => {
    const plain = cues.map(({ backdropColor: _drop, ...rest }) => rest);
    for (const [t] of expected) expect(backdropColorAt(plain, t, themeBg), `t=${t}`).toBe(themeBg);
  });

  it("leaves backdropOpacityAt's values untouched by the shared resolver", () => {
    // Recorded from backdropOpacityAt BEFORE the resolver was extracted.
    const before: [number, number][] = [
      [6, 1],
      [4.1, 0.19825072886297254],
      [7.99, 1],
      [8.01, 1],
      [12.1, 0.8017492711370274],
      [11.8, 0.6064139941690933],
      [15.9, 0.8017492711370275],
      [2, 0],
      [3.9, 0],
      [14, 0],
    ];
    for (const [t, opacity] of before) expect(backdropOpacityAt(cues, t), `t=${t}`).toBe(opacity);
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

  it("a landscape cover drops the profile-GRID crop (R16 §76)", () => {
    // The grid square is an Instagram constraint on a 9:16 cover. A 16:9
    // cover is a YouTube thumbnail shown whole — squeezing the banner into
    // the middle 56% of an already short frame would be a portrait rule
    // applied to a landscape image.
    const land = coverTextRect(null, LANDSCAPE_FRAME);
    expect(land).toEqual(safeRectFor(LANDSCAPE_FRAME));
    expect(land.h).toBeGreaterThan(COVER_TEXT_RECT.h);
    // The face rule still holds in landscape: the banner routes off the head.
    const face = { centerYFrac: 0.32, sizeFrac: 0.22 };
    const banded = coverTextRect(face, LANDSCAPE_FRAME);
    const head = headBand(face);
    expect(banded.y >= head.end || banded.y + banded.h <= head.start).toBe(true);
    // …and stays inside the landscape safe area.
    expect(banded.y).toBeGreaterThanOrEqual(land.y - 1e-9);
    expect(banded.y + banded.h).toBeLessThanOrEqual(land.y + land.h + 1e-9);
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

describe("clampGraphicRect (PLAN 2026-07-31 Task 2)", () => {
  it("keeps a hand-set rect inside SAFE_RECT with the minimum size enforced", () => {
    const wild = clampGraphicRect({ x: -0.5, y: 1.2, w: 3, h: 0.001 });
    expect(wild.x).toBeGreaterThanOrEqual(SAFE_RECT.x);
    expect(wild.y).toBeGreaterThanOrEqual(SAFE_RECT.y);
    expect(wild.x + wild.w).toBeLessThanOrEqual(SAFE_RECT.x + SAFE_RECT.w + 1e-9);
    expect(wild.y + wild.h).toBeLessThanOrEqual(SAFE_RECT.y + SAFE_RECT.h + 1e-9);
    expect(wild.w).toBeGreaterThanOrEqual(0.08);
    expect(wild.h).toBeGreaterThanOrEqual(0.05);
  });

  it("is the identity on a rect already inside — every layout's own slot", () => {
    for (const layout of ["video-top", "pip-bubble", "graphic-only", "blurred-behind"] as const) {
      const slot = layoutSlots(layout).graphic;
      if (!slot) continue;
      expect(clampGraphicRect(slot)).toEqual(slot);
    }
  });
});

describe("caption anchor honours a hand-moved rect on a CLEAN source (R11 Task 2b)", () => {
  it("returns the layout anchor when the rect is the default and there are no regions", () => {
    expect(captionAnchorAvoiding("video-top", [])).toBe(layoutSlots("video-top").captionAnchor);
    expect(captionAnchorAvoiding("blurred-behind", [], layoutSlots("blurred-behind").graphic)).toBe(
      layoutSlots("blurred-behind").captionAnchor,
    );
  });

  it("moves the anchor off a rect dragged onto it, with zero source-text regions", () => {
    const base = layoutSlots("blurred-behind").captionAnchor;
    // Park the graphic squarely on the default caption anchor.
    const onTop = { x: 0.1, y: base - 0.1, w: 0.7, h: 0.2 };
    const moved = captionAnchorAvoiding("blurred-behind", [], onTop);
    expect(moved).not.toBe(base);
    // The moved anchor's band is clear of the rect.
    expect(moved < onTop.y || moved > onTop.y + onTop.h).toBe(true);
  });
});

describe("landscape frame (R15)", () => {
  const LS = LANDSCAPE_FRAME;

  it("a 16:9 source in a 16:9 full-bleed slot needs no crop bias at all", () => {
    // The whole point of a landscape export: the picture fits exactly, so
    // there is no overflow to bias and nothing of the frame is thrown away.
    const face = { centerYFrac: 0.4, sizeFrac: 0.2, sourceAspect: 16 / 9 };
    const full = { x: 0, y: 0, w: 1, h: 1 };
    expect(objectPosYFor(full, face, LS)).toBe(0.5);
    expect(objectPosXFor(full, face, LS)).toBe(0.5);
  });

  it("the SAME source in the portrait frame is cropped hard — the asymmetry the frame arg exists for", () => {
    const face = { centerYFrac: 0.4, sizeFrac: 0.2, sourceAspect: 16 / 9, centerXFrac: 0.3 };
    const full = { x: 0, y: 0, w: 1, h: 1 };
    // Portrait: a 16:9 source is height-constrained and spills sideways.
    expect(objectPosXFor(full, face, PORTRAIT_FRAME)).not.toBe(0.5);
  });

  it("landscape drops the platform chrome insets", () => {
    expect(safeAreaFor(LS)).toBe(LANDSCAPE_SAFE_AREA);
    expect(safeAreaFor(PORTRAIT_FRAME)).toBe(SAFE_AREA);
    // Landscape has no action rail to dodge, so its usable rect is wider.
    expect(safeRectFor(LS).w).toBeGreaterThan(safeRectFor(PORTRAIT_FRAME).w);
  });

  it("clampGraphicRect respects the frame it is given", () => {
    const wide = { x: 0.03, y: 0.03, w: 0.9, h: 0.5 };
    // Legal in landscape (left inset 0.05)…
    expect(clampGraphicRect(wide, LS).x).toBeCloseTo(0.05, 6);
    // …and pushed further in under portrait's tighter, rail-aware rect.
    expect(clampGraphicRect(wide, PORTRAIT_FRAME).w).toBeLessThan(
      clampGraphicRect(wide, LS).w,
    );
  });

  it("every layout still resolves a graphic slot inside the LANDSCAPE safe rect", () => {
    const safe = safeRectFor(LS);
    for (const layout of LayoutSchema.options) {
      const g = clampGraphicRect(graphicSlotFor({ layout }, LS), LS);
      expect(g.x, layout).toBeGreaterThanOrEqual(safe.x - 1e-9);
      expect(g.y, layout).toBeGreaterThanOrEqual(safe.y - 1e-9);
      expect(g.x + g.w, layout).toBeLessThanOrEqual(safe.x + safe.w + 1e-9);
      expect(g.y + g.h, layout).toBeLessThanOrEqual(safe.y + safe.h + 1e-9);
    }
  });

  it("defaults stay portrait, so no existing caller changes behaviour", () => {
    const face = { centerYFrac: 0.38, sizeFrac: 0.22 };
    const band = { x: 0, y: 0, w: 1, h: 0.42 };
    expect(objectPosYFor(band, face)).toBe(objectPosYFor(band, face, PORTRAIT_FRAME));
    expect(layoutSlots("video-top", face)).toEqual(
      layoutSlots("video-top", face, [], PORTRAIT_FRAME),
    );
  });
});

describe("objectPos subject guard (2026-08-16 incident)", () => {
  const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
  // The incident's measured face: a screen recording's camera PiP — 11.9% of
  // frame height, sitting bottom-right — in a 3456×2234 (1.547:1) source.
  const pipFace = {
    centerYFrac: 0.76,
    sizeFrac: 0.119,
    centerXFrac: 0.88,
    sourceAspect: 3456 / 2234,
  };

  it("without a subject, the PiP face pins the crop to the frame bottom — the incident", () => {
    // 1.547 source cover-cropped into 16:9 overflows vertically; the chin
    // constraint pushes the offset past the overflow and clamps to 1.0,
    // which is exactly what cut the top 28% of every full-frame stretch.
    // Pinned as the OLD behaviour: absent subject must keep it byte-for-byte
    // so every existing render-props renders unchanged.
    expect(objectPosYFor(FULL_RECT, pipFace, LANDSCAPE_FRAME)).toBe(1);
  });

  it("subject 'screen' centres both axes — a face that is not the subject must not steer the crop", () => {
    const screenFace = { ...pipFace, subject: "screen" as const };
    expect(objectPosYFor(FULL_RECT, screenFace, LANDSCAPE_FRAME)).toBe(0.5);
    // Portrait frame makes the source width-overflow, so without the guard X
    // would chase centerXFrac 0.88 into the corner.
    expect(objectPosXFor(FULL_RECT, screenFace, PORTRAIT_FRAME)).toBe(0.5);
    expect(objectPosXFor(FULL_RECT, pipFace, PORTRAIT_FRAME)).not.toBe(0.5);
  });

  it("absent subject keeps the old face-biased values byte-for-byte, and 'face' is its synonym", () => {
    const band = { x: 0, y: 0, w: 1, h: 0.42 }; // the video-top slot
    const face = { centerYFrac: 0.38, sizeFrac: 0.22 };
    // Exact pre-guard numbers, hand-derived from the §13 interval math —
    // pinned as literals so a regression here cannot hide behind "the
    // function agrees with itself".
    expect(objectPosYFor(band, face)).toBeCloseTo(0.2629310344827586, 12);
    const wide = { centerYFrac: 0.38, sizeFrac: 0.22, centerXFrac: 0.7, sourceAspect: 16 / 9 };
    expect(objectPosXFor(FULL_RECT, wide)).toBeCloseTo(0.7925714285714286, 12);
    // An explicit "face" subject is the absent default spelled out.
    expect(objectPosYFor(band, { ...face, subject: "face" as const })).toBe(
      objectPosYFor(band, face),
    );
    expect(objectPosXFor(FULL_RECT, { ...wide, subject: "face" as const })).toBe(
      objectPosXFor(FULL_RECT, wide),
    );
  });
});

describe("contentTransformFor (user override composes ON TOP of the framing crop)", () => {
  // VideoStage applies this transform on the wrapper AROUND ContentCrop, and
  // the seal is structural: this function's inputs are only zoom + the user's
  // scale/dx/dy, and `activeCropBox` (content-crop.ts) takes no override at
  // all — so neither concern can consume the other, and "Reset framing"
  // returns exactly to the automatic framing.
  it("a no-op correction is NO transform — the legacy DOM stays byte-identical", () => {
    expect(contentTransformFor(1, 1, 0, 0)).toBeUndefined();
  });

  it("zoom and user scale compose multiplicatively, translate applied first", () => {
    expect(contentTransformFor(2, 1.5, 12, -8)).toBe("translate(12px, -8px) scale(3)");
  });

  it("the idle zoom alone flows through the same wrapper channel", () => {
    expect(contentTransformFor(1.05, 1, 0, 0)).toBe("scale(1.05)");
  });

  it("a pure translate does not emit a redundant scale(1)", () => {
    expect(contentTransformFor(1, 1, 5, 0)).toBe("translate(5px, 0px)");
  });
});

describe("the speaker picture in 16:9 (§163)", () => {
  const LS = LANDSCAPE_FRAME;
  const PT = PORTRAIT_FRAME;
  // Today's portrait bubble, as a literal so a regression cannot hide behind
  // "the function agrees with itself": Ø 0.30 of the width at y 0.66.
  const TODAYS_PIP = { x: 0.35, y: 0.66, w: 0.3, h: (0.3 * 1080) / 1920 };
  const picture = pipRectFor(LS);
  const near = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.w).toBeCloseTo(b.w, 6);
    expect(a.h).toBeCloseTo(b.h, 6);
  };

  describe("pipRectFor", () => {
    it("is exactly today's PIP_RECT in a portrait frame, and PIP_RECT keeps today's value", () => {
      expect(PIP_RECT).toEqual(TODAYS_PIP);
      expect(pipRectFor(PT)).toEqual(PIP_RECT);
      // A square frame is not landscape: it keeps the portrait numbers.
      expect(pipRectFor({ width: 1080, height: 1080 })).toEqual(PIP_RECT);
    });

    it("is a 302.4 px circle 4% of the width from the right and 6% of the height from the bottom in 1920x1080", () => {
      near(pipRectFor(LS), {
        x: (1920 - 76.8 - 302.4) / 1920,
        y: (1080 - 64.8 - 302.4) / 1080,
        w: 302.4 / 1920,
        h: 302.4 / 1080,
      });
      // Square in pixels, so corner radius 1 draws a circle.
      expect(picture.w * LS.width).toBeCloseTo(picture.h * LS.height, 9);
    });
  });

  describe("layoutSlots", () => {
    it("pip-bubble draws the picture as a circle in 16:9, and today's bubble in 9:16", () => {
      const land = layoutSlots("pip-bubble", DEFAULT_FACE, [], LS).video;
      expect(land.rect).toEqual(picture);
      expect(land.cornerRadius).toBe(1);
      expect(land.opacity).toBe(1);
      const port = layoutSlots("pip-bubble", DEFAULT_FACE, [], PT).video;
      expect(port.rect).toEqual(TODAYS_PIP);
      expect(port.cornerRadius).toBe(1);
      expect(layoutSlots("pip-bubble")).toEqual(layoutSlots("pip-bubble", DEFAULT_FACE, [], PT));
    });

    it("graphic-only parks its hidden footage in the same picture: the new one in 16:9, today's in 9:16", () => {
      const land = layoutSlots("graphic-only", DEFAULT_FACE, [], LS);
      expect(land.video.rect).toEqual(picture);
      expect(land.video.opacity).toBe(0);
      const port = layoutSlots("graphic-only", DEFAULT_FACE, [], PT);
      expect(port.video.rect).toEqual(TODAYS_PIP);
      expect(port.video.opacity).toBe(0);
      expect(port.graphic).toEqual({ x: 0.04, y: 0.14, w: 0.8, h: 0.54 });
    });
  });

  describe("pipZoomFor", () => {
    // sizeFrac is the face box's height (pico's square edge) as a fraction of
    // the SOURCE height (FaceCropSchema, face.ts FaceBox). A 16:9 source
    // under `object-fit: cover` in a square picture is height-constrained:
    // displayed height = max(pictureH, pictureW / (16/9)) = pictureH, so the
    // picture shows the source's full height and sourceHeightPx = 302.4.
    // zoom = 0.55 × pictureHeightPx / (sizeFrac × sourceHeightPx)
    //      = 0.55 × 302.4 / (0.3 × 302.4) = 1.8333…
    const side = picture.h * LS.height;
    const shownSourceH = Math.max(side, (picture.w * LS.width) / (16 / 9));

    it("makes the face 55% of the picture's height", () => {
      expect(shownSourceH).toBeCloseTo(302.4, 9);
      const face = { centerYFrac: 0.38, sizeFrac: 0.3, sourceAspect: 16 / 9 };
      expect(pipZoomFor(face, side, shownSourceH)).toBeCloseTo(0.55 / 0.3, 9);
      expect(pipZoomFor(face, side, shownSourceH)).toBeCloseTo(1.8333, 4);
    });

    it("is 1 with no face, no size, or a face that is not the frame's subject", () => {
      expect(pipZoomFor(null, side, shownSourceH)).toBe(1);
      expect(pipZoomFor(undefined, side, shownSourceH)).toBe(1);
      expect(pipZoomFor({ centerYFrac: 0.38 }, side, shownSourceH)).toBe(1);
      expect(pipZoomFor({ centerYFrac: 0.38, sizeFrac: 0.3, subject: "screen" }, side, shownSourceH)).toBe(1);
    });

    it("never zooms out, and never past 4", () => {
      expect(pipZoomFor({ centerYFrac: 0.4, sizeFrac: 0.8 }, side, shownSourceH)).toBe(1);
      expect(pipZoomFor({ centerYFrac: 0.4, sizeFrac: 0.05 }, side, shownSourceH)).toBe(4);
      expect(pipZoomFor({ centerYFrac: 0.4, sizeFrac: 0 }, side, shownSourceH)).toBe(1);
    });
  });

  describe("placedPictureFor: where the picture is drawn, for the kit's note (§163)", () => {
    it("is the frame's picture with no override, in either frame", () => {
      expect(placedPictureFor({}, LS)).toEqual(picture);
      expect(placedPictureFor({ pip: null }, PT)).toEqual(PIP_RECT);
    });

    it("moves to the cue's pip.x/y, held on-frame by the picture's own size", () => {
      near(placedPictureFor({ pip: { x: 0.04, y: 0.1 } }, LS), { ...picture, x: 0.04, y: 0.1 });
      near(placedPictureFor({ pip: { x: 1, y: 1 } }, LS), { ...picture, x: 1 - picture.w, y: 1 - picture.h });
      // A partial override keeps the layout's value for the other axis.
      near(placedPictureFor({ pip: { y: 0.2 } }, LS), { ...picture, y: 0.2 });
    });

    it("is the rectangle VideoStage draws mid-cue, moved or not", () => {
      for (const pip of [undefined, { x: 0.05, y: 0.3 }, { x: 0.99 }]) {
        const c = { ...cue("pip-bubble", 2, 6), pip };
        expect(placedPictureFor(c, LS)).toEqual(videoSlotAt([c], 4, DEFAULT_FACE, [], LS).rect);
      }
    });
  });

  describe("the kit clip's background fade (backdropOpacityAt on one rebased cue)", () => {
    it("is 0 on frame 0, part-way through the 0.35 s ease, opaque mid-clip and fading at the end", () => {
      for (const layout of ["graphic-only", "pip-bubble"] as const) {
        const one = [cue(layout, 0, 4)];
        expect(backdropOpacityAt(one, 0), layout).toBe(0);
        const at02 = backdropOpacityAt(one, 0.2);
        expect(at02).toBeGreaterThan(0);
        expect(at02).toBeLessThan(1);
        expect(backdropOpacityAt(one, LAYOUT_TRANSITION_SEC)).toBe(1);
        expect(backdropOpacityAt(one, 2)).toBe(1);
        expect(backdropOpacityAt(one, 4 - 1 / 30)).toBeLessThan(1);
      }
      expect(backdropOpacityAt([cue("full-bleed", 0, 4)], 2)).toBe(0);
    });
  });

  describe("clearOfPicture (Review Focus 5)", () => {
    const leftPicture = { ...picture, x: 0.04 };

    it("a picture on the right cuts the box's right edge to 3% of the width left of the picture", () => {
      near(clearOfPicture(FULL_FRAME_SLOT, picture), { x: 0, y: 0, w: picture.x - 0.03, h: 1 });
      const cut = clearOfPicture(SCRIPT_LANDSCAPE_RECT, picture);
      // 0.86 → picture.x − 0.03 (0.7425); x, y and h untouched.
      expect(SCRIPT_LANDSCAPE_RECT.x + SCRIPT_LANDSCAPE_RECT.w).toBeCloseTo(0.86, 9);
      near(cut, { ...SCRIPT_LANDSCAPE_RECT, w: picture.x - 0.03 - SCRIPT_LANDSCAPE_RECT.x });
    });

    it("a picture moved to the left half cuts the box's LEFT edge instead", () => {
      const edge = leftPicture.x + leftPicture.w + 0.03;
      near(clearOfPicture(FULL_FRAME_SLOT, leftPicture), { x: edge, y: 0, w: 1 - edge, h: 1 });
      near(clearOfPicture(SCRIPT_LANDSCAPE_RECT, leftPicture), {
        ...SCRIPT_LANDSCAPE_RECT,
        x: edge,
        w: 0.86 - edge,
      });
    });

    it("a box that would be narrower than 0.08 keeps 0.08, anchored at the cut edge", () => {
      const right = clearOfPicture({ x: 0.72, y: 0.2, w: 0.2, h: 0.3 }, picture);
      near(right, { x: picture.x - 0.03 - 0.08, y: 0.2, w: 0.08, h: 0.3 });
      const edge = leftPicture.x + leftPicture.w + 0.03;
      const left = clearOfPicture({ x: 0.05, y: 0.2, w: 0.15, h: 0.3 }, leftPicture);
      near(left, { x: edge, y: 0.2, w: 0.08, h: 0.3 });
    });

    it("leaves a box already clear of the picture's strip exactly as it was", () => {
      const clear = { x: 0.05, y: 0.1, w: 0.5, h: 0.8 };
      expect(clearOfPicture(clear, picture)).toEqual(clear);
      const clearRight = { x: 0.7, y: 0.1, w: 0.25, h: 0.8 };
      expect(clearOfPicture(clearRight, leftPicture)).toEqual(clearRight);
    });
  });

  describe("graphicSlotFor keeps the graphic clear of the picture", () => {
    it("is unchanged in a portrait frame, box or no box, picture moved or not", () => {
      const box = { x: 0.1, y: 0.2, w: 0.7, h: 0.3 };
      for (const pip of [undefined, { x: 0.02, y: 0.1 }]) {
        expect(graphicSlotFor({ layout: "pip-bubble", component: "TitleCard", pip }, PT)).toEqual({
          x: 0.06, y: 0.14, w: 0.78, h: 0.42,
        });
        expect(graphicSlotFor({ layout: "pip-bubble", component: "TitleCard", graphicRect: box, pip }, PT)).toEqual(
          clampGraphicRect(box, PT),
        );
        expect(graphicSlotFor({ layout: "pip-bubble", component: "CardRow", pip }, PT)).toEqual(FULL_FRAME_SLOT);
      }
      expect(graphicSlotFor({ layout: "pip-bubble" })).toEqual({ x: 0.06, y: 0.14, w: 0.78, h: 0.42 });
    });

    it("cuts a planned box, a hand-set box and the whole frame back in a 16:9 pip-bubble", () => {
      const edge = picture.x - 0.03;
      near(graphicSlotFor({ layout: "pip-bubble", component: "CardRow" }, LS), { x: 0, y: 0, w: edge, h: 1 });
      near(
        graphicSlotFor({ layout: "pip-bubble", component: "TitleCard", graphicRect: SCRIPT_LANDSCAPE_RECT }, LS),
        { ...SCRIPT_LANDSCAPE_RECT, w: edge - SCRIPT_LANDSCAPE_RECT.x },
      );
      // The layout's own slot (0.06..0.84) is cut too.
      near(graphicSlotFor({ layout: "pip-bubble", component: "TitleCard" }, LS), {
        x: 0.06, y: 0.14, w: edge - 0.06, h: 0.42,
      });
    });

    it("follows the picture when the author moves it to the left half", () => {
      const pip = { x: 0.05, y: 0.1 };
      const edge = 0.05 + picture.w + 0.03;
      near(graphicSlotFor({ layout: "pip-bubble", component: "CardRow", pip }, LS), {
        x: edge, y: 0, w: 1 - edge, h: 1,
      });
    });

    it("uses the picture as drawn: a placement off the frame is clamped first", () => {
      // pip.x 1 draws the picture at 1 − w (cueVideoSlot's clamp), so the cut
      // edge is that picture's left edge, not 1.
      const slot = graphicSlotFor({ layout: "pip-bubble", component: "CardRow", pip: { x: 1 } }, LS);
      near(slot, { x: 0, y: 0, w: 1 - picture.w - 0.03, h: 1 });
    });

    it("does not cut any other layout, and a stale pip on one is ignored", () => {
      for (const layout of ["graphic-only", "full-bleed"] as const) {
        expect(graphicSlotFor({ layout, component: "CardRow", pip: { x: 0.05 } }, LS)).toEqual(FULL_FRAME_SLOT);
        expect(
          graphicSlotFor({ layout, component: "TitleCard", graphicRect: SCRIPT_LANDSCAPE_RECT }, LS),
        ).toEqual(SCRIPT_LANDSCAPE_RECT);
      }
    });
  });

  describe("cueVideoSlot clamps the picture's placement against its real size", () => {
    it("pip {x: 1, y: 1} in 16:9 puts the circle in the bottom-right corner, whole", () => {
      const mid = videoSlotAt([{ ...cue("pip-bubble", 2, 6), pip: { x: 1, y: 1 } }], 4, DEFAULT_FACE, [], LS);
      expect(mid.rect.w).toBe(picture.w);
      expect(mid.rect.h).toBe(picture.h);
      expect(mid.rect.x).toBeCloseTo(1 - picture.w, 12);
      expect(mid.rect.y).toBeCloseTo(1 - picture.h, 12);
    });
  });

  describe("the head zoom inside the picture", () => {
    const face = { centerYFrac: 0.38, centerXFrac: 0.52, sizeFrac: 0.3, sourceAspect: 16 / 9 };
    const pipCues = [cue("pip-bubble", 2, 6)];

    it("eases in with the picture and settles at pipZoomFor in a 16:9 pip-bubble", () => {
      const side = picture.h * LS.height;
      expect(pictureZoomAt(pipCues, 4, face, LS)).toBeCloseTo(pipZoomFor(face, side, side), 9);
      expect(pictureZoomAt(pipCues, 1, face, LS)).toBe(1);
      expect(pictureZoomAt(pipCues, 2, face, LS)).toBe(1);
      const entering = pictureZoomAt(pipCues, 2 + LAYOUT_TRANSITION_SEC / 2, face, LS);
      expect(entering).toBeGreaterThan(1);
      expect(entering).toBeLessThan(pipZoomFor(face, side, side));
      expect(pictureZoomAt(pipCues, 6 - 1e-6, face, LS)).toBeCloseTo(1, 3);
    });

    it("is 1 with no measured face, in any other layout, and in every portrait frame", () => {
      expect(pictureZoomAt(pipCues, 4, null, LS)).toBe(1);
      expect(pictureZoomAt(pipCues, 4, undefined, LS)).toBe(1);
      expect(pictureZoomAt([cue("graphic-only", 2, 6)], 4, face, LS)).toBe(1);
      for (let t = 0; t <= 7; t += 0.05) {
        expect(pictureZoomAt(pipCues, t, face, PT)).toBe(1);
      }
    });

    it("centres the face in the picture when the source has room around it", () => {
      const slot = videoSlotAt(pipCues, 4, face, [], LS);
      const scale = pictureZoomAt(pipCues, 4, face, LS);
      const state = pictureZoomStateFor(slot, face, scale, LS)!;
      expect(state.scale).toBe(scale);
      const w = slot.rect.w * LS.width;
      const h = slot.rect.h * LS.height;
      // Where the face is in the picture before the zoom: the 16:9 source
      // is height-constrained (dispH = h), and objectPosX centres it.
      const dispW = h * (16 / 9);
      const px = -slot.objectPosX * (dispW - w) + face.centerXFrac * dispW;
      const py = face.centerYFrac * h;
      // The zoom is about the content origin (50% 40%) + (dx, dy).
      const ox = CONTENT_TRANSFORM_ORIGIN.x * w + state.dx;
      const oy = CONTENT_TRANSFORM_ORIGIN.y * h + state.dy;
      expect(ox + scale * (px - ox)).toBeCloseTo(w / 2, 6);
      expect(oy + scale * (py - oy)).toBeCloseTo(h / 2, 6);
    });

    it("never pulls the zoom origin outside the picture, so the footage still covers it, and the face stays in", () => {
      const high = { ...face, centerYFrac: 0.08, centerXFrac: 0.02 };
      const slot = videoSlotAt(pipCues, 4, high, [], LS);
      const scale = pictureZoomAt(pipCues, 4, high, LS);
      const state = pictureZoomStateFor(slot, high, scale, LS)!;
      const w = slot.rect.w * LS.width;
      const h = slot.rect.h * LS.height;
      const ox = CONTENT_TRANSFORM_ORIGIN.x * w + state.dx;
      const oy = CONTENT_TRANSFORM_ORIGIN.y * h + state.dy;
      expect(ox).toBeGreaterThanOrEqual(0);
      expect(ox).toBeLessThanOrEqual(w);
      expect(oy).toBeGreaterThanOrEqual(0);
      expect(oy).toBeLessThanOrEqual(h);
      const py = high.centerYFrac * h;
      const landed = oy + scale * (py - oy);
      expect(landed).toBeGreaterThanOrEqual(py - 1e-9);
      expect(landed).toBeLessThanOrEqual(h / 2 + 1e-9);
    });

    it("has no state at scale 1, so the transform is exactly today's", () => {
      const slot = videoSlotAt(pipCues, 4, face, [], PT);
      expect(pictureZoomStateFor(slot, face, 1, PT)).toBeNull();
    });

    it("a portrait pip-bubble cue's content transform equals today's at every moment", () => {
      // Today: contentTransformFor(zoom, scale, dx, dy) alone. The picture
      // term must add nothing in 9:16, through the transition and settled.
      for (let t = 1.9; t <= 6.1; t += 0.05) {
        const slot = videoSlotAt(pipCues, t, face, [], PT);
        const state = pictureZoomStateFor(slot, face, pictureZoomAt(pipCues, t, face, PT), PT);
        for (const [z, s, dx, dy] of [[1, 1, 0, 0], [1.04, 1, 0, 0], [1.02, 1.3, 6, -4]] as const) {
          expect(contentTransformFor(z, s, dx, dy, state)).toBe(contentTransformFor(z, s, dx, dy));
        }
      }
    });

    it("adds the head zoom after the existing transform, about its own origin", () => {
      expect(contentTransformFor(1, 1, 0, 0, { scale: 2, dx: 10, dy: -5 })).toBe(
        "translate(10px, -5px) scale(2) translate(-10px, 5px)",
      );
      expect(contentTransformFor(1.05, 1, 3, 0, { scale: 1.5, dx: 0, dy: 0 })).toBe(
        "translate(3px, 0px) scale(1.05) scale(1.5)",
      );
    });
  });
});

describe("pipPanFor: a pan in the bubble moves what it shows, never the mask (2026-11-20)", () => {
  const PT = PORTRAIT_FRAME;
  // Today's portrait bubble: a 324 px square. A 9:16 source under cover is
  // width-constrained there: 324 wide, 576 tall, so 252 px of vertical
  // excess and none horizontally.
  const base = layoutSlots("pip-bubble", DEFAULT_FACE, [], PT).video;
  const slot = { ...base, objectPosX: 0.5, objectPosY: 0.3 };
  const side = PIP_RECT.w * PT.width;
  const portrait = 9 / 16;
  const EX_Y = side / portrait - side;

  // Where the content box lands on screen, worked out the way CSS composes
  // the content div's transform: origin at CONTENT_TRANSFORM_ORIGIN, then
  // translate(t), scale(s), and the head zoom's translate·scale·translate,
  // applied right to left to each corner.
  const placed = (s: number, picture: { scale: number; dx: number; dy: number } | null, tx: number, ty: number) => {
    const ox = CONTENT_TRANSFORM_ORIGIN.x * side;
    const oy = CONTENT_TRANSFORM_ORIGIN.y * side;
    const map = (px: number, py: number) => {
      let x = px - ox;
      let y = py - oy;
      if (picture) {
        x = (x - picture.dx) * picture.scale + picture.dx;
        y = (y - picture.dy) * picture.scale + picture.dy;
      }
      return { x: x * s + tx + ox, y: y * s + ty + oy };
    };
    const a = map(0, 0);
    const b = map(side, side);
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
  };
  const covers = (r: { left: number; top: number; right: number; bottom: number }) => {
    expect(r.left).toBeLessThanOrEqual(1e-9);
    expect(r.top).toBeLessThanOrEqual(1e-9);
    expect(r.right).toBeGreaterThanOrEqual(side - 1e-9);
    expect(r.bottom).toBeGreaterThanOrEqual(side - 1e-9);
  };

  it("is the identity with no pan, so the stage's strings are today's", () => {
    for (const [s, picture] of [[1, null], [1.08, null], [2, { scale: 1.8, dx: 12, dy: -7 }], [0.8, null]] as const) {
      expect(pipPanFor(slot, portrait, s, picture, 0, 0, PT)).toEqual({
        objectPosX: 0.5,
        objectPosY: 0.3,
        dx: 0,
        dy: 0,
      });
    }
  });

  it("at scale 1, dy moves the crop window, not the picture, and stops at the source's edge", () => {
    // +50 px down on screen = the window moves UP the source: position falls.
    const down = pipPanFor(slot, portrait, 1, null, 0, 50, PT);
    expect(down.objectPosY).toBeCloseTo(0.3 - 50 / EX_Y, 12);
    expect(down.dy).toBe(0);
    expect(down.objectPosX).toBe(0.5);
    const up = pipPanFor(slot, portrait, 1, null, 0, -50, PT);
    expect(up.objectPosY).toBeCloseTo(0.3 + 50 / EX_Y, 12);
    expect(up.dy).toBe(0);
    // Past the source's edge the window stops: clamped to [0, 1], no translate.
    expect(pipPanFor(slot, portrait, 1, null, 0, 5000, PT)).toMatchObject({ objectPosY: 0, dy: 0 });
    expect(pipPanFor(slot, portrait, 1, null, 0, -5000, PT)).toMatchObject({ objectPosY: 1, dy: 0 });
  });

  it("at scale 1, dx in a portrait source does nothing: no excess to show, no room to translate", () => {
    for (const dx of [40, -40, 900]) {
      const r = pipPanFor(slot, portrait, 1, null, dx, 0, PT);
      expect(r).toEqual({ objectPosX: 0.5, objectPosY: 0.3, dx: 0, dy: 0 });
    }
  });

  it("at user scale 2, dx is a translate held to the overflow; the 50% x-origin makes it symmetric", () => {
    // The box is 648 wide about x = 162: it overhangs 162 px each side.
    expect(pipPanFor(slot, portrait, 2, null, 100, 0, PT)).toEqual({ objectPosX: 0.5, objectPosY: 0.3, dx: 100, dy: 0 });
    expect(pipPanFor(slot, portrait, 2, null, 900, 0, PT).dx).toBeCloseTo(162, 9);
    expect(pipPanFor(slot, portrait, 2, null, -900, 0, PT).dx).toBeCloseTo(-162, 9);
  });

  it("at user scale 2, dy spends the window first, then a translate held to the 40% origin's uneven overflow", () => {
    // On screen the window is worth EX_Y × 2 px per unit of position.
    const small = pipPanFor(slot, portrait, 2, null, 0, 60, PT);
    expect(small.objectPosY).toBeCloseTo(0.3 - 60 / (EX_Y * 2), 12);
    expect(small.dy).toBeCloseTo(0, 9);
    // Down: the window has 0.3 × 2 × EX_Y px to give, then the box's top
    // overhang (0.4 × 324 = 129.6 px).
    const down = pipPanFor(slot, portrait, 2, null, 0, 5000, PT);
    expect(down.objectPosY).toBe(0);
    expect(down.dy).toBeCloseTo(0.4 * side, 9);
    // Up: 0.7 × 2 × EX_Y px of window, then the bottom overhang (194.4 px).
    const up = pipPanFor(slot, portrait, 2, null, 0, -5000, PT);
    expect(up.objectPosY).toBe(1);
    expect(up.dy).toBeCloseTo(-0.6 * side, 9);
    // Short of the limit, the picture moves by exactly the pan.
    const mid = pipPanFor(slot, portrait, 2, null, 0, 0.3 * 2 * EX_Y + 50, PT);
    expect(mid.objectPosY).toBe(0);
    expect(mid.dy).toBeCloseTo(50, 9);
  });

  it("never uncovers the bubble, however far the pan goes", () => {
    for (const s of [1, 1.08, 1.5, 2, 3])
      for (const [dx, dy] of [[1e5, 0], [-1e5, 0], [0, 1e5], [0, -1e5], [1e5, -1e5], [-1e5, 1e5]]) {
        const r = pipPanFor(slot, portrait, s, null, dx, dy, PT);
        covers(placed(s, null, r.dx, r.dy));
        expect(r.objectPosY).toBeGreaterThanOrEqual(0);
        expect(r.objectPosY).toBeLessThanOrEqual(1);
      }
  });

  it("under scale 1 the picture already shows the backdrop: inputs pass through, exactly as today", () => {
    // User scale below 1 is the documented "show more of the source" escape.
    expect(pipPanFor(slot, portrait, 0.8, null, 70, -30, PT)).toEqual({
      objectPosX: 0.5,
      objectPosY: 0.3,
      dx: 70,
      dy: -30,
    });
  });

  it("a head zoom counts toward the scale and the clamp", () => {
    // Head zoom 2 about (O + (30, −20)) at s 1: the box overhangs by
    // 162 + 30 = 192 on the left, 162 − 30 = 132 on the right.
    const picture = { scale: 2, dx: 30, dy: -20 };
    expect(pipPanFor(slot, portrait, 1, picture, 900, 0, PT).dx).toBeCloseTo(192, 9);
    expect(pipPanFor(slot, portrait, 1, picture, -900, 0, PT).dx).toBeCloseTo(-132, 9);
    // The window's worth on screen is scaled by the head zoom too.
    const dy = pipPanFor(slot, portrait, 1, picture, 0, 40, PT);
    expect(dy.objectPosY).toBeCloseTo(0.3 - 40 / (EX_Y * 2), 12);
    expect(dy.dy).toBeCloseTo(0, 9);
    for (const [dx, dy] of [[1e5, 1e5], [-1e5, -1e5], [1e5, -1e5], [-1e5, 1e5]]) {
      for (const s of [0.6, 1, 1.3]) {
        const r = pipPanFor(slot, portrait, s, picture, dx, dy, PT);
        covers(placed(s, picture, r.dx, r.dy));
      }
    }
  });

  it("works in a 16:9 bubble, where a landscape source has horizontal excess", () => {
    const LS = LANDSCAPE_FRAME;
    const land = { ...layoutSlots("pip-bubble", DEFAULT_FACE, [], LS).video, objectPosX: 0.5, objectPosY: 0.5 };
    const w = land.rect.w * LS.width;
    const ex = w * (16 / 9) - w;
    const r = pipPanFor(land, 16 / 9, 1, null, 30, 30, LS);
    expect(r.objectPosX).toBeCloseTo(0.5 - 30 / ex, 12);
    expect(r).toMatchObject({ objectPosY: 0.5, dx: 0, dy: 0 });
  });
});

describe("storedGraphicBox: the box a scene keeps, before the picture cuts it (§163)", () => {
  const LS = LANDSCAPE_FRAME;
  const PT = PORTRAIT_FRAME;

  it("a full-frame component: its own box limited to the frame, or the whole frame", () => {
    const band = { x: 0.04, y: 0.56, w: 0.92, h: 0.4 };
    expect(storedGraphicBox({ layout: "full-bleed", component: "CardRow", graphicRect: band }, LS)).toEqual(band);
    const offRight = { x: 0.5, y: 0.1, w: 0.7, h: 0.3 };
    expect(storedGraphicBox({ layout: "full-bleed", component: "CardRow", graphicRect: offRight }, LS)).toEqual(
      clampToFrame(offRight),
    );
    expect(storedGraphicBox({ layout: "full-bleed", component: "CardRow" }, LS)).toEqual(FULL_FRAME_SLOT);
    expect(storedGraphicBox({ layout: "graphic-only", component: "BugCard", graphicRect: null }, LS)).toEqual(
      FULL_FRAME_SLOT,
    );
  });

  it("a slot component: its box in the caption-safe area, else the layout's slot, else the full-bleed band", () => {
    const box = { x: 0.1, y: 0.2, w: 0.7, h: 0.3 };
    for (const frame of [LS, PT]) {
      expect(storedGraphicBox({ layout: "lower-third", component: "TitleCard", graphicRect: box }, frame)).toEqual(
        clampGraphicRect(box, frame),
      );
      expect(storedGraphicBox({ layout: "lower-third", component: "TitleCard" }, frame)).toEqual(
        layoutSlots("lower-third", DEFAULT_FACE, [], frame).graphic,
      );
      expect(storedGraphicBox({ layout: "full-bleed", component: "TitleCard" }, frame)).toEqual(
        FULL_BLEED_GRAPHIC_SLOT,
      );
    }
  });

  it("a 16:9 pip-bubble scene keeps its UNCUT box; graphicSlotFor is that box cut clear of the picture", () => {
    const picture = pipRectFor(LS);
    const cues = [
      { layout: "pip-bubble" as const, component: "CardRow" as const },
      { layout: "pip-bubble" as const, component: "TitleCard" as const, graphicRect: SCRIPT_LANDSCAPE_RECT },
      { layout: "pip-bubble" as const, component: "TitleCard" as const },
      { layout: "pip-bubble" as const, component: "CardRow" as const, pip: { x: 0.05, y: 0.1 } },
    ];
    expect(storedGraphicBox(cues[0]!, LS)).toEqual(FULL_FRAME_SLOT);
    expect(storedGraphicBox(cues[1]!, LS)).toEqual(SCRIPT_LANDSCAPE_RECT);
    expect(storedGraphicBox(cues[2]!, LS)).toEqual({ x: 0.06, y: 0.14, w: 0.78, h: 0.42 });
    expect(storedGraphicBox(cues[3]!, LS)).toEqual(FULL_FRAME_SLOT);
    // One resolver under both: the drawn slot is the stored box, cut.
    expect(graphicSlotFor(cues[0]!, LS)).toEqual(clearOfPicture(FULL_FRAME_SLOT, picture));
    expect(graphicSlotFor(cues[1]!, LS)).toEqual(clearOfPicture(SCRIPT_LANDSCAPE_RECT, picture));
    expect(graphicSlotFor(cues[1]!, LS)).not.toEqual(storedGraphicBox(cues[1]!, LS));
  });

  it("equals graphicSlotFor everywhere the picture does not cut", () => {
    const box = { x: 0.1, y: 0.2, w: 0.7, h: 0.3 };
    for (const frame of [LS, PT]) {
      for (const layout of LayoutSchema.options) {
        if (layout === "pip-bubble" && frame === LS) continue;
        for (const component of ["CardRow", "TitleCard"] as const) {
          for (const graphicRect of [undefined, box]) {
            const c = { layout, component, graphicRect };
            expect(storedGraphicBox(c, frame), `${layout} ${component}`).toEqual(graphicSlotFor(c, frame));
          }
        }
      }
    }
  });
});

describe("belowFaceBox: the band under the speaker's head (§163, design 3)", () => {
  const LS = LANDSCAPE_FRAME;
  const near = (a: { x: number; y: number; w: number; h: number } | null, b: NonNullable<typeof a>) => {
    expect(a).not.toBeNull();
    expect(a!.x).toBeCloseTo(b.x, 9);
    expect(a!.y).toBeCloseTo(b.y, 9);
    expect(a!.w).toBeCloseTo(b.w, 9);
    expect(a!.h).toBeCloseTo(b.h, 9);
  };

  it("a face at centre y 0.38, size 0.3: the head ends at 0.59, so the box is y 0.62 to 0.96 across 0.92", () => {
    const face = { centerYFrac: 0.38, sizeFrac: 0.3 };
    // headBand: 0.38 + 0.3 × (0.5 + 0.2) = 0.59, in fractions of SOURCE
    // height — the frame's own when the full-bleed cover shows the source's
    // whole height (a 16:9 source, or one that never said its shape).
    expect(headBand(face).end).toBeCloseTo(0.59, 12);
    near(belowFaceBox(face, LS), { x: 0.04, y: 0.62, w: 0.92, h: 0.34 });
    near(belowFaceBox({ ...face, centerXFrac: 0.52, sourceAspect: 16 / 9 }, LS), {
      x: 0.04, y: 0.62, w: 0.92, h: 0.34,
    });
  });

  it("an unsized face takes the default size, the stage's rule everywhere else", () => {
    // 0.38 + 0.22 × 0.7 = 0.534 → y 0.564.
    near(belowFaceBox({ centerYFrac: 0.38 }, LS), { x: 0.04, y: 0.564, w: 0.92, h: 0.396 });
  });

  it("maps the head through the full-bleed crop when the source is narrower than the frame", () => {
    // A 4:3 source in 16:9 is width-constrained: shown 1440 px tall in a
    // 1080 px frame and windowed by objectPosYFor, so source fractions are
    // NOT frame fractions and the band must be moved with the crop.
    const face = { centerYFrac: 0.3, sizeFrac: 0.15, sourceAspect: 4 / 3 };
    const shownH = 1920 / (4 / 3);
    const overflow = shownH - 1080;
    const top = objectPosYFor({ x: 0, y: 0, w: 1, h: 1 }, face, LS) * overflow;
    const headEnd = (headBand(face).end * shownH - top) / 1080;
    expect(headEnd).not.toBeCloseTo(headBand(face).end, 3);
    near(belowFaceBox(face, LS), { x: 0.04, y: headEnd + 0.03, w: 0.92, h: 0.96 - headEnd - 0.03 });
  });

  it("graphicBoundsFor: the frame for a full-frame component, the caption-safe rect otherwise", () => {
    for (const frame of [LS, PORTRAIT_FRAME]) {
      for (const component of ["CardRow", "CtaCard", "BugCard", "PhoneDemo", "ClipScene"] as const) {
        expect(graphicBoundsFor(component, frame), component).toEqual(FULL_FRAME_SLOT);
      }
      expect(graphicBoundsFor("TitleCard", frame)).toEqual(safeRectFor(frame));
      expect(graphicBoundsFor(undefined, frame)).toEqual(safeRectFor(frame));
    }
  });

  it("the test face in 1920×1080: a full-frame box and a slot box, each one its clamp leaves alone", () => {
    const face = { centerYFrac: 0.38, sizeFrac: 0.3 };
    const full = belowFaceBox(face, LS, graphicBoundsFor("CardRow", LS));
    near(full, { x: 0.04, y: 0.62, w: 0.92, h: 0.34 });
    expect(graphicClampFor("CardRow", LS)(full!)).toEqual(full);
    // The landscape safe rect is x 0.05..0.95, y 0.06..0.88: the top stays
    // under the head (0.62), the bottom and sides come in to the rect.
    const slot = belowFaceBox(face, LS, graphicBoundsFor("TitleCard", LS));
    near(slot, { x: 0.05, y: 0.62, w: 0.9, h: 0.26 });
    // The clamp is a no-op, so it cannot move the box up onto the chin —
    // which moving the 0.34-tall full-frame box into this rect did (y 0.54).
    expect(graphicClampFor("TitleCard", LS)(slot!)).toEqual(slot);
    expect(slot!.y).toBeGreaterThanOrEqual(headBand(face).end + 0.03 - 1e-12);
  });

  it("stays inside any bounds: a top below the head is floored at the bounds' top", () => {
    const face = { centerYFrac: 0.38, sizeFrac: 0.3 };
    near(belowFaceBox(face, LS, { x: 0.1, y: 0.7, w: 0.6, h: 0.25 }), { x: 0.1, y: 0.7, w: 0.6, h: 0.25 });
  });

  it("is null when the bounds leave under 0.2 of height or under 0.3 of width", () => {
    const face = { centerYFrac: 0.38, sizeFrac: 0.3 };
    // Bottom 0.8: 0.62..0.8 is 0.18 tall.
    expect(belowFaceBox(face, LS, { x: 0, y: 0, w: 1, h: 0.8 })).toBeNull();
    // 0.25 wide.
    expect(belowFaceBox(face, LS, { x: 0.5, y: 0, w: 0.25, h: 1 })).toBeNull();
    // 0.3 wide is enough.
    near(belowFaceBox(face, LS, { x: 0.5, y: 0, w: 0.3, h: 1 }), { x: 0.5, y: 0.62, w: 0.3, h: 0.34 });
  });

  it("is null for a screen recording's face: it is a camera inset, not the speaker", () => {
    expect(belowFaceBox({ centerYFrac: 0.38, sizeFrac: 0.3, subject: "screen" }, LS)).toBeNull();
    expect(belowFaceBox({ centerYFrac: 0.38, sizeFrac: 0.3, subject: "face" }, LS)).not.toBeNull();
  });

  it("is null with no face, and when less than 0.2 of the height is left below the head", () => {
    expect(belowFaceBox(null, LS)).toBeNull();
    expect(belowFaceBox(undefined, LS)).toBeNull();
    // 0.55 + 0.3 × 0.7 = 0.76 → y 0.79, h 0.17.
    expect(belowFaceBox({ centerYFrac: 0.55, sizeFrac: 0.3 }, LS)).toBeNull();
    // 0.5 + 0.3 × 0.7 = 0.71 → y 0.74, h 0.22: still room.
    near(belowFaceBox({ centerYFrac: 0.5, sizeFrac: 0.3 }, LS), { x: 0.04, y: 0.74, w: 0.92, h: 0.22 });
  });
});
