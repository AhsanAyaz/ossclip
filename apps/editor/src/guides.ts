import type { BoxHandle } from "./Overlay";
import type { GraphicRect } from "./useEdits";

/** A snapped-to guide the overlay draws, in frame fractions (0..1). */
export interface Guide {
  axis: "x" | "y";
  at: number;
}

/** The same shape `safeAreaFor` returns — kept local so this file stays
 * import-free of the renderer package; the caller passes the numbers. */
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * ~1.5% of the frame: at the composition's native 1080px width that's ~16px
 * of on-screen pull once the stage is scaled up to fill the panel — close
 * enough to feel magnetic on a deliberate drag near a guide, far enough
 * below a handle's own hit radius (HANDLE = 9px in Overlay.tsx) that it
 * never fires on a drag that was aimed at the handle, not the guide.
 */
export const THRESHOLD_FRAC = 0.015;

interface AxisCandidate {
  /** The frame-fraction position a guide line is drawn at if this wins. */
  target: number;
  /** The rect's current feature (an edge or the centre) being tested. */
  feature: number;
}

// Epsilon-tolerant, same pattern as `clampGraphicRect` (packages/scenes/src/
// stage.ts): "exactly at the threshold" is a boundary a caller can legitimately
// hit, but float subtraction of two frame-fraction sums lands a few ULPs
// either side of it — without slack, "exactly at threshold" sometimes computes
// a hair OVER and silently fails to snap.
const EPS = 1e-9;

/** Nearest candidate within `thresholdFrac`, or null if none hit. Ties (an
 * exact equidistant match between two candidates) keep whichever was tested
 * first — `guideSnap` always lists them in a fixed, deterministic order. */
function nearest(candidates: AxisCandidate[], thresholdFrac: number): AxisCandidate | null {
  let best: AxisCandidate | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(c.feature - c.target);
    if (dist <= thresholdFrac + EPS && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Snap a dragged graphic rect to the frame's centre lines and the safe-area
 * edges (spec: "Overlay guides"). Pure and total: outside every threshold it
 * returns `rect` unchanged and no guides — the caller (`Overlay.tsx`) runs
 * this AFTER `applyBoxHandle` + `clampGraphicRect` and before the edit
 * commits, so `rect` here is already valid geometry going IN. Snapping tries
 * to nudge it onto one of the closed candidate set below, but the move
 * branch's centre candidate is REJECTED (not applied, not re-clamped) when
 * doing so would push an edge outside the safe bounds — see the comment on
 * that candidate for why re-clamping isn't the fix.
 *
 * Move drags snap the rect's CENTRE to the frame's centre lines and its
 * EDGES to the safe-area edges — whichever LEGAL candidate is nearest wins
 * per axis, at most one guide per axis. Resize drags snap only the edge(s)
 * the `handle` actually drags (the same `.includes("w"/"e"/"n"/"s")`
 * semantics `applyBoxHandle` uses) — the centre candidates don't apply,
 * since a resize doesn't move the rect's centre on purpose.
 */
export function guideSnap(
  rect: GraphicRect,
  handle: BoxHandle,
  safe: SafeArea,
  thresholdFrac: number,
): { rect: GraphicRect; guides: Guide[] } {
  const next: GraphicRect = { ...rect };
  const guides: Guide[] = [];

  if (handle === "move") {
    const centerX = rect.x + rect.w / 2;
    const rightEdge = rect.x + rect.w;
    // The safe area is ASYMMETRIC in production (portrait's SAFE_AREA is
    // top:0.12 bottom:0.22 left:0.04 right:0.16) — frame-centre 0.5 is NOT
    // the safe area's own centre. A rect can sit with its CENTRE close to
    // 0.5 while its far edge already sits past a safe bound (a wide rect is
    // enough to prove it: centre near 0.5, right edge already past
    // 1-safe.right). Landing such a rect's centre on 0.5 would produce an
    // illegal box; the edge candidates below are always legal here (the
    // caller's clamp already guarantees `rect` fits inside the safe rect,
    // and an edge candidate only ever moves the rect FURTHER inside), so
    // the fix is to drop the centre candidate from consideration rather
    // than accept-then-reclamp — reclamping would leave the drawn guide
    // line not matching where the rect actually ends up, the exact desync
    // the ordering (snap AFTER the clamp) was chosen to avoid.
    const centerXNext = 0.5 - rect.w / 2;
    const centerXLegal = centerXNext >= safe.left && centerXNext + rect.w <= 1 - safe.right;
    const xHit = nearest(
      [
        ...(centerXLegal ? [{ target: 0.5, feature: centerX }] : []),
        { target: safe.left, feature: rect.x },
        { target: 1 - safe.right, feature: rightEdge },
      ],
      thresholdFrac,
    );
    if (xHit) {
      // Shift the whole rect by however far the WINNING feature (centre or
      // an edge) sits from its target — not a fixed offset, since which
      // feature won determines how far x itself must move.
      next.x = rect.x + (xHit.target - xHit.feature);
      guides.push({ axis: "x", at: xHit.target });
    }

    const centerY = rect.y + rect.h / 2;
    const bottomEdge = rect.y + rect.h;
    // Same asymmetry, same rejection rule, on the y axis.
    const centerYNext = 0.5 - rect.h / 2;
    const centerYLegal = centerYNext >= safe.top && centerYNext + rect.h <= 1 - safe.bottom;
    const yHit = nearest(
      [
        ...(centerYLegal ? [{ target: 0.5, feature: centerY }] : []),
        { target: safe.top, feature: rect.y },
        { target: 1 - safe.bottom, feature: bottomEdge },
      ],
      thresholdFrac,
    );
    if (yHit) {
      next.y = rect.y + (yHit.target - yHit.feature);
      guides.push({ axis: "y", at: yHit.target });
    }

    return { rect: next, guides };
  }

  // Resize: only the dragged edge(s) — the opposite edge is anchored, same
  // as `applyBoxHandle`, so snapping one edge must keep the other fixed.
  if (handle.includes("w")) {
    const hit = nearest([{ target: safe.left, feature: rect.x }], thresholdFrac);
    if (hit) {
      const anchoredRight = rect.x + rect.w;
      next.x = hit.target;
      next.w = anchoredRight - hit.target;
      guides.push({ axis: "x", at: hit.target });
    }
  } else if (handle.includes("e")) {
    const target = 1 - safe.right;
    const hit = nearest([{ target, feature: rect.x + rect.w }], thresholdFrac);
    if (hit) {
      next.w = hit.target - rect.x;
      guides.push({ axis: "x", at: hit.target });
    }
  }

  if (handle.includes("n")) {
    const hit = nearest([{ target: safe.top, feature: rect.y }], thresholdFrac);
    if (hit) {
      const anchoredBottom = rect.y + rect.h;
      next.y = hit.target;
      next.h = anchoredBottom - hit.target;
      guides.push({ axis: "y", at: hit.target });
    }
  } else if (handle.includes("s")) {
    const target = 1 - safe.bottom;
    const hit = nearest([{ target, feature: rect.y + rect.h }], thresholdFrac);
    if (hit) {
      next.h = hit.target - rect.y;
      guides.push({ axis: "y", at: hit.target });
    }
  }

  return { rect: next, guides };
}
