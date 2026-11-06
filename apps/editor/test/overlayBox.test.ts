import { describe, expect, it } from "vitest";
import { OverlayRectSchema } from "@ossclip/core";
import { safeAreaFor } from "@ossclip/scenes/geometry";
import {
  canvasBoxFor,
  handPlacedStartRect,
  clampOverlayRect,
  fracToPage,
  moveOverlayRect,
  pageToFrac,
  resizeOverlayRect,
} from "../src/overlayBox";

const close = (a: Record<string, number>, b: Record<string, number>) => {
  for (const k of Object.keys(b)) expect(a[k]).toBeCloseTo(b[k]!, 9);
};

describe("overlay box geometry (overlay-transform)", () => {
  it("canvasBoxFor letterboxes the canvas centred in its host", () => {
    expect(canvasBoxFor({ left: 0, top: 0, width: 400, height: 1000 }, 0.25, { width: 1080, height: 1920 })).toEqual({
      left: 65,
      top: 260,
      w: 270,
      h: 480,
    });
    expect(canvasBoxFor({ left: 0, top: 0, width: 1, height: 1 }, 0, { width: 1, height: 1 })).toBeNull();
  });

  it("page px and frame fractions round-trip", () => {
    const canvas = { left: 10, top: 20, w: 200, h: 400 };
    const page = { left: 60, top: 120, width: 50, height: 100 };
    const frac = pageToFrac(page, canvas);
    close(frac, { x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    close(fracToPage(frac, canvas), page);
  });

  it("a move is clamped so the whole box stays in frame", () => {
    const start = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    close(moveOverlayRect(start, 0.1, -0.05), { x: 0.5, y: 0.35, w: 0.2, h: 0.1 });
    close(moveOverlayRect(start, 0.9, 0.9), { x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
    close(moveOverlayRect(start, -0.9, -0.9), { x: 0, y: 0, w: 0.2, h: 0.1 });
  });

  it("a corner resize keeps the aspect and pins the opposite corner", () => {
    const start = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    // se pulled right by 0.1 (×1.5 in w), barely down: w leads.
    const se = resizeOverlayRect(start, "se", 0.1, 0.01);
    close(se, { x: 0.4, y: 0.4, w: 0.3, h: 0.15 });
    // nw pulled up-left: the se corner (0.6, 0.5) stays put.
    const nw = resizeOverlayRect(start, "nw", -0.1, 0);
    close(nw, { x: 0.3, y: 0.35, w: 0.3, h: 0.15 });
    expect(nw.x + nw.w).toBeCloseTo(0.6, 9);
    expect(nw.y + nw.h).toBeCloseTo(0.5, 9);
  });

  it("a resize stops at the frame edge without breaking the aspect", () => {
    const start = { x: 0.6, y: 0.4, w: 0.2, h: 0.1 };
    // Pulling se far right: room on the right is 0.4 → at most ×2.
    const r = resizeOverlayRect(start, "se", 5, 0);
    close(r, { x: 0.6, y: 0.4, w: 0.4, h: 0.2 });
  });

  it("a resize never drops under the schema minimum", () => {
    const start = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    const r = resizeOverlayRect(start, "se", -5, -5);
    expect(r.h).toBeCloseTo(0.02, 9);
    expect(r.w).toBeCloseTo(0.04, 9);
  });

  it("clamp pulls an oversized or off-frame box back in", () => {
    close(clampOverlayRect({ x: -0.1, y: 0.95, w: 1.2, h: 0.1 }), { x: 0, y: 0.9, w: 1, h: 0.1 });
  });
});

describe("handPlacedStartRect", () => {
  it("is the automatic box's size, centred at the top of the safe area, and passes the rect schema", () => {
    const frame = { width: 1080, height: 1920 };
    const r = handPlacedStartRect(frame);
    expect(r.w).toBeCloseTo(1 / 3);
    expect(r.h * frame.height).toBeCloseTo(r.w * frame.width); // square in pixels
    expect(r.x + r.w / 2).toBeCloseTo(0.5);
    expect(r.y).toBe(safeAreaFor(frame).top);
    expect(OverlayRectSchema.safeParse(r).success).toBe(true);
  });
});
