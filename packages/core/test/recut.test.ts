import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TimeMap } from "../src/timemap";
import { applyUserCuts, remapOverridesThroughRecut, subtractCutsFromCutlist } from "../src/recut";
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

describe("subtractCutsFromCutlist", () => {
  it("matches cutOutputRange's spans for a single fresh cut", () => {
    fc.assert(
      fc.property(freshCutScenario, ({ duration, cutStart, cutEnd }) => {
        const map = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
        const viaFixture = cutOutputRange(map, cutStart, cutEnd);
        const viaImpl = new TimeMap(
          subtractCutsFromCutlist(
            [{ srcIn: 0, srcOut: duration, kind: "keep" }],
            [{ startSec: cutStart, endSec: cutEnd }],
            map,
          ),
        );
        expect(viaImpl.outputDuration).toBeCloseTo(viaFixture.outputDuration, 6);
        expect(viaImpl.spans).toEqual(viaFixture.spans);
      }),
    );
  });

  it("tags the newly-removed span with reason \"user\" so formatCutReport lists it", () => {
    const map = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const out = subtractCutsFromCutlist(
      [{ srcIn: 0, srcOut: 60, kind: "keep" }],
      [{ startSec: 20, endSec: 24 }],
      map,
    );
    const removed = out.filter((s) => s.kind === "remove");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ srcIn: 20, srcOut: 24, reason: "user" });
  });

  it("subtracts two non-overlapping cuts independently, both anchored to the SAME map", () => {
    const map = new TimeMap([{ srcIn: 0, srcOut: 100, kind: "keep" }]);
    const out = subtractCutsFromCutlist(
      [{ srcIn: 0, srcOut: 100, kind: "keep" }],
      [
        { startSec: 10, endSec: 15 },
        { startSec: 50, endSec: 52 },
      ],
      map,
    );
    const newMap = new TimeMap(out);
    expect(newMap.outputDuration).toBeCloseTo(100 - 5 - 2, 6);
    expect(out.filter((s) => s.kind === "remove" && s.reason === "user")).toHaveLength(2);
  });

  it("carves around an existing automatic `remove` segment untouched", () => {
    // An automatic cut already removed [20, 25); a user cut spanning [15, 30)
    // in OUTPUT time reaches across that existing gap.
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 20, kind: "keep" },
      { srcIn: 20, srcOut: 25, kind: "remove", reason: "silence" },
      { srcIn: 25, srcOut: 60, kind: "keep" },
    ];
    const map = new TimeMap(cutlist);
    // Output time is contiguous: source 15 -> output 15; source 30 -> output 25.
    const out = subtractCutsFromCutlist(cutlist, [{ startSec: 15, endSec: 25 }], map);
    // The automatic removal survives untouched, exactly once.
    expect(out.filter((s) => s.reason === "silence")).toHaveLength(1);
    expect(out.find((s) => s.reason === "silence")).toMatchObject({ srcIn: 20, srcOut: 25 });
    // The user cut carved both sides of it: [15,20) and [25,30).
    const userCuts = out.filter((s) => s.reason === "user");
    expect(userCuts).toHaveLength(2);
    expect(userCuts).toContainEqual(
      expect.objectContaining({ srcIn: 15, srcOut: 20 }),
    );
    expect(userCuts).toContainEqual(
      expect.objectContaining({ srcIn: 25, srcOut: 30 }),
    );
  });

  it("ignores a degenerate cut (endSec <= startSec)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const out = subtractCutsFromCutlist(cutlist, [{ startSec: 30, endSec: 30 }], map);
    expect(out).toEqual(cutlist);
  });

  it("returns segments TimeMap accepts (sorted, non-overlapping) for many cuts", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 200, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: 8 }),
        (duration, fracs) => {
          const map = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
          const cuts = fracs.map((f) => {
            const start = f * duration * 0.9;
            return { startSec: start, endSec: start + duration * 0.05 };
          });
          // Must not throw — TimeMap's constructor is the sortedness/overlap check.
          expect(() => new TimeMap(subtractCutsFromCutlist([{ srcIn: 0, srcOut: duration, kind: "keep" }], cuts, map))).not.toThrow();
        },
      ),
    );
  });
});

describe("applyUserCuts", () => {
  it("is a no-op when doc.cuts is empty", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ splits: [10] });

    const result = applyUserCuts(doc, cutlist, map);

    expect(result.changed).toBe(false);
    expect(result.reports).toEqual([]);
    expect(result.removedSec).toBe(0);
    expect(result.map.outputDuration).toBeCloseTo(map.outputDuration, 6);
    expect(result.doc).toBe(doc);
  });

  it("subtracts the cut and leaves the doc's cuts UNCHANGED (not collapsed) when there's nothing else to re-anchor", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }] });

    const result = applyUserCuts(doc, cutlist, map);

    expect(result.removedSec).toBeCloseTo(4, 6);
    expect(result.map.outputDuration).toBeCloseTo(56, 6);
    // Nothing to re-anchor (no splits, no pins) — no write-back needed.
    expect(result.changed).toBe(false);
    expect(result.reports).toEqual([]);
    // The critical persistence property (see the doc comment on
    // `applyUserCuts`): the stored cut keeps its ORIGINAL, non-degenerate
    // range so a second produce run subtracts the SAME source material
    // again, rather than a zero-width no-op that would silently restore it.
    expect(result.doc.cuts).toEqual(doc.cuts);
  });

  it("re-anchors a split after the cut and reports nothing (a clean shift)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({
      cuts: [{ startSec: 20, endSec: 24 }],
      splits: [40],
    });

    const result = applyUserCuts(doc, cutlist, map);

    expect(result.changed).toBe(true);
    expect(result.reports).toEqual([]);
    expect(result.doc.splits[0]).toBeCloseTo(36, 6); // 40 - 4
    expect(result.doc.cuts).toEqual(doc.cuts);
  });

  it("re-anchors a pin the cut swallowed and reports it", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({
      cuts: [{ startSec: 20, endSec: 30 }],
      scenes: { "scene-1": { timing: { startSec: 22, endSec: 26 } } },
    });

    const result = applyUserCuts(doc, cutlist, map);

    expect(result.changed).toBe(true);
    expect(result.reports).toHaveLength(2);
    expect(result.doc.scenes["scene-1"]!.timing!.startSec).toBeCloseTo(20, 6);
    expect(result.doc.scenes["scene-1"]!.timing!.endSec).toBeCloseTo(20, 6);
    expect(result.doc.cuts).toEqual(doc.cuts);
  });

  it("is idempotent: removes the SAME material on a re-run with no new edits", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }] });

    const first = applyUserCuts(doc, cutlist, map);
    // A second produce run rebuilds the SAME automatic cutlist from scratch
    // (deterministic from source + cleanup level) and re-reads the SAME
    // overrides.json this run wrote back (or, since nothing changed, never
    // rewrote) — simulated here by re-running against the ORIGINAL automatic
    // cutlist/map with `first.doc`.
    const second = applyUserCuts(first.doc, cutlist, map);

    expect(second.map.outputDuration).toBeCloseTo(first.map.outputDuration, 6);
    expect(second.removedSec).toBeCloseTo(first.removedSec, 6);
  });

  // Found on the repro workdir during Task 4b's verification (a real
  // `pnpm produce --no-render` run twice in a row): without `priorMap`, a
  // split re-anchored on run 1 (now expressed in the POST-cut frame) got
  // treated as if it were STILL in the PRE-cut frame on run 2 and shifted by
  // the cut's duration a second time — 33.9s became 31.4s with no new edit.
  it("does NOT double-shift a split that a PRIOR run already re-anchored", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }], splits: [40] });

    const first = applyUserCuts(doc, cutlist, map);
    expect(first.doc.splits[0]).toBeCloseTo(36, 6); // 40 - 4, as in the earlier test

    // Second produce run: SAME automatic map (nothing upstream changed), but
    // `priorMap` is now `first.map` — reconstructed in `produce.ts` from the
    // render-props.json THIS run's predecessor wrote (`mapFromKeptSpans`) —
    // because that, not the automatic map, is the frame `first.doc.splits`
    // is actually expressed in.
    const second = applyUserCuts(first.doc, cutlist, map, first.map);

    expect(second.changed).toBe(false);
    expect(second.doc.splits[0]).toBeCloseTo(36, 6); // unchanged — NOT 32
  });

  // Found on the repro workdir alongside the double-shift bug: `priorMap`
  // differing from `map` for reasons OTHER than the user's own cut (there,
  // an unrelated fuzzy-blooper-marker change widened the automatic cutlist
  // between when render-props.json was last written and this run) makes a
  // SECOND stored cut land squarely inside the recut, which used to leak a
  // "cut start"/"cut end fell inside the new cut" report — describing a
  // value the function then throws away (`doc.cuts` is always restored to
  // the original). `reports` must only ever explain splits/pins.
  it("never reports on `cuts` themselves, even when priorMap drift pushes one onto an edge", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 100, kind: "keep" }];
    const map = new TimeMap(cutlist);
    // `priorMap` already has an unrelated 10s gap early on — standing in for
    // "the automatic cutlist changed for a reason that has nothing to do
    // with this run's user cut" (PLAN 2026-08-04 Task 4b verification).
    const priorMap = new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 5, srcOut: 15, kind: "remove", reason: "silence" },
      { srcIn: 15, srcOut: 100, kind: "keep" },
    ]);
    const doc = OverrideDocSchema.parse({
      cuts: [
        { startSec: 40, endSec: 44 },
        // In OLD (priorMap) output terms this sits inside [40,44) once
        // shifted through the 10s gap `priorMap` already accounts for and
        // `map` (this run's fresh automatic map) does not yet.
        { startSec: 42, endSec: 43 },
      ],
      splits: [70],
    });

    const result = applyUserCuts(doc, cutlist, map, priorMap);

    expect(result.reports.every((r) => !r.startsWith("cut start") && !r.startsWith("cut end"))).toBe(
      true,
    );
    expect(result.doc.cuts).toEqual(doc.cuts);
  });

  it("WOULD double-shift without `priorMap` (documents why the parameter exists)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }], splits: [40] });

    const first = applyUserCuts(doc, cutlist, map);
    // Omitting `priorMap` defaults it to `map` — the automatic map again,
    // NOT the frame `first.doc.splits` is anchored to.
    const second = applyUserCuts(first.doc, cutlist, map);

    expect(second.doc.splits[0]).toBeCloseTo(32, 6); // 36 - 4: the bug, pinned down
  });
});
