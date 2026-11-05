import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core/browser";
import {
  cardRect,
  containedRect,
  graphicRectAtFor,
  overlayBoxForCue,
  overlayRect,
} from "../src/overlay-rect";
import {
  CAPTION_HALF_BAND,
  LANDSCAPE_FRAME,
  PORTRAIT_FRAME,
  SAFE_AREA,
  layoutSlots,
  safeAreaFor,
} from "../src/stage";

/**
 * Overlay placement (overlay-library spec §Rendering, overlay look). The one
 * rule every case pins: the box never reaches below the caption top.
 */

const EPS = 1e-9;

describe("overlayRect", () => {
  it("centred, ~1/3 width, bottom edge above captionTop with a gap", () => {
    const r = overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.66 });
    expect(r.w).toBeCloseTo(1 / 3);
    expect(r.x + r.w / 2).toBeCloseTo(0.5);
    expect(r.y + r.h).toBeLessThan(0.66);
    expect(0.66 - (r.y + r.h)).toBeCloseTo(0.02);
    // Plenty of room: the full square box (1/3 of 1080 = 360px → 360/1920).
    expect(r.h).toBeCloseTo(360 / 1920);
  });

  it("box height capped inside SAFE_AREA (ruling R2: the image is contained in it)", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      const safe = safeAreaFor(frame);
      for (const captionTop of [0.3, 0.5, 0.7, 0.95, null]) {
        const r = overlayRect({ frame, captionTop });
        expect(r.y).toBeGreaterThanOrEqual(safe.top - EPS);
        expect(r.y + r.h).toBeLessThanOrEqual(1 - safe.bottom + EPS);
        // Never taller than the square box a third of the width makes.
        expect(r.h * frame.height).toBeLessThanOrEqual((frame.width / 3) + EPS);
      }
    }
    // A caption way down at the bottom does not drag the box under the chrome.
    const low = overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.95 });
    expect(low.y + low.h).toBeLessThanOrEqual(1 - SAFE_AREA.bottom + EPS);
  });

  it("captionTop high (0.3) → no room → top safe area", () => {
    const r = overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.3 });
    expect(r.y).toBeCloseTo(SAFE_AREA.top);
    expect(r.y + r.h).toBeLessThanOrEqual(0.3);
  });

  it("captions hand-placed at the very top shrink the box, never cover the captions", () => {
    // captionY is free in 0..1 (R15 §56); the anti-goal wins over the size.
    for (const captionTop of [0.2, 0.13, 0.05, 0]) {
      const r = overlayRect({ frame: PORTRAIT_FRAME, captionTop });
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(captionTop + EPS);
    }
  });

  it("graphicRect between → avoids it; neither fits → may overlap graphic, never captions", () => {
    // A graphic high in the frame leaves the band above the captions free.
    const high = { x: 0.07, y: 0.12, w: 0.77, h: 0.2 };
    const a = overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.66, graphicRect: high });
    expect(a.y).toBeGreaterThanOrEqual(high.y + high.h);
    expect(a.y + a.h).toBeLessThanOrEqual(0.66);

    // The blurred-behind slot: too little between it and the captions, so
    // the overlay moves to the top safe area above the graphic.
    const mid = { x: 0.07, y: 0.4, w: 0.77, h: 0.22 };
    const b = overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.66, graphicRect: mid });
    expect(b.y).toBeCloseTo(SAFE_AREA.top);
    expect(b.y + b.h).toBeLessThanOrEqual(mid.y);

    // graphic-only: the slot fills the whole band above the captions — the
    // overlay may sit on the graphic, but still clears the captions.
    const only = layoutSlots("graphic-only").graphic!;
    const captionTop = layoutSlots("graphic-only").captionAnchor - CAPTION_HALF_BAND;
    const c = overlayRect({ frame: PORTRAIT_FRAME, captionTop, graphicRect: only });
    expect(c.y + c.h).toBeLessThanOrEqual(captionTop);
    expect(c.h).toBeGreaterThan(0);

    // A graphic off to the side of the centred box does not move it.
    const side = { x: 0.04, y: 0.3, w: 0.2, h: 0.3 };
    expect(overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.66, graphicRect: side })).toEqual(
      overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.66 }),
    );
  });

  it("null captionTop → above the default caption anchor", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      const anchor = layoutSlots("full-bleed", undefined, [], frame).captionAnchor;
      const r = overlayRect({ frame, captionTop: null });
      expect(r.y + r.h).toBeLessThanOrEqual(anchor - CAPTION_HALF_BAND);
      expect(r).toEqual(overlayRect({ frame, captionTop: anchor - CAPTION_HALF_BAND }));
    }
  });
});

describe("containedRect", () => {
  const box = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
  it("a wide image fills the width and hugs the bottom edge", () => {
    // Box is 432x384px; a 4:1 image → 432x108.
    const r = containedRect(box, 4, PORTRAIT_FRAME, "bottom");
    expect(r.w).toBeCloseTo(0.4);
    expect(r.h * 1920).toBeCloseTo(108);
    expect(r.y + r.h).toBeCloseTo(0.6);
  });
  it("a tall image is capped by the box height and centred horizontally", () => {
    const r = containedRect(box, 0.5, PORTRAIT_FRAME, "center");
    expect(r.h).toBeCloseTo(0.2);
    expect(r.w * 1080).toBeCloseTo(192);
    expect(r.x + r.w / 2).toBeCloseTo(0.5);
  });
  it("an unusable aspect falls back to the box", () => {
    expect(containedRect(box, 0, PORTRAIT_FRAME, "bottom")).toEqual(box);
    expect(containedRect(box, Number.NaN, PORTRAIT_FRAME, "bottom")).toEqual(box);
  });
});

describe("cardRect", () => {
  it("is a centred square at half the frame's shorter side, in both shapes", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      const r = cardRect(frame);
      const side = 0.5 * Math.min(frame.width, frame.height);
      expect(r.w * frame.width).toBeCloseTo(side);
      expect(r.h * frame.height).toBeCloseTo(side);
      expect(r.x + r.w / 2).toBeCloseTo(0.5);
      expect(r.y + r.h / 2).toBeCloseTo(0.5);
    }
  });
});

describe("graphicRectAtFor", () => {
  const graphic: SceneCue = {
    id: "g",
    layout: "blurred-behind",
    component: "StatCard",
    props: {},
    startSec: 2,
    endSec: 4,
  };
  const plain: SceneCue = { id: "p", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 2 };
  it("returns the slot SceneLayer draws, and nothing for plain cues or gaps", () => {
    const at = graphicRectAtFor([plain, graphic], PORTRAIT_FRAME);
    expect(at(1)).toBeUndefined();
    expect(at(3)).toEqual(layoutSlots("blurred-behind").graphic);
    expect(at(5)).toBeUndefined();
  });
  it("honours a hand-moved rect", () => {
    const moved = { ...graphic, graphicRect: { x: 0.1, y: 0.15, w: 0.7, h: 0.2 } };
    expect(graphicRectAtFor([moved], PORTRAIT_FRAME)(3)).toEqual(moved.graphicRect);
  });
});

describe("overlayBoxForCue", () => {
  it("clears the HIGHEST caption top seen over the window, so the box never hops", () => {
    // A caption that rises mid-window (a hand-moved line) still bounds the box.
    const captionTopAt = (t: number) => (t < 1.5 ? 0.66 : 0.5);
    const r = overlayBoxForCue({ atSec: 1, endSec: 2.5 }, 30, PORTRAIT_FRAME, captionTopAt, () => undefined);
    expect(r).toEqual(overlayRect({ frame: PORTRAIT_FRAME, captionTop: 0.5 }));
  });
  it("no caption anywhere in the window → the null-caption placement", () => {
    const r = overlayBoxForCue({ atSec: 0, endSec: 1 }, 30, PORTRAIT_FRAME, () => null, () => undefined);
    expect(r).toEqual(overlayRect({ frame: PORTRAIT_FRAME, captionTop: null }));
  });
  it("dodges every graphic seen in the window (their bounding box)", () => {
    const g1 = { x: 0.07, y: 0.12, w: 0.77, h: 0.1 };
    const g2 = { x: 0.07, y: 0.2, w: 0.77, h: 0.1 };
    const graphicRectAt = (t: number) => (t < 1.5 ? g1 : g2);
    const r = overlayBoxForCue({ atSec: 1, endSec: 2.5 }, 30, PORTRAIT_FRAME, () => 0.66, graphicRectAt);
    expect(r.y).toBeGreaterThanOrEqual(0.3);
    expect(r.y + r.h).toBeLessThanOrEqual(0.66);
  });
});
