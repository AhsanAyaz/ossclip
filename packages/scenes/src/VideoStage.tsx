import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type {
  ContentRectSegment,
  FaceCrop,
  SceneCue,
  Theme,
  ZoomSegment,
} from "@ossclip/core/browser";
import { zoomScaleAt } from "@ossclip/core/browser";
import { backdropOpacityAt, videoSlotAt } from "./stage";
import { contentBox, contentRectAtOutput, type ContentCropMode, type SpanLike } from "./content-crop";

/**
 * The stage (PHASE1 §1): a solid backdrop that fades in when a scene demotes
 * the speaker, and an animated video slot (rect, circular mask, blur, dim)
 * that the EDL video renders inside. The children — <EdlVideo> — stay mounted
 * at all times, so the BASE AUDIO TRACK IS CONTINUOUS regardless of layout.
 */
export const VideoStage: React.FC<{
  cues: SceneCue[];
  theme: Theme;
  /** Measured face box; null/undefined falls back to the assumed selfie framing. */
  face?: FaceCrop | null;
  /** Micro zoom punches (FINDINGS §15), precomputed from phrase boundaries. */
  zoomPlan?: ZoomSegment[];
  /**
   * Burned-in text in the source, in OUTPUT time. The crop window is nudged so
   * it never slices one of these bands in half (FINDINGS §36).
   */
  sourceTextRegions?: Array<{ y: number; h: number; startSec: number; endSec: number }>;
  /**
   * The source's framing over SOURCE time (PLAN Task C). Present only for a
   * source whose framing CHANGES mid-take — a uniformly letterboxed one is
   * cropped by ffmpeg into the mezzanine long before this runs, and passing a
   * timeline for it would crop the same bars twice.
   */
  contentTimeline?: ContentRectSegment[];
  /** Kept spans, needed to read the timeline's SOURCE clock at an output time. */
  spans?: SpanLike[];
  /** The source's own pixel dimensions — the frame the timeline is measured in. */
  sourceSize?: { width: number; height: number };
  /**
   * How a letterboxed stretch renders: `cover` fills the slot from the strip
   * (face-biased crop), `fit` insets the strip whole — the fallback when the
   * strip is too small to cover without visible softening (option (b)).
   */
  contentCropMode?: ContentCropMode;
  children: React.ReactNode;
}> = ({
  cues,
  theme,
  face,
  zoomPlan,
  sourceTextRegions,
  contentTimeline,
  spans,
  sourceSize,
  contentCropMode = "cover",
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const slot = videoSlotAt(cues, t, face ?? undefined, sourceTextRegions ?? []);
  const backdrop = backdropOpacityAt(cues, t);

  const wPx = slot.rect.w * width;
  const hPx = slot.rect.h * height;
  const radiusPx = (slot.cornerRadius * Math.min(wPx, hPx)) / 2;

  // §15: the idle zoom fades with the slot (graphic-only suppresses it) and
  // is damped on the bubble — a zooming bubble reads as a wobble. Both fall
  // out of the already-lerped slot state, so the damping stays continuous
  // through layout transitions. It composes with EdlVideo's cut-driven
  // punch-in multiplicatively (nested transforms).
  const zoomRaw = zoomPlan && zoomPlan.length > 0 ? zoomScaleAt(zoomPlan, t) : 1;
  const zoomDamp = Math.max(0, slot.opacity * (1 - 0.6 * slot.cornerRadius));
  const zoom = 1 + (zoomRaw - 1) * zoomDamp;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: theme.bg, opacity: backdrop }} />
      <div
        style={{
          position: "absolute",
          left: `${slot.rect.x * 100}%`,
          top: `${slot.rect.y * 100}%`,
          width: wPx,
          height: hPx,
          borderRadius: radiusPx,
          overflow: "hidden",
          opacity: slot.opacity,
          // Slightly lift the bubble off the backdrop like the reference.
          boxShadow: slot.cornerRadius > 0.5 ? "0 18px 60px rgba(0,0,0,0.55)" : undefined,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            filter: slot.blurPx > 0.5 ? `blur(${slot.blurPx}px)` : undefined,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
            // Zoom toward the face, which the crop bias keeps in the upper part.
            transformOrigin: "50% 40%",
            // Crop bias consumed by EdlVideo's object-position (FINDINGS §11/§13):
            // derived from the measured face so the head lands in the band.
            ["--ossclip-obj-y" as string]: `${slot.objectPosY * 100}%`,
            // …and the horizontal one, which only leaves centre for a source
            // wider than the slot (a landscape take in a vertical frame).
            ["--ossclip-obj-x" as string]: `${slot.objectPosX * 100}%`,
          }}
        >
          <ContentCrop
            timeline={contentTimeline}
            spans={spans}
            sourceSize={sourceSize}
            mode={contentCropMode}
            tSec={t}
            slot={{ width: wPx, height: hPx }}
            posX={slot.objectPosX}
            posY={slot.objectPosY}
          >
            {children}
          </ContentCrop>
        </div>
        <div style={{ position: "absolute", inset: 0, background: "black", opacity: slot.dim }} />
      </div>
    </AbsoluteFill>
  );
};

/**
 * Crops the video to the source's ACTIVE content rect (PLAN Task C).
 *
 * A no-op — literally the same `inset: 0` box as before — unless the source's
 * framing changes mid-take AND this moment is inside a letterboxed stretch.
 * Keeping the untouched path byte-identical is deliberate: the uniform case is
 * what every existing geometry test covers, and it must not drift because the
 * mixed case needed something.
 *
 * When it does apply, the FULL frame is sized and offset so the content rect
 * covers the slot. The resulting box carries the source's own aspect ratio, so
 * the video's `object-fit: cover` has no overflow left to crop and its
 * `object-position` becomes a no-op — the bias has already been spent here.
 */
const ContentCrop: React.FC<{
  timeline?: ContentRectSegment[];
  spans?: SpanLike[];
  sourceSize?: { width: number; height: number };
  mode: ContentCropMode;
  tSec: number;
  slot: { width: number; height: number };
  posX: number;
  posY: number;
  children: React.ReactNode;
}> = ({ timeline, spans, sourceSize, mode, tSec, slot, posX, posY, children }) => {
  const passthrough = <div style={{ position: "absolute", inset: 0 }}>{children}</div>;
  if (!timeline || timeline.length < 2 || !sourceSize) return passthrough;

  const rect = contentRectAtOutput(timeline, spans ?? [], tSec, sourceSize);
  if (rect.full) return passthrough;

  const box = contentBox(mode, sourceSize, rect, slot, posX, posY);
  return (
    <div
      style={{
        position: "absolute",
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
      }}
    >
      {children}
    </div>
  );
};
