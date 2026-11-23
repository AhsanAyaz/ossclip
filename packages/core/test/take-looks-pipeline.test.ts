import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type OverrideDoc } from "../src/overrides";
import { lookAt, pieceSourceRanges, setTakeLook, type TakeLook } from "../src/take-looks";
import { TimeMap } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";
import {
  FE_GRAPHICS,
  FE_SPLITS_A,
  FE_SPLITS_B,
  HALF_VIDEO,
  SPANS,
  TAKE_2_VIDEO,
  feMap,
  pieceAt,
  runTakePipeline,
} from "./take-looks.fixtures";

/**
 * A migrated doc through produce's take steps on changed clocks
 * (take-looks-by-source, spec "Core, take-looks-pipeline.test.ts", R7-2):
 * the look on `[66.055, 68.353]` stays on that footage whatever renumbers
 * the takes around it — the positional-id failure this design replaces.
 */

const parse = (raw: unknown): OverrideDoc => OverrideDocSchema.parse(raw);
const HALF_LOOK: TakeLook = { video: HALF_VIDEO };
const looked = (extra: Record<string, unknown> = {}) =>
  parse({
    splits: FE_SPLITS_B,
    takeLooks: [{ srcIn: 66.055, srcOut: 68.353, look: HALF_LOOK }],
    ...extra,
  });

/** The FE Loop spans with `cuts` (source seconds) also removed — the clock
 * produce builds after the author adds those cuts. */
function cutMap(cuts: ReadonlyArray<[number, number]>): TimeMap {
  const keeps: Array<{ srcIn: number; srcOut: number; kind: "keep" }> = [];
  for (const sp of SPANS) {
    let from = sp.srcIn;
    for (const [a, b] of cuts) {
      if (b <= from || a >= sp.srcOut) continue;
      if (a > from) keeps.push({ srcIn: from, srcOut: a, kind: "keep" });
      from = Math.max(from, b);
    }
    if (sp.srcOut > from) keeps.push({ srcIn: from, srcOut: sp.srcOut, kind: "keep" });
  }
  return new TimeMap(keeps);
}

/** The graphics after a cut of `removed` seconds ending at output `atOut`:
 * the ones after it move up, as their word anchors would. */
const shiftedAfter = (atOut: number, removed: number): SceneCue[] =>
  FE_GRAPHICS.map((g) => (g.startSec >= atOut ? { ...g, startSec: g.startSec - removed, endSec: g.endSec - removed } : g));

describe("a migrated doc's look follows its footage (take-looks-by-source L2)", () => {
  it("after a cut of src [2, 4] in front, the piece holding 66.055 shows it — under its new id", () => {
    const map = cutMap([[2, 4]]);
    const r = runTakePipeline(looked(), { map, graphics: shiftedAfter(0.7, 2) });
    const piece = pieceAt(r.cues, map, 66.1);
    // The extra span renumbers every take after it: the id the look was
    // edited under is gone, and the look did not care.
    expect(piece?.id).toBe("take-4@66055");
    expect(piece?.video).toEqual(HALF_VIDEO);
    expect(pieceAt(r.cues, map, 60)?.video).toBeUndefined();
    expect(r.cues.filter((c) => c.video !== undefined).map((c) => c.id)).toEqual(["take-4@66055"]);
    expect(r.migration.changed).toBe(false);
  });

  it("a graphic inserted over src [67, 67.5]: both visible pieces show it", () => {
    const map = feMap();
    const inserted: SceneCue = {
      id: "scene-x",
      layout: "blurred-behind",
      component: "StatCard",
      props: { label: "X", value: "1" },
      startSec: map.toOutput(67)!,
      endSec: map.toOutput(67.5)!,
    };
    const r = runTakePipeline(looked(), { map, graphics: [...FE_GRAPHICS, inserted] });
    const before = pieceAt(r.cues, map, 66.1);
    const after = pieceAt(r.cues, map, 67.8);
    expect([before?.id, after?.id]).toEqual(["take-3@66055", "take-3-1"]);
    expect(before?.video).toEqual(HALF_VIDEO);
    expect(after?.video).toEqual(HALF_VIDEO);
    expect(pieceAt(r.cues, map, 60)?.video).toBeUndefined();
  });

  it("a cut through it at src [67, 67.2]: both pieces show it, and the next take does not", () => {
    const map = cutMap([[67, 67.2]]);
    const r = runTakePipeline(looked(), { map, graphics: shiftedAfter(feMap().toOutput(67.2)!, 0.2) });
    const before = pieceAt(r.cues, map, 66.1);
    const after = pieceAt(r.cues, map, 67.8);
    // The new span start makes 67.2 a clip start: the second piece is a
    // whole new `take-4`, and the old take-4's footage is `take-5` now.
    expect([before?.id, after?.id]).toEqual(["take-3@66055", "take-4"]);
    expect(before?.video).toEqual(HALF_VIDEO);
    expect(after?.video).toEqual(HALF_VIDEO);
    expect(pieceAt(r.cues, map, 72)?.id).toBe("take-5");
    expect(pieceAt(r.cues, map, 72)?.video).toBeUndefined();
  });
});

describe("a second run with no edits changes nothing (Review Focus 2)", () => {
  // Through JSON and the schema, as the next produce reads what this one
  // wrote.
  const reread = (doc: OverrideDoc) => parse(JSON.parse(JSON.stringify(doc)));

  it("on a migrated doc: identical cues and doc, nothing to write", () => {
    const first = runTakePipeline(looked());
    const second = runTakePipeline(reread(first.doc));
    expect(second.cues).toEqual(first.cues);
    expect(second.doc).toEqual(first.doc);
    expect(second.migration.changed).toBe(false);
    expect(second.rekey.changed).toBe(false);
  });

  it("from the legacy FE Loop doc: the migrating run writes, the next one does not, and takeLooks is byte-equal", () => {
    const legacy = parse({
      scenes: { "take-2": { video: TAKE_2_VIDEO }, "take-2@66055": { video: HALF_VIDEO } },
      splits: FE_SPLITS_A,
    });
    const first = runTakePipeline(legacy);
    expect(first.migration.changed).toBe(true);
    const second = runTakePipeline(reread(first.doc));
    // Both halves of produce's write gate stay down (`takeLooksMigrated`,
    // `splitHalvesChanged`), so overrides.json is not rewritten.
    expect(second.migration.changed).toBe(false);
    expect(second.rekey.changed).toBe(false);
    expect(second.migration.notes).toEqual([]);
    expect(JSON.stringify(second.doc.takeLooks)).toBe(JSON.stringify(first.doc.takeLooks));
    expect(second.doc).toEqual(first.doc);
    // The same pieces with the same looks. Not whole-cue equality: in the
    // migrating run `applyOverrides` still met the two take entries and
    // left its merge's empty `props` on those cues, which nothing renders.
    const shown = (cues: readonly SceneCue[]) =>
      cues.map((c) => [c.id, c.startSec, c.endSec, c.layout, c.video, c.pip, c.captionY, c.captionScale]);
    expect(shown(second.cues)).toEqual(shown(first.cues));
  });
});

describe("phase 1's step 4 is legacy-only (take-looks-by-source L5)", () => {
  // A ⌘B split in look mode is unflagged (`addSplit` stops flagging). Were
  // step 4 still to run it would flag it, announce "now owns its framing"
  // and earn a write on every such split — for framing no take key holds
  // any more.
  const split40 = { at: 32.412, src: 40, id: "40000" };

  it("a migrated doc's unflagged take split is neither flagged nor materialized", () => {
    const r = runTakePipeline(looked({ splits: [...FE_SPLITS_B, split40] }));
    expect(r.rekey.doc.splits.find((s) => s.id === "40000")?.ownFraming).toBeUndefined();
    expect(r.rekey.notes.some((n) => n.includes("owns its framing"))).toBe(false);
    expect(r.rekey.changed).toBe(false);
    expect(Object.keys(r.doc.scenes)).toEqual([]);
    // Both halves of the split take resolve from source time.
    expect(r.cues.some((c) => c.id === "take-3@40000")).toBe(true);
  });

  it("the same split on a legacy doc is still flagged — the marker is the gate", () => {
    const r = runTakePipeline(parse({ splits: [...FE_SPLITS_B, split40] }));
    expect(r.rekey.doc.splits.find((s) => s.id === "40000")?.ownFraming).toBe(true);
    expect(r.rekey.notes).toContain("split 40000 now owns its framing");
  });
});

describe("restoring cut material after a look write (R6-3, R7-2)", () => {
  const B: TakeLook = { video: { scale: 1.4, dx: 10 } };
  /** The editor's write on the half while a live cut is in place: over the
   * piece's ranges on the cut clock, which `setTakeLook` widens to their
   * hull. */
  const writeOnCutClock = (cuts: ReadonlyArray<[number, number]>, srcEnd: number) => {
    const map = cutMap(cuts);
    const window = { startSec: map.toOutput(66.055)!, endSec: map.toOutput(srcEnd)! };
    const ranges = pieceSourceRanges(window, map);
    const doc = looked();
    return { ranges, doc: { ...doc, takeLooks: setTakeLook(doc.takeLooks!, ranges, B) } };
  };

  it("material restored from INSIDE a piece takes that piece's look — the older one cannot come back", () => {
    const { ranges, doc } = writeOnCutClock([[67, 67.2]], 68.3526);
    // A live-clock piece across the seam: two ranges, one hull.
    expect(ranges).toEqual([
      { srcIn: 66.055, srcOut: 67 },
      { srcIn: 67.2, srcOut: 68.353 },
    ]);
    expect(doc.takeLooks).toEqual([{ srcIn: 66.055, srcOut: 68.353, look: B }]);
    // The cut is undone: the FE Loop clock again.
    const map = feMap();
    const r = runTakePipeline(parse(JSON.parse(JSON.stringify(doc))), { map });
    expect(lookAt(r.doc.takeLooks!, [{ srcIn: 67, srcOut: 67.2 }])).toEqual(B);
    expect(pieceAt(r.cues, map, 67.1)?.video).toEqual(B.video);
  });

  it("material restored at a piece's EDGE shows the look it had before it was cut (declared limit)", () => {
    const { ranges, doc } = writeOnCutClock([[68, 68.3526]], 68);
    expect(ranges).toEqual([{ srcIn: 66.055, srcOut: 68 }]);
    // Restored with a split at its edge, so a piece plays exactly that
    // material: it shows the OLDER look, while the written piece keeps B.
    const map = feMap();
    const restored = parse({
      ...JSON.parse(JSON.stringify(doc)),
      splits: [...FE_SPLITS_B, { src: 68, id: "68000" }],
    });
    const r = runTakePipeline(restored, { map });
    expect(pieceAt(r.cues, map, 66.1)?.video).toEqual(B.video);
    const edge = pieceAt(r.cues, map, 68.2);
    expect(edge?.id).toBe("take-3@68000");
    expect(edge?.video).toEqual(HALF_VIDEO);
  });
});
