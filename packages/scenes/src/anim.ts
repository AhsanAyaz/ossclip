import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CSSProperties } from "react";

/**
 * Entrance progress 0→1, scene-local (components are mounted inside a
 * <Sequence> per cue, so frame 0 === the cue's start). Stagger children by
 * passing increasing delays (~4-6 frames, PHASE1 §3).
 */
export function useEnter(delayFrames = 0): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: frame - delayFrames,
    fps,
    config: { damping: 200, stiffness: 130 },
    durationInFrames: Math.round(fps * 0.5),
  });
}

export function rise(progress: number, px = 26): CSSProperties {
  return { opacity: progress, transform: `translateY(${(1 - progress) * px}px)` };
}

export function pop(progress: number): CSSProperties {
  return { opacity: progress, transform: `scale(${0.9 + 0.1 * progress})` };
}
