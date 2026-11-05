import type { OverlayRect } from "@ossclip/core/browser";

/**
 * Move/resize geometry for a library overlay's on-canvas box
 * (overlay-transform). Pure, frame fractions in and out, so the drag maths is
 * testable without a Player — the DOM measuring lives in OverlayImageBox.
 */

/** A corner an overlay resize drags. No edge handles: a picture keeps its
 * aspect, and an edge handle that cannot change the aspect is a corner
 * handle with a worse grip. */
export type OverlayCorner = "nw" | "ne" | "se" | "sw";

/** core's `OverlayRectSchema` minimum — a smaller box is refused on save. */
export const OVERLAY_MIN_FRAC = 0.02;

/** The Player's canvas in page px (`Overlay.tsx` canvasBox's arithmetic:
 * the canvas is letterboxed centred inside its host at `scale`). */
export interface CanvasBox {
  left: number;
  top: number;
  w: number;
  h: number;
}

export function canvasBoxFor(
  host: { left: number; top: number; width: number; height: number },
  scale: number,
  frame: { width: number; height: number },
): CanvasBox | null {
  if (!(scale > 0)) return null;
  const w = frame.width * scale;
  const h = frame.height * scale;
  return { left: host.left + (host.width - w) / 2, top: host.top + (host.height - h) / 2, w, h };
}

/** A page-px rect (a `getBoundingClientRect`) as frame fractions. */
export function pageToFrac(
  r: { left: number; top: number; width: number; height: number },
  canvas: CanvasBox,
): OverlayRect {
  return {
    x: (r.left - canvas.left) / canvas.w,
    y: (r.top - canvas.top) / canvas.h,
    w: r.width / canvas.w,
    h: r.height / canvas.h,
  };
}

/** Frame fractions back to page px, for drawing the box during a drag. */
export function fracToPage(r: OverlayRect, canvas: CanvasBox): { left: number; top: number; width: number; height: number } {
  return {
    left: canvas.left + r.x * canvas.w,
    top: canvas.top + r.y * canvas.h,
    width: r.w * canvas.w,
    height: r.h * canvas.h,
  };
}

/**
 * Pull a box fully inside the frame, size first. The schema bounds x/y to
 * [0, 1] but not x + w; an overlay half off the frame would save, render
 * cropped, and leave the user nothing to grab back — so the editor never
 * writes one.
 */
export function clampOverlayRect(r: OverlayRect): OverlayRect {
  const w = Math.min(1, Math.max(OVERLAY_MIN_FRAC, r.w));
  const h = Math.min(1, Math.max(OVERLAY_MIN_FRAC, r.h));
  return {
    x: Math.min(1 - w, Math.max(0, r.x)),
    y: Math.min(1 - h, Math.max(0, r.y)),
    w,
    h,
  };
}

/** A move drag: the start box shifted by the pointer delta, kept in frame. */
export function moveOverlayRect(start: OverlayRect, fdx: number, fdy: number): OverlayRect {
  return clampOverlayRect({ ...start, x: start.x + fdx, y: start.y + fdy });
}

/**
 * A corner drag, aspect LOCKED, the opposite corner pinned.
 *
 * One uniform factor from whichever axis the pointer pulled further — the
 * box is the picture (OverlayTrack sizes the tagged element to the image's
 * own aspect), so a free-aspect box would just leave the image floating
 * inside a frame it no longer fills. The factor is capped so the box neither
 * drops under the schema minimum nor crosses the frame edge on the dragged
 * side; capping the FACTOR rather than clamping the result is what keeps the
 * aspect through the cap.
 */
export function resizeOverlayRect(
  start: OverlayRect,
  corner: OverlayCorner,
  fdx: number,
  fdy: number,
): OverlayRect {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const sx = (start.w + (west ? -fdx : fdx)) / start.w;
  const sy = (start.h + (north ? -fdy : fdy)) / start.h;
  // The axis the pointer moved further (relative to the box) leads.
  let s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  const anchorX = west ? start.x + start.w : start.x;
  const anchorY = north ? start.y + start.h : start.y;
  const roomW = west ? anchorX : 1 - anchorX;
  const roomH = north ? anchorY : 1 - anchorY;
  const sMax = Math.min(roomW / start.w, roomH / start.h);
  const sMin = Math.max(OVERLAY_MIN_FRAC / start.w, OVERLAY_MIN_FRAC / start.h);
  s = Math.min(sMax, Math.max(sMin, s));
  const w = start.w * s;
  const h = start.h * s;
  return {
    x: west ? anchorX - w : anchorX,
    y: north ? anchorY - h : anchorY,
    w,
    h,
  };
}
