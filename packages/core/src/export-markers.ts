import type { Production, Span } from "./schema";

/**
 * Shared derivations for the NLE marker exporters (§142 round 2).
 *
 * The field editor's second complaint, verified frame-by-frame against her
 * recorded feedback: real pauses sat visibly in her waveform with no marker
 * on them. Those are pauses the analysis DETECTED but the cut rules KEPT —
 * below the cut bar, or sentence-snapped away. The exports read only the
 * cutlist, so a kept pause was invisible in exactly the tool she uses to
 * find pauses. `analysis.cuttable` is the right pool: regions with no
 * audible speech AFTER the transcript veto — the same candidates every
 * silence/pause cut was drawn from.
 */

/**
 * 0.25s, not `breaths`' 120ms floor: a 30-minute take carries hundreds of
 * sub-quarter-second breaths, and a marker per breath buries the markers the
 * editor asked for under the ones she didn't (§142 round 2 — marker-spam
 * floor).
 */
export const MIN_KEPT_PAUSE_SEC = 0.25;

/**
 * Detected pauses the cut rules kept: cuttable regions no remove segment
 * overlaps, at or above the floor. A PARTIALLY overlapped region is excluded
 * too — the cut already marks that neighbourhood, and a second marker there
 * would read as a second suggestion.
 */
export function keptPauses(production: Production): Span[] {
  const cuttable = production.analysis?.cuttable ?? [];
  const removes = (production.cutlist ?? []).filter((s) => s.kind === "remove");
  return cuttable.filter(
    (span) =>
      span.end - span.start >= MIN_KEPT_PAUSE_SEC &&
      !removes.some((r) => r.srcIn < span.end && r.srcOut > span.start),
  );
}

/** The kept-pause label, shared so all three formats say the same words. */
export function keptPauseLabel(span: Span): string {
  return `pause ${(span.end - span.start).toFixed(2)}s (kept)`;
}
