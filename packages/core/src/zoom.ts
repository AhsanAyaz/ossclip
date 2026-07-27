import type { CaptionLine } from "./captions";

/**
 * Micro zoom punches (FINDINGS §15): the cut-driven punch-in only fires at
 * cuts, so a clean take sits visually static for 8–12 s at a time. This is
 * the independent driver — a slow, subtle zoom that reverses direction at
 * speech-phrase boundaries, precomputed by the pipeline (browser-safe, pure).
 * It composes with the cut punch multiplicatively: with zero cuts the cut
 * punch is 1 and this is the only motion; at a cut the step dwarfs the drift.
 */

export interface ZoomSegment {
  startSec: number;
  endSec: number;
  from: number;
  to: number;
}

export interface ZoomPlanOptions {
  /** Zoomed-in extreme; the other extreme is 1. */
  maxScale?: number;
  /** An inter-word gap at least this long reads as a phrase break. */
  phraseGapSec?: number;
  /** Boundaries closer than this are merged — no twitching. */
  minPhraseSec?: number;
  /** A stretch with no natural break still reverses at least this often. */
  maxPhraseSec?: number;
}

/**
 * Phrase boundaries from caption lines' word timings (OUTPUT time): a gap
 * over `phraseGapSec` between consecutive words is a natural half-sentence
 * break. Dense speech still breathes via `maxPhraseSec`; silence-only takes
 * (no captions) get a plain maxPhraseSec metronome.
 */
export function buildZoomPlan(
  lines: readonly CaptionLine[],
  outputDurationSec: number,
  opts: ZoomPlanOptions = {},
): ZoomSegment[] {
  const maxScale = opts.maxScale ?? 1.08;
  const phraseGap = opts.phraseGapSec ?? 0.25;
  const minPhrase = opts.minPhraseSec ?? 1.6;
  const maxPhrase = opts.maxPhraseSec ?? 4.5;
  if (outputDurationSec <= 0) return [];

  const words = lines.flatMap((l) => l.words).sort((a, b) => a.start - b.start);
  const natural: number[] = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.start - words[i - 1]!.end >= phraseGap) natural.push(words[i]!.start);
  }

  // Merge close boundaries, then subdivide long phrases.
  const boundaries: number[] = [0];
  for (const b of natural) {
    if (b - boundaries[boundaries.length - 1]! >= minPhrase && b < outputDurationSec - minPhrase / 2) {
      boundaries.push(b);
    }
  }
  boundaries.push(outputDurationSec);
  const times: number[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    times.push(a);
    const pieces = Math.ceil((b - a) / maxPhrase);
    for (let p = 1; p < pieces; p++) times.push(a + ((b - a) * p) / pieces);
  }
  times.push(outputDurationSec);

  const plan: ZoomSegment[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    plan.push({
      startSec: times[i]!,
      endSec: times[i + 1]!,
      from: i % 2 === 0 ? 1 : maxScale,
      to: i % 2 === 0 ? maxScale : 1,
    });
  }
  return plan;
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
