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

export function fade(progress: number): CSSProperties {
  return { opacity: progress };
}

/**
 * easeOutBack: 0→0, 1→1, overshooting ~10% past 1 on the way. A pure
 * function of the same 0→1 progress every style takes — NOT a second spring
 * — so a still at frame N renders identically every time (reveal-timing
 * spec §4: the style only says how progress is drawn, never when).
 */
function overshoot(progress: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = progress - 1;
  return 1 + c3 * t ** 3 + c1 * t ** 2;
}

export function bounce(progress: number): CSSProperties {
  return { opacity: progress, transform: `scale(${0.6 + 0.4 * overshoot(progress)})` };
}

/**
 * The author's `entrance` prop → how an item's progress is drawn (spec §4).
 * Unset is today's `pop`, so every existing scene renders unchanged.
 */
export function entranceStyle(
  style: "pop" | "fade" | "rise" | "bounce" | undefined,
  progress: number,
): CSSProperties {
  switch (style) {
    case "fade":
      return fade(progress);
    case "rise":
      return rise(progress);
    case "bounce":
      return bounce(progress);
    default:
      return pop(progress);
  }
}
