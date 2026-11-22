import { describe, expect, it } from "vitest";
import {
  ITEM_TIMING_COMPONENTS,
  OverrideDocSchema,
  SceneOverrideSchema,
  applyOverrides,
  blockWindow,
  itemTimingRoots,
  resolveItemTimings,
  splitCues,
  type ItemTimingRoot,
  type OverrideDoc,
} from "../src/overrides";
import { assembleScenes, ITEM_LEAD_SEC } from "../src/assemble";
import { TimeMap } from "../src/timemap";
import type { Scene, SceneCue } from "../src/scene-schema";
import type { Word } from "../src/schema";

/**
 * `itemPins` and `resolveItemTimings` (graphic-editor-modal §2, §3). The
 * EGM list from the spec's Overview, said once, source-timed. Times are
 * binary-exact where a test compares them, so `toEqual` is exact.
 */
const SAID: [string, number, number][] = [
  ["agents", 0.0, 0.375],
  ["hallucinate", 0.5, 1.0],
  ["they", 1.25, 1.375],
  ["forget", 1.5, 1.875],
  ["context", 2.0, 2.5],
  ["then", 2.625, 2.75],
  ["review", 3.0, 3.25],
  ["code", 3.5, 3.75],
  ["later", 5.0, 5.375],
  ["ship", 5.5, 5.875],
];
const WORDS: Word[] = SAID.map(([text, start, end]) => ({ text, start, end }));
const at = (i: number): number => WORDS[i]!.start;
/** Source == output: the identity clock, so a word's time is its start. */
const IDENTITY = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
/** 1.4375–1.9375 cut: word 3 ("forget") has no time; everything after
 * moves exactly 0.5 s earlier (binary-exact edges, so conversions compare
 * exactly). */
const FORGET_CUT = new TimeMap([
  { srcIn: 0, srcOut: 1.4375, kind: "keep" },
  { srcIn: 1.4375, srcOut: 1.9375, kind: "remove", reason: "retake" },
  { srcIn: 1.9375, srcOut: 10, kind: "keep" },
]);

const ITEMS = ["HALLUCINATE", "FORGET CONTEXT", "REVIEW CODE"];

const listCue = (over: Partial<SceneCue> = {}): SceneCue => ({
  id: "scene-0",
  anchor: { startWord: 0, endWord: 7 },
  layout: "video-top",
  component: "BulletList",
  props: { items: [...ITEMS] },
  startSec: 0,
  endSec: 3.75,
  ...over,
});

const docWith = (scenes: Record<string, unknown>, extra: Record<string, unknown> = {}): OverrideDoc =>
  OverrideDocSchema.parse({ scenes, ...extra });

const marker = (pins: ({ src: number; text: string } | null)[], component = "BulletList") => ({
  itemPins: { component, pins },
});

/** Item time on a map: the word's output start less the lead (Terms, "Word time"). */
const itemAt = (i: number, map: TimeMap = IDENTITY): number =>
  Math.max(0, map.mapWord(WORDS[i]!)!.start - ITEM_LEAD_SEC);

describe("SceneOverrideSchema.itemPins (graphic-editor-modal §2)", () => {
  it("accepts the marker: a component and one entry per item, null or {src, text}", () => {
    const parsed = SceneOverrideSchema.parse(
      marker([null, { src: 1.5, text: "FORGET CONTEXT" }, null], "FlowDiagram"),
    );
    expect(parsed.itemPins).toEqual({
      component: "FlowDiagram",
      pins: [null, { src: 1.5, text: "FORGET CONTEXT" }, null],
    });
    // Present with every pin null is still word timing on (§2).
    expect(SceneOverrideSchema.parse(marker([null])).itemPins).toEqual({
      component: "BulletList",
      pins: [null],
    });
  });

  it("rejects a pin that is not a source second or has no text", () => {
    expect(SceneOverrideSchema.safeParse(marker([{ src: -1, text: "A" }])).success).toBe(false);
    expect(SceneOverrideSchema.safeParse(marker([{ src: 1e400, text: "A" }])).success).toBe(false);
    expect(SceneOverrideSchema.safeParse({ itemPins: { component: "BulletList", pins: [{ src: 1 }] } }).success).toBe(
      false,
    );
    expect(SceneOverrideSchema.safeParse({ itemPins: { pins: [] } }).success).toBe(false);
  });

  it("a doc written before the key parses byte-equal to before it existed", () => {
    // Captured from the pre-itemPins schema (2026-11-22): the key is optional
    // with no default, so an old doc grows nothing.
    const old = {
      scenes: {
        "scene-0": {
          props: { items: ["A", "B"], reveal: "paced" },
          timing: { startSec: 1, endSec: 4 },
          component: "BulletList",
        },
        "scene-1@s1": { elements: { "item-0": { dx: 2 } }, hidden: true },
        "added-1": { timing: { srcStart: 2.5, srcEnd: 6 } },
      },
      splits: [{ id: "s1", at: 3, src: 3.5 }],
      addedScenes: [{ id: "added-1", component: "BulletList", props: { items: ["X"] }, srcStart: 2, srcEnd: 7 }],
    };
    expect(JSON.stringify(OverrideDocSchema.parse(old))).toBe(
      '{"theme":{},"scenes":{"scene-0":{"props":{"items":["A","B"],"reveal":"paced"},"elements":{},"timing":{"startSec":1,"endSec":4},"component":"BulletList"},"scene-1@s1":{"props":{},"elements":{"item-0":{"dx":2}},"hidden":true},"added-1":{"props":{},"elements":{},"timing":{"srcStart":2.5,"srcEnd":6}}},"captions":{},"captionWordsHidden":{},"captionRangeEdits":[],"captionLineTiming":{},"captionLineWindows":{},"splits":[{"at":3,"src":3.5,"id":"s1"}],"cuts":[],"cleanup":{"reasons":{},"kept":[],"dismissed":[]},"addedScenes":[{"id":"added-1","component":"BulletList","props":{"items":["X"]},"srcStart":2,"srcEnd":7}]}',
    );
  });

  it("a doc carrying the marker round-trips unchanged", () => {
    const doc = docWith({ "scene-0": marker([null, { src: 1.5, text: "FORGET CONTEXT" }, null]) });
    const again = OverrideDocSchema.parse(JSON.parse(JSON.stringify(doc)));
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });
});

describe("blockWindow (graphic-editor-modal Terms, 'Block window')", () => {
  it("rule 3: a plan cue's window runs from its first anchor word's start to its last word's end", () => {
    expect(blockWindow(listCue(), docWith({}), WORDS, IDENTITY, IDENTITY)).toEqual({ srcStart: 0, srcEnd: 3.75 });
  });

  it("rule 2: an added graphic's window is its stored entry span, not its anchor", () => {
    const doc = docWith({}, {
      addedScenes: [{ id: "added-1", component: "BulletList", props: { items: ["A"] }, srcStart: 1.25, srcEnd: 2.5 }],
    });
    const cue = listCue({ id: "added-1", anchor: { startWord: 0, endWord: 9 } });
    expect(blockWindow(cue, doc, WORDS, IDENTITY, IDENTITY)).toEqual({ srcStart: 1.25, srcEnd: 2.5 });
  });

  it("rule 1, src pin: the stored span when it resolves on the LIVE map; otherwise the next rule", () => {
    const doc = docWith({ "scene-0": { timing: { srcStart: 1.25, srcEnd: 3.0 } } });
    expect(blockWindow(listCue(), doc, WORDS, IDENTITY, IDENTITY)).toEqual({ srcStart: 1.25, srcEnd: 3.0 });
    // Inert on the live clock: its start, 1.5, is removed on FORGET_CUT.
    const inert = docWith({ "scene-0": { timing: { srcStart: 1.5, srcEnd: 3.0 } } });
    expect(blockWindow(listCue(), inert, WORDS, IDENTITY, FORGET_CUT)).toEqual({ srcStart: 0, srcEnd: 3.75 });
    // The pin map plays no part for a src pin: inert on it, live on the live map.
    expect(blockWindow(listCue(), inert, WORDS, FORGET_CUT, IDENTITY)).toEqual({ srcStart: 1.5, srcEnd: 3.0 });
  });

  it("rule 1, legacy pin: output seconds on the pin's own clock, converted with that clock's toSource", () => {
    // 1.0–2.75 output on FORGET_CUT is 1.0–3.25 source (after the 0.5 s cut).
    const doc = docWith({ "scene-0": { timing: { startSec: 1.0, endSec: 2.75 } } });
    expect(blockWindow(listCue(), doc, WORDS, FORGET_CUT, IDENTITY)).toEqual({ srcStart: 1.0, srcEnd: 3.25 });
    // On the identity pin map the same numbers are their own source seconds:
    // the live map is never used for a legacy pin.
    expect(blockWindow(listCue(), doc, WORDS, IDENTITY, FORGET_CUT)).toEqual({ srcStart: 1.0, srcEnd: 2.75 });
  });

  it("rule 1 wins over rule 2 for an added graphic with a timing pin", () => {
    const doc = docWith(
      { "added-1": { timing: { srcStart: 2.0, srcEnd: 3.0 } } },
      { addedScenes: [{ id: "added-1", component: "BulletList", props: { items: ["A"] }, srcStart: 0, srcEnd: 5 }] },
    );
    expect(blockWindow(listCue({ id: "added-1" }), doc, WORDS, IDENTITY, IDENTITY)).toEqual({
      srcStart: 2.0,
      srcEnd: 3.0,
    });
  });

  it("rule 4: no pin, no entry, no anchor (or an anchor past the transcript) → no window", () => {
    const { anchor: _a, ...bare } = listCue();
    expect(blockWindow(bare, docWith({}), WORDS, IDENTITY, IDENTITY)).toBeNull();
    expect(
      blockWindow(listCue({ anchor: { startWord: 8, endWord: 40 } }), docWith({}), WORDS, IDENTITY, IDENTITY),
    ).toBeNull();
  });
});

describe("resolveItemTimings (graphic-editor-modal §3)", () => {
  const pinForget = { src: at(3), text: "FORGET CONTEXT" };

  it("gate: a doc with no itemPins returns the very same list", () => {
    const cues = [listCue()];
    const doc = docWith({ "scene-0": { props: { items: ["A", "B"] } } });
    const out = resolveItemTimings(cues, doc, WORDS, IDENTITY);
    expect(out.cues).toBe(cues);
    expect(out.notes).toEqual([]);
  });

  it("gate: a marker on a component outside item timing returns the very same list", () => {
    const cues = [
      listCue({
        component: "TerminalMock",
        props: { windows: [{ title: "hallucinate", lines: ["x"] }] },
      }),
    ];
    const doc = docWith({ "scene-0": marker([null], "TerminalMock") });
    expect(resolveItemTimings(cues, doc, WORDS, IDENTITY).cues).toBe(cues);
    // A marker only on a split half's own key is not a root's (§3: per root id).
    const halfOnly = docWith({ "scene-0@s1": marker([null, null, null]) });
    expect(resolveItemTimings([listCue()], halfOnly, WORDS, IDENTITY).cues).toEqual([listCue()]);
  });

  it("covers exactly the five list components (Terms)", () => {
    expect([...ITEM_TIMING_COMPONENTS].sort()).toEqual(
      ["BulletList", "CardRow", "ChatMock", "FlowDiagram", "StrikethroughReveal"].sort(),
    );
  });

  it("pins an item to its word and matches the rest by text, on the given map", () => {
    const doc = docWith({ "scene-0": marker([null, pinForget, null]) });
    const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, IDENTITY);
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
    expect(notes).toEqual([]);
  });

  it("an item on the first word is floored at 0, as assembly floors it", () => {
    const cue = listCue({ props: { items: ["AGENTS", "HALLUCINATE"] } });
    const doc = docWith({ "scene-0": marker([{ src: 0, text: "AGENTS" }, null]) });
    expect(resolveItemTimings([cue], doc, WORDS, IDENTITY).cues[0]!.reveal!.itemAtSec[0]).toBe(0);
  });

  it("component mismatch: every pin is auto, with a note; the marker is left in the doc", () => {
    const doc = docWith({ "scene-0": marker([null, { src: at(4), text: "FORGET CONTEXT" }, null], "FlowDiagram") });
    const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, IDENTITY);
    // Auto: item 2 matches "forget" (word 3), not the pinned "context".
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
    expect(notes).toEqual([
      'scene "scene-0": its item pins were made for FlowDiagram, not BulletList — every item is matched by its text',
    ]);
    expect(doc.scenes["scene-0"]!.itemPins!.component).toBe("FlowDiagram");
  });

  it("count mismatch: every pin is auto, with a note", () => {
    const doc = docWith({ "scene-0": marker([null, { src: at(4), text: "FORGET CONTEXT" }]) });
    const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, IDENTITY);
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
    expect(notes).toEqual(['scene "scene-0": 2 item pins for 3 items — every item is matched by its text']);
  });

  it("a mismatch with no pin to lose says nothing: every entry was auto already", () => {
    const doc = docWith({ "scene-0": marker([null, null], "FlowDiagram") });
    expect(resolveItemTimings([listCue()], doc, WORDS, IDENTITY).notes).toEqual([]);
  });

  it("per-pin text mismatch: only that pin is auto, with a note", () => {
    // Item 3's text was edited since it was pinned on "code" (word 7).
    const doc = docWith({
      "scene-0": marker([{ src: at(1), text: "HALLUCINATE" }, null, { src: at(7), text: "REVIEW THE CODE" }]),
    });
    const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, IDENTITY);
    // Item 3 auto: "REVIEW CODE" first lands on "review" (word 6), not "code".
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
    expect(notes).toEqual(['scene "scene-0" item 3: its text changed since it was pinned']);
  });

  it("resolveItemWords' own notes come through, named by scene", () => {
    const doc = docWith({ "scene-0": marker([null, { src: 1.7, text: "FORGET CONTEXT" }, null]) });
    expect(resolveItemTimings([listCue()], doc, WORDS, IDENTITY).notes).toEqual([
      'scene "scene-0" item 2: its word moved',
    ]);
  });

  it("CardRow: an item's text is its title and sub joined with ' · ', or the title alone", () => {
    const cue = listCue({
      component: "CardRow",
      props: { cards: [{ text: "Hallucinate", sub: "makes it up" }, { text: "Review" }] },
    });
    const doc = docWith({
      "scene-0": marker(
        [{ src: at(1), text: "Hallucinate · makes it up" }, { src: at(7), text: "Review" }],
        "CardRow",
      ),
    });
    const { cues, notes } = resolveItemTimings([cue], doc, WORDS, IDENTITY);
    expect(notes).toEqual([]);
    // Item 2 is pinned to "code" (word 7): a text match would have said "review".
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(7)] });
  });

  describe("synced (§3 step 5)", () => {
    it("a pinned item forces props.reveal synced", () => {
      const doc = docWith({ "scene-0": marker([null, pinForget, null]) });
      expect(resolveItemTimings([listCue()], doc, WORDS, IDENTITY).cues[0]!.props!.reveal).toBe("synced");
    });

    it("a cut pin counts: no time of its own, still synced", () => {
      const doc = docWith({ "scene-0": marker([null, pinForget, null]) });
      const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, FORGET_CUT);
      expect(cues[0]!.reveal!.itemAtSec[1]).toBeNull();
      expect(cues[0]!.props!.reveal).toBe("synced");
      expect(notes).toEqual(['scene "scene-0" item 2: its word was cut']);
    });

    it("auto items only leave reveal to the renderer: no props.reveal is written", () => {
      const doc = docWith({ "scene-0": marker([null, null, null]) });
      const cue = resolveItemTimings([listCue()], doc, WORDS, IDENTITY).cues[0]!;
      expect(cue.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
      expect("reveal" in cue.props!).toBe(false);
    });

    it("the author's own reveal choice in the cue's effective override is never overwritten", () => {
      const doc = docWith({ "scene-0": { ...marker([null, pinForget, null]), props: { reveal: "paced" } } });
      const [merged] = applyOverrides([listCue()], doc).cues;
      const out = resolveItemTimings([merged!], doc, WORDS, IDENTITY).cues[0]!;
      expect(out.props!.reveal).toBe("paced");
      expect(out.reveal!.itemAtSec[1]).toBe(itemAt(3));
    });

    it("per cue: a half whose own override sets reveal keeps it, its sibling is synced", () => {
      const doc = docWith({
        "scene-0": marker([null, pinForget, null]),
        "scene-0@s1": { props: { reveal: "paced" } },
      });
      const halves = applyOverrides(splitCues([listCue()], [{ at: 2.0, id: "s1" }]), doc).cues;
      const out = resolveItemTimings(halves, doc, WORDS, IDENTITY, itemTimingRoots([listCue()], doc, WORDS, IDENTITY, IDENTITY)).cues;
      expect(out.map((c) => c.props!.reveal)).toEqual(["synced", "paced"]);
    });
  });

  describe("split halves (§3 step 4)", () => {
    const doc = docWith({
      "scene-0": marker([null, pinForget, null]),
      // The half's own text edit does not re-time items (call 5).
      "scene-0@s1": { props: { items: ["X", "Y", "Z"] } },
    });
    const roots = itemTimingRoots([listCue()], doc, WORDS, IDENTITY, IDENTITY);

    it("every half with the root's component gets the root's times", () => {
      const halves = applyOverrides(splitCues([listCue()], [{ at: 2.0, id: "s1" }]), doc).cues;
      const out = resolveItemTimings(halves, doc, WORDS, IDENTITY, roots).cues;
      const times = { itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] };
      expect(out.map((c) => [c.id, c.reveal])).toEqual([
        ["scene-0", times],
        ["scene-0@s1", times],
      ]);
    });

    it("a half with its own component swap is left as its swap made it", () => {
      const swapDoc = docWith({
        "scene-0": marker([null, pinForget, null]),
        "scene-0@s1": { component: "FlowDiagram", props: { nodes: ["A", "B"] } },
      });
      const halves = applyOverrides(splitCues([listCue()], [{ at: 2.0, id: "s1" }]), swapDoc).cues;
      const out = resolveItemTimings(halves, swapDoc, WORDS, IDENTITY, roots).cues;
      expect(out[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
      expect(out[1]).toBe(halves[1]);
    });

    it("given roots, the root's component and props come from them, not from the list", () => {
      // The editor's list is split by the time it resolves; the roots map was
      // taken from the unsplit list (§4).
      const given = new Map<string, ItemTimingRoot>([
        [
          "scene-0",
          { component: "BulletList", props: { items: ["LATER", "SHIP"] }, window: { srcStart: 0, srcEnd: 10 } },
        ],
      ]);
      const twoDoc = docWith({ "scene-0": marker([null, null]) });
      const out = resolveItemTimings([listCue()], twoDoc, WORDS, IDENTITY, given).cues[0]!;
      expect(out.reveal).toEqual({ itemAtSec: [itemAt(8), itemAt(9)] });
    });

    it("a root missing from the given roots is not resolved", () => {
      const doc2 = docWith({ "scene-0": marker([null, null, null]) });
      const cues = [listCue()];
      expect(resolveItemTimings(cues, doc2, WORDS, IDENTITY, new Map()).cues).toBe(cues);
    });
  });

  it("the window follows a timing pin: a pin outside it turns auto with a note", () => {
    // Pinned on "later" (word 8), but a src timing pin narrows the block to
    // 0.5–3.75: the pin is outside, and item 3 is matched inside instead.
    const doc = docWith({
      "scene-0": {
        ...marker([null, null, { src: at(8), text: "REVIEW CODE" }]),
        timing: { srcStart: 0.5, srcEnd: 3.75 },
      },
    });
    const { cues, notes } = resolveItemTimings([listCue()], doc, WORDS, IDENTITY);
    expect(cues[0]!.reveal).toEqual({ itemAtSec: [itemAt(1), itemAt(3), itemAt(6)] });
    expect(notes).toEqual(['scene "scene-0" item 3: its word is outside this block']);
  });

  it("a legacy timing pin sets the window through the run map (no roots: pin map = map)", () => {
    // On FORGET_CUT, output 2.0–3.25 is source 2.5–3.75: "context" (2.0)
    // is outside, so item 2 ("FORGET CONTEXT") finds nothing and item 3 lands.
    const cue = listCue({ props: { items: ["CONTEXT", "REVIEW CODE"] } });
    const doc = docWith({ "scene-0": { ...marker([null, null]), timing: { startSec: 2.0, endSec: 3.25 } } });
    const out = resolveItemTimings([cue], doc, WORDS, FORGET_CUT).cues[0]!;
    expect(out.reveal).toEqual({ itemAtSec: [null, itemAt(6, FORGET_CUT)] });
  });

  it("no window (no anchor, no entry, no pin): the graphic is skipped with a note", () => {
    const { anchor: _a, ...bare } = listCue();
    const cues = [bare];
    const doc = docWith({ "scene-0": marker([null, pinForget, null]) });
    const out = resolveItemTimings(cues, doc, WORDS, IDENTITY);
    expect(out.cues).toBe(cues);
    expect(out.notes).toEqual(['scene "scene-0": no block window to time its items in — item timing skipped']);
  });

  it("startSec, endSec and entryAtSec are never touched; other cues are the same objects", () => {
    const cue = listCue({ startSec: 0.25, endSec: 3.9, entryAtSec: 0.55, pinned: true });
    const other = listCue({ id: "scene-1", startSec: 5, endSec: 6, anchor: { startWord: 8, endWord: 9 } });
    const doc = docWith({ "scene-0": marker([null, pinForget, null]) });
    const out = resolveItemTimings([cue, other], doc, WORDS, IDENTITY).cues;
    expect(out[0]).toMatchObject({ startSec: 0.25, endSec: 3.9, entryAtSec: 0.55, pinned: true });
    expect(out[1]).toBe(other);
  });

  it("an earlier reveal (the planner's, or a retime's) is overwritten for a marked root", () => {
    const cue = listCue({ component: "FlowDiagram", props: { nodes: [...ITEMS] }, reveal: { itemAtSec: [9, 9, 9] } });
    const doc = docWith({ "scene-0": marker([null, null, null], "FlowDiagram") });
    expect(resolveItemTimings([cue], doc, WORDS, IDENTITY).cues[0]!.reveal).toEqual({
      itemAtSec: [itemAt(1), itemAt(3), itemAt(6)],
    });
  });
});

describe("itemTimingRoots (graphic-editor-modal §4)", () => {
  it("one root per marked root id present in the list, windowed by blockWindow on the two maps", () => {
    const doc = docWith({
      "scene-0": { ...marker([null, null, null]), timing: { startSec: 1.0, endSec: 2.75 } },
      "scene-1": { props: { items: ["A"] } },
      "scene-9": marker([null]),
    });
    const cues = [listCue(), listCue({ id: "scene-1" })];
    const roots = itemTimingRoots(cues, doc, WORDS, FORGET_CUT, IDENTITY);
    expect([...roots.keys()]).toEqual(["scene-0"]);
    expect(roots.get("scene-0")).toEqual({
      component: "BulletList",
      props: { items: [...ITEMS] },
      window: { srcStart: 1.0, srcEnd: 3.25 },
    });
  });
});

describe("BulletList invariant (graphic-editor-modal Test plan)", () => {
  it("a stored BulletList with neither itemWords nor itemPins has no reveal after the overrides and the resolve", () => {
    const scene: Scene = {
      id: "scene-0",
      anchor: { startWord: 0, endWord: 7 },
      layout: "video-top",
      component: "BulletList",
      props: { items: [...ITEMS] },
      overrides: {},
      cue: { entryWord: 1 },
    };
    const assembled = assembleScenes([scene], { language: "en", words: WORDS }, IDENTITY).cues;
    const doc = docWith({ "scene-0": { props: { items: ["A", "B", "C"] } } });
    const merged = applyOverrides(assembled, doc).cues;
    const out = resolveItemTimings(merged, doc, WORDS, IDENTITY).cues;
    expect(out).toBe(merged);
    expect("reveal" in out[0]!).toBe(false);
  });
});
