import type { SceneCue } from "@ossclip/core/browser";

/** Same floor assembly uses, so a hand nudge cannot make an unrenderable cue. */
const MIN_SCENE_SEC = 1.2;
const GAP = 0.05;

export function clampTiming(
  cues: readonly SceneCue[],
  sceneId: string,
  startSec: number,
  endSec: number,
  duration: number,
): { startSec: number; endSec: number } {
  const i = cues.findIndex((c) => c.id === sceneId);
  const prev = i > 0 ? cues[i - 1] : undefined;
  const next = i >= 0 && i < cues.length - 1 ? cues[i + 1] : undefined;
  const lo = prev ? prev.endSec + GAP : 0;
  const hi = next ? next.startSec - GAP : duration;
  let s = Math.min(Math.max(startSec, lo), Math.max(lo, hi - MIN_SCENE_SEC));
  let e = Math.max(Math.min(endSec, hi), s + MIN_SCENE_SEC);
  if (e > hi) { e = hi; s = Math.max(lo, e - MIN_SCENE_SEC); }
  return { startSec: s, endSec: e };
}
