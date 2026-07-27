import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FaceCrop, SceneCue, Theme, ZoomSegment } from "@ossclip/core/browser";
import { zoomScaleAt } from "@ossclip/core/browser";
import { backdropOpacityAt, videoSlotAt } from "./stage";

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
  children: React.ReactNode;
}> = ({ cues, theme, face, zoomPlan, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const slot = videoSlotAt(cues, t, face ?? undefined);
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
          {children}
        </div>
        <div style={{ position: "absolute", inset: 0, background: "black", opacity: slot.dim }} />
      </div>
    </AbsoluteFill>
  );
};
