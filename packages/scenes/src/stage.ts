import type { Layout, SceneCue } from "@ossclip/core/browser";

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
}

export interface StageSlots {
  video: VideoSlotState;
  graphic: Rect | null;
  /** Vertical anchor (fraction of frame height) for captions; null = hidden. */
  captionAnchor: number | null;
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** PIP circle: Ø 0.30 of frame width, sitting in the lower third. */
const PIP_DIAMETER_W = 0.3;
const PIP_RECT: Rect = {
  x: 0.5 - PIP_DIAMETER_W / 2,
  y: 0.66,
  w: PIP_DIAMETER_W,
  h: (PIP_DIAMETER_W * 1080) / 1920,
};

/** The stage's slot arrangement per layout (PHASE1 §1 table). */
export function layoutSlots(layout: Layout): StageSlots {
  switch (layout) {
    case "full-bleed":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1 },
        graphic: null,
        captionAnchor: 0.76,
      };
    case "video-top":
      return {
        video: { rect: { x: 0, y: 0, w: 1, h: 0.45 }, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1 },
        graphic: { x: 0.05, y: 0.48, w: 0.9, h: 0.44 },
        captionAnchor: 0.38,
      };
    case "pip-bubble":
      return {
        video: { rect: PIP_RECT, cornerRadius: 1, blurPx: 0, dim: 0, opacity: 1 },
        graphic: { x: 0.06, y: 0.1, w: 0.88, h: 0.52 },
        captionAnchor: null,
      };
    case "graphic-only":
      return {
        video: { rect: PIP_RECT, cornerRadius: 1, blurPx: 0, dim: 0, opacity: 0 },
        graphic: { x: 0.06, y: 0.1, w: 0.88, h: 0.8 },
        captionAnchor: null,
      };
    case "blurred-behind":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 22, dim: 0.55, opacity: 1 },
        graphic: { x: 0.07, y: 0.3, w: 0.86, h: 0.4 },
        captionAnchor: null,
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
export function videoSlotAt(cues: readonly SceneCue[], tSec: number): VideoSlotState {
  const base = layoutSlots("full-bleed").video;
  const cue = activeCueAt(cues, tSec);
  if (!cue) return base;
  const target = layoutSlots(cue.layout).video;
  const T = Math.min(LAYOUT_TRANSITION_SEC, (cue.endSec - cue.startSec) / 2);
  const sinceStart = tSec - cue.startSec;
  const untilEnd = cue.endSec - tSec;

  const prev = activeCueAt(cues, cue.startSec - 1e-3);
  const next = activeCueAt(cues, cue.endSec + 1e-3);
  const from = prev ? layoutSlots(prev.layout).video : base;
  const to = next ? layoutSlots(next.layout).video : base;

  if (sinceStart < T) return lerpVideo(from, target, easeInOut(sinceStart / T));
  if (untilEnd < T) return lerpVideo(target, to, easeInOut(1 - untilEnd / T));
  return target;
}

/** Caption anchor at time t (null = captions hidden while this cue owns the frame). */
export function captionAnchorAt(cues: readonly SceneCue[], tSec: number): number | null {
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
