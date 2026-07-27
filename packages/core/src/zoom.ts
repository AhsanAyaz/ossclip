/**
 * Idle camera movement (FINDINGS §15): the cut-driven punch-in only fires at
 * cuts, so a clean take sits visually static for 8–12 s at a time. This is the
 * independent driver.
 *
 * ## Why this was rewritten (2026-07-28)
 *
 * The first version reversed direction at every speech-phrase boundary, on the
 * theory that a phrase break is a natural place for the camera to turn around.
 * On the author's own 64s take that found 24 boundaries and duly produced 24
 * reversals, and the verdict was immediate: "the weird constant zooming in and
 * zooming out". Reversing at a boundary is defensible ONCE; doing it every two
 * seconds for a minute reads as a wobble, not as camera work. The bug was the
 * contract, not the boundary detection — so the boundary machinery is gone
 * rather than tuned.
 *
 * ## What it does now
 *
 * Within one cut-free CLIP the zoom moves in exactly one direction: a cosine
 * ease from 1 to `maxScale` over `rampSec`, then a HOLD at `maxScale` for the
 * rest of the clip. A cut resets it to 1, which is the one place a step is
 * already justified — `EdlVideo`'s punch-in steps there too, and the frame
 * changes anyway.
 *
 * Holding after the ramp is what keeps the move readable. Stretching 1 → 1.08
 * across a 64s take is ~0.12%/s, which is indistinguishable from no motion; a
 * bounded ramp followed by a hold is a slow push that arrives somewhere and
 * stays — the author's "zoomed-out to zoomed-in, then keep that perspective
 * consistent", composed from their own two options.
 *
 * A clip shorter than `rampSec` gets a PARTIAL push at the same rate rather
 * than a compressed full one, so a 2s clip and a 20s clip move at the same
 * speed. Making short clips complete the push would make them zoom visibly
 * faster, which is the oscillation problem in a new costume.
 *
 * `maxScale: 1` disables the driver outright (the author's "no zoom" option)
 * without needing a separate flag.
 */

export interface ZoomSegment {
  startSec: number;
  endSec: number;
  from: number;
  to: number;
}

export interface ZoomPlan {
  segments: ZoomSegment[];
  /** How many cut-free clips the plan covers — logged, never inferred. */
  clips: number;
  /** The ramp actually used, so the log can't drift from the behaviour. */
  rampSec: number;
}

export interface ZoomPlanOptions {
  /** Zoomed-in extreme; the other extreme is 1. `1` disables the zoom. */
  maxScale?: number;
  /**
   * Clip starts in OUTPUT time — the kept spans' `outIn`, i.e. every point the
   * source jumps. A missing or empty list means the take is one clip, which is
   * the correct reading of a cutlist that removed nothing.
   */
  clipStarts?: readonly number[];
  /** Seconds the push takes to arrive before it holds. */
  rampSec?: number;
}

/** Zoom amplitude, exported so the stage can budget crop margins against it. */
export const ZOOM_MAX_SCALE = 1.08;

/**
 * How long the push takes. Long enough that the movement is never noticed as
 * movement, short enough that it has arrived while the viewer is still on the
 * hook — and, deliberately, far shorter than a typical clip so most of a clip
 * is the settled perspective rather than a drift.
 */
export const ZOOM_RAMP_SEC = 8;

/** Clip starts, cleaned: in range, unique, sorted, and always including 0. */
function clipBoundaries(starts: readonly number[] | undefined, duration: number): number[] {
  const seen = new Set<number>([0]);
  for (const t of starts ?? []) {
    if (Number.isFinite(t) && t > 0 && t < duration) seen.add(t);
  }
  return [...seen].sort((a, b) => a - b);
}

export function buildZoomPlan(
  outputDurationSec: number,
  opts: ZoomPlanOptions = {},
): ZoomPlan {
  const maxScale = opts.maxScale ?? ZOOM_MAX_SCALE;
  const rampSec = opts.rampSec ?? ZOOM_RAMP_SEC;
  if (outputDurationSec <= 0) return { segments: [], clips: 0, rampSec };

  const starts = clipBoundaries(opts.clipStarts, outputDurationSec);
  const segments: ZoomSegment[] = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : outputDurationSec;
    const length = end - start;
    if (length <= 1e-9) continue;

    const rampEnd = Math.min(start + rampSec, end);
    // Same rate for every clip: a short clip stops partway up rather than
    // racing to the top.
    const reached = 1 + (maxScale - 1) * Math.min(1, (rampEnd - start) / Math.max(rampSec, 1e-9));

    segments.push({ startSec: start, endSec: rampEnd, from: 1, to: reached });
    if (end - rampEnd > 1e-9) {
      segments.push({ startSec: rampEnd, endSec: end, from: reached, to: reached });
    }
  }

  return { segments, clips: starts.length, rampSec };
}

/**
 * Scale at output time t — cosine-eased across each segment (never linear), so
 * the push starts and settles gently. 1 outside the plan.
 *
 * A hold segment has `from === to`, which the same easing renders as a
 * constant; no special case is needed and none should be added, because the
 * ramp/hold boundary must not be a place where two code paths could disagree.
 *
 * Segments are matched HALF-OPEN, `[start, end)`. Under the old oscillating
 * contract this was academic — neighbouring segments shared a value at every
 * boundary — but a cut is a boundary where they deliberately disagree: the
 * previous clip holds at `maxScale` and the next starts at 1. Closed matching
 * let the earlier segment win, so the first frame of a new clip rendered the
 * PREVIOUS clip's zoom and the reset appeared one frame late. The final instant
 * of the plan has no following segment and so is served by the last one.
 */
export function zoomScaleAt(plan: readonly ZoomSegment[], tSec: number): number {
  for (const seg of plan) {
    if (tSec >= seg.startSec && tSec < seg.endSec) {
      const span = seg.endSec - seg.startSec;
      const p = span > 0 ? (tSec - seg.startSec) / span : 1;
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * p);
      return seg.from + (seg.to - seg.from) * eased;
    }
  }
  const last = plan[plan.length - 1];
  if (last && tSec === last.endSec) return last.to;
  return 1;
}
