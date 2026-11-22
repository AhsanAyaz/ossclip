import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  atSplitPoints,
  dropHiddenCues,
  itemTimingRoots,
  reclampPinnedTiming,
  resolveItemTimings,
  resolveSplitPoints,
  resolveSrcTimingPins,
  splitCues,
  splitThenDropHidden,
  type OverrideDoc,
} from "../src/overrides";
import { addedSceneToScene, dropOverlappingAdded, isAddedKey, previewAddedScenes } from "../src/added-scenes";
import { assembleScenes } from "../src/assemble";
import type { CaptionLine } from "../src/captions";
import { applyCleanupChoices, dismissedRemovals, vetoedRemovals } from "../src/cutlist";
import { fillPlainCues } from "../src/fill";
import { carveKeptTakes } from "../src/kept-takes";
import { applyUserCuts } from "../src/recut";
import { livePreviewMap, retimeForPreview } from "../src/retime-preview";
import type { Scene, SceneCue } from "../src/scene-schema";
import type { Segment, Transcript, Word } from "../src/schema";
import { mapFromKeptSpans, TimeMap } from "../src/timemap";

/**
 * Preview equals render (graphic-editor-modal G7, Test plan "Parity"): for
 * one doc, one transcript and one set of cleanup choices, item times come
 * out the same from produce's ordering and from the editor preview's.
 *
 * Both pipelines below are the real call sequences, step for step, with the
 * real core functions — `produce.ts` ~5100-5580 and App.tsx's live memo
 * ~1393-1677 with `finishOnClock` — and `resolveItemTimings` placed where
 * §4 puts it:
 *   produce: roots taken from the unsplit list at the FIRST
 *     `applyOverrides` (both maps the run's), the resolve after the SECOND,
 *     on the run's map (coordinator ruling on Task 3, option (a));
 *   editor:  roots taken from the unsplit list at the memo's first
 *     `applyOverrides` (legacy pins on the old clock), the resolve on the
 *     live clock after `finishOnClock`'s `applyOverrides` — or on its early
 *     exit, when nothing live changed.
 * Left out, each because it cannot touch `reveal`: source-text routing (no
 * regions here, so it hands the cues back), caption building and the
 * caption edit layers, the stage previews, and the editor's landscape
 * layout remap (portrait here). `previewBaseCues` and `previewDropCovered`
 * are App's thin wrappers over `previewAddedScenes` and
 * `dropOverlappingAdded`, called directly. Produce's one-time `splits[].src`
 * backfill (produce.ts, after `applyUserCuts`) is not modelled either: it
 * only fills a src-less legacy split, and every fixture here dual-writes
 * `{at, src}`, as the editor's split gesture does.
 *
 * The LAST render is part of the input: the editor's base cues are what it
 * baked (`baseSceneCues` = produce's `routed.cues` on its clock), and its
 * spans are both the editor's old clock and the next run's `priorMap`.
 */
interface Run {
  words: Word[];
  /** The automatic cutlist, as `cutlistProposed` stores it. */
  proposal: Segment[];
  /** The plan scenes (added graphics come from `doc.addedScenes`). */
  scenes: Scene[];
  /** overrides.json now: what the editor holds, and what the next run reads. */
  doc: OverrideDoc;
  /** The cleanup choices the last render was made with (default: none). */
  rendered?: OverrideDoc["cleanup"];
}

const transcriptOf = (run: Run): Transcript => ({ language: "en", words: run.words });

/** The last render's clock: the proposal with the choices it was made with. */
const lastRenderMap = (run: Run): TimeMap => new TimeMap(applyCleanupChoices(run.proposal, run.rendered));

/** `produce.ts`'s two assemblies (fix-wave I1): the plan, and the added
 * graphics on their own, merged in time order. */
function assembleRun(run: Run, map: TimeMap): SceneCue[] {
  const starts = run.words.map((w) => ({ srcStart: w.start }));
  const added = (run.doc.addedScenes ?? []).flatMap((e) => {
    const c = addedSceneToScene(e, starts);
    return "scene" in c ? [c.scene] : [];
  });
  const plan = assembleScenes(run.scenes.filter((s) => !isAddedKey(s.id)), transcriptOf(run), map).cues;
  const own = assembleScenes(added, transcriptOf(run), map).cues;
  return [...plan, ...own].sort((a, b) => a.startSec - b.startSec);
}

/** `vetoedRemovals`/`dismissedRemovals` as the ranges both pipelines carve. */
function keptRangesOf(proposal: Segment[], cleanup: OverrideDoc["cleanup"]) {
  return [
    ...vetoedRemovals(proposal, cleanup).map((s) => ({ srcIn: s.srcIn, srcOut: s.srcOut })),
    ...dismissedRemovals(proposal, cleanup).map((s) => ({ srcIn: s.srcIn, srcOut: s.srcOut, dismissed: true })),
  ];
}

interface Outcome {
  cues: SceneCue[];
  notes: string[];
}

function producePipeline(run: Run): Outcome {
  // The run's clock: the proposal, the cleanup choices, then the user cuts
  // with the last render as `priorMap`, which re-anchors legacy pins and
  // splits onto this clock (`applyUserCuts`).
  let cutlist: Segment[] = run.proposal;
  let map = new TimeMap(cutlist);
  const cleanupVetoed = vetoedRemovals(cutlist, run.doc.cleanup);
  const cleanupDismissed = dismissedRemovals(cutlist, run.doc.cleanup);
  if (cleanupVetoed.length > 0 || cleanupDismissed.length > 0) {
    cutlist = applyCleanupChoices(cutlist, run.doc.cleanup);
    map = new TimeMap(cutlist);
  }
  const cut = applyUserCuts(run.doc, cutlist, map, lastRenderMap(run));
  map = cut.map;
  const doc = cut.doc;

  const routed = assembleRun(run, map);
  const pinnedDoc = resolveSrcTimingPins(doc, map);
  const { cues: editedCues } = applyOverrides(routed, pinnedDoc.doc);
  // §4: the roots from this unsplit list, on the run's map, against the raw
  // (re-anchored) doc — not `pinnedDoc.doc`, whose src pins have become
  // output seconds. The resolve itself waits for the second pass below.
  const roots = itemTimingRoots(editedCues, doc, run.words, map, map);
  const { cues: shownCues } = splitThenDropHidden(editedCues, doc);
  const visibleCues = dropOverlappingAdded(shownCues).cues;
  const { cues: reclamped } = reclampPinnedTiming(visibleCues);
  const keptRangesForCarve = keptRangesOf(run.proposal, doc.cleanup);
  const keptEdgeStarts = keptRangesForCarve.flatMap((r) => {
    const a = map.toOutput(r.srcIn);
    const b = map.toOutput(r.srcOut);
    return [...(a !== null ? [a] : []), ...(b !== null ? [b] : [])];
  });
  const filled0 = fillPlainCues(reclamped, {
    outputDurationSec: map.outputDuration,
    clipStarts: [...map.spans.map((s) => s.outIn), ...keptEdgeStarts],
  });
  const { cues: filled } = carveKeptTakes(filled0, keptRangesForCarve, map);
  const split = splitCues(filled, resolveSplitPoints(doc.splits, map).points);
  const { cues: mergedCues } = applyOverrides(split, pinnedDoc.doc);
  // After the second pass, as the editor resolves after its last one: a
  // half's own swap has already happened, so `withSwappedReveal` sees the
  // same cue in both pipelines (resolved before the split, a reveal-less
  // root's swapped half came out all-null here and reveal-less there).
  const timed = resolveItemTimings(mergedCues, doc, run.words, map, roots);
  return { cues: dropHiddenCues(timed.cues, doc).cues, notes: timed.notes };
}

function editorPipeline(run: Run): Outcome & { exit: "early" | "main" } {
  const oldMap = lastRenderMap(run);
  const doc = run.doc;
  const producedCues = assembleRun(run, oldMap).filter((c) => c.kind !== "plain");
  const oldClockMap = mapFromKeptSpans(oldMap.spans);
  const baseCues = previewAddedScenes({
    baseCues: producedCues,
    added: doc.addedScenes ?? [],
    issueIds: new Set(),
    transcript: transcriptOf(run),
    map: oldClockMap,
  }).cues;
  const liveRecut = livePreviewMap(run.proposal, doc.cleanup, doc.cuts, oldMap.spans);
  const liveMap = liveRecut?.newMap ?? oldClockMap;

  const oldClockDoc = resolveSrcTimingPins(doc, oldClockMap).doc;
  const { cues: graphicCues } = applyOverrides(baseCues, oldClockDoc);
  // §4: the roots, from this unsplit list; windows from stored source data,
  // a legacy pin through the old clock it was written on.
  const roots = itemTimingRoots(graphicCues, doc, run.words, oldClockMap, liveMap);
  const { cues: shownCues } = splitThenDropHidden(graphicCues, doc);
  const visibleCues = dropOverlappingAdded(shownCues).cues;
  const filled = fillPlainCues(visibleCues, {
    outputDurationSec: oldMap.outputDuration,
    clipStarts: oldMap.spans.map((s) => s.outIn),
  });
  const splitted = splitCues(filled, atSplitPoints(doc.splits));
  const { cues: mergedCues } = applyOverrides(splitted, oldClockDoc);
  const { cues } = dropHiddenCues(mergedCues, doc);

  const captionLines: CaptionLine[] = [];
  let props = { outputDurationSec: oldMap.outputDuration, captionLines, sceneCues: cues };
  let clockMap = oldClockMap;
  if (liveRecut) {
    const { fields } = retimeForPreview(props, liveRecut.oldMap, liveRecut.newMap);
    props = { ...props, ...fields };
    clockMap = liveRecut.newMap;
  }

  // finishOnClock. `transcriptDoc` is taken as loaded, so the caption
  // rebuild's trigger is `ranges.length > 0 || liveRecut !== null`.
  const ranges = keptRangesOf(run.proposal, doc.cleanup);
  const srcOnly = doc.splits.filter((s) => s.at === undefined && s.src !== undefined);
  const rebuildCaptions = ranges.length > 0 || liveRecut !== null;
  if (ranges.length === 0 && srcOnly.length === 0 && !rebuildCaptions) {
    const timed = resolveItemTimings(props.sceneCues, doc, run.words, clockMap, roots);
    return { ...timed, exit: "early" };
  }
  const carved = carveKeptTakes(props.sceneCues, ranges, clockMap);
  const resolved = resolveSplitPoints(srcOnly, clockMap);
  const splitted2 = splitCues(carved.cues, resolved.points);
  const pinned = resolveSrcTimingPins(doc, clockMap);
  const { cues: merged } = applyOverrides(splitted2, pinned.doc);
  const timed = resolveItemTimings(merged, doc, run.words, clockMap, roots);
  return { ...timed, exit: "main" };
}

/** What G7 is about, per graphic cue: which component, its item times, and
 * the synced/paced prop the resolve may force. */
const itemState = (cues: readonly SceneCue[]) =>
  Object.fromEntries(
    cues
      .filter((c) => c.kind !== "plain")
      .map((c) => [c.id, { component: c.component, itemAtSec: c.reveal?.itemAtSec, reveal: c.props?.reveal }]),
  );

/** Both pipelines, asserted equal; produce's outcome returned so each case
 * can also show it exercised what it names. */
function expectParity(run: Run, exit: "early" | "main") {
  const produce = producePipeline(run);
  const editor = editorPipeline(run);
  expect(editor.exit).toBe(exit);
  expect(itemState(editor.cues)).toEqual(itemState(produce.cues));
  expect(editor.notes).toEqual(produce.notes);
  return itemState(produce.cues);
}

// ---- The take ---------------------------------------------------------------
// The EGM list (Overview), with a pause before "they forget", a retake
// ("they forgot") and a pause after "code". Binary-exact seconds.
const SAID: [string, number, number][] = [
  ["so", 0.0, 0.25], //            0
  ["agents", 0.5, 1.0], //         1
  ["they", 1.25, 1.5], //          2
  ["hallucinate", 1.625, 2.25], // 3
  // pause 2.25–3.5
  ["they", 3.5, 3.75], //          4
  ["forget", 3.875, 4.25], //      5
  ["the", 4.375, 4.5], //          6
  ["context", 4.625, 5.25], //     7
  // retake 5.5–6.5
  ["they", 5.5, 5.75], //          8
  ["forgot", 5.875, 6.25], //      9
  ["and", 6.5, 6.75], //           10
  ["they", 7.0, 7.25], //          11
  ["review", 7.375, 7.75], //      12
  ["the", 7.875, 8.0], //          13
  ["code", 8.125, 8.625], //       14
  // pause 8.75–10.0
  ["then", 10.0, 10.25], //        15
  ["we", 10.375, 10.5], //         16
  ["ship", 10.625, 11.0], //       17
  ["it", 11.125, 11.375], //       18
  ["fast", 11.5, 12.0], //         19
];
const WORDS: Word[] = SAID.map(([text, start, end]) => ({ text, start, end }));
const src = (i: number): number => WORDS[i]!.start;
const PAUSE_1 = { srcIn: 2.25, srcOut: 3.5 };
const RETAKE = { srcIn: 5.5, srcOut: 6.5 };
const PROPOSAL: Segment[] = [
  { srcIn: 0, srcOut: 2.25, kind: "keep" },
  { ...PAUSE_1, kind: "remove", reason: "pause" },
  { srcIn: 3.5, srcOut: 5.5, kind: "keep" },
  { ...RETAKE, kind: "remove", reason: "retake" },
  { srcIn: 6.5, srcOut: 8.75, kind: "keep" },
  { srcIn: 8.75, srcOut: 10.0, kind: "remove", reason: "pause" },
  { srcIn: 10.0, srcOut: 20.0, kind: "keep" },
];
const keep = (...ranges: { srcIn: number; srcOut: number }[]) => ({ reasons: {}, kept: ranges, dismissed: [] });

const LIST = ["HALLUCINATE", "FORGET THE CONTEXT", "REVIEW THE CODE"];
const bullets = (over: Partial<Scene> = {}): Scene => ({
  id: "scene-0",
  anchor: { startWord: 2, endWord: 14 },
  layout: "video-top",
  component: "BulletList",
  props: { items: [...LIST] },
  overrides: {},
  cue: { entryWord: 3 },
  ...over,
});
const pins = (list: ({ src: number; text: string } | null)[], component = "BulletList") => ({
  itemPins: { component, pins: list },
});
const docOf = (raw: Record<string, unknown>): OverrideDoc => OverrideDocSchema.parse(raw);

describe("item timing parity: produce and the editor preview (graphic-editor-modal G7, §4)", () => {
  it("no veto: the ordinary session (finishOnClock's early exit) equals the render", () => {
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets()],
      doc: docOf({ scenes: { "scene-0": pins([null, { src: src(5), text: "FORGET THE CONTEXT" }, null]) } }),
    };
    const out = expectParity(run, "early");
    expect(out["scene-0"]!.itemAtSec!.every((t) => t !== null)).toBe(true);
    expect(out["scene-0"]!.reveal).toBe("synced");
  });

  it("a veto change cutting a pinned word: null in both", () => {
    // The last render kept the retake; the author has since let it go (and
    // still keeps the first pause, so a live re-cut is open). "forgot" is cut.
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets({ props: { items: ["HALLUCINATE", "THEY FORGOT", "REVIEW THE CODE"] } })],
      doc: docOf({
        scenes: { "scene-0": pins([null, { src: src(9), text: "THEY FORGOT" }, null]) },
        cleanup: keep(PAUSE_1),
      }),
      rendered: keep(PAUSE_1, RETAKE),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec![1]).toBeNull();
    expect(out["scene-0"]!.itemAtSec![2]).not.toBeNull();
  });

  it("a veto reviving a word an auto item matches (an added graphic, window from its entry)", () => {
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [],
      doc: docOf({
        addedScenes: [
          {
            id: "added-1",
            component: "BulletList",
            props: { items: ["THEY FORGOT", "REVIEW THE CODE"] },
            srcStart: 5.5,
            srcEnd: 8.625,
          },
        ],
        scenes: { "added-1": pins([null, null]) },
        cleanup: keep(RETAKE),
      }),
    };
    const out = expectParity(run, "main");
    // On the last render "they forgot" was cut; live it is spoken and matched.
    expect(out["added-1"]!.itemAtSec![0]).not.toBeNull();
  });

  it("a seam at the block start that the veto revives", () => {
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [
        bullets({ anchor: { startWord: 4, endWord: 7 }, props: { items: ["THEY FORGET", "CONTEXT"] }, cue: { entryWord: 4 } }),
      ],
      doc: docOf({
        scenes: { "scene-0": pins([{ src: src(4), text: "THEY FORGET" }, null]) },
        cleanup: keep(PAUSE_1),
      }),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec!.every((t) => t !== null)).toBe(true);
  });

  it("a revived pause inside a minScene-extended cue: the window is the anchor's, not the cue's", () => {
    // Two words, 1 s of speech, stretched to the floor across the pause; the
    // stretch reaches "forget" on the last render's clock, never in the window.
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets({ anchor: { startWord: 2, endWord: 3 }, props: { items: ["HALLUCINATE", "FORGET"] } })],
      doc: docOf({ scenes: { "scene-0": pins([null, null]) }, cleanup: keep(PAUSE_1) }),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec![0]).not.toBeNull();
    expect(out["scene-0"]!.itemAtSec![1]).toBeNull();
  });

  it("a revived entry word (a planned cue whose stored item times the retime remaps first)", () => {
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [
        bullets({
          component: "FlowDiagram",
          anchor: { startWord: 8, endWord: 14 },
          props: { nodes: ["FORGOT", "REVIEW"] },
          cue: { entryWord: 9, itemWords: [9, 12] },
        }),
      ],
      doc: docOf({ scenes: { "scene-0": pins([null, null], "FlowDiagram") }, cleanup: keep(RETAKE) }),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec!.every((t) => t !== null)).toBe(true);
  });

  it("a src timing pin that resolves only on the live clock", () => {
    // Its start sits in the first pause: inert on the last render's clock,
    // live once the pause is kept. Item 1's pin is then outside the window.
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets()],
      doc: docOf({
        scenes: {
          "scene-0": {
            ...pins([{ src: src(3), text: "HALLUCINATE" }, null, null]),
            timing: { srcStart: 2.75, srcEnd: 8.625 },
          },
        },
        cleanup: keep(PAUSE_1),
      }),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec![0]).toBeNull();
    expect(producePipeline(run).notes).toEqual(['scene "scene-0" item 1: its word is outside this block']);
  });

  it("a legacy output timing pin under a veto", () => {
    // Output 2.375–6.0 on the last render's clock is source 3.625–8.25:
    // "they" (3.5) and "hallucinate" fall outside it.
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets()],
      doc: docOf({
        scenes: {
          "scene-0": {
            ...pins([{ src: src(3), text: "HALLUCINATE" }, null, null]),
            timing: { startSec: 2.375, endSec: 6.0 },
          },
        },
        cleanup: keep(PAUSE_1),
      }),
    };
    const out = expectParity(run, "main");
    expect(out["scene-0"]!.itemAtSec![0]).toBeNull();
    expect(out["scene-0"]!.itemAtSec![1]).not.toBeNull();
  });

  describe("a split half with its own component swap: left as swapped in both", () => {
    // A normal ⌘B dual-writes `at` and `src` (SplitSchema); with no veto the
    // two name the same instant (output == source before the first pause).
    const split = { id: "s1", at: 1.875, src: 1.875 };
    const halfSwap = { component: "StrikethroughReveal", props: { lines: [{ text: "a" }, { text: "b" }] } };

    it("on a planned graphic that carries item times", () => {
      const run: Run = {
        words: WORDS,
        proposal: PROPOSAL,
        scenes: [
          bullets({
            component: "FlowDiagram",
            props: { nodes: ["HALLUCINATE", "FORGET", "REVIEW"] },
            cue: { entryWord: 3, itemWords: [3, 5, 12] },
          }),
        ],
        doc: docOf({
          scenes: {
            "scene-0": pins([null, { src: src(5), text: "FORGET" }, null], "FlowDiagram"),
            "scene-0@s1": halfSwap,
          },
          splits: [split],
        }),
      };
      const out = expectParity(run, "early");
      expect(out["scene-0"]!.itemAtSec!.every((t) => t !== null)).toBe(true);
      expect(out["scene-0@s1"]!.component).toBe("StrikethroughReveal");
    });

    it("on a stored bullet list (no item times until the resolve)", () => {
      const run: Run = {
        words: WORDS,
        proposal: PROPOSAL,
        scenes: [bullets()],
        doc: docOf({
          scenes: {
            "scene-0": pins([null, { src: src(5), text: "FORGET THE CONTEXT" }, null]),
            "scene-0@s1": halfSwap,
          },
          splits: [split],
        }),
      };
      const out = expectParity(run, "early");
      expect(out["scene-0@s1"]!.component).toBe("StrikethroughReveal");
    });
  });

  it("invariant: a BulletList with neither itemWords nor itemPins has no reveal after both pipelines", () => {
    const run: Run = {
      words: WORDS,
      proposal: PROPOSAL,
      scenes: [bullets()],
      doc: docOf({ scenes: { "scene-0": { props: { items: ["A", "B", "C"] } } }, cleanup: keep(PAUSE_1) }),
    };
    const produce = producePipeline(run).cues.find((c) => c.id === "scene-0")!;
    const editor = editorPipeline(run).cues.find((c) => c.id === "scene-0")!;
    expect("reveal" in produce).toBe(false);
    expect("reveal" in editor).toBe(false);
  });
});
