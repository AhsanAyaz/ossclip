import { contentRectAt, type ContentRect, type ContentRectSegment } from "@ossclip/core/browser";

/**
 * Rendering a source whose framing changes mid-take (PLAN Task C).
 *
 * A uniformly letterboxed source is cropped once, by ffmpeg, into the
 * mezzanine — the bars stop existing before any React sees them (Task 7). That
 * is impossible when the framing changes: there is no single crop, and the
 * letterboxed stretches of the author's clip hold a LANDSCAPE picture, which no
 * amount of ffmpeg cropping turns into a portrait frame. Those stretches have
 * to be cover-cropped, with the face bias, exactly as a landscape source
 * already is — which is work the stage does per frame anyway.
 *
 * So the crop moves to render time. This module answers one question: how must
 * the FULL source frame be sized and offset so that a sub-rect of it covers the
 * slot? The video element then fills the returned box, whose aspect ratio is
 * the source's own, so `cover` and `fill` agree and nothing is distorted.
 *
 * With a full-frame rect this reduces exactly to plain `object-fit: cover` —
 * one code path, so the common case cannot drift from the mixed one.
 */

export interface CoverBox {
  /** CSS px for the FULL source frame, of which only the rect is visible. */
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Size and offset the full source frame so `rect` covers `slot`.
 *
 * `posX`/`posY` are the same 0..1 crop bias `object-position` takes — 0.5 is
 * centred, and the stage derives them from the measured face — applied to the
 * OVERFLOW, which is what makes this behave like `object-position` rather than
 * an unrelated second positioning system.
 */
export function contentCoverBox(
  source: { width: number; height: number },
  rect: { x: number; y: number; w: number; h: number },
  slot: { width: number; height: number },
  posX = 0.5,
  posY = 0.5,
): CoverBox {
  const sw = Math.max(1, source.width);
  const sh = Math.max(1, source.height);
  const cw = Math.max(1, rect.w);
  const ch = Math.max(1, rect.h);

  // Cover the slot with the CONTENT rect, not the frame.
  const k = Math.max(slot.width / cw, slot.height / ch);

  // Park the rect's top-left at the slot's origin, then spend the overflow
  // according to the bias.
  const left = -rect.x * k + (slot.width - cw * k) * clamp01(posX);
  const top = -rect.y * k + (slot.height - ch * k) * clamp01(posY);

  return { width: sw * k, height: sh * k, left, top };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

/** A kept span, as the TimeMap emits it — output and source in one record. */
export interface SpanLike {
  outIn: number;
  outOut: number;
  srcIn: number;
  srcOut: number;
}

/**
 * SOURCE time for an OUTPUT time, through the kept spans.
 *
 * The content timeline is measured on the source, but everything at render time
 * runs in output time, and with cuts the two are not the same clock. Times
 * between spans (inside a removed gap, which the output never shows) resolve to
 * the nearest span edge rather than to nothing.
 */
export function sourceTimeAt(spans: readonly SpanLike[], outSec: number): number {
  if (spans.length === 0) return outSec;
  for (const sp of spans) {
    if (outSec >= sp.outIn && outSec < sp.outOut) return sp.srcIn + (outSec - sp.outIn);
  }
  const first = spans[0]!;
  if (outSec < first.outIn) return first.srcIn;
  const last = spans[spans.length - 1]!;
  return last.srcOut;
}

/** The content rect to render at an OUTPUT time. */
export function contentRectAtOutput(
  timeline: readonly ContentRectSegment[],
  spans: readonly SpanLike[],
  outSec: number,
  source: { width: number; height: number },
): ContentRect {
  if (timeline.length === 0) {
    return { x: 0, y: 0, w: source.width, h: source.height, full: true };
  }
  return contentRectAt(timeline, sourceTimeAt(spans, outSec), source);
}
