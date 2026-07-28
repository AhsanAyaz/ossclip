import type { SceneCue } from "@ossclip/core/browser";

/** Same floor assembly uses, so a hand nudge cannot make an unrenderable cue. */
const MIN_SCENE_SEC = 1.2;
const GAP = 0.05;

/**
 * Map a pointer x-position on the track to a seek time, clamped to the clip.
 * One mapping for every seek gesture — a bare-track press, a scrub move, and
 * a click inside a scene block (PLAN Tasks 3+4) — so they cannot drift apart.
 */
export function timeAtX(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  durationSec: number,
): number {
  if (trackWidth <= 0 || durationSec <= 0) return 0;
  const frac = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  return frac * durationSec;
}

/**
 * Timing clamps only against GRAPHIC neighbours. The plain takes that fill
 * the gaps (Task A) are derived filler: they butt flush against every
 * graphic block and RE-DERIVE around wherever it lands, so clamping against
 * them would pin every scene exactly where it already is — no drag could
 * ever move.
 */
const stored = (cues: readonly SceneCue[]): SceneCue[] =>
  cues.filter((c) => c.kind !== "plain");

/**
 * Shift a cue in time WITHOUT changing its duration (PLAN Task 6) — the
 * body-drag gesture. Distinct from `clampTiming`, which clamps each edge
 * independently and therefore changes duration: moving must slide the whole
 * block until it rests against a neighbour (or the clip bounds) and stop,
 * never squash it.
 */
export function moveTiming(
  allCues: readonly SceneCue[],
  sceneId: string,
  deltaSec: number,
  duration: number,
): { startSec: number; endSec: number } | null {
  const cues = stored(allCues);
  const i = cues.findIndex((c) => c.id === sceneId);
  const cue = cues[i];
  if (!cue) return null;
  const len = cue.endSec - cue.startSec;
  const prev = i > 0 ? cues[i - 1] : undefined;
  const next = i < cues.length - 1 ? cues[i + 1] : undefined;
  const lo = prev ? prev.endSec + GAP : 0;
  const hi = next ? next.startSec - GAP : duration;
  const start = Math.min(Math.max(cue.startSec + deltaSec, lo), Math.max(lo, hi - len));
  return { startSec: start, endSec: start + len };
}

export function clampTiming(
  allCues: readonly SceneCue[],
  sceneId: string,
  startSec: number,
  endSec: number,
  duration: number,
): { startSec: number; endSec: number } {
  const cues = stored(allCues);
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
