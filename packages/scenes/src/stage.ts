import { ZOOM_MAX_SCALE, type FaceCrop, type Layout, type SceneCue } from "@ossclip/core/browser";

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
  /**
   * Horizontal crop bias, same convention. Only moves off 0.5 when the source
   * is wider than the slot — a landscape take in a vertical slot loses most of
   * its width, and centring it can crop the speaker out (0.5 = center).
   */
  objectPosX: number;
}

/** The frame the stage lays out for — all rect fractions refer to this. */
const FRAME_W = 1080;
const FRAME_H = 1920;

/**
 * Assumed face when none was measured (screen recording, detector miss):
 * an arm's-length selfie puts the face center ~38% down the frame, with the
 * detector's box about a fifth of the frame height. A guess either way lands
 * closer than the old per-layout constants — 0.12 traded the cut forehead for
 * a cut mouth (FINDINGS §13).
 */
export const DEFAULT_FACE: FaceCrop & { sizeFrac: number } = {
  centerYFrac: 0.38,
  sizeFrac: 0.22,
  // No centerXFrac and no sourceAspect on purpose: an unmeasured face has no
  // horizontal position worth asserting, and a source that never said what
  // shape it is gets assumed to be the frame's own 9:16.
};

/**
 * How far a head extends ABOVE the detector's box, as a multiple of that
 * box's height. pico bounds the face — eyes, nose, mouth — and excludes hair
 * and skull, so centring the box seats the head too low and the crown is cut
 * mid-forehead (FINDINGS §19).
 */
export const HEAD_ABOVE_FACE = 0.35;

/** Preferred position of the head's centre within the slot. */
const HEAD_ANCHOR_IN_SLOT = 0.45;

/**
 * Clearance kept above the crown and below the chin, as fractions of slot
 * height. Floored by what the §15 zoom eats: it scales slot content by up to
 * ZOOM_MAX_SCALE about `50% 40%`, so at peak zoom the band loses
 * `0.4·(1−1/s)` off the top and `0.6·(1−1/s)` off the bottom. Hard-coding
 * smaller margins would let the zoom undo this fix at its peaks while the
 * geometry tests still passed.
 */
const ZOOM_BITE = 1 - 1 / ZOOM_MAX_SCALE;
export const HEAD_TOP_MARGIN = 0.4 * ZOOM_BITE;
export const CHIN_BOTTOM_MARGIN = 0.6 * ZOOM_BITE;

/**
 * Whether a slot can hold this whole head — box, margins and all — and
 * whether the crown was in the source to begin with. When this is false the
 * crop is a choice about which end to lose, not a solvable placement.
 */
export function headFitsSlot(rect: Rect, face: FaceCrop): boolean {
  const slotH = rect.h * FRAME_H;
  const displayedH = displayedHeight(rect, face);
  const size = face.sizeFrac ?? DEFAULT_FACE.sizeFrac;
  const crownFrac = face.centerYFrac - size / 2 - HEAD_ABOVE_FACE * size;
  const needed =
    (1 + HEAD_ABOVE_FACE) * size * displayedH + (HEAD_TOP_MARGIN + CHIN_BOTTOM_MARGIN) * slotH;
  return crownFrac >= 0 && needed <= slotH;
}

/** The frame's own aspect — the assumption when a source doesn't state one. */
const FRAME_ASPECT = FRAME_W / FRAME_H;

/**
 * Displayed height of the source inside a slot under `object-fit: cover`.
 *
 * `cover` scales by whichever axis needs the larger factor. A 9:16 source in
 * any of our slots is width-constrained and spills vertically — which is the
 * only case the crop math used to handle. A landscape source is
 * HEIGHT-constrained: it fills the slot's height exactly and spills sideways,
 * so there is no vertical bias to apply and `objectPosXFor` takes over.
 */
function displayedHeight(rect: Rect, face: FaceCrop): number {
  const slotW = rect.w * FRAME_W;
  const slotH = rect.h * FRAME_H;
  return Math.max(slotH, slotW / (face.sourceAspect ?? FRAME_ASPECT));
}

/**
 * Vertical object-position for a slot: where to window the source so the
 * speaker's whole head lands in the band.
 *
 * Expressed as a feasible interval rather than one tuned constant — the crown
 * gives an upper bound on the offset, the chin a lower one. Inside the
 * interval we take the preferred anchor; when the band is too short to hold a
 * whole head the interval is empty and we keep the CHIN, because a talking
 * head without a mouth stops reading as speech (FINDINGS §13).
 */
export function objectPosYFor(rect: Rect, face: FaceCrop): number {
  const slotH = rect.h * FRAME_H;
  const displayedH = displayedHeight(rect, face);
  const overflow = displayedH - slotH;
  if (overflow <= 1) return 0.5; // slot shows the full source height — no bias to apply

  // sizeFrac is optional on the schema; without it there is no head to model,
  // so fall back to the assumed framing rather than propagating NaN into CSS.
  const size = face.sizeFrac ?? DEFAULT_FACE.sizeFrac;
  const crown = (face.centerYFrac - size / 2 - HEAD_ABOVE_FACE * size) * displayedH;
  const chin = (face.centerYFrac + size / 2) * displayedH;

  const preferred = (crown + chin) / 2 - HEAD_ANCHOR_IN_SLOT * slotH;
  const crownVisible = crown - HEAD_TOP_MARGIN * slotH;
  const chinVisible = chin + CHIN_BOTTOM_MARGIN * slotH - slotH;
  const offset =
    chinVisible <= crownVisible
      ? Math.min(Math.max(preferred, chinVisible), crownVisible)
      : chinVisible;

  return Math.min(1, Math.max(0, offset / overflow));
}

/** A band of the SOURCE frame, as fractions of source height. */
export interface SourceBand {
  y: number;
  h: number;
}

/**
 * Nudge a crop so its window never cuts through burned-in text.
 *
 * A slot shorter than the source shows a window of it, and nothing stopped
 * that window's edge landing halfway through the source's own title — which
 * is exactly what happened on a real reel: the title's box was sliced along
 * its top edge while ossclip printed a competing title underneath
 * (FINDINGS §36).
 *
 * Either answer is defensible, so we take whichever moves the framing least:
 * EXCLUDE the band (start the window below it, ossclip owns the messaging) or
 * INCLUDE it whole (the source's title reads as intended). When neither fits —
 * the band is taller than the window, or the shift would run off the source —
 * the original position stands: a decapitated speaker is worse than a clipped
 * title, and §13 already decided that trade.
 */
export function avoidSlicingText(
  posY: number,
  rect: Rect,
  face: FaceCrop,
  bands: readonly SourceBand[],
): number {
  if (bands.length === 0) return posY;
  const slotH = rect.h * FRAME_H;
  const displayedH = displayedHeight(rect, face);
  const overflow = displayedH - slotH;
  if (overflow <= 1) return posY; // whole source visible — nothing to slice

  const winH = slotH / displayedH; // window height, as a fraction of the source
  const travel = 1 - winH; // how far the window's top may move
  if (travel <= 0) return posY;

  let top = posY * travel;
  // Resolve the worst offender first, then re-check: moving the window can
  // slide a different band across an edge.
  for (let pass = 0; pass < bands.length + 1; pass++) {
    const sliced = bands.find((b) => {
      const bTop = b.y;
      const bBot = b.y + b.h;
      const bottom = top + winH;
      const cutsTop = bTop < top && top < bBot;
      const cutsBottom = bTop < bottom && bottom < bBot;
      return cutsTop || cutsBottom;
    });
    if (!sliced) break;

    const candidates: number[] = [];
    const exclude = sliced.y + sliced.h; // window starts below the band
    if (exclude <= travel) candidates.push(exclude);
    const excludeAbove = sliced.y - winH; // window ends above the band
    if (excludeAbove >= 0) candidates.push(excludeAbove);
    if (sliced.h <= winH) {
      // Include it whole: the window's top must sit in this interval.
      const lo = Math.max(0, sliced.y + sliced.h - winH);
      const hi = Math.min(travel, sliced.y);
      if (lo <= hi) candidates.push(Math.min(Math.max(top, lo), hi));
    }
    // A title is never worth a mouth. §13 settled that trade; this must not
    // quietly re-open it, so any shift that pushes the chin out of the window
    // is discarded even though it would resolve the slice.
    const size = face.sizeFrac ?? DEFAULT_FACE.sizeFrac;
    const chin = face.centerYFrac + size / 2;
    const viable = candidates.filter((c) => c + winH >= chin);
    if (viable.length === 0) return posY;
    top = viable.reduce((best, c) => (Math.abs(c - top) < Math.abs(best - top) ? c : best));
  }
  return Math.min(1, Math.max(0, top / travel));
}

/**
 * Horizontal object-position: keep the speaker in frame when the source is
 * wider than the slot.
 *
 * A 9:16 take never triggers this — its width matches the slot's and the
 * overflow is vertical. A 16:9 webcam or screen recording in a vertical slot
 * loses about 70% of its width, and centring that blindly crops out a speaker
 * who was sitting to one side. Unmeasured X falls back to centre, which is
 * exactly the old behaviour.
 */
export function objectPosXFor(rect: Rect, face: FaceCrop): number {
  const slotW = rect.w * FRAME_W;
  const slotH = rect.h * FRAME_H;
  const displayedW = Math.max(slotW, slotH * (face.sourceAspect ?? FRAME_ASPECT));
  const overflow = displayedW - slotW;
  if (overflow <= 1 || face.centerXFrac === undefined) return 0.5;
  // Centre the face in the slot, then clamp to what the source actually has.
  const offset = face.centerXFrac * displayedW - slotW / 2;
  return Math.min(1, Math.max(0, offset / overflow));
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

/**
 * Cover-image safe area (FINDINGS §31) — a DIFFERENT constraint from
 * `SAFE_AREA`, and both apply to cover text.
 *
 * `SAFE_AREA` keeps text clear of the player's chrome. This keeps it inside
 * what the Instagram profile GRID will still show: the grid crops a cover to
 * a centre square, so a 1080×1920 cover keeps only y ∈ [420, 1500] — the
 * middle 56% of its height. Text outside that is simply gone from the grid,
 * which is the one place a cover is meant to work.
 */

export const COVER_GRID_SAFE = { top: 0.24, bottom: 0.24, left: 0.06, right: 0.06 };

/** The rect the grid crop leaves visible. */
export const COVER_GRID_RECT: Rect = {
  x: COVER_GRID_SAFE.left,
  y: COVER_GRID_SAFE.top,
  w: 1 - COVER_GRID_SAFE.left - COVER_GRID_SAFE.right,
  h: 1 - COVER_GRID_SAFE.top - COVER_GRID_SAFE.bottom,
};

/** The rect everything textual must live in. */
export const SAFE_RECT: Rect = {
  x: SAFE_AREA.left,
  y: SAFE_AREA.top,
  w: 1 - SAFE_AREA.left - SAFE_AREA.right,
  h: 1 - SAFE_AREA.top - SAFE_AREA.bottom,
};

/** Floors for a hand-set graphic box — match `SceneOverrideSchema.graphicRect`. */
const GRAPHIC_RECT_MIN_W = 0.08;
const GRAPHIC_RECT_MIN_H = 0.05;

/**
 * Clamp a hand-set graphic rect into `SAFE_RECT` with the minimum size
 * enforced (PLAN 2026-07-31 Task 2). Used in BOTH places: the editor while a
 * handle drag previews, and `SceneLayer` defensively at draw time — so a
 * hand-edited `overrides.json` can't push a graphic under the platform
 * chrome. Same invariant `stage.test.ts` pins for every layout's own slot.
 */
export function clampGraphicRect(rect: Rect): Rect {
  // Epsilon-tolerant: SAFE_RECT's bounds are float sums (1 - 0.04 - 0.16 =
  // 0.79999…), and a layout slot that is EXACTLY 0.8 wide must clamp to
  // itself, not to the representation noise.
  const EPS = 1e-9;
  const clamp = (v: number, lo: number, hi: number): number =>
    v < lo - EPS ? lo : v > hi + EPS ? hi : v;
  const w = clamp(rect.w, GRAPHIC_RECT_MIN_W, SAFE_RECT.w);
  const h = clamp(rect.h, GRAPHIC_RECT_MIN_H, SAFE_RECT.h);
  const x = clamp(rect.x, SAFE_RECT.x, SAFE_RECT.x + SAFE_RECT.w - w);
  const y = clamp(rect.y, SAFE_RECT.y, SAFE_RECT.y + SAFE_RECT.h - h);
  return { x, y, w, h };
}

/**
 * Where cover TEXT may actually go: the intersection of the two constraints.
 *
 * Neither rect contains the other — the grid crop is tighter top and bottom,
 * while the player's action rail eats the right side that a grid tile does
 * not have. A cover is seen in both places, so text has to satisfy both.
 */
export const COVER_TEXT_RECT: Rect = (() => {
  const x = Math.max(COVER_GRID_RECT.x, SAFE_RECT.x);
  const y = Math.max(COVER_GRID_RECT.y, SAFE_RECT.y);
  const right = Math.min(COVER_GRID_RECT.x + COVER_GRID_RECT.w, SAFE_RECT.x + SAFE_RECT.w);
  const bottom = Math.min(COVER_GRID_RECT.y + COVER_GRID_RECT.h, SAFE_RECT.y + SAFE_RECT.h);
  return { x, y, w: right - x, h: bottom - y };
})();

/** Approximate half-height of a caption line block, for free-band math/tests. */
export const CAPTION_HALF_BAND = 0.045;

/** A vertical interval in frame fractions. */
export interface Band {
  start: number;
  end: number;
}

/**
 * The vertical gaps `blocked` leaves inside `[start, end]`, tallest first.
 *
 * One implementation for every "put this somewhere nothing else is" problem
 * on the stage — routing a graphic around the source's burned-in text (§26),
 * and placing the cover banner clear of the face (§33). They are the same
 * question about different occupants, and were worth solving once.
 */
export function freeBands(
  range: Band,
  blocked: ReadonlyArray<{ y: number; h: number }>,
): Band[] {
  const clipped = blocked
    .map((r) => ({ start: Math.max(range.start, r.y), end: Math.min(range.end, r.y + r.h) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const free: Band[] = [];
  let cursor = range.start;
  for (const b of clipped) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < range.end) free.push({ start: cursor, end: range.end });
  return free.sort((a, b) => b.end - b.start - (a.end - a.start));
}

/**
 * How far a head extends BELOW the detector's box. Smaller than
 * `HEAD_ABOVE_FACE` because pico's box already includes the mouth — what sits
 * under it is a chin and some neck, not a whole skull.
 */
const HEAD_BELOW_FACE = 0.2;

/**
 * The head's extent from a face box, in frame fractions — the §19 expansion,
 * reused. pico bounds the FACE, so anything routing around a head has to grow
 * the box or it lands on hair.
 */
export function headBand(face: { centerYFrac: number; sizeFrac: number }): Band {
  return {
    start: face.centerYFrac - face.sizeFrac * (0.5 + HEAD_ABOVE_FACE),
    end: face.centerYFrac + face.sizeFrac * (0.5 + HEAD_BELOW_FACE),
  };
}

/** Below this a banner band is too short to hold a headline at cover sizes. */
const MIN_COVER_BAND_H = 0.13;

/**
 * Where the cover banner goes: inside `COVER_TEXT_RECT`, clear of the face
 * (FINDINGS §33).
 *
 * The reference covers all put the banner in the frame's dead space, never
 * across the speaker — a face with a box over its mouth reads as a mistake.
 * When the face leaves no band tall enough (a tight close-up fills the whole
 * grid-safe strip), the full rect comes back: a banner over the face still
 * beats a cover with no headline, and the caller logs that it happened.
 */
export function coverTextRect(face?: { centerYFrac: number; sizeFrac: number } | null): Rect {
  if (!face) return COVER_TEXT_RECT;
  const range = { start: COVER_TEXT_RECT.y, end: COVER_TEXT_RECT.y + COVER_TEXT_RECT.h };
  const head = headBand(face);
  const [tallest] = freeBands(range, [{ y: head.start, h: head.end - head.start }]);
  if (!tallest || tallest.end - tallest.start < MIN_COVER_BAND_H) return COVER_TEXT_RECT;
  return { ...COVER_TEXT_RECT, y: tallest.start, h: tallest.end - tallest.start };
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

/**
 * The stage's slot arrangement per layout (PHASE1 §1 table, safe-area'd per
 * FINDINGS §6). Caption anchors sit in the free band each layout reserves:
 *   full-bleed     → lower third, below the face, above the bottom inset
 *   video-top      → the gap between the video block and the graphic
 *   pip-bubble     → between the graphic and the bubble
 *   graphic-only   → below the graphic (the layout reserves the band)
 *   blurred-behind → below the centred graphic (face is blurred — no clash)
 */
export function layoutSlots(
  layout: Layout,
  face: FaceCrop = DEFAULT_FACE,
  /** Burned-in text bands visible right now — the crop must not slice them. */
  textBands: readonly SourceBand[] = [],
): StageSlots {
  const posY = (rect: Rect) => avoidSlicingText(objectPosYFor(rect, face), rect, face, textBands);
  const posX = (rect: Rect) => objectPosXFor(rect, face);
  switch (layout) {
    case "full-bleed":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1, objectPosY: posY(FULL), objectPosX: posX(FULL) },
        graphic: null,
        captionAnchor: 0.7,
      };
    case "video-top": {
      const rect: Rect = { x: 0, y: 0, w: 1, h: 0.42 };
      return {
        video: { rect, cornerRadius: 0, blurPx: 0, dim: 0, opacity: 1, objectPosY: posY(rect), objectPosX: posX(rect) },
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
          objectPosY: posY(PIP_RECT), objectPosX: posX(PIP_RECT),
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
          objectPosY: posY(PIP_RECT), objectPosX: posX(PIP_RECT),
        },
        graphic: { x: 0.04, y: 0.14, w: 0.8, h: 0.54 },
        captionAnchor: 0.73,
      };
    case "blurred-behind":
      return {
        video: { rect: FULL, cornerRadius: 0, blurPx: 22, dim: 0.55, opacity: 1, objectPosY: posY(FULL), objectPosX: posX(FULL) },
        graphic: { x: 0.07, y: 0.24, w: 0.77, h: 0.36 },
        captionAnchor: 0.69,
      };
  }
}

/**
 * Where a graphic floats when its cue's layout defines no slot (R13).
 *
 * `full-bleed` was designed as "talking head only" and returns `graphic:
 * null` — which made it the one layout that silently DELETED the graphic
 * when the user switched to it, selection box and all. Layout and component
 * are independent axes: layout decides where the VIDEO sits, and a cue that
 * has a graphic always renders it. The band is blurred-behind's geometry —
 * the placement most graphics already ship on — over the full-frame video,
 * minus the blur. Deliberately NOT added to `layoutSlots` itself: the slot
 * table is shared stage geometry (caption avoidance, routing candidates),
 * and a phantom full-bleed slot there would make captions steer around a
 * band that is empty on every plain cue.
 */
export const FULL_BLEED_GRAPHIC_SLOT: Rect = { x: 0.07, y: 0.24, w: 0.77, h: 0.36 };

/**
 * The slot a cue's graphic actually renders in — never null. Precedence: the
 * cue's own rect (routed by source-text avoidance or hand-set in the editor,
 * clamped so a hand-edited overrides.json can't push a graphic under the
 * platform chrome), then the layout's slot, then the full-bleed fallback.
 * One resolver for the renderer and the Inspector, so the box the panel
 * edits is byte-for-byte the box the stage draws.
 */
export function graphicSlotFor(cue: {
  layout: Layout;
  graphicRect?: Rect | null;
}): Rect {
  if (cue.graphicRect) return clampGraphicRect(cue.graphicRect);
  return layoutSlots(cue.layout).graphic ?? FULL_BLEED_GRAPHIC_SLOT;
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
    objectPosX: lerp(a.objectPosX, b.objectPosX, p),
  };
}

function easeInOut(p: number): number {
  return p * p * (3 - 2 * p);
}

/**
 * A full-bleed plain cue IS the base stage state — it exists so the timeline
 * shows a block and framing overrides have an id to land on, not to change
 * what renders. It must therefore be INVISIBLE to the morph machinery: a
 * plain cue butts flush against its graphic neighbour (no assembler gap), so
 * the ±1e-3 neighbour probes would see it where today they see a gap, and the
 * slot would complete its end-of-scene morph to base and then snap back to
 * the graphic layout to morph a second time. Filtering keeps graphic↔plain
 * transitions byte-identical to today's cue↔gap. A plain cue whose LAYOUT the
 * user overrode away from full-bleed stays morphable — that's a real staging
 * decision, not filler.
 */
function morphCues(cues: readonly SceneCue[]): readonly SceneCue[] {
  return cues.filter((c) => !(c.kind === "plain" && c.layout === "full-bleed"));
}

/**
 * The video slot's state at output time t, easing between layouts around cue
 * boundaries. The morph runs INSIDE the cue's own window (start → start+T,
 * end-T → end) so neighbouring cues never fight over the slot.
 */
export function videoSlotAt(
  allCues: readonly SceneCue[],
  tSec: number,
  face: FaceCrop = DEFAULT_FACE,
  /** Text regions in OUTPUT time; only those on screen now constrain the crop. */
  textRegions: readonly (SourceBand & { startSec: number; endSec: number })[] = [],
): VideoSlotState {
  const cues = morphCues(allCues);
  const bands = textRegions.filter((r) => tSec >= r.startSec && tSec < r.endSec);
  const base = layoutSlots("full-bleed", face, bands).video;
  const cue = activeCueAt(cues, tSec);
  if (!cue) return base;
  const target = layoutSlots(cue.layout, face, bands).video;
  const T = Math.min(LAYOUT_TRANSITION_SEC, (cue.endSec - cue.startSec) / 2);
  const sinceStart = tSec - cue.startSec;
  const untilEnd = cue.endSec - tSec;

  const prev = activeCueAt(cues, cue.startSec - 1e-3);
  const next = activeCueAt(cues, cue.endSec + 1e-3);
  const from = prev ? layoutSlots(prev.layout, face, bands).video : base;
  const to = next ? layoutSlots(next.layout, face, bands).video : base;

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
export function backdropOpacityAt(allCues: readonly SceneCue[], tSec: number): number {
  const cues = morphCues(allCues);
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
