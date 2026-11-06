import type { SceneCue } from "@ossclip/core/browser";
import { frameWindow } from "./frames";
import {
  CAPTION_HALF_BAND,
  graphicSlotFor,
  layoutSlots,
  safeAreaFor,
  type FrameSize,
  type Rect,
} from "./stage";

/**
 * Where a library overlay sits (overlay-library spec §Rendering, overlay
 * look). Pure and JSX-free, `sfx-track.ts`'s posture: the placement rules are
 * the whole behaviour, and this package carries no DOM to assert them in.
 *
 * Every rect here is a fraction of the frame (stage.ts's `Rect`), so one
 * placement serves both frame shapes. `Rect` itself is stage.ts's, already
 * on the package surface — one rect type, so a graphic slot passes straight in.
 */

/** The overlay box's width: "about a third of the frame" (spec). */
export const OVERLAY_WIDTH_FRAC = 1 / 3;
/**
 * The "small gap" between the overlay and whatever it sits against — the
 * caption block's top, or a graphic's edge — as a fraction of frame height.
 * Big enough that the caption's stroke and drop shadow (which paint outside
 * its line box) do not touch the image.
 */
const OVERLAY_GAP = 0.02;
/**
 * A band shorter than this share of the desired box is "no room". Below half
 * height a logo reads as a smudge, and the next candidate (the top safe
 * area, or ignoring the graphic) is the better place for it.
 */
const MIN_BOX_SHARE = 0.5;

interface Band {
  top: number;
  bottom: number;
}

const bandH = (b: Band): number => b.bottom - b.top;

/**
 * The MAX box an overlay image may fill (ruling R2): about a third of the
 * frame wide, centred, its height capped so it stays inside `SAFE_AREA`. The
 * image is drawn inside it with `object-fit: contain`, so its aspect is
 * preserved without this function knowing the image's dimensions.
 *
 * The box is desired SQUARE in pixels — a square logo fills it, a wide one
 * fills its width, a tall one is capped by its height.
 *
 * Candidates, in order (spec: "it never overlaps the captions"; the graphic
 * may be overlapped only when nothing else fits):
 * 1. bottom edge a gap above the caption top, below any graphic in the way;
 * 2. the top safe area, above that graphic;
 * 3. above the captions, over the graphic;
 * 4. BELOW the caption block, a gap under its bottom down to the safe-area
 *    bottom (ruling R19) — a caption hand-placed high (captionY is free in
 *    0..1) leaves the room under it, and shrinking into the sliver above
 *    used to collapse the box to nothing while its pop still played (final
 *    review I3). Like 3, it may sit over a graphic. Needs `captionBottom`;
 *    absent, the block's extent is unknown and this band is not tried;
 * 5. nothing fits even that: the top safe area, shrunk to whatever space the
 *    captions leave — possibly none (`overlayFits` then says no). A caption
 *    never loses its visibility to an overlay.
 *
 * `captionTop` null = no caption on screen for the overlay's whole window;
 * it then sits where the default layout's caption WOULD be, so an overlay
 * does not jump around the frame just because a pause had no words.
 */
export function overlayRect(args: {
  frame: FrameSize;
  /** Fraction of frame height; null = no caption on screen. */
  captionTop: number | null;
  /**
   * The LOWEST caption bottom over the window (fraction of frame height).
   * null = no caption on screen (the default block's bottom is used, as for
   * `captionTop`); absent = unknown, so the below-captions band is skipped.
   */
  captionBottom?: number | null;
  /** The active scene graphic's rect, if one is on screen. */
  graphicRect?: Rect;
}): Rect {
  const { frame, graphicRect } = args;
  const safe = safeAreaFor(frame);
  const w = OVERLAY_WIDTH_FRAC;
  const x = (1 - w) / 2;
  const desiredH = (w * frame.width) / frame.height;
  const minH = desiredH * MIN_BOX_SHARE;
  const defaultAnchor = layoutSlots("full-bleed", undefined, [], frame).captionAnchor;
  const captionTop = args.captionTop ?? defaultAnchor - CAPTION_HALF_BAND;
  const captionBottom =
    args.captionBottom === undefined
      ? undefined
      : args.captionTop === null || args.captionBottom === null
        ? defaultAnchor + CAPTION_HALF_BAND
        : args.captionBottom;
  const floor = Math.min(captionTop - OVERLAY_GAP, 1 - safe.bottom);

  const bottomAnchored = (b: Band): Rect => {
    const h = Math.min(desiredH, bandH(b));
    return { x, y: b.bottom - h, w, h };
  };
  const topAnchored = (b: Band): Rect => ({ x, y: b.top, w, h: Math.min(desiredH, bandH(b)) });

  const aboveCaptions: Band = { top: safe.top, bottom: floor };
  // A graphic matters only if it actually shares the space the overlay would
  // use: horizontally across the centred box, vertically inside the band.
  const g =
    graphicRect &&
    graphicRect.x < x + w &&
    graphicRect.x + graphicRect.w > x &&
    graphicRect.y < floor &&
    graphicRect.y + graphicRect.h > safe.top
      ? graphicRect
      : undefined;

  if (g) {
    const between: Band = { top: Math.max(safe.top, g.y + g.h + OVERLAY_GAP), bottom: floor };
    if (bandH(between) >= minH) return bottomAnchored(between);
    const overGraphic: Band = { top: safe.top, bottom: Math.min(floor, g.y - OVERLAY_GAP) };
    if (bandH(overGraphic) >= minH) return topAnchored(overGraphic);
  }
  if (bandH(aboveCaptions) >= minH) return bottomAnchored(aboveCaptions);
  if (captionBottom !== undefined) {
    const belowCaptions: Band = { top: Math.max(safe.top, captionBottom + OVERLAY_GAP), bottom: 1 - safe.bottom };
    if (bandH(belowCaptions) >= minH) return topAnchored(belowCaptions);
  }
  const h = Math.max(0, bandH(aboveCaptions));
  return { x, y: Math.min(safe.top, Math.max(0, floor)), w, h };
}

/**
 * Whether an overlay box is big enough to show at all (ruling R19): the same
 * half-height floor the candidates are tried against. `overlayRect`'s last
 * resort can shrink to a sliver or to nothing, and a logo that small must
 * not be drawn — nor its pop played without a picture.
 */
export function overlayFits(box: Rect, frame: FrameSize): boolean {
  const desiredH = (OVERLAY_WIDTH_FRAC * frame.width) / frame.height;
  return box.h >= desiredH * MIN_BOX_SHARE;
}

/**
 * The image's own rect inside a max box, `object-fit: contain` done by hand
 * for the one renderer that cannot take CSS for it: `@remotion/gif` draws to
 * a canvas and centres its contain-fit vertically, which would float a wide
 * GIF off the caption-side edge `object-position: center bottom` keeps a
 * still on. `aspect` is pixel width / height.
 */
export function containedRect(
  box: Rect,
  aspect: number,
  frame: FrameSize,
  align: "bottom" | "center",
): Rect {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return box;
  const bw = box.w * frame.width;
  const bh = box.h * frame.height;
  const [pw, ph] = bw / bh > aspect ? [bh * aspect, bh] : [bw, bw / aspect];
  const w = pw / frame.width;
  const h = ph / frame.height;
  return {
    x: box.x + (box.w - w) / 2,
    y: align === "bottom" ? box.y + box.h - h : box.y + (box.h - h) / 2,
    w,
    h,
  };
}

/**
 * The card look's image box: centred, a square about 50% of the frame's
 * shorter side (spec §Rendering, card look).
 */
export function cardRect(frame: FrameSize): Rect {
  const side = 0.5 * Math.min(frame.width, frame.height);
  const w = side / frame.width;
  const h = side / frame.height;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * `tSec → the rect of the scene graphic on screen`, or undefined. The same
 * resolver SceneLayer draws through (`graphicSlotFor`), so the overlay dodges
 * the box the stage actually paints, hand moves included; plain cues carry
 * no graphic.
 */
export function graphicRectAtFor(
  cues: readonly SceneCue[],
  frame: FrameSize,
): (tSec: number) => Rect | undefined {
  return (tSec) => {
    const cue = cues.find(
      (c) =>
        c.kind !== "plain" && c.component && c.props && tSec >= c.startSec && tSec < c.endSec,
    );
    return cue ? graphicSlotFor(cue, frame) : undefined;
  };
}

/**
 * One box for a cue's WHOLE window, not one per frame: placing per frame
 * would make the overlay hop every time the caption under it changed line or
 * row count. Sampled at every frame the cue covers, it takes the HIGHEST
 * caption top and the LOWEST caption bottom seen (it must clear all of them,
 * above or below — ruling R19) and the bounding box of every graphic seen
 * (it must dodge each one).
 */
export function overlayBoxForCue(
  cue: { atSec: number; endSec: number },
  fps: number,
  frame: FrameSize,
  captionTopAt: (tSec: number) => number | null,
  graphicRectAt: (tSec: number) => Rect | undefined,
  captionBottomAt: (tSec: number) => number | null,
): Rect {
  const { from, durationInFrames } = frameWindow(cue.atSec, cue.endSec, fps);
  let captionTop: number | null = null;
  let captionBottom: number | null = null;
  let graphic: Rect | undefined;
  for (let f = from; f < from + durationInFrames; f++) {
    const t = f / fps;
    const top = captionTopAt(t);
    if (top !== null) captionTop = captionTop === null ? top : Math.min(captionTop, top);
    const bottom = captionBottomAt(t);
    if (bottom !== null) captionBottom = captionBottom === null ? bottom : Math.max(captionBottom, bottom);
    const g = graphicRectAt(t);
    if (g) {
      if (!graphic) graphic = g;
      else {
        const x = Math.min(graphic.x, g.x);
        const y = Math.min(graphic.y, g.y);
        graphic = {
          x,
          y,
          w: Math.max(graphic.x + graphic.w, g.x + g.w) - x,
          h: Math.max(graphic.y + graphic.h, g.y + g.h) - y,
        };
      }
    }
  }
  return overlayRect({ frame, captionTop, captionBottom, ...(graphic ? { graphicRect: graphic } : {}) });
}
