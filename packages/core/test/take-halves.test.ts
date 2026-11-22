import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  effectiveOverride,
  isParkedOverrideKey,
  ownFramingSplitIds,
  parkedOverrideBaseKey,
  resolveSplitPoints,
  splitCuesWithLanding,
  type OverrideDoc,
  type ResolvedSplitPoint,
} from "../src/overrides";
import { rekeyTakeHalves } from "../src/take-halves";
import { fillPlainCues } from "../src/fill";
import { TimeMap } from "../src/timemap";

/**
 * `rekeyTakeHalves` (take-framing-identity P2), one rule per test. Inputs are
 * parsed through `OverrideDocSchema` the way produce reads overrides.json, so
 * the legacy/flagged split shapes are the real ones.
 */

const parse = (raw: unknown): OverrideDoc => OverrideDocSchema.parse(raw);
const landedOf = (pairs: Array<[string, string]>) => new Map(pairs);
/** What the half resolves to on screen: its own entry over its root's, with
 * the doc's own-framing set — the read `applyOverrides` does. */
const framing = (doc: OverrideDoc, id: string) => {
  const o = effectiveOverride(doc.scenes, id, ownFramingSplitIds(doc.splits));
  return { video: o?.video, pip: o?.pip };
};
const splitOf = (doc: OverrideDoc, id: string) => doc.splits.find((s) => s.id === id)!;

describe("rekeyTakeHalves (take-framing-identity P2)", () => {
  // The FE Loop short (2026-11-22): `take-2@66055`'s split resolves inside
  // take-3 on the final clock, so the half renders as `take-3@66055` and
  // the edit orphans.
  const feLoop = () =>
    parse({
      scenes: {
        "take-2": { video: { scale: 2.2, dx: 814.4 } },
        "take-2@66055": { video: { scale: 2.2, dx: -664.8 } },
      },
      splits: [{ at: 58.784, src: 66.055, id: "66055" }],
    });
  const feLanded = landedOf([["66055", "take-3"]]);
  const fePoints: ResolvedSplitPoint[] = [{ at: 58.467, id: "66055" }];

  it("1: the FE Loop half re-keys to the root its split landed in, framing intact", () => {
    const out = rekeyTakeHalves(feLoop(), feLanded, fePoints, []);
    expect(out.doc.scenes["take-3@66055"]?.video).toEqual({ scale: 2.2, dx: -664.8 });
    expect(out.doc.scenes["take-2@66055"]).toBeUndefined();
    expect(out.doc.scenes["take-2"]).toEqual(feLoop().scenes["take-2"]);
    expect(splitOf(out.doc, "66055").ownFraming).toBe(true);
    expect(out.changed).toBe(true);
    // Steps 4, 5 and 7 in order — the third is the `at` refresh (R5-B1).
    expect(out.notes).toEqual([
      "split 66055 now owns its framing",
      "edit for take-2@66055 re-keyed to take-3@66055 — its split now falls in take-3",
      "split 66055 moved to 58.467s on this cut",
    ]);
  });

  it("1b: a framed new root does not leak into the mover, and the mover is not parked", () => {
    const doc = feLoop();
    doc.scenes["take-3"] = { props: {}, elements: {}, video: { dy: 50 } };
    const out = rekeyTakeHalves(doc, feLanded, fePoints, []);
    expect(out.doc.scenes["take-3@66055"]?.video).toEqual({ scale: 2.2, dx: -664.8 });
    expect(framing(out.doc, "take-3@66055").video).toEqual({ scale: 2.2, dx: -664.8 });
    expect(Object.keys(out.doc.scenes).some((k) => k.endsWith("#orphaned"))).toBe(false);
  });

  it("2: a legacy half with no entry, still in its root, gets the root's framing", () => {
    const doc = parse({
      scenes: { "take-1": { video: { scale: 1.8, dx: 10 }, pip: { x: 0.2 } } },
      splits: [{ at: 12, src: 12, id: "12000" }],
    });
    const before = framing(doc, "take-1@12000");
    const out = rekeyTakeHalves(doc, landedOf([["12000", "take-1"]]), [{ at: 12, id: "12000" }], []);
    expect(out.doc.scenes["take-1@12000"]).toEqual({
      props: {},
      elements: {},
      video: { scale: 1.8, dx: 10 },
      pip: { x: 0.2 },
    });
    expect(splitOf(out.doc, "12000").ownFraming).toBe(true);
    expect(framing(out.doc, "take-1@12000")).toEqual(before);
    expect(out.notes).toEqual(["split 12000 now owns its framing"]);
    expect(out.changed).toBe(true);
  });

  it("3: a legacy half with only `dx` gets the root's `scale` beside it", () => {
    const doc = parse({
      scenes: { "take-1": { video: { scale: 2 } }, "take-1@s": { video: { dx: -30 } } },
      splits: [{ at: 12, src: 12, id: "s" }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-1"]]), [{ at: 12, id: "s" }], []);
    expect(out.doc.scenes["take-1@s"]?.video).toEqual({ scale: 2, dx: -30 });
    expect(framing(out.doc, "take-1@s").video).toEqual({ scale: 2, dx: -30 });
  });

  it("4: with an incumbent, another candidate parks and the incumbent's framing holds", () => {
    const doc = parse({
      scenes: {
        "take-2": { video: { scale: 1.5 } },
        "take-3": { video: { dy: 7 } },
        "take-3@s": { video: { scale: 1.2 } },
        "take-2@s": { video: { dx: 5 }, captionY: 0.3 },
      },
      splits: [{ at: 30, src: 30, id: "s" }],
    });
    const before = framing(doc, "take-3@s");
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(framing(out.doc, "take-3@s")).toEqual(before);
    expect(out.doc.scenes["take-2@s"]).toBeUndefined();
    // Parked whole and materialized against its OWN root (take-2), from the
    // input doc — so a later rescue is self-contained.
    expect(out.doc.scenes["take-2@s#orphaned"]).toEqual({
      props: {},
      elements: {},
      video: { scale: 1.5, dx: 5 },
      captionY: 0.3,
    });
    // Parked through overrides.ts's own builder, so the warning loop sees it.
    const parked = Object.keys(out.doc.scenes).filter(isParkedOverrideKey);
    expect(parked.map(parkedOverrideBaseKey)).toEqual(["take-2@s"]);
    expect(out.notes).toContain("edit for take-2@s parked — take-3@s already has its own edit");
    expect(out.changed).toBe(true);
  });

  it("5: of two movers the lower take index moves — numeric, not lexicographic", () => {
    const doc = parse({
      scenes: { "take-10@s": { video: { dx: 1 } }, "take-2@s": { video: { dx: 2 } } },
      splits: [{ at: 30, src: 30, id: "s", ownFraming: true }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-5"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc.scenes["take-5@s"]?.video).toEqual({ dx: 2 });
    expect(out.doc.scenes["take-10@s#orphaned"]?.video).toEqual({ dx: 1 });
    expect(out.notes).toEqual([
      "edit for take-2@s re-keyed to take-5@s — its split now falls in take-5",
      "edit for take-10@s parked — take-5@s already has its own edit",
    ]);
  });

  it("5: `take-N` sorts before its own `take-N-k` piece", () => {
    const doc = parse({
      scenes: { "take-2-1@s": { video: { dx: 1 } }, "take-2@s": { video: { dx: 2 } } },
      splits: [{ at: 30, src: 30, id: "s", ownFraming: true }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-5"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc.scenes["take-5@s"]?.video).toEqual({ dx: 2 });
    expect(out.doc.scenes["take-2-1@s#orphaned"]?.video).toEqual({ dx: 1 });
  });

  it("5: `take-N-k` pieces sort by k, numerically", () => {
    const doc = parse({
      scenes: { "take-2-10@s": { video: { dx: 1 } }, "take-2-2@s": { video: { dx: 2 } } },
      splits: [{ at: 30, src: 30, id: "s", ownFraming: true }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-5"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc.scenes["take-5@s"]?.video).toEqual({ dx: 2 });
    expect(out.doc.scenes["take-2-10@s#orphaned"]?.video).toEqual({ dx: 1 });
  });

  const heldSlot = (ownFraming?: true) =>
    parse({
      scenes: {
        "take-3@s": { video: { scale: 1.2 } },
        "take-2": { video: { scale: 1.5 } },
        "take-2@s": { video: { dx: 5 } },
        "take-2@s#orphaned": { video: { dx: 99 } },
      },
      splits: [{ at: 30, src: 30, id: "s", ...(ownFraming ? { ownFraming } : {}) }],
    });
  const orphanNote = "edit for take-2@s left as an orphan — its park slot is taken";

  it("6: a held park slot leaves the entry as an orphan; on a flagged split nothing changes", () => {
    const doc = heldSlot(true);
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(out.notes).toEqual([orphanNote]);
    expect(out.changed).toBe(false);
    expect(out.doc).toEqual(doc);
  });

  it("6b: on a legacy split the first call materializes and flags; the second changes nothing", () => {
    const first = rekeyTakeHalves(heldSlot(), landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(first.changed).toBe(true);
    expect(first.notes).toEqual(["split s now owns its framing", orphanNote]);
    // A left-in-place orphan is materialized like any candidate (R5-S9).
    expect(first.doc.scenes["take-2@s"]?.video).toEqual({ scale: 1.5, dx: 5 });
    expect(first.doc.scenes["take-2@s#orphaned"]?.video).toEqual({ dx: 99 });
    const second = rekeyTakeHalves(first.doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(second.changed).toBe(false);
    expect(second.notes).toEqual([orphanNote]);
    expect(second.doc).toEqual(first.doc);
  });

  it("6c: a flag-only legacy migration — nothing to copy, nothing moves — still counts as changed", () => {
    const doc = parse({ splits: [{ at: 30, src: 30, id: "s" }] });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(out.changed).toBe(true);
    // The landed root has no framing: an empty entry is not stored.
    expect(out.doc.scenes).toEqual({});
    expect(splitOf(out.doc, "s").ownFraming).toBe(true);
    expect(out.notes).toEqual(["split s now owns its framing"]);
  });

  it("7: graphic, added, kept-block and parked keys are never candidates", () => {
    const doc = parse({
      scenes: {
        "scene-3@s": { video: { dx: 1 } },
        "added-1@s": { video: { dx: 2 } },
        "take-kept-1@s": { video: { dx: 3 } },
        "take-2@s#orphaned": { video: { dx: 4 } },
      },
      splits: [{ at: 30, src: 30, id: "s", ownFraming: true }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc).toEqual(doc);
    expect(out.notes).toEqual([]);
    expect(out.changed).toBe(false);
  });

  it("8: the move carries the whole entry — `hidden` and `timing` included (R4-S3)", () => {
    const doc = parse({
      scenes: {
        "take-2@s": {
          hidden: true,
          timing: { startSec: 30, endSec: 34 },
          props: { a: 1 },
          video: { scale: 2 },
        },
      },
      splits: [{ at: 30, src: 30, id: "s", ownFraming: true }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-3"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc.scenes["take-3@s"]).toEqual(doc.scenes["take-2@s"]);
  });

  it("9: a second call on its own output changes nothing (Review Focus 3)", () => {
    const first = rekeyTakeHalves(feLoop(), feLanded, fePoints, []);
    const second = rekeyTakeHalves(first.doc, feLanded, fePoints, []);
    expect(second.changed).toBe(false);
    expect(second.notes).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });

  it("10: a cut after the split (landing root unchanged) only materializes the legacy half", () => {
    const doc = parse({
      scenes: { "take-2": { video: { scale: 1.5 } }, "take-2@s": { video: { dx: 5 } } },
      splits: [{ at: 30, src: 30, id: "s" }],
    });
    const out = rekeyTakeHalves(doc, landedOf([["s", "take-2"]]), [{ at: 30, id: "s" }], []);
    expect(out.doc.scenes["take-2@s"]?.video).toEqual({ scale: 1.5, dx: 5 });
    expect(Object.keys(out.doc.scenes).sort()).toEqual(["take-2", "take-2@s"]);
    expect(out.notes).toEqual(["split s now owns its framing"]);
  });

  describe("11b: `at` refresh (take splits only, R5-B1)", () => {
    const doc = parse({
      splits: [
        { at: 10, src: 12, id: "a", ownFraming: true },
        { src: 12.5, id: "b", ownFraming: true },
        { at: 20, src: 22, id: "c", ownFraming: true },
        { at: 30, src: 31, id: "d", ownFraming: true },
        { at: 40, src: 41, id: "e", ownFraming: true },
      ],
    });
    const points: ResolvedSplitPoint[] = [
      { at: 9.5, id: "a" },
      { at: 11, id: "b" },
      { at: 19, id: "c" },
      { at: 29, id: "d" },
      { at: 40.0004, id: "e" },
    ];
    // `c` did not land; `d` landed in a graphic.
    const landed = landedOf([
      ["a", "take-1"],
      ["b", "take-1"],
      ["d", "scene-1"],
      ["e", "take-4"],
    ]);
    const out = rekeyTakeHalves(doc, landed, points, []);

    it("a landed {at, src} take split gets `at` = the resolved point", () => {
      expect(splitOf(out.doc, "a").at).toBe(9.5);
      expect(out.notes).toEqual(["split a moved to 9.500s on this cut"]);
      expect(out.changed).toBe(true);
    });

    it("src-only, not-landed and graphic-root splits are untouched (R4-B1, B2)", () => {
      for (const id of ["b", "c", "d"]) expect(splitOf(out.doc, id), id).toEqual(splitOf(doc, id));
    });

    it("a difference under 0.5 ms writes nothing", () => {
      expect(splitOf(out.doc, "e")).toEqual(splitOf(doc, "e"));
      const only = rekeyTakeHalves(
        parse({ splits: [{ at: 40, src: 41, id: "e", ownFraming: true }] }),
        landedOf([["e", "take-4"]]),
        [{ at: 40.0004, id: "e" }],
        [],
      );
      expect(only.changed).toBe(false);
      expect(only.notes).toEqual([]);
    });
  });

  describe("11d: graphic exclusion (R6-B1, R7-B1)", () => {
    const run = (windows: Array<{ startSec: number; endSec: number }>) =>
      rekeyTakeHalves(
        parse({ splits: [{ at: 10, src: 12, id: "a", ownFraming: true }] }),
        landedOf([["a", "take-1"]]),
        [{ at: 8, id: "a" }],
        windows,
      );

    it("keeps `at` when the stored `at` lies in a graphic window — that split cuts the graphic today", () => {
      const out = run([{ startSec: 9.5, endSec: 11 }]);
      expect(splitOf(out.doc, "a").at).toBe(10);
      expect(out.changed).toBe(false);
      expect(out.notes).toEqual([]);
    });

    it("the window is closed: a stored `at` on its edge also stays", () => {
      expect(splitOf(run([{ startSec: 5, endSec: 10 }]).doc, "a").at).toBe(10);
    });

    it("keeps `at` when the resolved point lies in a (hidden) graphic's window", () => {
      // A hidden graphic's window still counts: the new `at` would split it on
      // the next run and bring a deleted half back (R7-B1).
      const out = run([{ startSec: 7.5, endSec: 8.5 }]);
      expect(splitOf(out.doc, "a").at).toBe(10);
      expect(out.changed).toBe(false);
    });

    it("a window touching neither point does not block the refresh", () => {
      expect(splitOf(run([{ startSec: 20, endSec: 25 }]).doc, "a").at).toBe(8);
    });
  });

  it("11e: two runs refresh `at` on each clock; the half's key and framing hold", () => {
    // The take holding the split is take-2 on both clocks: run 2's cut trims
    // the head of take-0, which moves every later output time back 2 s but
    // adds no clip start, so no ordinal changes.
    const oneRun = (doc: OverrideDoc, map: TimeMap) => {
      const filled = fillPlainCues([], {
        outputDurationSec: map.outputDuration,
        clipStarts: map.spans.map((s) => s.outIn),
      });
      const { points } = resolveSplitPoints(doc.splits, map);
      const { cues, landed } = splitCuesWithLanding(filled, points);
      const out = rekeyTakeHalves(doc, landed, points, []);
      const applied = applyOverrides(cues, out.doc);
      return { out, half: applied.cues.find((c) => c.id === "take-2@s"), orphans: applied.orphans };
    };
    const run1Map = new TimeMap([
      { srcIn: 0, srcOut: 10, kind: "keep" },
      { srcIn: 12, srcOut: 22, kind: "keep" },
      { srcIn: 24, srcOut: 44, kind: "keep" },
    ]);
    const run2Map = new TimeMap([
      { srcIn: 2, srcOut: 10, kind: "keep" },
      { srcIn: 12, srcOut: 22, kind: "keep" },
      { srcIn: 24, srcOut: 44, kind: "keep" },
    ]);
    const doc0 = parse({
      scenes: { "take-2@s": { video: { scale: 2, dx: -40 } } },
      // A stale `at` from an older clock; `src` 30 is output 26 on run 1.
      splits: [{ at: 25, src: 30, id: "s", ownFraming: true }],
    });

    const r1 = oneRun(doc0, run1Map);
    expect(splitOf(r1.out.doc, "s").at).toBe(26);
    expect(r1.half?.video).toEqual({ scale: 2, dx: -40 });
    expect(r1.orphans).toEqual([]);

    const r2 = oneRun(r1.out.doc, run2Map);
    expect(splitOf(r2.out.doc, "s").at).toBe(24);
    expect(r2.out.notes).toEqual(["split s moved to 24.000s on this cut"]);
    expect(r2.half?.video).toEqual({ scale: 2, dx: -40 });
    expect(r2.orphans).toEqual([]);

    // Same clock again: the refreshed value equals the stored `at`.
    const r3 = oneRun(r2.out.doc, run2Map);
    expect(r3.out.changed).toBe(false);
    expect(r3.out.notes).toEqual([]);
    expect(r3.out.doc).toEqual(r2.out.doc);
  });
});
