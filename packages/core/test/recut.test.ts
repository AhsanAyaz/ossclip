import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TimeMap } from "../src/timemap";
import { remapOverridesThroughRecut } from "../src/recut";
import { OverrideDocSchema } from "../src/overrides";
import type { Segment } from "../src/schema";

/**
 * Build the TimeMap after removing an OUTPUT-time range [cutStart, cutEnd)
 * from `map` — the same "subtract the user's cuts from the automatic
 * cutlist's keep-spans" operation Task 4b's `produce.ts` performs.
 * Reproduced here as a TEST fixture only (this task's scope is `recut.ts`,
 * not `produce.ts` — the brief is explicit that the real pipeline wiring is
 * 4b's job), so these property tests exercise exactly the old→new
 * relationship `remapOverridesThroughRecut` is documented against.
 */
function cutOutputRange(map: TimeMap, cutStart: number, cutEnd: number): TimeMap {
  const segments: Segment[] = [];
  for (const sp of map.spans) {
    const overlapStart = Math.max(sp.outIn, cutStart);
    const overlapEnd = Math.min(sp.outOut, cutEnd);
    if (overlapStart >= overlapEnd) {
      segments.push({ srcIn: sp.srcIn, srcOut: sp.srcOut, kind: "keep" });
      continue;
    }
    if (overlapStart > sp.outIn) {
      segments.push({ srcIn: sp.srcIn, srcOut: sp.srcIn + (overlapStart - sp.outIn), kind: "keep" });
    }
    if (overlapEnd < sp.outOut) {
      segments.push({ srcIn: sp.srcIn + (overlapEnd - sp.outIn), srcOut: sp.srcOut, kind: "keep" });
    }
  }
  return new TimeMap(segments);
}

/** Random full partition of [0, D] into alternating keep/remove segments —
 * same shape as timemap.test.ts's own arbitrary, redefined here so this
 * file's identity property exercises a REALISTIC already-cut map (existing
 * splits from an earlier cleanup), not just a single untouched span. */
const partitionArb = fc
  .tuple(
    fc.double({ min: 5, max: 300, noNaN: true }),
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: 16 }),
    fc.boolean(),
  )
  .map(([duration, fractions, startKeep]) => {
    const points = [...new Set(fractions.map((f) => f * duration))].sort((a, b) => a - b);
    const bounds = [0, ...points.filter((p) => p > 0 && p < duration), duration];
    const segments: Segment[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const kind = (i % 2 === 0) === startKeep ? "keep" : "remove";
      segments.push({
        srcIn: bounds[i]!,
        srcOut: bounds[i + 1]!,
        kind,
        ...(kind === "remove" ? { reason: "pause" as const } : {}),
      });
    }
    return segments;
  });

describe("remapOverridesThroughRecut — identity re-cut", () => {
  it("is the identity on splits, pinned timing, and cuts, with nothing to report", () => {
    fc.assert(
      fc.property(
        partitionArb,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 5 }),
        (segments, fracs) => {
          const map = new TimeMap(segments);
          if (map.outputDuration <= 0) return; // degenerate: partition removed everything
          const at = (f: number) => f * map.outputDuration;
          const splits = fracs.map(at);
          const pinStart = at(fracs[0] ?? 0);
          const doc = OverrideDocSchema.parse({
            splits,
            scenes: { s: { timing: { startSec: pinStart, endSec: map.outputDuration } } },
            cuts: [{ startSec: 0, endSec: at(fracs[1] ?? 0.5) }],
          });

          const { doc: out, reports } = remapOverridesThroughRecut(doc, map, map);

          expect(reports).toEqual([]);
          expect(out.splits).toHaveLength(splits.length);
          out.splits.forEach((s, i) => expect(s).toBeCloseTo(splits[i]!, 6));
          expect(out.scenes.s!.timing!.startSec).toBeCloseTo(pinStart, 6);
          expect(out.scenes.s!.timing!.endSec).toBeCloseTo(map.outputDuration, 6);
          expect(out.cuts[0]!.startSec).toBeCloseTo(0, 6);
          expect(out.cuts[0]!.endSec).toBeCloseTo(at(fracs[1] ?? 0.5), 6);
        },
      ),
    );
  });
});

/** A fresh cut carved out of an untouched single span [0, duration] — the
 * simplest possible "old map → new map" pair, chosen so the expected
 * before/after/inside values below can be derived by hand (see the task
 * report) rather than re-deriving the implementation under test. */
const freshCutScenario = fc
  .record({
    duration: fc.double({ min: 30, max: 300, noNaN: true }),
    cutStartFrac: fc.double({ min: 0.2, max: 0.4, noNaN: true }),
    cutLenFrac: fc.double({ min: 0.05, max: 0.2, noNaN: true }),
  })
  .map(({ duration, cutStartFrac, cutLenFrac }) => {
    const cutStart = duration * cutStartFrac;
    const cutEnd = cutStart + duration * cutLenFrac;
    return { duration, cutStart, cutEnd };
  });

describe("remapOverridesThroughRecut — before/after/inside a fresh cut", () => {
  it("a split strictly before the cut range is unchanged", () => {
    fc.assert(
      fc.property(freshCutScenario, fc.double({ min: 0, max: 1, noNaN: true }), (
        { duration, cutStart, cutEnd },
        frac,
      ) => {
        const oldMap = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
        const newMap = cutOutputRange(oldMap, cutStart, cutEnd);
        const margin = 0.01;
        const t = frac * Math.max(0, cutStart - margin);
        const doc = OverrideDocSchema.parse({ splits: [t] });

        const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

        expect(out.splits[0]).toBeCloseTo(t, 6);
        expect(reports).toEqual([]);
      }),
    );
  });

  it("a split strictly after the cut range shifts by exactly the removed duration", () => {
    fc.assert(
      fc.property(freshCutScenario, fc.double({ min: 0, max: 1, noNaN: true }), (
        { duration, cutStart, cutEnd },
        frac,
      ) => {
        const oldMap = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
        const newMap = cutOutputRange(oldMap, cutStart, cutEnd);
        const margin = 0.01;
        const lo = cutEnd + margin;
        if (lo >= duration) return; // no room left after the cut for this draw
        const t = lo + frac * (duration - lo);
        const doc = OverrideDocSchema.parse({ splits: [t] });

        const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

        expect(out.splits[0]).toBeCloseTo(t - (cutEnd - cutStart), 6);
        expect(reports).toEqual([]);
      }),
    );
  });

  it("a split inside the cut range lands on the cut's edge and is reported, never silently dropped", () => {
    fc.assert(
      fc.property(freshCutScenario, fc.double({ min: 0.05, max: 0.95, noNaN: true }), (
        { duration, cutStart, cutEnd },
        frac,
      ) => {
        const oldMap = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
        const newMap = cutOutputRange(oldMap, cutStart, cutEnd);
        const t = cutStart + frac * (cutEnd - cutStart);
        const doc = OverrideDocSchema.parse({ splits: [t] });

        const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

        // Before and after the cut collapse onto the SAME new-output instant
        // (nothing before the cut moved, and the material right after it now
        // sits flush against that point) — so the edge is exactly cutStart,
        // regardless of which of the two neighbouring kept spans
        // `toOutputClamped` snaps to.
        expect(out.splits[0]).toBeCloseTo(cutStart, 6);
        expect(reports.length).toBe(1);
      }),
    );
  });
});

describe("remapOverridesThroughRecut — pinned timing (unit)", () => {
  it("re-anchors a pinned scene's absolute window across a recut earlier in the output", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 5, 8); // 3s removed at 5–8s
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-2": { timing: { startSec: 20, endSec: 24 } } },
    });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.scenes["scene-2"]!.timing!.startSec).toBeCloseTo(17, 6); // 20 - 3
    expect(out.scenes["scene-2"]!.timing!.endSec).toBeCloseTo(21, 6); // 24 - 3
    expect(reports).toEqual([]);
  });

  it("reports and clamps a pin whose entire window the new cut removed", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 20, 24);
    // Strictly inside [20, 24] so both edges truly fall in the removed
    // region rather than landing exactly on its (still-kept) boundary.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-2": { timing: { startSec: 21, endSec: 23 } } },
    });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.scenes["scene-2"]!.timing!.startSec).toBeCloseTo(20, 6);
    expect(out.scenes["scene-2"]!.timing!.endSec).toBeCloseTo(20, 6);
    expect(reports).toHaveLength(2);
  });

  it("leaves an unpinned scene (no `timing` override) alone", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 5, 8);
    const doc = OverrideDocSchema.parse({ scenes: { "scene-2": { props: { value: "1%" } } } });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.scenes["scene-2"]).toEqual(doc.scenes["scene-2"]);
    expect(reports).toEqual([]);
  });
});

describe("remapOverridesThroughRecut — cuts recorded against an older output (unit)", () => {
  it("re-anchors an unconsumed cut range past an earlier recut", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 5, 8);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 30, endSec: 34 }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.cuts[0]!.startSec).toBeCloseTo(27, 6); // 30 - 3
    expect(out.cuts[0]!.endSec).toBeCloseTo(31, 6); // 34 - 3
    expect(reports).toEqual([]);
  });

  it("reports and clamps a stored cut whose range a NEWER cut already swallowed", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 20, 30);
    // Recorded against the OLD output, now strictly inside the newer cut.
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 22, endSec: 26 }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.cuts[0]!.startSec).toBeCloseTo(20, 6);
    expect(out.cuts[0]!.endSec).toBeCloseTo(20, 6);
    expect(reports).toHaveLength(2);
  });
});
