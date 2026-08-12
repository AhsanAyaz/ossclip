import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TimeMap } from "../src/timemap";
import {
  applyUserCuts,
  remapOverridesThroughRecut,
  resolveCutSourceRanges,
  subtractRangesFromCutlist,
} from "../src/recut";
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
  it("is the identity on splits and pinned timing, with nothing to report", () => {
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
            // Rides along to prove the pass-through below, not to be
            // remapped itself (PLAN 2026-08-04 Task 4c prerequisite
            // cleanup) — see the dedicated describe block further down.
            cuts: [{ startSec: 0, endSec: at(fracs[1] ?? 0.5) }],
          });

          const { doc: out, reports } = remapOverridesThroughRecut(doc, map, map);

          expect(reports).toEqual([]);
          expect(out.splits).toHaveLength(splits.length);
          out.splits.forEach((s, i) => expect(s.at).toBeCloseTo(splits[i]!, 6));
          expect(out.scenes.s!.timing!.startSec).toBeCloseTo(pinStart, 6);
          expect(out.scenes.s!.timing!.endSec).toBeCloseTo(map.outputDuration, 6);
          // Same reference, not just an equal value — proof nothing here
          // recomputed it.
          expect(out.cuts).toBe(doc.cuts);
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

        expect(out.splits[0]!.at).toBeCloseTo(t, 6);
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

        expect(out.splits[0]!.at).toBeCloseTo(t - (cutEnd - cutStart), 6);
        // `at` moved; `id` MUST NOT (§137). Recomputing it from the remapped
        // time is the field bug — it renames `${root}@${id}` and orphans
        // every override on that half.
        expect(out.splits[0]!.id).toBe(doc.splits[0]!.id);
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
        expect(out.splits[0]!.at).toBeCloseTo(cutStart, 6);
        expect(reports.length).toBe(1);
      }),
    );
  });

  it("the field case, concretely: `at` moves from 1.2 to 0.6 and the id stays \"1200\" (§137)", () => {
    // The bug this plan exists for, in one assertion. A split minted at
    // 1.2s names its half `scene-0@1200`; a 0.6s cut before it re-anchors
    // the split to 0.6s. Deriving the id from the CURRENT time would rename
    // the half to `scene-0@600`, orphaning the `hidden` override the user
    // saved against it — the deleted scene came back in the render.
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 0, 0.6);
    const doc = OverrideDocSchema.parse({ splits: [1.2] });
    expect(doc.splits[0]!.id).toBe("1200");

    const { doc: out } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.splits[0]!.at).toBeCloseTo(0.6, 6);
    expect(out.splits[0]!.id).toBe("1200");
  });
});

describe("remapOverridesThroughRecut — a split the re-cut squeezed below the minimum piece (§137)", () => {
  it("reports the split whose remapped `at` can no longer divide anything", () => {
    // The other half of the field case: a split at 0.6s re-anchors to 0 when
    // 0.6s is cut from the front. `splitCues` then finds no cue satisfying
    // `at >= startSec + SPLIT_MIN_PIECE_SEC` (output starts at 0, so nothing
    // can) and skips it — silently, until §137 — orphaning every override on
    // the half and resurrecting the scene the user deleted.
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 0, 0.6);
    const doc = OverrideDocSchema.parse({ splits: [0.6] });
    expect(doc.splits[0]!.id).toBe("600");

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    // 0.6s survives the cut (it is the kept edge, not inside it) — so the
    // ONLY thing said about it is that it is now unusable.
    expect(out.splits[0]!.at).toBeCloseTo(0, 6);
    expect(out.splits[0]!.id).toBe("600");
    expect(reports).toHaveLength(1);
    expect(reports.join("\n")).toMatch(/split "600".*too close to the start/i);
  });

  it("says it once, not twice, when the split ALSO landed inside the new cut", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 0.2, 0.8); // 0.5s is inside it
    const doc = OverrideDocSchema.parse({ splits: [0.5] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.splits[0]!.at).toBeCloseTo(0.2, 6);
    // Two DIFFERENT facts — it moved, and where it moved to is unusable —
    // so two reports. But only the first states the new time: repeating
    // "0.200s" in both reads as two separate moves of the same split.
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatch(/split "500" at 0\.500s fell inside the new cut — snapped to 0\.200s/);
    expect(reports[1]).toMatch(/^split "500" is too close to the start/);
    expect(reports[1]).not.toMatch(/0\.200s/);
  });

  it("stays quiet about a split that was ALREADY below the minimum and did not move", () => {
    // A pre-existing sub-minimum split is not news about this re-cut, and
    // `reports` is the "a value MOVED" channel (see `RecutRemap`). Saying it
    // anyway would fire on every identity re-cut, for a split the editor's
    // own SPLIT_MIN_PIECE_SEC guard refuses to create in the first place.
    const map = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
    const doc = OverrideDocSchema.parse({ splits: [{ at: 0.1, id: "100" }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, map, map);

    expect(out.splits[0]!.at).toBeCloseTo(0.1, 6);
    expect(reports).toEqual([]);
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

describe("remapOverridesThroughRecut — cuts are never remapped here (PLAN 2026-08-04 Task 4c prerequisite cleanup)", () => {
  it("passes doc.cuts through completely unchanged across a recut that would move a raw point", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 5, 8);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 30, endSec: 34 }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    // Same reference: proof this function never touches `cuts` at all —
    // resolving/re-anchoring a cut is `resolveCutSourceRanges`'s job
    // (through `priorMap`, in `applyUserCuts`), not this one's.
    expect(out.cuts).toBe(doc.cuts);
    expect(reports).toEqual([]);
  });

  it("does not report on a cut even when its own range falls entirely inside the new cut", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const newMap = cutOutputRange(oldMap, 20, 30);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 22, endSec: 26 }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.cuts).toBe(doc.cuts);
    expect(reports).toEqual([]);
  });
});

describe("subtractRangesFromCutlist", () => {
  it("matches cutOutputRange's spans for a single fresh cut, given the OUTPUT range pre-converted to source", () => {
    fc.assert(
      fc.property(freshCutScenario, ({ duration, cutStart, cutEnd }) => {
        const map = new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
        const viaFixture = cutOutputRange(map, cutStart, cutEnd);
        // The map here is the identity (single untouched span), so output
        // and source coincide — this is the one case a hand-derived source
        // range needs no separate conversion step to set up.
        const viaImpl = new TimeMap(
          subtractRangesFromCutlist(
            [{ srcIn: 0, srcOut: duration, kind: "keep" }],
            [{ start: cutStart, end: cutEnd }],
          ),
        );
        expect(viaImpl.outputDuration).toBeCloseTo(viaFixture.outputDuration, 6);
        expect(viaImpl.spans).toEqual(viaFixture.spans);
      }),
    );
  });

  it("tags the newly-removed span with reason \"user\" so formatCutReport lists it", () => {
    const out = subtractRangesFromCutlist(
      [{ srcIn: 0, srcOut: 60, kind: "keep" }],
      [{ start: 20, end: 24 }],
    );
    const removed = out.filter((s) => s.kind === "remove");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ srcIn: 20, srcOut: 24, reason: "user" });
  });

  it("subtracts two non-overlapping ranges independently", () => {
    const out = subtractRangesFromCutlist(
      [{ srcIn: 0, srcOut: 100, kind: "keep" }],
      [
        { start: 10, end: 15 },
        { start: 50, end: 52 },
      ],
    );
    const newMap = new TimeMap(out);
    expect(newMap.outputDuration).toBeCloseTo(100 - 5 - 2, 6);
    expect(out.filter((s) => s.kind === "remove" && s.reason === "user")).toHaveLength(2);
  });

  it("carves around an existing automatic `remove` segment untouched", () => {
    // An automatic cut already removed [20, 25); a range spanning [15, 30)
    // reaches across that existing gap.
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 20, kind: "keep" },
      { srcIn: 20, srcOut: 25, kind: "remove", reason: "silence" },
      { srcIn: 25, srcOut: 60, kind: "keep" },
    ];
    const out = subtractRangesFromCutlist(cutlist, [{ start: 15, end: 30 }]);
    // The automatic removal survives untouched, exactly once.
    expect(out.filter((s) => s.reason === "silence")).toHaveLength(1);
    expect(out.find((s) => s.reason === "silence")).toMatchObject({ srcIn: 20, srcOut: 25 });
    // The user range carved both sides of it: [15,20) and [25,30).
    const userCuts = out.filter((s) => s.reason === "user");
    expect(userCuts).toHaveLength(2);
    expect(userCuts).toContainEqual(expect.objectContaining({ srcIn: 15, srcOut: 20 }));
    expect(userCuts).toContainEqual(expect.objectContaining({ srcIn: 25, srcOut: 30 }));
  });

  it("no-ops on a degenerate range (end <= start)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const out = subtractRangesFromCutlist(cutlist, [{ start: 30, end: 30 }]);
    expect(out).toEqual(cutlist);
  });

  it("returns segments TimeMap accepts (sorted, non-overlapping) for many ranges", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 200, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: 8 }),
        (duration, fracs) => {
          const ranges = fracs.map((f) => {
            const start = f * duration * 0.9;
            return { start, end: start + duration * 0.05 };
          });
          // Must not throw — TimeMap's constructor is the sortedness/overlap check.
          expect(() =>
            new TimeMap(subtractRangesFromCutlist([{ srcIn: 0, srcOut: duration, kind: "keep" }], ranges)),
          ).not.toThrow();
        },
      ),
    );
  });
});

describe("resolveCutSourceRanges", () => {
  // The review's core drift scenario, verified on the real dogfood workdir:
  // an UNRELATED change (there, fuzzier blooper matching) grew the automatic
  // cutlist between when render-props.json was last written and this run.
  // `priorMap` (the identity here — nothing had drifted YET when the user
  // drew the cut) is what the cut's `startSec`/`endSec` are actually
  // expressed against; `map` (drifted: a 5.8s retake removal at the very
  // start) is NOT. Using `map` to interpret the cut would land it 5.8s away
  // from where the user pointed — exactly the bug finding 1 reported.
  it("converts a fresh cut through priorMap, not this run's drifted map", () => {
    const priorMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const driftedCutlist: Segment[] = [
      { srcIn: 0, srcOut: 5.8, kind: "remove", reason: "retake" },
      { srcIn: 5.8, srcOut: 60, kind: "keep" },
    ];
    const map = new TimeMap(driftedCutlist);
    const cut = { startSec: 31, endSec: 33.5 };

    const { ranges, cuts, reports } = resolveCutSourceRanges([cut], priorMap, map);

    // Via priorMap (correct): output 31/33.5 map straight through, the
    // identity. Via map (the bug): output 31 -> source 5.8+31=36.8.
    expect(ranges).toEqual([{ start: 31, end: 33.5 }]);
    expect(cuts[0]!.src).toEqual({ startSec: 31, endSec: 33.5 });
    // startSec/endSec — the historical record of what the user drew — are
    // untouched.
    expect(cuts[0]!.startSec).toBe(31);
    expect(cuts[0]!.endSec).toBe(33.5);
    expect(reports).toEqual([]);
  });

  it("uses `src` directly when present, ignoring startSec/endSec and priorMap entirely", () => {
    const priorMap = new TimeMap([{ srcIn: 0, srcOut: 200, kind: "keep" }]);
    const map = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    // startSec/endSec are deliberately nonsense — proving they're unused
    // once `src` is present (they're display/history only, per the schema).
    const cut = { startSec: 999, endSec: 999.1, src: { startSec: 10, endSec: 14 } };

    const { ranges, cuts, reports } = resolveCutSourceRanges([cut], priorMap, map);

    expect(ranges).toEqual([{ start: 10, end: 14 }]);
    expect(cuts[0]).toBe(cut); // untouched — no new object, nothing to write back
    expect(reports).toEqual([]);
  });

  it("falls back to `map` WITH a report when priorMap is unavailable and the cut has no src", () => {
    // A non-identity map so the fallback is provably `map`, not some
    // coincidental match.
    const map = new TimeMap([{ srcIn: 10, srcOut: 70, kind: "keep" }]);
    const cut = { startSec: 20, endSec: 24 };

    const { ranges, cuts, reports } = resolveCutSourceRanges([cut], null, map);

    expect(ranges).toEqual([{ start: 30, end: 34 }]); // map.toSource(20/24) = 10+20 / 10+24
    expect(cuts[0]!.src).toEqual({ startSec: 30, endSec: 34 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("no render-props");
  });

  it("resolves multiple cuts independently and excludes only the degenerate one from ranges", () => {
    const priorMap = new TimeMap([{ srcIn: 0, srcOut: 100, kind: "keep" }]);
    const map = priorMap;
    const cuts = [
      { startSec: 10, endSec: 12 },
      { startSec: 50, endSec: 50 }, // degenerate — nothing to remove
      { startSec: 70, endSec: 75 },
    ];

    const { ranges, cuts: resolved } = resolveCutSourceRanges(cuts, priorMap, map);

    expect(ranges).toEqual([
      { start: 10, end: 12 },
      { start: 70, end: 75 },
    ]);
    // All three still come back with a resolved `src`, degenerate included —
    // nothing about resolution itself is lossy, only the subtraction step.
    expect(resolved).toHaveLength(3);
    expect(resolved[1]!.src).toEqual({ startSec: 50, endSec: 50 });
  });
});

describe("applyUserCuts", () => {
  it("is a true no-op when there are no cuts and priorMap already matches map", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ splits: [10] });

    const result = applyUserCuts(doc, cutlist, map, map);

    expect(result.changed).toBe(false);
    expect(result.reports).toEqual([]);
    expect(result.removedSec).toBe(0);
    expect(result.doc).toEqual(doc);
  });

  it("is also a no-op with priorMap: null and no cuts (first-ever produce)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ splits: [10] });

    const result = applyUserCuts(doc, cutlist, map, null);

    expect(result.changed).toBe(false);
    expect(result.reports).toEqual([]);
  });

  // A fresh cut resolving its `src` for the first time is itself a real,
  // persistable change — even with nothing else in the doc to re-anchor —
  // because WITHOUT writing `src` back, the next run has no stable way to
  // reinterpret `startSec`/`endSec` (review fix wave finding 1's Bug A,
  // generalized: an output-seconds pair means nothing once its own render-
  // props frame is gone).
  it("marks `changed` on a first-time cut resolution even with nothing else to re-anchor", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }] });

    // priorMap === map: nothing had drifted before this, the ordinary
    // "user just drew this cut against the current render-props" case.
    const result = applyUserCuts(doc, cutlist, map, map);

    expect(result.removedSec).toBeCloseTo(4, 6);
    expect(result.map.outputDuration).toBeCloseTo(56, 6);
    expect(result.changed).toBe(true);
    expect(result.doc.cuts[0]!.src).toEqual({ startSec: 20, endSec: 24 });
    expect(result.doc.cuts[0]!.startSec).toBe(20); // untouched
    expect(result.reports).toEqual([]);
  });

  it("re-anchors a split after the cut and reports nothing (a clean shift)", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({
      cuts: [{ startSec: 20, endSec: 24 }],
      splits: [40],
    });

    const result = applyUserCuts(doc, cutlist, map, map);

    expect(result.changed).toBe(true);
    expect(result.reports).toEqual([]);
    expect(result.doc.splits[0]!.at).toBeCloseTo(36, 6); // 40 - 4
  });

  it("re-anchors a pin the cut swallowed and reports it", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({
      cuts: [{ startSec: 20, endSec: 30 }],
      scenes: { "scene-1": { timing: { startSec: 22, endSec: 26 } } },
    });

    const result = applyUserCuts(doc, cutlist, map, map);

    expect(result.changed).toBe(true);
    expect(result.reports).toHaveLength(2);
    expect(result.doc.scenes["scene-1"]!.timing!.startSec).toBeCloseTo(20, 6);
    expect(result.doc.scenes["scene-1"]!.timing!.endSec).toBeCloseTo(20, 6);
  });

  it("is idempotent once `src` is resolved: a stable re-run makes no further changes", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    const doc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }], splits: [40] });

    const first = applyUserCuts(doc, cutlist, map, map);
    expect(first.changed).toBe(true); // src resolved + split re-anchored

    // Second run: automatic cutlist unchanged, `priorMap` is `first.map` —
    // exactly what render-props.json now says (the frame `first.doc` is
    // anchored to). `first.doc.cuts[0]` already has `src`, so it's used
    // directly, independent of `priorMap`/`map` this time.
    const second = applyUserCuts(first.doc, cutlist, map, first.map);

    expect(second.changed).toBe(false);
    expect(second.doc).toEqual(first.doc);
    expect(second.map.outputDuration).toBeCloseTo(first.map.outputDuration, 6);
  });

  // Review fix wave finding 3: emptying `cuts` (the editor's Restore
  // gesture) must give the split back exactly what the user originally set,
  // not leave it stranded in the post-cut frame — even though `cuts.length`
  // is back to zero and there is nothing left to drive a subtraction.
  it("restoring a cut (cuts emptied again) re-anchors splits/pins back to their pre-cut values", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist); // stable automatic map across both runs

    const initialDoc = OverrideDocSchema.parse({ cuts: [{ startSec: 20, endSec: 24 }], splits: [40] });
    const run1 = applyUserCuts(initialDoc, cutlist, map, map);
    expect(run1.doc.splits[0]!.at).toBeCloseTo(36, 6);

    // Restore: the editor removes the cut, everything else (including the
    // now-re-anchored split) is whatever run1 wrote back.
    const restoredDoc: typeof run1.doc = { ...run1.doc, cuts: [] };
    const run2 = applyUserCuts(restoredDoc, cutlist, map, run1.map);

    expect(run2.changed).toBe(true);
    // Back to 40 — `remapPoint` maps 36 through run1.map (the short, post-
    // cut frame) to source, then through `map` (the full, uncut frame) back
    // to output: source = 24 + (36-20) = 40 (past the old cut in the short
    // frame's second span); `map` is identity, so output = source = 40.
    expect(run2.doc.splits[0]!.at).toBeCloseTo(40, 6);
  });

  // The other half of finding 3's parenthetical: automatic-cutlist drift
  // re-anchors splits/pins even on a workdir that has never had a user cut.
  it("re-anchors a split when the automatic cutlist alone drifts, with cuts always empty", () => {
    const priorMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const doc = OverrideDocSchema.parse({ splits: [40] });

    // Baseline: nothing has drifted yet.
    const stable = applyUserCuts(doc, [{ srcIn: 0, srcOut: 60, kind: "keep" }], priorMap, priorMap);
    expect(stable.changed).toBe(false);

    // Now the automatic cutlist grows a 5s retake removal at the start —
    // nothing the user did; `priorMap` (what render-props.json still says)
    // is unchanged.
    const driftedCutlist: Segment[] = [
      { srcIn: 0, srcOut: 5, kind: "remove", reason: "retake" },
      { srcIn: 5, srcOut: 60, kind: "keep" },
    ];
    const driftedMap = new TimeMap(driftedCutlist);

    const result = applyUserCuts(doc, driftedCutlist, driftedMap, priorMap);

    expect(result.changed).toBe(true);
    expect(result.reports).toEqual([]); // a clean shift, nothing clamped
    expect(result.doc.splits[0]!.at).toBeCloseTo(35, 6); // 40 - 5, the drift
  });

  it("tolerates float noise between priorMap and map without marking `changed`", () => {
    const cutlist: Segment[] = [{ srcIn: 0, srcOut: 60, kind: "keep" }];
    const map = new TimeMap(cutlist);
    // 1e-9s off — far below EPS (1e-6), the kind of noise a JSON round-trip
    // of a TimeMap's spans can introduce (review fix wave, Minor finding).
    const priorMap = new TimeMap([{ srcIn: 0, srcOut: 60 + 1e-9, kind: "keep" }]);
    const doc = OverrideDocSchema.parse({ splits: [30] });

    const result = applyUserCuts(doc, cutlist, map, priorMap);

    expect(result.changed).toBe(false);
  });
});
