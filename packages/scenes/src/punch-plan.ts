/**
 * The face-only jump-cut punch plan (2026-08-16 incident, Task 6).
 *
 * `punch` in render-props is produce's per-span verdict on the cut punch-in:
 * one scale, and a per-span mask saying which spans may render it. It exists
 * because the legacy everywhere-punch scaled screen shares too, and punching
 * a screen share SLIDES its content — text visibly drifting is worse than
 * the jump the punch conceals. The scale itself dropped from the legacy 7%
 * to ~1.5% (user decision 2026-08-16, "minimal, ~1%") for the same reason:
 * on the spans that ARE allowed, a large punch reads as the camera lurching.
 *
 * ABSENT MEANS LEGACY: every pre-feature render-props.json has no `punch`
 * key, and those renders must come out byte-identical to what they always
 * were — the 1.07 punch on every alternating span. Presence is the opt-in.
 *
 * Pure and JSX-free (house rule): the mask/parity interaction is the whole
 * behavior, and it has to be assertable without mounting a Remotion
 * composition.
 */

export interface PunchPlan {
  /** Scale allowed spans render on their punched turns (e.g. 1.015). */
  scale: number;
  /** Per-span gate, indexed like `spans`; false = never punch this span. */
  allowed: boolean[];
}

/**
 * Whether a render-props `punch` field is a plan this renderer will follow —
 * `showWatermark`'s posture (watermark-layout.ts), parse-don't-coerce
 * (CLAUDE.md): the file is user-visible and hand-editable, and a truncated
 * or tweaked plan must fall back to the LEGACY behavior rather than scale
 * spans by `undefined` or a string. Null is the legacy signal the callers
 * already treat "no plan at all" as, so malformed and pre-feature converge
 * on the one path that always worked.
 */
export function punchPropsFor(punch: unknown): PunchPlan | null {
  if (typeof punch !== "object" || punch === null) return null;
  const p = punch as { scale?: unknown; allowed?: unknown };
  if (typeof p.scale !== "number" || !Number.isFinite(p.scale) || p.scale <= 0) return null;
  if (!Array.isArray(p.allowed) || p.allowed.some((v) => typeof v !== "boolean")) return null;
  return { scale: p.scale, allowed: p.allowed as boolean[] };
}

/**
 * The per-span scales EdlVideo renders — the alternating jump-cut concealer,
 * now mask-aware. THE PARITY STILL FLIPS ON EVERY QUALIFYING GAP, masked
 * spans included: the toggle is stable indexing, so adding or removing a
 * span from the mask can never re-phase which of the OTHER spans punch — a
 * masked span simply renders its punched turn at 1 instead of the scale.
 * `allowed[i] !== false` (not `=== true`): a mask shorter than the spans
 * reads as allowed, matching the plan-less legacy default.
 *
 * export-premiere-project.ts (core) replicates this loop for the Premiere
 * export and its doc comment demands lockstep — change one, change both,
 * and both hand-computed tests.
 */
export function punchScalesFor(
  spans: readonly { srcIn: number; srcOut: number }[],
  plan: PunchPlan | null,
  punchInScale: number,
  punchThresholdSec: number,
): number[] {
  const scale = plan ? plan.scale : punchInScale;
  const out: number[] = [];
  let punched = false;
  for (let i = 0; i < spans.length; i++) {
    const prev = spans[i - 1];
    const gap = prev ? spans[i]!.srcIn - prev.srcOut : 0;
    if (i > 0 && gap >= punchThresholdSec) punched = !punched;
    const allowed = plan ? plan.allowed[i] !== false : true;
    out.push(punched && allowed ? scale : 1);
  }
  return out;
}
