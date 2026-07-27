import type { FaceCrop, Layout, SceneCue } from "@ossclip/core/browser";

/** Fractions of the 1080×1920 frame. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoSlotState {
  rect: Rect;
  /** 0..1 — fraction of the slot's shorter edge (1 = circle on a square slot). */
  cornerRadius: number;
  blurPx: number;
  /** 0..1 black overlay on top of the video. */
  dim: number;
  opacity: number;
  /**
   * Vertical crop bias for object-position (0 = show the top of the source,
   * 0.5 = center). Slots shorter than the portrait source slice through it
   * and can decapitate the speaker — derived from the measured face so the
   * whole head, chin included, lands in the band (FINDINGS §11/§13).
   */
  objectPosY: number;
}

/** The frame the stage lays out for — all rect fractions refer to this. */
const FRAME_W = 1080;
const FRAME_H = 1920;

/**
 * Assumed face when none was measured (screen recording, detector miss):
 * an arm's-length selfie puts the face center ~38% down the frame. A guess
 * either way lands closer than the old per-layout constants — 0.12 traded
 * the cut forehead for a cut mouth (FINDINGS §13).
 */
export const DEFAULT_FACE: FaceCrop = { centerYFrac: 0.38, sizeFrac: 0.35 };

/**
 * Where the face center should sit inside a cropping slot, as a fraction of
 * slot height: ~40% down keeps headroom above AND the chin in — the mouth is
 * what makes a talking head read as speech.
 */
const FACE_ANCHOR_IN_SLOT = 0.42;

/**
 * Vertical object-position for a slot, placing the measured face center at
 * FACE_ANCHOR_IN_SLOT of the slot. Assumes the source shares the frame's
 * portrait aspect (the v1 target is phone footage), so with object-fit:
 * cover every slot is width-constrained and shows the source at
 * slot-width-proportional height.
 */
export function objectPosYFor(rect: Rect, face: FaceCrop): number {
  const slotW = rect.w * FRAME_W;
  const slotH = rect.h * FRAME_H;
  const displayedH = (slotW * FRAME_H) / FRAME_W;
  const overflow = displayedH - slotH;
  if (overflow <= 1) return 0.5; // slot shows the full source height — no bias to apply
  const y = (face.centerYFrac * displayedH - FACE_ANCHOR_IN_SLOT * slotH) / overflow;
  return Math.min(1, Math.max(0, y));
}

export interface StageSlots {
  video: VideoSlotState;
  graphic: Rect | null;
  /**
   * Vertical center (fraction of frame height) for captions. Captions are
   * NEVER hidden ("muted-viewing complete", BRAINSTORM §4.5) — each layout
   * reserves a free band clear of the graphic, the platform chrome, and the
   * un-blurred face (FINDINGS §2, §6).
   */
  captionAnchor: number;
}

/**
 * Platform chrome insets — the union of Reels/TikTok/Shorts UI overlays
 * (top: status bar + tabs, bottom: username/caption/ticker, right: action
 * rail). All TEXT and GRAPHICS must stay inside; the video slot may bleed
 * full-frame — a face under the chrome is fine, text under it is not.
 * (FINDINGS §6a.)
 */
export const SAFE_AREA = { top: 0.12, bottom: 0.22, right: 0.16, left: 0.04 };

/** The rect everything textual must live in. */
export const SAFE_RECT: Rect = {
  x: SAFE_AREA.left,
  y: SAFE_AREA.top,
  w: 1 - SAFE_AREA.left - SAFE_AREA.right,
  h: 1 - SAFE_AREA.top - SAFE_AREA.bottom,
};

/** Approximate half-height of a caption line block, for free-band math/tests. */
export const CAPTION_HALF_BAND = 0.045;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** PIP circle: Ø 0.30 of frame width, sitting in the lower third. */
const PIP_DIAMETER_W = 0.3;
const PIP_RECT: Rect = {
  x: 0.5 - PIP_DIAMETER_W / 2,
  y: 0.66,
  w: PIP_DIAMETER_W,
  h: (PIP_DIAMETER_W * 1080) / 1920,
};

/**
 * The stage's slot arrangement per layout (PHASE1 §1 table, safe-area'd per
 * FINDINGS §6). Caption anchors sit in the free band each layout reserves:
 *   full-bleed     → lower third, below the face, above the bottom inset
 *   video-top      → the gap between the video block and the graphic
 *   pip-bubble     → between the graphic and the bubble
 *   graphic-only   → below the graphic (the layout reserves the band)
 *   blurred-behind → below the centred graphic (face is blurred — no clash)
 */
export function layoutSlots(layout: Layout, face: FaceCrop = DEFAULT_FACE): StageSlots {
  const posY = (rect: Rect) => objectPosYFor(rect, face);
  switch (layout) {
    case "full-bleed":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1, objectPosY: posY(FULL) },
        graphic: null,
        captionAnchor: 0.7,
      };
    case "video-top": {
      const rect: Rect = { x: 0, y: 0, w: 1, h: 0.42 };
      return {
        video: { rect, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1, objectPosY: posY(rect) },
        graphic: { x: 0.04, y: 0.54, w: 0.8, h: 0.24 },
        captionAnchor: 0.48,
      };
    }
    case "pip-bubble":
      return {
        video: {
          rect: PIP_RECT,
          cornerRadius: 1,
          blurPx: 0,
          dim: 0,
          opacity: 1,
          objectPosY: posY(PIP_RECT),
        },
        graphic: { x: 0.06, y: 0.14, w: 0.78, h: 0.42 },
        captionAnchor: 0.61,
      };
    case "graphic-only":
      return {
        video: {
          rect: PIP_RECT,
          cornerRadius: 1,
          blurPx: 0,
          dim: 0,
          opacity: 0,
          objectPosY: posY(PIP_RECT),
        },
        graphic: { x: 0.04, y: 0.14, w: 0.8, h: 0.54 },
        captionAnchor: 0.73,
      };
    case "blurred-behind":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 22, dim: 0.55, opacity: 1, objectPosY: posY(FULL) },
        graphic: { x: 0.07, y: 0.24, w: 0.77, h: 0.36 },
        captionAnchor: 0.69,
      };
  }
}

/** Seconds the video slot spends morphing between layouts at a cue boundary. */
export const LAYOUT_TRANSITION_SEC = 0.35;

export function activeCueAt(cues: readonly SceneCue[], tSec: number): SceneCue | null {
  for (const cue of cues) {
    if (tSec >= cue.startSec && tSec < cue.endSec) return cue;
  }
  return null;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function lerpRect(a: Rect, b: Rect, p: number): Rect {
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) };
}

function lerpVideo(a: VideoSlotState, b: VideoSlotState, p: number): VideoSlotState {
  return {
    rect: lerpRect(a.rect, b.rect, p),
    cornerRadius: lerp(a.cornerRadius, b.cornerRadius, p),
    blurPx: lerp(a.blurPx, b.blurPx, p),
    dim: lerp(a.dim, b.dim, p),
    opacity: lerp(a.opacity, b.opacity, p),
    objectPosY: lerp(a.objectPosY, b.objectPosY, p),
  };
}

function easeInOut(p: number): number {
  return p * p * (3 - 2 * p);
}

/**
 * The video slot's state at output time t, easing between layouts around cue
 * boundaries. The morph runs INSIDE the cue's own window (start → start+T,
 * end-T → end) so neighbouring cues never fight over the slot.
 */
export function videoSlotAt(
  cues: readonly SceneCue[],
  tSec: number,
  face: FaceCrop = DEFAULT_FACE,
): VideoSlotState {
  const base = layoutSlots("full-bleed", face).video;
  const cue = activeCueAt(cues, tSec);
  if (!cue) return base;
  const target = layoutSlots(cue.layout, face).video;
  const T = Math.min(LAYOUT_TRANSITION_SEC, (cue.endSec - cue.startSec) / 2);
  const sinceStart = tSec - cue.startSec;
  const untilEnd = cue.endSec - tSec;

  const prev = activeCueAt(cues, cue.startSec - 1e-3);
  const next = activeCueAt(cues, cue.endSec + 1e-3);
  const from = prev ? layoutSlots(prev.layout, face).video : base;
  const to = next ? layoutSlots(next.layout, face).video : base;

  if (sinceStart < T) return lerpVideo(from, target, easeInOut(sinceStart / T));
  if (untilEnd < T) return lerpVideo(target, to, easeInOut(1 - untilEnd / T));
  return target;
}

/**
 * Caption anchor at time t. Resolved from the settled layout at the line's
 * start (never animated — a caption sliding mid-word reads as a bug).
 */
export function captionAnchorAt(cues: readonly SceneCue[], tSec: number): number {
  const cue = activeCueAt(cues, tSec);
  return cue ? layoutSlots(cue.layout).captionAnchor : layoutSlots("full-bleed").captionAnchor;
}

function backdropTarget(layout: Layout): number {
  return layout === "pip-bubble" || layout === "graphic-only" ? 1 : 0;
}

/** Opacity of the solid stage backdrop (theme.bg) behind the demoted video slot. */
export function backdropOpacityAt(cues: readonly SceneCue[], tSec: number): number {
  const cue = activeCueAt(cues, tSec);
  if (!cue) return 0;
  const target = backdropTarget(cue.layout);
  const T = Math.min(LAYOUT_TRANSITION_SEC, (cue.endSec - cue.startSec) / 2);
  const prev = activeCueAt(cues, cue.startSec - 1e-3);
  const next = activeCueAt(cues, cue.endSec + 1e-3);
  const from = prev ? backdropTarget(prev.layout) : 0;
  const to = next ? backdropTarget(next.layout) : 0;
  const sinceStart = tSec - cue.startSec;
  const untilEnd = cue.endSec - tSec;
  if (sinceStart < T) return lerp(from, target, easeInOut(sinceStart / T));
  if (untilEnd < T) return lerp(target, to, easeInOut(1 - untilEnd / T));
  return target;
}
