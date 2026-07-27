import type { CaptionLine } from "./captions";

/**
 * Micro zoom punches (FINDINGS §15): the cut-driven punch-in only fires at
 * cuts, so a clean take sits visually static for 8–12 s at a time. This is
 * the independent driver — a slow, subtle zoom that reverses direction at
 * speech-phrase boundaries, precomputed by the pipeline (browser-safe, pure).
 * It composes with the cut punch multiplicatively: with zero cuts the cut
 * punch is 1 and this is the only motion; at a cut the step dwarfs the drift.
 *
 * Finding the boundaries is the whole problem (FINDINGS §18). The first
 * version looked for inter-word gaps, which whisper `-ml 1` never produces —
 * its stamps are contiguous — so every take silently fell through to uniform
 * pacing. Boundaries now come from measured audio, with caption lines as the
 * subdivision grid and the metronome only as a reported last resort.
 */

export interface ZoomSegment {
  startSec: number;
  endSec: number;
  from: number;
  to: number;
}

/** Which signal actually produced the boundaries — logged, never silent. */
export type ZoomSource = "acoustic" | "captions" | "metronome";

export interface ZoomPlan {
  segments: ZoomSegment[];
  source: ZoomSource;
  /** Real phrase boundaries found (excluding the two endpoints). */
  boundaries: number;
}

export interface ZoomPlanOptions {
  /** Zoomed-in extreme; the other extreme is 1. */
  maxScale?: number;
  /**
   * Measured pauses in OUTPUT time — `analysis.breaths` mapped through the
   * TimeMap. The primary phrase signal.
   */
  pauses?: Array<{ start: number; end: number }>;
  /** Boundaries closer than this are merged — no twitching. */
  minPhraseSec?: number;
  /** A stretch with no natural break still reverses at least this often. */
  maxPhraseSec?: number;
}

/** Zoom amplitude, exported so the stage can budget crop margins against it. */
export const ZOOM_MAX_SCALE = 1.08;

/**
 * Merge boundaries that sit closer together than `minPhrase`, keeping the
 * first of each cluster. Also guarantees strictly increasing times, which
 * matters because a fully-cut pause maps to a single output instant on both
 * ends and would otherwise emit a zero-length segment (an instant jump in
 * scale rather than a glide).
 */
function merge(times: readonly number[], minPhrase: number, duration: number): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t <= 0 || t >= duration) continue;
    const prev = out[out.length - 1] ?? 0;
    if (t - prev >= minPhrase) out.push(t);
  }
  // Never strand a final sliver shorter than a phrase.
  while (out.length > 0 && duration - out[out.length - 1]! < minPhrase) out.pop();
  return out;
}

export function buildZoomPlan(
  lines: readonly CaptionLine[],
  outputDurationSec: number,
  opts: ZoomPlanOptions = {},
): ZoomPlan {
  const maxScale = opts.maxScale ?? ZOOM_MAX_SCALE;
  const minPhrase = opts.minPhraseSec ?? 1.6;
  const maxPhrase = opts.maxPhraseSec ?? 4.5;
  if (outputDurationSec <= 0) return { segments: [], source: "metronome", boundaries: 0 };

  // A pause's MIDPOINT, not its edges: the reversal should happen inside the
  // silence, where the eased curve is momentarily still, rather than at the
  // instant speech stops.
  const acoustic = (opts.pauses ?? [])
    .map((p) => (p.start + p.end) / 2)
    .filter((t) => t > 0 && t < outputDurationSec);
  // Caption lines break at ≤3 words / ≤1.2 s, which is roughly a phrase —
  // dense, always available, and independent of whisper's stamp behaviour.
  const lineStarts = lines.map((l) => l.start).filter((t) => t > 0 && t < outputDurationSec);

  let boundaries = merge(acoustic, minPhrase, outputDurationSec);
  let source: ZoomSource = boundaries.length > 0 ? "acoustic" : "metronome";
  if (boundaries.length === 0) {
    boundaries = merge(lineStarts, minPhrase, outputDurationSec);
    if (boundaries.length > 0) source = "captions";
  }
  const found = boundaries.length;

  // Subdivide anything still longer than maxPhrase, snapping to a caption
  // line start when one is available so even filler reversals land on a word.
  const withEnds = [0, ...boundaries, outputDurationSec];
  const times: number[] = [0];
  for (let i = 0; i < withEnds.length - 1; i++) {
    const a = withEnds[i]!;
    const b = withEnds[i + 1]!;
    const pieces = Math.ceil((b - a) / maxPhrase);
    for (let p = 1; p < pieces; p++) {
      const ideal = a + ((b - a) * p) / pieces;
      const snapped = lineStarts
        .filter((t) => t > times[times.length - 1]! + 1e-6 && t < b - 1e-6)
        .reduce<number | null>(
          (best, t) => (best === null || Math.abs(t - ideal) < Math.abs(best - ideal) ? t : best),
          null,
        );
      times.push(snapped ?? ideal);
    }
    times.push(b);
  }

  const segments: ZoomSegment[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i + 1]! - times[i]! <= 1e-6) continue; // never a zero-length segment
    segments.push({
      startSec: times[i]!,
      endSec: times[i + 1]!,
      from: segments.length % 2 === 0 ? 1 : maxScale,
      to: segments.length % 2 === 0 ? maxScale : 1,
    });
  }
  return { segments, source, boundaries: found };
}

/**
 * Scale at output time t — cosine-eased across each segment (never linear),
 * continuous at boundaries because segments alternate between shared
 * extremes. 1 outside the plan.
 */
export function zoomScaleAt(plan: readonly ZoomSegment[], tSec: number): number {
  for (const seg of plan) {
    if (tSec >= seg.startSec && tSec <= seg.endSec) {
      const span = seg.endSec - seg.startSec;
      const p = span > 0 ? (tSec - seg.startSec) / span : 1;
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * p);
      return seg.from + (seg.to - seg.from) * eased;
    }
  }
  return 1;
}
