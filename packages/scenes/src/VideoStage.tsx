import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { SceneCue, Theme } from "@ossclip/core/browser";
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
  children: React.ReactNode;
}> = ({ cues, theme, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const slot = videoSlotAt(cues, t);
  const backdrop = backdropOpacityAt(cues, t);

  const wPx = slot.rect.w * width;
  const hPx = slot.rect.h * height;
  const radiusPx = (slot.cornerRadius * Math.min(wPx, hPx)) / 2;

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
        <div style={{ position: "absolute", inset: 0, filter: slot.blurPx > 0.5 ? `blur(${slot.blurPx}px)` : undefined }}>
          {children}
        </div>
        <div style={{ position: "absolute", inset: 0, background: "black", opacity: slot.dim }} />
      </div>
    </AbsoluteFill>
  );
};
