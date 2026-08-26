import type { KeptSpan, SceneCue, SceneTiming } from "@ossclip/core/browser";

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

/** Timeline zoom bounds (R14 §53). 1 = the whole clip fits the viewport. */
export const TIMELINE_ZOOM_MAX = 16;

export const clampZoom = (z: number): number =>
  Math.min(TIMELINE_ZOOM_MAX, Math.max(1, z));

/**
 * The scrollLeft that keeps the content under `anchorX` stationary through a
 * zoom change — the gesture every editor's timeline zoom is judged by: the
 * moment under the cursor (or the viewport centre) must not slide away when
 * the scale changes. Pure so the anchoring math is testable without a DOM.
 *
 * `anchorX` is viewport-relative (clientX minus the scroller's left edge);
 * the result is clamped to the scrollable range at the NEW zoom.
 */
export function zoomedScrollLeft(
  prevZoom: number,
  nextZoom: number,
  viewportWidth: number,
  scrollLeft: number,
  anchorX: number,
): number {
  if (prevZoom <= 0 || viewportWidth <= 0) return 0;
  const content = scrollLeft + anchorX;
  const scaled = content * (nextZoom / prevZoom);
  const max = Math.max(0, nextZoom * viewportWidth - viewportWidth);
  return Math.min(max, Math.max(0, scaled - anchorX));
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

/** Source seconds are persisted, so they are rounded to ms at the gesture —
 * `Inspector`'s `cuts[].src` write uses the same quantum for the same
 * reason: float noise from the clock arithmetic is not user intent. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The `timing` entry a completed drag stores (source-anchoring audit,
 * 2026-08-26). `startSec`/`endSec` are the PREVIEW's numbers, which speak
 * whatever clock the timeline is currently drawing — under a live cleanup
 * veto that is the re-cut LIVE clock, not the last render's, and storing
 * them raw is what landed a dragged block seconds from where it was dropped
 * (`SceneTimingSchema` owns the full argument).
 *
 * With a mapper in hand the window is converted to SOURCE seconds and the
 * pin becomes recut-immune. Without one — no spans at all, a degenerate
 * clock — it falls back to today's legacy write verbatim: an old-clock pin
 * is worse than a source-anchored one but far better than a fabricated
 * source second, and `remapOverridesThroughRecut` still looks after it.
 *
 * Pure (and exported) so the clock decision is testable without a DOM.
 */
export function pinTiming(
  startSec: number,
  endSec: number,
  toSourceSec: ((sec: number) => number) | null | undefined,
): SceneTiming {
  if (!toSourceSec) return { startSec, endSec };
  const srcStart = round3(toSourceSec(startSec));
  const srcEnd = round3(toSourceSec(endSec));
  // An ordered pair is the src arm's schema refinement: a clock that answered
  // the same source second for both edges (a window entirely inside removed
  // material, or a rounding tie on a sub-millisecond block) would write a doc
  // that no longer parses. Legacy is the honest fallback there too.
  if (!(srcEnd > srcStart)) return { startSec, endSec };
  return { srcStart, srcEnd };
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

/**
 * Candidate landing spots for a drag on `sceneId` (precision-editing design,
 * "Timeline snapping"): every OTHER stored cue's edges — `stored()` above,
 * because plain takes re-derive around wherever the graphic lands and are
 * never something to snap TO, same reasoning `moveTiming`/`clampTiming`
 * already lean on — plus the playhead and the clip's own bounds. The
 * dragged scene's own edges are excluded; a scene cannot snap to itself.
 * Sorted ascending and deduplicated within 1e-6 so a playhead or bound that
 * happens to coincide with a cue edge doesn't hand the caller two
 * near-identical targets whose tie-break order depends on float noise.
 */
export function snapTargets(
  cues: readonly SceneCue[],
  sceneId: string,
  playheadSec: number,
  durationSec: number,
): number[] {
  const raw = [0, durationSec, playheadSec];
  for (const c of stored(cues)) {
    if (c.id === sceneId) continue;
    raw.push(c.startSec, c.endSec);
  }
  raw.sort((a, b) => a - b);
  const out: number[] = [];
  let last: number | undefined;
  for (const t of raw) {
    if (last === undefined || t - last > 1e-6) {
      out.push(t);
      last = t;
    }
  }
  return out;
}

/**
 * Snap `sec` to whichever target is nearest, within `thresholdSec`; the
 * caller converts the 8px screen threshold into seconds at the current zoom
 * (zoom lives at the call site, not here). On an exact tie between two
 * targets equidistant from `sec`, the EARLIER one wins — arbitrary, but a
 * fixed rule beats letting the outcome depend on which of two equal
 * floating-point distances a scan happens to visit first. No targets, or a
 * threshold that isn't positive, is "snapping is off": pass `sec` through
 * unchanged rather than special-casing the caller.
 *
 * (corrected) With `targets` sorted ascending — every call site here passes
 * `snapTargets`'s own output — the tie clause below is dead code: the
 * earlier candidate is scanned first and already wins outright on the
 * strict `dist < bestDist`, so the tie branch never gets a chance to fire.
 * It stays because `applySnap` is exported and a future unsorted external
 * caller would need it.
 */
export function applySnap(
  sec: number,
  targets: readonly number[],
  thresholdSec: number,
): { sec: number; snapped: number | null } {
  if (thresholdSec <= 0 || targets.length === 0) return { sec, snapped: null };
  let best: number | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const dist = Math.abs(sec - t);
    if (dist < bestDist || (dist === bestDist && best !== null && t < best)) {
      best = t;
      bestDist = dist;
    }
  }
  if (best === null || bestDist > thresholdSec) return { sec, snapped: null };
  return { sec: best, snapped: best };
}

/**
 * Output position for a SOURCE instant, clamped to the nearest kept edge when
 * the instant itself was cut (PLAN 2026-08-04 Task 4c fix wave, review
 * finding 1) — used to place the seam marker for an ALREADY-APPLIED cut
 * (`doc.cuts[*].src` present) at its true position in the CURRENT output,
 * rather than at the stale `startSec`/`endSec` it was drawn against (a
 * frame that no longer exists once produce has actually removed it).
 *
 * A small, standalone reimplementation of `TimeMap.toOutputClamped`
 * (`packages/core/src/timemap.ts`) rather than a call to it: the editor only
 * ever has the PLAIN `spans` array off `render-props.json` (there is no
 * client-side `TimeMap` to construct one from — see App.tsx's DECIDE comment
 * on why building one here would be the second-EDL-in-the-browser this
 * feature is explicitly not doing). `spans` carries the same invariant a
 * `TimeMap`'s own do (sorted, non-overlapping, contiguous in output time),
 * so the identical two-pass algorithm applies unchanged: exact containment
 * first, then walk in order and land on whichever kept edge is nearest.
 */
export function sourceToOutputClamped(spans: readonly KeptSpan[], srcSec: number): number {
  if (spans.length === 0) return 0;
  for (const sp of spans) {
    if (srcSec >= sp.srcIn && srcSec <= sp.srcOut) return sp.outIn + (srcSec - sp.srcIn);
  }
  let best = 0;
  for (const sp of spans) {
    if (sp.srcOut <= srcSec) best = sp.outOut;
    else if (sp.srcIn >= srcSec) return sp.outIn;
  }
  return best;
}

/**
 * "m:ss:ff" — the OpusClip-style readout the outside-user feedback asked
 * for (precision-editing design, "The frames readout"). `ff` is
 * `Math.floor` on the sub-second remainder, NEVER `Math.round`: rounding at
 * a rate like 29.97fps can push that remainder's frame count up to `fps`
 * itself (ff === fps), which displays a frame number that doesn't exist at
 * that rate (e.g. frame 30 of a 30fps clip). Negative input has no
 * meaningful timecode, so it clamps to 0 rather than showing a sign;
 * `fps <= 0` has no frame concept at all, so it falls back to a
 * seconds-only string instead of dividing by zero.
 *
 * `ff`'s zero-pad width is the digit count of the largest legal frame index
 * (fps - 1), not a hardcoded 2: at 30fps that's "29" (2 digits, the common
 * case), but at 120fps it's "119" (3 digits) — padding everything to 2
 * would print "5" as "05" but "105" as "105", an inconsistent width within
 * one readout. `Math.ceil` covers fractional rates (29.97 -> width of 29,
 * matching the emitted frame range); `Math.max(1, …)` keeps 1fps at width 1
 * instead of collapsing to an empty pad.
 */
export function formatTimecode(sec: number, fps: number): string {
  const clamped = Math.max(0, sec);
  if (fps <= 0) return `${clamped.toFixed(1)}s`;
  const whole = Math.floor(clamped);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const ff = Math.floor((clamped - whole) * fps);
  const ffWidth = String(Math.max(1, Math.ceil(fps) - 1)).length;
  return `${m}:${String(s).padStart(2, "0")}:${String(ff).padStart(ffWidth, "0")}`;
}
