import { describe, expect, it } from "vitest";
import { OverrideDocSchema, ownFramingSplitIds, type OverrideDoc } from "../src/overrides";
import { applyTakeLooks } from "../src/take-looks";
import { migrateTakeLooks } from "../src/take-looks-migrate";
import { TimeMap } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";
import {
  FE_SPLITS_A,
  FE_SPLITS_B,
  HALF_VIDEO,
  TAKE_2_VIDEO,
  TAKE_CLIP_STARTS,
  clipStartsFor,
  feMap,
  runTakePipeline,
} from "./take-looks.fixtures";

/**
 * `migrateTakeLooks` (take-looks-by-source L3), through produce's take steps
 * on the FE Loop clock (spec "Core, take-looks-migration.test.ts"). Docs are
 * parsed through `OverrideDocSchema` the way produce reads overrides.json.
 * "Before" is the second `applyOverrides`' output — the pipeline with the
 * migration and the look pass skipped — and the migration's whole promise
 * is that the looked cues deep-equal it (L3 "Output unchanged").
 */

const parse = (raw: unknown): OverrideDoc => OverrideDocSchema.parse(raw);
const run = (doc: OverrideDoc) => runTakePipeline(doc, { clipStarts: TAKE_CLIP_STARTS });
const takeKeys = (doc: OverrideDoc) => Object.keys(doc.scenes).filter((k) => k.startsWith("take-"));

/** (a) The real FE Loop workdir: `take-2@66055` keyed to the root it no
 * longer lands in, its split unflagged. A graphic edit rides along to show
 * the strip touches take keys only. */
const fixtureA = () =>
  parse({
    scenes: {
      "shot-s1": { captionY: 0.8 },
      "take-2": { video: TAKE_2_VIDEO },
      "take-2@66055": { video: HALF_VIDEO },
    },
    splits: FE_SPLITS_A,
  });

/** (b) The same project after phase 1 ran once: the half re-keyed to
 * `take-3@66055` and its split flagged. */
const fixtureB = () =>
  parse({
    scenes: {
      "shot-s1": { captionY: 0.8 },
      "take-2": { video: TAKE_2_VIDEO },
      "take-3@66055": { video: HALF_VIDEO },
    },
    splits: FE_SPLITS_B,
  });

const FE_LOOKS = [
  { srcIn: 20.752, srcOut: 24.518, look: { video: TAKE_2_VIDEO } },
  { srcIn: 66.055, srcOut: 68.353, look: { video: HALF_VIDEO } },
];

describe("the fixture is produce's (R6-9, R7-10)", () => {
  it("the clip-start formula on these spans gives the copy's takeClipStarts", () => {
    // Guards the pipeline tests, which compute their clip starts with the
    // formula on other clocks: on this one it must be produce's real list.
    expect(clipStartsFor(feMap(), [{ srcIn: 166.219, srcOut: 180.539 }])).toEqual(TAKE_CLIP_STARTS);
  });

  it("the legacy pipeline renders the real cue list: take-2 and take-3@66055 framed", () => {
    const r = run(fixtureA());
    const plain = r.overridden.filter((c) => c.kind === "plain");
    expect(plain.map((c) => c.id)).toEqual([
      "take-0",
      "take-1",
      "take-2",
      "take-3",
      "take-3@66055",
      "take-4",
      "take-5",
      "take-6",
      "take-7",
      "take-kept-166219",
      "take-9",
      "take-10",
      "take-10-1",
    ]);
    expect(plain.filter((c) => c.video !== undefined).map((c) => [c.id, c.video])).toEqual([
      ["take-2", TAKE_2_VIDEO],
      ["take-3@66055", HALF_VIDEO],
    ]);
  });
});

describe("migrateTakeLooks (take-looks-by-source L3)", () => {
  for (const [name, fixture] of [
    ["(a) pre-phase-1, unflagged take-2@66055", fixtureA],
    ["(b) post-phase-1, flagged take-3@66055", fixtureB],
  ] as const) {
    it(`1 ${name}: two looks, cues unchanged, every in-scope take field stripped`, () => {
      const r = run(fixture());
      expect(r.migration.changed).toBe(true);
      expect(r.doc.takeLooks).toEqual(FE_LOOKS);
      // In (a) "before" already shows take-3@66055 framed: rekeyTakeHalves
      // runs in both pipelines (R4-S6).
      expect(r.cues).toEqual(r.overridden);
      expect(takeKeys(r.doc)).toEqual([]);
      expect(r.doc.scenes["shot-s1"]?.captionY).toBe(0.8);
      expect(r.migration.notes).toEqual(["moved the look of 2 take piece(s) onto source time"]);
    });
  }

  it("1 (a): phase 1's notes come first, exactly as the field check expects", () => {
    expect(run(fixtureA()).rekey.notes).toEqual([
      "split 66055 now owns its framing",
      "edit for take-2@66055 re-keyed to take-3@66055 — its split now falls in take-3",
      "split 66055 moved to 58.467s on this cut",
    ]);
  });

  it("R6-7: a flagged half inheriting captionY gets it in its look, beside its own framing", () => {
    const doc = fixtureB();
    doc.scenes["take-3"] = { props: {}, elements: {}, captionY: 0.3 };
    const r = run(doc);
    // The flag stops the half inheriting the root's framing, not its
    // caption placement (take-framing-identity P1) — `effectiveOverride`
    // with the own-framing set is what the migration reads (N2).
    expect(r.overridden.find((c) => c.id === "take-3@66055")?.captionY).toBe(0.3);
    expect(r.doc.takeLooks).toEqual([
      { srcIn: 20.752, srcOut: 24.518, look: { video: TAKE_2_VIDEO } },
      { srcIn: 29.304, srcOut: 66.055, look: { captionY: 0.3 } },
      { srcIn: 66.055, srcOut: 68.353, look: { video: HALF_VIDEO, captionY: 0.3 } },
    ]);
    expect(r.cues).toEqual(r.overridden);
    expect(takeKeys(r.doc)).toEqual([]);
    expect(r.migration.notes).toEqual(["moved the look of 3 take piece(s) onto source time"]);
  });

  it("2: an unflagged half inheriting from its root takes the root's look, and both keys are stripped", () => {
    // A kept block's half: `rekeyTakeHalves` leaves `take-kept-*` alone, so
    // its split stays unflagged and the half inherits the root's framing.
    const doc = fixtureB();
    doc.splits.push({ src: 170, id: "170000" });
    doc.scenes["take-kept-166219"] = { props: {}, elements: {}, video: { scale: 1.5 } };
    doc.scenes["take-kept-166219@170000"] = { props: {}, elements: {}, captionY: 0.4 };
    const r = run(doc);
    const half = r.overridden.find((c) => c.id === "take-kept-166219@170000");
    expect(half?.video).toEqual({ scale: 1.5 });
    expect(r.doc.takeLooks).toEqual([
      FE_LOOKS[0],
      FE_LOOKS[1],
      { srcIn: 167.648, srcOut: 170, look: { video: { scale: 1.5 } } },
      { srcIn: 170, srcOut: 176.577, look: { video: { scale: 1.5 }, captionY: 0.4 } },
    ]);
    expect(r.cues).toEqual(r.overridden);
    expect(takeKeys(r.doc)).toEqual([]);
  });

  it("3: keys naming no current piece are left as they are and listed in the note (S1, m12)", () => {
    const doc = fixtureB();
    // An inactive kept block (its cleanup range is removed by a cut) and
    // `take-8`, which the kept block replaced on this clock.
    doc.scenes["take-kept-20490"] = { props: {}, elements: {}, captionScale: 1.2 };
    doc.scenes["take-8"] = { props: {}, elements: {}, video: { scale: 3 } };
    // A dead key with nothing in scope is not a look edit: not listed.
    doc.scenes["take-12"] = { props: {}, elements: {}, hidden: true };
    const r = run(doc);
    expect(r.doc.scenes["take-kept-20490"]).toEqual(doc.scenes["take-kept-20490"]);
    expect(r.doc.scenes["take-8"]).toEqual(doc.scenes["take-8"]);
    expect(r.doc.scenes["take-12"]).toEqual(doc.scenes["take-12"]);
    expect(r.doc.takeLooks).toEqual(FE_LOOKS);
    expect(r.migration.notes).toEqual([
      "moved the look of 2 take piece(s) onto source time",
      "left 2 look edit(s) on takes not in this cut: take-8, take-kept-20490",
    ]);
  });

  it("3b: the strip covers the ROOT a piece resolves through, and keeps that entry's other fields", () => {
    // Called directly with a lone half: in produce the root's own lead
    // piece is always there too, so only this isolates rule 3's "and its
    // root" — a root left holding `captionY` would be a second, ignored
    // copy of a look that now lives on source time.
    const map = new TimeMap([{ srcIn: 0, srcOut: 20, kind: "keep" }]);
    const doc = parse({
      scenes: { "take-5": { captionY: 0.2, hidden: true } },
      splits: [{ at: 10, src: 10, id: "s1" }],
    });
    const half: SceneCue = { id: "take-5@s1", kind: "plain", layout: "full-bleed", startSec: 10, endSec: 20 };
    const out = migrateTakeLooks(doc, [half], map, new Set());
    expect(out.doc.takeLooks).toEqual([{ srcIn: 10, srcOut: 20, look: { captionY: 0.2 } }]);
    expect(out.doc.scenes["take-5"]).toEqual({ props: {}, elements: {}, hidden: true });
    expect(out.notes).toEqual(["moved the look of 1 take piece(s) onto source time"]);
  });

  it("3c: a piece with a look but no source ranges keeps its key, and the note names it (Task 2 review, Minor 1)", () => {
    // Near-unreachable in produce (a non-zero plain window on this run's
    // map always plays source), so called directly: a window past the
    // map's end plays nothing. Stripping before the write would lose the
    // look silently — gone from the key, never on source time, unlisted.
    const map = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
    const doc = parse({ scenes: { "take-1": { captionY: 0.3 }, "take-4": { video: { scale: 2 } } } });
    const onMap: SceneCue = { id: "take-1", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10 };
    const offMap: SceneCue = { id: "take-4", kind: "plain", layout: "full-bleed", startSec: 20, endSec: 30 };
    const out = migrateTakeLooks(doc, [onMap, offMap], map, new Set());
    expect(out.doc.takeLooks).toEqual([{ srcIn: 0, srcOut: 10, look: { captionY: 0.3 } }]);
    expect(out.doc.scenes["take-1"]).toBeUndefined();
    expect(out.doc.scenes["take-4"]).toEqual(doc.scenes["take-4"]);
    expect(out.notes).toEqual([
      "moved the look of 1 take piece(s) onto source time",
      "left 1 look edit(s) on takes not in this cut: take-4",
    ]);
  });

  it("4: the marker stops a second migration — the doc comes back untouched", () => {
    const first = run(fixtureA());
    const again = migrateTakeLooks(first.doc, first.overridden, feMap(), ownFramingSplitIds(first.doc.splits));
    expect(again).toEqual({ doc: first.doc, notes: [], changed: false });
    expect(again.doc).toBe(first.doc);
    // Even with take fields present — the marker, not their absence, is
    // what says "migrated" (S2).
    const withFields = { ...first.doc, scenes: { ...first.doc.scenes, "take-2": { props: {}, elements: {}, video: { scale: 9 } } } };
    const blocked = migrateTakeLooks(withFields, first.overridden, feMap(), new Set());
    expect(blocked.doc).toBe(withFields);
    expect(blocked.changed).toBe(false);
  });

  it("5 (N2): a half with its own dx only, whose root has scale, gets both — the cue is unchanged", () => {
    const doc = fixtureB();
    doc.splits.push({ src: 170, id: "170000" });
    doc.scenes["take-kept-166219"] = { props: {}, elements: {}, video: { scale: 1.5 } };
    doc.scenes["take-kept-166219@170000"] = { props: {}, elements: {}, video: { dx: 40 } };
    const r = run(doc);
    expect(r.doc.takeLooks?.at(-1)).toEqual({
      srcIn: 170,
      srcOut: 176.577,
      look: { video: { scale: 1.5, dx: 40 } },
    });
    expect(r.overridden.find((c) => c.id === "take-kept-166219@170000")?.video).toEqual({ scale: 1.5, dx: 40 });
    expect(r.cues).toEqual(r.overridden);
    expect(takeKeys(r.doc)).toEqual([]);
  });

  it("6 (S11, Review Focus 5): a stale editor's legacy save migrates again to the same looks and cues", () => {
    const first = run(fixtureA());
    // The editor saves the legacy doc it still holds: the marker is gone and
    // the in-scope fields are back on the take keys the migration stripped.
    const { takeLooks: _marker, ...unmarked } = first.doc;
    const restored = parse({
      ...unmarked,
      scenes: { ...unmarked.scenes, "take-2": { video: TAKE_2_VIDEO }, "take-3@66055": { video: HALF_VIDEO } },
    });
    const again = run(restored);
    expect(again.migration.changed).toBe(true);
    expect(again.doc.takeLooks).toEqual(first.doc.takeLooks);
    expect(again.cues).toEqual(first.cues);
    expect(again.doc.scenes).toEqual(first.doc.scenes);
  });

  it("7 (S5): a doc with no take looks still gets `takeLooks: []` once, and the next run changes nothing", () => {
    const r = run(parse({ scenes: { "shot-s1": { captionY: 0.8 } }, splits: FE_SPLITS_B }));
    expect(r.doc.takeLooks).toEqual([]);
    expect(r.migration.changed).toBe(true);
    expect(r.migration.notes).toEqual(["moved the look of 0 take piece(s) onto source time"]);
    expect(r.cues).toEqual(r.overridden);
    // Through the schema, as the next produce reads what this one wrote:
    // `[]` survives (presence is the marker).
    const next = run(parse(JSON.parse(JSON.stringify(r.doc))));
    expect(next.migration.changed).toBe(false);
    expect(next.migration.notes).toEqual([]);
    expect(next.doc.takeLooks).toEqual([]);
  });
});

describe("the minted-kept layout exception (L3 rule 1, R4-S7)", () => {
  // Graphics leave only a 0.5 s gap, under the fill's 0.6 s floor, so there
  // is no plain take anywhere: the carve mints the kept block from scratch
  // with no neighbour to borrow from, and gives it "video-top".
  const map = new TimeMap([{ srcIn: 0, srcOut: 20, kind: "keep" }]);
  const graphic = (id: string, startSec: number, endSec: number): SceneCue => ({
    id,
    layout: "video-top",
    component: "StatCard",
    props: { label: "X", value: "1" },
    startSec,
    endSec,
  });
  const runMinted = (doc: OverrideDoc) =>
    runTakePipeline(doc, {
      map,
      graphics: [graphic("scene-1", 0, 10), graphic("scene-2", 10.5, 20)],
      kept: [{ srcIn: 10, srcOut: 10.5 }],
    });

  it("a minted block's base layout is moved into its look, so it still renders video-top", () => {
    const r = runMinted(parse({}));
    const minted = r.overridden.find((c) => c.id === "take-kept-10000");
    expect(minted?.layout).toBe("video-top");
    expect(r.doc.takeLooks).toEqual([{ srcIn: 10, srcOut: 10.5, look: { layout: "video-top" } }]);
    expect(r.cues).toEqual(r.overridden);
    expect(r.migration.notes).toEqual(["moved the look of 1 take piece(s) onto source time"]);
    // Without the exception the look pass would make it full-bleed (L2).
    expect(applyTakeLooks(r.overridden, [], map).find((c) => c.id === "take-kept-10000")?.layout).toBe(
      "full-bleed",
    );
  });

  it("an id-keyed layout wins over the base: the exception only fills an absent layout", () => {
    const r = runMinted(parse({ scenes: { "take-kept-10000": { layout: "split-left" } } }));
    expect(r.overridden.find((c) => c.id === "take-kept-10000")?.layout).toBe("split-left");
    expect(r.doc.takeLooks).toEqual([{ srcIn: 10, srcOut: 10.5, look: { layout: "split-left" } }]);
    expect(r.cues).toEqual(r.overridden);
    expect(r.doc.scenes["take-kept-10000"]).toBeUndefined();
  });
});
