import type { Segment, Word } from "./schema.js";

export interface KeptSpan {
  srcIn: number;
  srcOut: number;
  outIn: number;
  outOut: number;
}

/**
 * Source-time ↔ output-time mapping derived from a cutlist.
 *
 * All overlay timings (captions, scenes, SFX) live in OUTPUT time; this is the
 * only place source time is translated. Invariants (property-tested):
 *  - spans are sorted, non-overlapping, and contiguous in output time
 *  - outputDuration === Σ (srcOut - srcIn) over kept spans
 *  - toSource(toOutput(t)) === t for t strictly inside a kept span
 *  - toOutput(toSource(o)) === o for any kept output instant (projection identity)
 *  - toOutput is monotonically non-decreasing over kept source time
 *
 * Note: an output instant exactly at a cut boundary has TWO source preimages
 * (the end of the span before the cut and the start of the span after);
 * toSource deterministically returns the earlier one.
 */
export class TimeMap {
  readonly spans: readonly KeptSpan[];
  readonly outputDuration: number;

  constructor(cutlist: readonly Segment[]) {
    let prevOut = -Infinity;
    for (const s of cutlist) {
      if (s.srcOut < s.srcIn) throw new Error(`segment ends before it starts: ${s.srcIn}..${s.srcOut}`);
      if (s.srcIn < prevOut) throw new Error(`cutlist segments overlap at ${s.srcIn}`);
      prevOut = s.srcOut;
    }
    const spans: KeptSpan[] = [];
    let out = 0;
    for (const s of cutlist) {
      if (s.kind !== "keep" || s.srcOut <= s.srcIn) continue;
      const dur = s.srcOut - s.srcIn;
      spans.push({ srcIn: s.srcIn, srcOut: s.srcOut, outIn: out, outOut: out + dur });
      out += dur;
    }
    this.spans = spans;
    this.outputDuration = out;
  }

  /** Output time for a source instant, or null when the instant was cut. */
  toOutput(tSrc: number): number | null {
    // Exact containment first — a tolerance must never steal an instant that
    // exactly belongs to another span (removed segments can be arbitrarily short).
    for (const sp of this.spans) {
      if (tSrc >= sp.srcIn && tSrc <= sp.srcOut) return sp.outIn + (tSrc - sp.srcIn);
    }
    // Then tolerate float-ulp overshoot at edges: clamp into the nearest span
    // only when the instant is within EPS of it.
    const EPS = 1e-9;
    let best: KeptSpan | null = null;
    let bestDist = Infinity;
    for (const sp of this.spans) {
      const dist = tSrc < sp.srcIn ? sp.srcIn - tSrc : tSrc - sp.srcOut;
      if (dist < bestDist) {
        bestDist = dist;
        best = sp;
      }
    }
    if (best && bestDist <= EPS) {
      const clamped = Math.min(Math.max(tSrc, best.srcIn), best.srcOut);
      return best.outIn + (clamped - best.srcIn);
    }
    return null;
  }

  /**
   * Output time for a source instant, clamping instants that fall in removed
   * regions to the nearest kept edge. Used for caption/overlay boundaries.
   */
  toOutputClamped(tSrc: number): number {
    const exact = this.toOutput(tSrc);
    if (exact !== null) return exact;
    let best = 0;
    for (const sp of this.spans) {
      if (sp.srcOut <= tSrc) best = sp.outOut;
      else if (sp.srcIn >= tSrc) return sp.outIn;
    }
    return best;
  }

  /** Source time for an output instant. Output time is contiguous, so this is total. */
  toSource(tOut: number): number {
    const spans = this.spans;
    if (spans.length === 0) return 0;
    const first = spans[0]!;
    if (tOut <= first.outIn) return first.srcIn;
    for (const sp of spans) {
      if (tOut >= sp.outIn && tOut <= sp.outOut) return sp.srcIn + (tOut - sp.outIn);
    }
    return spans[spans.length - 1]!.srcOut;
  }

  /**
   * Map a word into output time. Returns null when the word was entirely cut
   * (e.g. a removed filler); ends are clamped when a cut clips the word edge.
   */
  mapWord(w: Word): { start: number; end: number } | null {
    const mid = (w.start + w.end) / 2;
    if (this.toOutput(mid) === null && this.toOutput(w.start) === null && this.toOutput(w.end) === null) {
      return null;
    }
    const start = this.toOutputClamped(w.start);
    const end = this.toOutputClamped(w.end);
    if (end <= start) return null;
    return { start, end };
  }
}
