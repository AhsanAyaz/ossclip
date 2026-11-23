import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  doubleCutNotes,
  dropHiddenCues,
  pass1SplitPoints,
  resolveSplitPoints,
  splitCuesWithLanding,
  splitThenDropHidden,
  survivingLandings,
  type OverrideDoc,
} from "../src/overrides";
import { dropOverlappingAdded } from "../src/added-scenes";
import { applyUserCuts } from "../src/recut";
import { fillPlainCues } from "../src/fill";
import { carveKeptTakes } from "../src/kept-takes";
import { reconcileSplitAnchors, rekeyTakeHalves } from "../src/take-halves";
import { TimeMap } from "../src/timemap";
import type { Segment } from "../src/schema";
import type { SceneCue } from "../src/scene-schema";
import { FE_GRAPHICS, FE_SPLITS_A, KEPT, SPANS, clipStartsFor, feMap } from "./take-looks.fixtures";

/**
 * Each split cuts once, in one place (split-positions-by-source), through
 * produce's split steps on the FE Loop short (R7-8, R8-6):
 *
 *   `applyUserCuts` (prior map = the last render's) → the graphic pass
 *   (`splitThenDropHidden` over `pass1SplitPoints`) → the overlap drop →
 *   `survivingLandings` → fill with `clipStartsFor(map, KEPT)` → carve →
 *   pass 2 (`resolveSplitPoints` over the splits that did not land) →
 *   `doubleCutNotes` → `rekeyTakeHalves` → `reconcileSplitAnchors` → the
 *   final `applyOverrides` and hidden drop.
 *
 * The graphics are placed by SOURCE window and mapped onto each run's clock,
 * which is what assembly does: `shot-s1` is [10.085, 17.950] on the FE Loop
 * clock and [8.085, 15.950] once source [2, 4] is cut. The cutlist is the
 * fixture's spans as keeps, so `new TimeMap(cutlist)` is `feMap()`.
 */

const FE_CUTLIST: Segment[] = SPANS.map((s) => ({ srcIn: s.srcIn, srcOut: s.srcOut, kind: "keep" }));
const fe = feMap();
/** Each FE graphic's source window, read off the FE Loop clock once. */
const GRAPHIC_SRC = FE_GRAPHICS.map((g) => ({ g, srcIn: fe.toSource(g.startSec), srcOut: fe.toSource(g.endSec) }));
const graphicsOn = (map: TimeMap): SceneCue[] =>
  GRAPHIC_SRC.map(({ g, srcIn, srcOut }) => ({ ...g, startSec: map.toOutputClamped(srcIn), endSec: map.toOutputClamped(srcOut) }));

const parse = (raw: unknown): OverrideDoc => OverrideDocSchema.parse(raw);
/** overrides.json written and read back, as the next produce sees it. */
const reread = (doc: OverrideDoc): OverrideDoc => parse(JSON.parse(JSON.stringify(doc)));

interface ProduceRun {
  cues: SceneCue[];
  doc: OverrideDoc;
  map: TimeMap;
  /** D5, the reconcile, the re-key and the inert reports, in print order. */
  notes: string[];
  pass1Surviving: Set<string>;
  pass2Landed: Map<string, string>;
}

function produceRun(doc0: OverrideDoc, priorMap: TimeMap): ProduceRun {
  const cut = applyUserCuts(doc0, FE_CUTLIST, fe, priorMap);
  const map = cut.map;
  let doc = cut.doc;
  const { cues: editedCues } = applyOverrides(graphicsOn(map), doc);
  const pass1 = splitThenDropHidden(editedCues, doc, pass1SplitPoints(doc.splits, map));
  const visibleCues = dropOverlappingAdded(pass1.cues).cues;
  const pass1Surviving = survivingLandings(pass1.landedHost, visibleCues);
  const filled0 = fillPlainCues(visibleCues, { outputDurationSec: map.outputDuration, clipStarts: clipStartsFor(map, KEPT) });
  const { cues: filled } = carveKeptTakes(filled0, KEPT, map);
  const notLandedInPass1 = doc.splits.filter((s) => !pass1Surviving.has(s.id));
  const resolved = resolveSplitPoints(notLandedInPass1, map);
  const pass2 = splitCuesWithLanding(filled, resolved.points);
  const d5 = doubleCutNotes(doc.splits, pass1Surviving, pass1.landedHost, filled, map);
  const rekey = rekeyTakeHalves(doc, pass2.landed);
  const reconcile = reconcileSplitAnchors(
    rekey.doc,
    pass1Surviving,
    pass2.landed,
    resolved.points,
    editedCues.map((c) => ({ startSec: c.startSec, endSec: c.endSec })),
    map,
  );
  doc = reconcile.doc;
  const { cues: overridden } = applyOverrides(pass2.cues, doc);
  const { cues } = dropHiddenCues(overridden, doc);
  return {
    cues,
    doc,
    map,
    notes: [...cut.reports, ...resolved.reports, ...d5, ...rekey.notes, ...reconcile.notes],
    pass1Surviving,
    pass2Landed: pass2.landed,
  };
}

const ms = (t: number) => Math.round(t * 1000) / 1000;
/** The pieces of one root (`root` and every `root@sid`), millisecond-rounded. */
const windows = (cues: readonly SceneCue[], root: string) =>
  cues.filter((c) => c.id === root || c.id.startsWith(`${root}@`)).map((c) => [c.id, ms(c.startSec), ms(c.endSec)]);
const splitOf = (doc: OverrideDoc, id: string) => doc.splits.find((s) => s.id === id)!;

const fc1 = { at: 14.015, src: 16.5, id: "fc1" };
const fc2 = { at: 16.0, src: 14.0, id: "fc2" };
const CUT_2_4 = { startSec: 0, endSec: 0, src: { startSec: 2, endSec: 4 } };

describe("fc1 and fc2 on the FE Loop short (split-positions-by-source Tests, R7-10 runs 1–3)", () => {
  const doc0 = parse({ splits: [...FE_SPLITS_A, fc1, fc2] });
  const r1 = produceRun(doc0, fe);
  const r2 = produceRun(reread(r1.doc), r1.map);
  const r3 = produceRun(reread({ ...r2.doc, cuts: [CUT_2_4] }), r2.map);

  it("run 1: each split cuts once — exactly one shot-s1@fc2, at fc2's `at`", () => {
    // Before this design fc2 also cut shot-s1 at toOutput(14.0) = 11.515 in
    // pass 2, and two cues were named `shot-s1@fc2`.
    expect(r1.cues.map((c) => [c.id, ms(c.startSec), ms(c.endSec)])).toEqual([
      ["take-0", 0, 8.214],
      ["take-1", 8.214, 10.085],
      ["shot-s1", 10.085, 14.015],
      ["shot-s1@fc1", 14.015, 16],
      ["shot-s1@fc2", 16, 17.95],
      ["take-2", 17.95, 21.716],
      ["take-3", 21.716, 58.467],
      ["take-3@66055", 58.467, 60.764],
      ["take-4", 60.764, 70.82],
      ["take-5", 70.82, 109.569],
      ["take-6", 109.569, 122.138],
      ["take-7", 122.138, 151.62],
      ["take-kept-166219", 151.62, 160.549],
      ["take-9", 160.549, 161.291],
      ["take-10", 161.291, 165.247],
      ["added-1", 165.247, 166.891],
      ["take-10-1", 166.891, 168.079],
    ]);
  });

  it("run 1: fc2 chains onto fc1's piece, and both count as graphic landings", () => {
    expect(r1.pass1Surviving).toEqual(new Set(["fc1", "fc2"]));
    // 20752 is margin-skipped at the carved block's edge: it lands nowhere
    // and keeps its `at` (R8-7 m8).
    expect([...r1.pass2Landed.keys()]).toEqual(["66055"]);
    expect(splitOf(r1.doc, "20752").at).toBe(18.267);
    expect(r1.cues.some((c) => c.id.endsWith("@20752"))).toBe(false);
  });

  it("run 1: the D5 note, then the re-key, then both reconciles (R7-1, R8-7)", () => {
    expect(r1.notes).toEqual([
      "split fc2 cuts only shot-s1 now (it used to cut shot-s1 too)",
      "split 66055 now owns its framing",
      "split 66055 anchors reconciled (at 58.467s, source 66.055s)",
      "split fc2 anchors reconciled (at 16.000s, source 18.485s)",
    ]);
    expect(splitOf(r1.doc, "fc2")).toEqual({ at: 16.0, src: 18.485, id: "fc2" });
    // fc1's anchors are 0.12 ms apart: not rewritten.
    expect(splitOf(r1.doc, "fc1")).toEqual(fc1);
    expect(splitOf(r1.doc, "66055")).toMatchObject({ at: 58.467, src: 66.055 });
  });

  it("run 2 with no edit: the same cues, no notes, and a byte-identical overrides.json (Review Focus 2)", () => {
    expect(r2.cues).toEqual(r1.cues);
    expect(r2.notes).toEqual([]);
    expect(JSON.stringify(r2.doc)).toBe(JSON.stringify(r1.doc));
  });

  it("run 3, the cut src [2, 4]: fc1's and fc2's `at` follow it, and the cues sit there (D1)", () => {
    expect(Math.abs(splitOf(r3.doc, "fc1").at! - 12.015)).toBeLessThan(0.002);
    expect(Math.abs(splitOf(r3.doc, "fc2").at! - 14.0)).toBeLessThan(0.002);
    // `src` never moves.
    expect(splitOf(r3.doc, "fc1").src).toBe(16.5);
    expect(splitOf(r3.doc, "fc2").src).toBe(18.485);
    expect(windows(r3.cues, "shot-s1")).toEqual([
      ["shot-s1", 8.085, 12.015],
      ["shot-s1@fc1", 12.015, 14],
      ["shot-s1@fc2", 14, 15.95],
    ]);
    // The cut adds a clip start, so the takes renumber; the count is one
    // more than run 1's.
    expect(r3.cues.filter((c) => c.kind === "plain")).toHaveLength(r1.cues.filter((c) => c.kind === "plain").length + 1);
    // The remap is the only move: nothing is reconciled, nothing reported.
    expect(r3.notes).toEqual([]);
  });
});

describe("the other split shapes through both passes", () => {
  it("a take split with no graphic is cut at toOutput(src), as before", () => {
    const r = produceRun(parse({ splits: [{ at: 37.412, src: 45.0, id: "t1", ownFraming: true }] }), fe);
    expect(windows(r.cues, "take-3")).toEqual([
      ["take-3", 21.716, 37.412],
      ["take-3@t1", 37.412, 60.764],
    ]);
    expect(r.notes).toEqual([]);
  });

  it("an inert graphic split cuts nothing in either pass, then comes back exactly on restore (R7-3, R8-1, R8-2)", () => {
    const cut = { startSec: 0, endSec: 0, src: { startSec: 16, endSec: 17 } };
    const inert = produceRun(parse({ splits: [fc1], cuts: [cut] }), fe);
    // Not cut at its untouched `at` (14.015 sits inside shot-s1 on this
    // clock too), and skipped by pass 2 with the one inert report.
    expect(windows(inert.cues, "shot-s1")).toEqual([["shot-s1", 10.085, 16.95]]);
    expect(inert.pass1Surviving.size).toBe(0);
    expect(inert.notes).toEqual([
      'split "fc1" sits in removed material (source 16.500s) — inert until that material is kept again',
    ]);
    expect(splitOf(inert.doc, "fc1")).toEqual(fc1);

    const restored = produceRun(reread({ ...inert.doc, cuts: [] }), inert.map);
    expect(splitOf(restored.doc, "fc1")).toEqual(fc1);
    expect(windows(restored.cues, "shot-s1")).toEqual([
      ["shot-s1", 10.085, 14.015],
      ["shot-s1@fc1", 14.015, 17.95],
    ]);
    expect(restored.notes).toEqual([]);
  });

  it("an at-only (legacy) graphic split behaves as today: cut at `at`, never reconciled (Review Focus 1)", () => {
    const doc = parse({ splits: [{ at: 14.015, id: "legacy" }] });
    const r = produceRun(doc, fe);
    expect(windows(r.cues, "shot-s1")).toEqual([
      ["shot-s1", 10.085, 14.015],
      ["shot-s1@legacy", 14.015, 17.95],
    ]);
    expect(r.notes).toEqual([]);
    expect(r.doc.splits).toEqual(doc.splits);
  });

  it("a deleted half under a drifted split stays hidden, this run and the next (Review Focus 3)", () => {
    // fc2's `at` half is deleted. Its host piece `shot-s1@fc1` is shown, so
    // fc2 counts as landed and pass 2 does not cut shot-s1 at 11.515 —
    // before, that second cut minted a new `shot-s1@fc2` the hide matched.
    const doc = parse({ splits: [fc1, fc2], scenes: { "shot-s1@fc2": { hidden: true } } });
    const r1 = produceRun(doc, fe);
    expect(windows(r1.cues, "shot-s1")).toEqual([
      ["shot-s1", 10.085, 14.015],
      ["shot-s1@fc1", 14.015, 16],
    ]);
    // A take fills the deleted half's window.
    expect(windows(r1.cues, "take-1-1")).toEqual([["take-1-1", 16, 17.95]]);
    expect(r1.cues.some((c) => c.id === "shot-s1@fc2")).toBe(false);
    const r2 = produceRun(reread(r1.doc), r1.map);
    expect(r2.cues).toEqual(r1.cues);
    expect(r2.notes).toEqual([]);
  });

  it("both host pieces hidden: the split falls to pass 2 and cuts the take, and its `at` is not reconciled (R7-2, R8-3 guard)", () => {
    // `h` cut shot-s1 at 15.0 and both halves are deleted, so nothing it
    // made is shown; its `src` 19.0 plays at 16.515, inside the take now
    // filling that window. The old `at` sits in the (hidden) graphic's
    // window, so it is kept: written there it would cut that graphic on the
    // next run and bring a deleted half back.
    const h = { at: 15.0, src: 19.0, id: "h", ownFraming: true };
    const doc = parse({ splits: [h], scenes: { "shot-s1": { hidden: true }, "shot-s1@h": { hidden: true } } });
    const r = produceRun(doc, fe);
    expect(r.pass1Surviving.size).toBe(0);
    expect(windows(r.cues, "shot-s1")).toEqual([]);
    expect(windows(r.cues, "take-1")).toEqual([
      ["take-1", 8.214, 16.515],
      ["take-1@h", 16.515, 17.95],
    ]);
    expect(splitOf(r.doc, "h")).toEqual(h);
    expect(r.notes).toEqual([]);
  });

  it("a pass-2 landing whose point lies in a hidden graphic's window keeps its `at` (R8-3 guard)", () => {
    // `at` 20.0 touches no graphic; the point 16.515 is inside hidden shot-s1.
    const g = { at: 20.0, src: 19.0, id: "g", ownFraming: true };
    const r = produceRun(parse({ splits: [g], scenes: { "shot-s1": { hidden: true } } }), fe);
    expect(windows(r.cues, "take-1")).toEqual([
      ["take-1", 8.214, 16.515],
      ["take-1@g", 16.515, 17.95],
    ]);
    expect(splitOf(r.doc, "g")).toEqual(g);
    expect(r.notes).toEqual([]);
  });
});
