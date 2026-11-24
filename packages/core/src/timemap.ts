import type { Segment, Word } from "./schema";

/** How far outside a kept span an instant may fall and still map into it:
 * float-ulp overshoot at an edge, never a real cut. */
const EDGE_EPS = 1e-9;

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

  /**
   * The kept span a source instant belongs to, in `toOutput`'s order:
   * exact containment first (a tolerance must never steal an instant that
   * exactly belongs to another span — removed segments can be arbitrarily
   * short); then the nearest span within `EDGE_EPS` (float-ulp overshoot at
   * an edge); then, for an instant inside a removed region, the next kept
   * span, where `toOutputClamped` and so `mapWord` clamp a clipped word's
   * start. Null past the last span.
   *
   * One lookup for `toOutput` and the editor's When row floor
   * (graphic-editor-modal §5, `keptSpanStartOf`), so the span a word is
   * timed in and the span its timing pin is floored at cannot disagree at
   * an edge.
   */
  spanOf(tSrc: number): KeptSpan | null {
    for (const sp of this.spans) {
      if (tSrc >= sp.srcIn && tSrc <= sp.srcOut) return sp;
    }
    let best: KeptSpan | null = null;
    let bestDist = Infinity;
    for (const sp of this.spans) {
      const dist = tSrc < sp.srcIn ? sp.srcIn - tSrc : tSrc - sp.srcOut;
      if (dist < bestDist) {
        bestDist = dist;
        best = sp;
      }
    }
    if (best && bestDist <= EDGE_EPS) return best;
    return this.spans.find((sp) => sp.srcIn > tSrc) ?? null;
  }

  /** Output time for a source instant, or null when the instant was cut. */
  toOutput(tSrc: number): number | null {
    const sp = this.spanOf(tSrc);
    // `spanOf`'s next-span step is for instants in a removed region, which
    // are cut here: only a span the instant is in, or within EPS of, maps.
    if (sp === null) return null;
    // The distance as `spanOf` measures it, not shifted edges (`srcIn - EPS`
    // rounds differently), so the EPS boundary is exactly where it was.
    const dist = tSrc < sp.srcIn ? sp.srcIn - tSrc : tSrc > sp.srcOut ? tSrc - sp.srcOut : 0;
    if (dist > EDGE_EPS) return null;
    const clamped = Math.min(Math.max(tSrc, sp.srcIn), sp.srcOut);
    return sp.outIn + (clamped - sp.srcIn);
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

/**
 * Rebuild a `TimeMap` from another map's own `spans` — e.g. a PREVIOUS
 * produce run's `render-props.json`, read back to learn which coordinate
 * frame the user's stored splits/pins are CURRENTLY anchored to (PLAN
 * 2026-08-04 Task 4b: `applyUserCuts`'s `priorMap`). The constructor only
 * reasons about `keep`-kind segments when building `spans` — `remove`
 * segments carry no information it uses — so handing back exactly the spans
 * a map once produced, each re-labelled `keep`, reconstructs an identical
 * map without needing the original cutlist's `remove` segments at all.
 */
export function mapFromKeptSpans(spans: readonly KeptSpan[]): TimeMap {
  return new TimeMap(spans.map((s) => ({ srcIn: s.srcIn, srcOut: s.srcOut, kind: "keep" as const })));
}

/**
 * Whether two maps describe the same kept-span structure, within `eps` —
 * the re-anchoring gate (review fix wave, PLAN 2026-08-04 Task 4, finding
 * 3): `applyUserCuts` re-anchors `splits`/pinned timing whenever `priorMap`
 * and this run's final map disagree, span for span, REGARDLESS of whether
 * `cuts` is empty — comparing the maps directly, not the doc, is what keeps
 * "was there drift to correct" and "did correcting it change anything"
 * separate questions.
 */
export function mapsClose(a: TimeMap, b: TimeMap, eps: number): boolean {
  if (Math.abs(a.outputDuration - b.outputDuration) > eps) return false;
  if (a.spans.length !== b.spans.length) return false;
  return a.spans.every((sp, i) => {
    const other = b.spans[i]!;
    return (
      Math.abs(sp.srcIn - other.srcIn) <= eps &&
      Math.abs(sp.srcOut - other.srcOut) <= eps &&
      Math.abs(sp.outIn - other.outIn) <= eps &&
      Math.abs(sp.outOut - other.outOut) <= eps
    );
  });
}
