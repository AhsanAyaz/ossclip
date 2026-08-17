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
  /**
   * The allowedClips split, carried on the plan so the CLI log reports the
   * counts the plan actually acted on instead of re-deriving them (and
   * possibly disagreeing after the boundary cleaning).
   */
  zoomedClips: number;
  staticClips: number;
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
  /**
   * Per-clip zoom permission, PARALLEL TO `clipStarts` by index. User
   * decision 2026-08-16 — "Face-only. If there's anything else, then no
   * zoom": the always-on idle push visibly SLID screen-recording content,
   * so a clip whose subject is not a face gets NO segments at all rather
   * than a flat one. `zoomScaleAt` answers 1 outside the plan, and the
   * premiere export's `zoomKeyframesFor` collapses a segment-free span to a
   * plain scale-1 value, so downstream needs zero changes. Entries missing
   * off the end of a short mask read as allowed, and an absent mask is
   * today's plan exactly — pre-F1 callers are byte-identical.
   */
  allowedClips?: readonly boolean[];
}

/**
 * Zoom amplitude, exported so the stage can budget crop margins against it.
 *
 * 5%, not 8%: at 8% the push was eating enough of an already-tight frame to
 * clip a forehead on a close-up, and the amount a viewer should register is
 * "the camera is alive", not "the camera moved". Every crop budget that cites
 * this constant tightens with it rather than needing its own edit.
 */
export const ZOOM_MAX_SCALE = 1.05;

/**
 * How long the push takes. Long enough that the movement is never noticed as
 * movement, short enough that it has arrived while the viewer is still on the
 * hook — and, deliberately, far shorter than a typical clip so most of a clip
 * is the settled perspective rather than a drift.
 */
export const ZOOM_RAMP_SEC = 8;

/**
 * Clip starts, cleaned — in range, unique, sorted, always including 0 — each
 * carrying its `allowedClips` verdict. The verdict is paired with its start
 * BY INDEX before any of the cleaning, so dedupe/sort can never shift a
 * verdict onto a different clip; duplicated starts are one clip and OR their
 * verdicts (any pairing that vouches "face" wins — losing the push on a face
 * clip is the regression, holding still an extra clip is merely conservative
 * the wrong way). The synthetic 0 boundary is allowed unless the caller's
 * own list contains a 0 that says otherwise. Missing mask entries read as
 * allowed (`!== false`), which is also what makes an absent mask identical
 * to the pre-mask contract.
 */
function clipBoundaries(
  starts: readonly number[] | undefined,
  allowed: readonly boolean[] | undefined,
  duration: number,
): Array<{ start: number; allowed: boolean }> {
  const byStart = new Map<number, boolean>();
  (starts ?? []).forEach((t, i) => {
    if (!Number.isFinite(t) || t < 0 || t >= duration) return;
    byStart.set(t, (byStart.get(t) ?? false) || allowed?.[i] !== false);
  });
  if (!byStart.has(0)) byStart.set(0, true);
  return [...byStart.entries()]
    .map(([start, ok]) => ({ start, allowed: ok }))
    .sort((a, b) => a.start - b.start);
}

export function buildZoomPlan(
  outputDurationSec: number,
  opts: ZoomPlanOptions = {},
): ZoomPlan {
  const maxScale = opts.maxScale ?? ZOOM_MAX_SCALE;
  const rampSec = opts.rampSec ?? ZOOM_RAMP_SEC;
  if (outputDurationSec <= 0) {
    return { segments: [], clips: 0, zoomedClips: 0, staticClips: 0, rampSec };
  }

  const starts = clipBoundaries(opts.clipStarts, opts.allowedClips, outputDurationSec);
  const segments: ZoomSegment[] = [];
  const staticClips = starts.filter((s) => !s.allowed).length;

  for (let i = 0; i < starts.length; i++) {
    const { start, allowed } = starts[i]!;
    // A disallowed clip emits NOTHING — not a flat segment. `zoomScaleAt`
    // returns 1 for any instant no segment claims (zoom.ts's own "1 outside
    // the plan" contract), so a hole in the plan IS the static camera.
    if (!allowed) continue;
    const end = i + 1 < starts.length ? starts[i + 1]!.start : outputDurationSec;
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

  return {
    segments,
    clips: starts.length,
    zoomedClips: starts.length - staticClips,
    staticClips,
    rampSec,
  };
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
