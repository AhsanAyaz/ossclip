import { describe, expect, it } from "vitest";
import {
  ADDED_OFFERED,
  ENTRY_LEAD_SEC,
  ITEM_LEAD_SEC,
  OverrideDocSchema,
  SCENE_GAP_SEC,
  SCENE_REGISTRY,
  frameWindow,
  mapFromKeptSpans,
  resolveItemTimings,
  resolveSceneProps,
  resolveTimingPin,
  wordOutputStart,
  type OverrideDoc,
  type SceneCue,
  type TimeMap,
} from "@ossclip/core/browser";
import { revealFrames } from "@ossclip/scenes";
import {
  ADD_TYPE_COPY,
  addFormFieldsFor,
  addFormIssue,
  allowedWords,
  appendItem,
  blockWords,
  initialAddValues,
  keptSpanStartOf,
  modalRows,
  openModal,
  pinItem,
  removeItem,
  saveFor,
  shownItemPins,
  unpinItem,
  whenRowPin,
  windowWords,
  withProps,
  type ModalRow,
  type ModalState,
  type RowContext,
} from "../src/graphicEditorModel";
import type { ItemPins } from "../src/useEdits";

describe("ADD_TYPE_COPY (editor-added-graphics §5, step 1)", () => {
  it("names every offered type with one plain line under 60 characters", () => {
    expect(Object.keys(ADD_TYPE_COPY).sort()).toEqual([...ADDED_OFFERED].sort());
    for (const c of ADDED_OFFERED) {
      const { name, line } = ADD_TYPE_COPY[c];
      expect(line.length, c).toBeLessThan(60);
      // Plain names: no shouted labels, no arrows tacked on.
      for (const text of [name, line]) {
        expect(text, c).not.toMatch(/\b[A-Z]{3,}\b/);
        expect(text, c).not.toMatch(/[→›»>]/);
      }
    }
  });
});

describe("addFormFieldsFor", () => {
  it("builds each type's fields once — the JSON-schema walk is not per render", () => {
    expect(addFormFieldsFor("StatCard")).toBe(addFormFieldsFor("StatCard"));
    expect(addFormFieldsFor("StatCard").map((f) => f.key)).toEqual(["value", "label"]);
  });
});

describe("initialAddValues (§5 prefill)", () => {
  it("prefills the FIRST text field with the selected words when they fit", () => {
    expect(initialAddValues("StatCard", "two words")).toEqual({ value: "two words", label: "" });
  });

  it("leaves it empty when the words exceed that field's max", () => {
    // StatCard.value is capped at 12.
    expect(initialAddValues("StatCard", "thirteen char")).toEqual({ value: "", label: "" });
  });

  it("skips a leading choice and number for the first TEXT field, and starts lists empty", () => {
    expect(initialAddValues("CtaCard", "follow me")).toEqual({ action: undefined, text: "follow me" });
    expect(initialAddValues("BugCard", "it breaks")).toEqual({ number: undefined, headline: "it breaks" });
    expect(initialAddValues("BulletList", "a b")).toEqual({ items: [] });
    expect(initialAddValues("ChatMock", "hi")).toEqual({ messages: [] });
  });
});

describe("addFormIssue — the Add gate", () => {
  it("is null for a form that parses RAW", () => {
    expect(addFormIssue("TitleCard", { title: "Hello" })).toBeNull();
  });

  it("gates on the RAW schema, not resolveSceneProps — registry defaults would mask an empty title", () => {
    // resolveSceneProps fills TitleCard's default "TITLE" and passes; the
    // conversion parses raw and would skip the entry (editor-added-graphics §2).
    expect(resolveSceneProps("TitleCard", {})).not.toBeNull();
    expect(SCENE_REGISTRY.TitleCard.propsSchema.safeParse({}).success).toBe(false);
    expect(addFormIssue("TitleCard", { title: "" })).not.toBeNull();
    expect(addFormIssue("TitleCard", {})).not.toBeNull();
  });

  it("holds a list below its minimum, and opens at it", () => {
    expect(addFormIssue("BulletList", { items: ["one"] })).not.toBeNull();
    expect(addFormIssue("BulletList", { items: ["one", "two"] })).toBeNull();
  });
});

/**
 * The block the itemTimingPreview tests use: "they hallucinate, they forget
 * … review … code", source seconds, with an identity clock (output ==
 * source) unless a case cuts.
 */
const SAID: [string, number, number][] = [
  ["so", 0.0, 0.25], //            0
  ["they", 1.25, 1.5], //          1
  ["hallucinate", 1.625, 2.25], // 2
  ["they", 3.5, 3.75], //          3
  ["forget", 3.875, 4.25], //      4
  ["review", 5.375, 5.75], //      5
  ["code", 6.125, 6.625], //       6
];
const words = SAID.map(([text, start, end]) => ({ text, start, end }));
const identity = mapFromKeptSpans([{ srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 }]);
// "forget" (3.875–4.25) cut whole: 3.8–4.3 removed.
const forgetCut = mapFromKeptSpans([
  { srcIn: 0, srcOut: 3.8, outIn: 0, outOut: 3.8 },
  { srcIn: 4.3, srcOut: 10, outIn: 3.8, outOut: 9.5 },
]);
const WINDOW = { srcStart: 1.25, srcEnd: 6.625 };
const ITEMS = ["HALLUCINATE", "FORGET", "REVIEW THE CODE"];
const ctxOn = (liveMap: TimeMap, ownReveal = false): RowContext => ({
  words,
  window: WINDOW,
  liveMap,
  cue: { startSec: 1.25, endSec: 6.625 },
  fps: 30,
  ownReveal,
});
const pinsOf = (pins: ItemPins["pins"], component = "BulletList"): ItemPins => ({ component, pins });
const FORGET_PIN = { src: 3.875, text: "FORGET" };
const rowsOf = (itemPins: ItemPins | undefined, items = ITEMS, map: TimeMap = identity) =>
  modalRows("BulletList", { items }, itemPins, ctxOn(map));
const pick = (rows: ModalRow[]) => rows.map((r) => [r.state, r.word, r.note]);

describe("modalRows (graphic-editor-modal §3 states, §5 rows)", () => {
  it("pinned and auto rows: each on its word, no note", () => {
    expect(pick(rowsOf(pinsOf([null, FORGET_PIN, null])))).toEqual([
      ["auto", 2, null],
      ["pinned", 4, null],
      ["auto", 5, null],
    ]);
  });

  it("a cut pin keeps its word, for the struck marker and as a bound, with the row note", () => {
    const rows = rowsOf(pinsOf([null, FORGET_PIN, null]), ITEMS, forgetCut);
    expect(pick(rows)).toEqual([
      ["auto", 2, null],
      ["cut", 4, "its word was cut"],
      ["auto", 5, null],
    ]);
  });

  it("an item no word matches is unmatched, with no word", () => {
    expect(pick(rowsOf(undefined, ["HALLUCINATE", "ZEBRA", "REVIEW THE CODE"]))).toEqual([
      ["auto", 2, null],
      ["unmatched", null, null],
      ["auto", 5, null],
    ]);
  });

  it("a pin the resolver turns auto carries its §3 reason", () => {
    // Moved: 3.0 s is no word's start within 0.05 s.
    expect(pick(rowsOf(pinsOf([null, { src: 3.0, text: "FORGET" }, null])))[1]).toEqual([
      "auto",
      4,
      "its word moved",
    ]);
    // Outside: "so" at 0 s is before the block window.
    expect(pick(rowsOf(pinsOf([{ src: 0, text: "HALLUCINATE" }, null, null])))[0]).toEqual([
      "auto",
      2,
      "its word is outside this block",
    ]);
    // Out of order: item 2 pinned before item 1's pinned word. Its segment
    // (after item 1's word) has no "forget", so it is left to the renderer.
    const outOfOrder = pinsOf([{ src: 3.875, text: "HALLUCINATE" }, { src: 1.625, text: "FORGET" }, null]);
    expect(pick(rowsOf(outOfOrder))[1]).toEqual(["unmatched", null, "out of order"]);
  });

  it("a pin whose stored text no longer matches its item is auto, as resolveItemTimings has it", () => {
    expect(pick(rowsOf(pinsOf([null, { src: 3.875, text: "OLD" }, null])))[1]).toEqual([
      "auto",
      4,
      "its text changed since it was pinned",
    ]);
  });

  it("a component or count mismatch turns every row auto, noted only when a pin was set", () => {
    const flow = rowsOf(pinsOf([null, FORGET_PIN, null], "FlowDiagram"));
    expect(flow.map((r) => r.state)).toEqual(["auto", "auto", "auto"]);
    expect(flow.every((r) => r.note !== null && r.note.includes("FlowDiagram"))).toBe(true);
    const count = rowsOf(pinsOf([null, FORGET_PIN]));
    expect(count.map((r) => r.state)).toEqual(["auto", "auto", "auto"]);
    expect(count.every((r) => r.note !== null)).toBe(true);
    // An all-auto marker has nothing to lose: no note.
    expect(rowsOf(pinsOf([null, null], "FlowDiagram")).every((r) => r.note === null)).toBe(true);
  });

  it("rows carry the item's text as a pin stores it (CardRow joined with ' · ')", () => {
    const rows = modalRows(
      "CardRow",
      { cards: [{ text: "Hallucinate", sub: "llm" }, { text: "Forget" }] },
      undefined,
      ctxOn(identity),
    );
    expect(rows.map((r) => r.text)).toEqual(["Hallucinate · llm", "Forget"]);
  });

  it("a type without item timing has no rows", () => {
    expect(modalRows("TitleCard", { title: "Hi" }, undefined, ctxOn(identity))).toEqual([]);
    // PhoneDemo's pills are revealed items, but not offered for item timing.
    expect(
      modalRows("PhoneDemo", { caption: [{ text: "a" }], pills: [{ text: "x" }] }, undefined, ctxOn(identity)),
    ).toEqual([]);
  });

  /** What the render does for one cue: the very pass the preview runs, then
   * the renderer's schedule over the cue's frame window. */
  const rendered = (doc: OverrideDoc, items: string[], map: TimeMap): number[] => {
    const cue: SceneCue = {
      id: "scene-0",
      layout: "video-top",
      component: "BulletList",
      props: { items },
      startSec: 1.25,
      endSec: 6.625,
    };
    const roots = new Map([["scene-0", { component: "BulletList", props: { items }, window: WINDOW }]]);
    const out = resolveItemTimings([cue], doc, words, map, roots).cues[0]!;
    const { durationInFrames } = frameWindow(out.startSec, out.endSec, 30);
    const frames = revealFrames({
      count: items.length,
      legacyStepFrames: 7,
      fps: 30,
      durationInFrames,
      cueStartSec: out.startSec,
      itemAtSec: out.reveal?.itemAtSec,
      props: out.props as { reveal?: string },
    });
    return frames.map((f) => out.startSec + f / 30);
  };

  it("estimates are the renderer's own times for every row (revealFrames over the resolved cue)", () => {
    const items = ["HALLUCINATE", "ZEBRA", "REVIEW THE CODE"];
    const itemPins = pinsOf([null, null, { src: 5.375, text: "REVIEW THE CODE" }]);
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { itemPins } } });
    const rows = modalRows("BulletList", { items }, itemPins, ctxOn(identity));
    expect(rows.map((r) => r.state)).toEqual(["auto", "unmatched", "pinned"]);
    expect(rows.map((r) => r.estSec)).toEqual(rendered(doc, items, identity));
    // The unmatched item sits between its neighbours, as the renderer interpolates.
    expect(rows[1]!.estSec!).toBeGreaterThan(rows[0]!.estSec!);
    expect(rows[1]!.estSec!).toBeLessThan(rows[2]!.estSec!);
  });

  it("estimates follow a cut pin and the author's own reveal choice, as the render does", () => {
    const cutPins = pinsOf([null, FORGET_PIN, null]);
    const cutDoc = OverrideDocSchema.parse({ scenes: { "scene-0": { itemPins: cutPins } } });
    expect(rowsOf(cutPins, ITEMS, forgetCut).map((r) => r.estSec)).toEqual(rendered(cutDoc, ITEMS, forgetCut));
    // `reveal: "paced"` in the override: no forced synced, the render paces.
    const paced = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { reveal: "paced" }, itemPins: cutPins } },
    });
    const rows = modalRows("BulletList", { items: ITEMS, reveal: "paced" }, cutPins, ctxOn(identity, true));
    const cue: SceneCue = {
      id: "scene-0",
      layout: "video-top",
      component: "BulletList",
      props: { items: ITEMS, reveal: "paced" },
      startSec: 1.25,
      endSec: 6.625,
    };
    const roots = new Map([["scene-0", { component: "BulletList", props: cue.props!, window: WINDOW }]]);
    const out = resolveItemTimings([cue], paced, words, identity, roots).cues[0]!;
    expect(out.props?.reveal).toBe("paced");
    const frames = revealFrames({
      count: 3,
      legacyStepFrames: 7,
      fps: 30,
      durationInFrames: frameWindow(1.25, 6.625, 30).durationInFrames,
      cueStartSec: 1.25,
      itemAtSec: out.reveal?.itemAtSec,
      props: { reveal: "paced" },
    });
    expect(rows.map((r) => r.estSec)).toEqual(frames.map((f) => 1.25 + f / 30));
  });
});

describe("windowWords / blockWords (Terms)", () => {
  it("window words are every word in [srcStart, srcEnd); block words only the spoken ones", () => {
    expect(windowWords(words, WINDOW)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(blockWords(words, WINDOW, identity)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(blockWords(words, WINDOW, forgetCut)).toEqual([1, 2, 3, 5, 6]);
  });
});

describe("allowedWords (§5 picking)", () => {
  const row = (state: ModalRow["state"], word: number | null): ModalRow => ({
    text: "x",
    state,
    word,
    estSec: 0,
    note: null,
  });
  // Bounding pins at words 2 (pinned) and 5 (cut); autos at 3 and 7.
  const rows = [row("pinned", 2), row("auto", 3), row("cut", 5), row("auto", 7), row("unmatched", null)];
  const block = [1, 2, 3, 4, 6, 7, 8, 9]; // 5 is cut, so not a block word

  it("enables only block words strictly between the neighbouring bounding pins", () => {
    expect([...allowedWords(rows, 1, block)]).toEqual([3, 4]);
    // An auto neighbour does not bound: item 4 may cross item 4's own auto word and beyond.
    expect([...allowedWords(rows, 3, block)]).toEqual([6, 7, 8, 9]);
    expect([...allowedWords(rows, 4, block)]).toEqual([6, 7, 8, 9]);
    // The row being picked is not its own bound.
    expect([...allowedWords(rows, 0, block)]).toEqual([1, 2, 3, 4]);
    expect([...allowedWords(rows, 2, block)]).toEqual([3, 4, 6, 7, 8, 9]);
  });

  it("the start enables block words up to the first item that has a word", () => {
    expect([...allowedWords(rows, "start", block)]).toEqual([1, 2]);
    expect([...allowedWords([], "start", block)]).toEqual(block);
    expect([...allowedWords([row("unmatched", null)], "start", block)]).toEqual(block);
  });
});

describe("saveFor (graphic-editor-modal §6)", () => {
  const ctx = ctxOn(identity);
  const edit = (props: Record<string, unknown>, itemPins?: ItemPins): ModalState =>
    openModal({ mode: "edit", component: "BulletList", props, itemPins, timing: undefined });
  const shown = (opened: ModalState, now: ModalState) =>
    modalRows(now.component, now.props, shownItemPins(opened, now), ctx);
  const editItems = (opened: ModalState, now: ModalState, items: string[]): ModalState =>
    withProps(now, { ...now.props, items }, shown(opened, now));

  it("no change → null, so Save dispatches nothing", () => {
    const opened = edit({ title: "T", items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    expect(saveFor(opened, opened)).toBeNull();
    // An edit typed and typed back is no change either.
    const now = editItems(opened, editItems(opened, opened, ["HALLUCINATE", "FORGOT", "REVIEW THE CODE"]), ITEMS);
    expect(saveFor(opened, now)).toBeNull();
  });

  it("a title-only edit writes the title and no marker", () => {
    const opened = edit({ title: "T", items: ITEMS });
    const now = withProps(opened, { title: "NEW", items: ITEMS }, shown(opened, opened));
    const patch = saveFor(opened, now);
    expect(patch).toEqual({ props: { title: "NEW" }, clearKeys: [] });
    expect(patch).not.toHaveProperty("itemPins");
  });

  it("a cleared field is a clear key, not a patched undefined", () => {
    const opened = edit({ title: "T", items: ITEMS });
    const now = withProps(opened, { items: ITEMS }, shown(opened, opened));
    expect(saveFor(opened, now)).toEqual({ props: {}, clearKeys: ["title"] });
  });

  it("editing a pinned item's text keeps its pin, storing the new text", () => {
    const opened = edit({ items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    const now = editItems(opened, opened, ["HALLUCINATE", "FORGETTING", "REVIEW THE CODE"]);
    expect(shown(opened, now)[1]!.state).toBe("pinned");
    expect(saveFor(opened, now)).toEqual({
      props: { items: ["HALLUCINATE", "FORGETTING", "REVIEW THE CODE"] },
      clearKeys: [],
      itemPins: pinsOf([null, { src: 3.875, text: "FORGETTING" }, null]),
    });
  });

  it("editing a cut pin's text keeps it too (a cut pin is a bounding pin)", () => {
    const cutCtx = ctxOn(forgetCut);
    const opened = edit({ items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    const rows = modalRows("BulletList", opened.props, shownItemPins(opened, opened), cutCtx);
    expect(rows[1]!.state).toBe("cut");
    const now = withProps(opened, { items: ["HALLUCINATE", "FORGOT", "REVIEW THE CODE"] }, rows);
    expect(saveFor(opened, now)!.itemPins).toEqual(pinsOf([null, { src: 3.875, text: "FORGOT" }, null]));
  });

  it("deleting a row splices its pin out at the same index", () => {
    const opened = edit({ items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    const now = removeItem(opened, 0);
    expect(saveFor(opened, now)).toEqual({
      props: { items: ["FORGET", "REVIEW THE CODE"] },
      clearKeys: [],
      itemPins: pinsOf([FORGET_PIN, null]),
    });
  });

  it("adding a row appends a null (auto) pin and an empty item", () => {
    const opened = edit({ items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    const now = appendItem(opened);
    expect(saveFor(opened, now)).toEqual({
      props: { items: [...ITEMS, ""] },
      clearKeys: [],
      itemPins: pinsOf([null, FORGET_PIN, null, null]),
    });
  });

  it("a stale pin is kept as stored while its row is untouched, and stores what the modal shows once edited", () => {
    const moved = { src: 3.0, text: "HALLUCINATE" };
    const opened = edit({ items: ITEMS }, pinsOf([moved, null, null]));
    expect(shown(opened, opened)[0]!.note).toBe("its word moved");
    // Another row's pin changes: the moved pin is written back exactly as stored.
    const other = pinItem(opened, 2, words[5]!);
    expect(saveFor(opened, other)!.itemPins!.pins).toEqual([moved, null, { src: 5.375, text: "REVIEW THE CODE" }]);
    // Another auto row's text only: the pins are the stored ones, so the
    // marker is left out of the patch and stays exactly as it was.
    const typed = editItems(opened, opened, ["HALLUCINATE", "FORGET", "REVIEW CODE"]);
    expect(saveFor(opened, typed)).toEqual({ props: { items: ["HALLUCINATE", "FORGET", "REVIEW CODE"] }, clearKeys: [] });
    // Its own row edited: the modal showed it auto, so it stores auto.
    const own = editItems(opened, opened, ["HALLUCINATING", "FORGET", "REVIEW THE CODE"]);
    expect(saveFor(opened, own)!.itemPins!.pins[0]).toBeNull();
  });

  it("after a component or count mismatch, no item change leaves the stored marker alone", () => {
    const flowPins = pinsOf([null, FORGET_PIN, null], "FlowDiagram");
    const opened = edit({ title: "T", items: ITEMS }, flowPins);
    const titled = withProps(opened, { title: "NEW", items: ITEMS }, shown(opened, opened));
    expect(saveFor(opened, titled)).toEqual({ props: { title: "NEW" }, clearKeys: [] });
    // What the modal shows meanwhile is the stored marker, mismatch and all.
    expect(shownItemPins(opened, titled)).toBe(flowPins);
    // An item change rewrites it for the current component from the rows.
    const repinned = pinItem(opened, 1, words[4]!);
    expect(saveFor(opened, repinned)!.itemPins).toEqual(pinsOf([null, FORGET_PIN, null]));
  });

  it("an item text edit turns word timing on for a graphic without the marker", () => {
    const opened = edit({ items: ITEMS });
    const now = editItems(opened, opened, ["HALLUCINATE", "FORGET", "REVIEW CODE"]);
    expect(saveFor(opened, now)!.itemPins).toEqual(pinsOf([null, null, null]));
  });

  it("pinning and unpinning are item changes", () => {
    const opened = edit({ items: ITEMS }, pinsOf([null, FORGET_PIN, null]));
    expect(saveFor(opened, unpinItem(opened, 1))).toEqual({
      props: {},
      clearKeys: [],
      itemPins: pinsOf([null, null, null]),
    });
    const pinned = pinItem(opened, 2, words[5]!);
    expect(saveFor(opened, pinned)!.itemPins).toEqual(
      pinsOf([null, FORGET_PIN, { src: 5.375, text: "REVIEW THE CODE" }]),
    );
    // Pinned and unpinned again: back where it opened.
    expect(saveFor(opened, unpinItem(pinItem(opened, 0, words[2]!), 0))).toBeNull();
  });

  it("a When-row timing pin alone is a timing-only patch", () => {
    const opened = edit({ items: ITEMS });
    const now: ModalState = { ...opened, timing: { srcStart: 1.25, srcEnd: 6.625 } };
    expect(saveFor(opened, now)).toEqual({ props: {}, clearKeys: [], timing: { srcStart: 1.25, srcEnd: 6.625 } });
  });

  it("an add always writes the marker for a covered type, and never for one without item timing", () => {
    const list = openModal({ mode: "add", component: "BulletList", props: { items: ["A", "B"] } });
    expect(saveFor(list, pinItem(list, 1, words[4]!))).toEqual({
      props: { items: ["A", "B"] },
      clearKeys: [],
      itemPins: pinsOf([null, { src: 3.875, text: "B" }]),
    });
    // Unchanged, still an add: the marker goes on for G2.
    expect(saveFor(list, list)!.itemPins).toEqual(pinsOf([null, null]));
    const title = openModal({ mode: "add", component: "TitleCard", props: { title: "Hi" } });
    expect(saveFor(title, title)).toEqual({ props: { title: "Hi" }, clearKeys: [] });
  });

  it("row ops splice text-object and message lists with their own blanks", () => {
    const strike = openModal({ mode: "add", component: "StrikethroughReveal", props: { lines: [{ text: "a" }] } });
    expect(appendItem(strike).props).toEqual({ lines: [{ text: "a" }, { text: "" }] });
    const chat = openModal({
      mode: "add",
      component: "ChatMock",
      props: { messages: [{ from: "user", text: "hi" }] },
    });
    // The popover's rule: a new bubble answers the last one.
    expect(appendItem(chat).props.messages).toEqual([
      { from: "user", text: "hi" },
      { from: "agent", text: "" },
    ]);
    expect(removeItem(appendItem(chat), 0).props.messages).toEqual([{ from: "agent", text: "" }]);
  });
});

describe("whenRowPin (graphic-editor-modal §5, When row)", () => {
  // A cut at 3.0–3.4 s: the seam is output 3.0. "they" at 3.35 starts in
  // the cut, so its output start clamps to the seam.
  const seam = mapFromKeptSpans([
    { srcIn: 0, srcOut: 3.0, outIn: 0, outOut: 3.0 },
    { srcIn: 3.4, srcOut: 10, outIn: 3.0, outOut: 9.6 },
  ]);
  const clipped = { text: "they", start: 3.35, end: 3.75 };

  it("keptSpanStartOf: the source start of the kept span a word plays in", () => {
    expect(keptSpanStartOf(clipped, seam)).toBe(3.4);
    expect(keptSpanStartOf({ text: "so", start: 1, end: 1.2 }, seam)).toBe(0);
    expect(keptSpanStartOf({ text: "gone", start: 3.1, end: 3.2 }, seam)).toBeNull();
  });

  it("at a seam, the pin starts in the word's kept span and resolves on the live clock", () => {
    expect(wordOutputStart(clipped, seam)).toBe(3.0);
    const pin = whenRowPin(clipped, seam, keptSpanStartOf(clipped, seam)!, null, 8)!;
    // Unfloored, 3.0 − ENTRY_LEAD_SEC maps to 2.7 s, before the cut pause:
    // on a clock that revives the pause, the graphic would start in it.
    expect(seam.toSource(3.0 - ENTRY_LEAD_SEC)).toBeLessThan(3.0);
    expect(pin.srcStart).toBe(3.4);
    expect(pin.srcEnd).toBeCloseTo(seam.toSource(8), 9);
    expect(resolveTimingPin(pin, seam)).not.toBeNull();
  });

  it("starts ENTRY_LEAD_SEC ahead of the word inside a kept span", () => {
    const w = words[4]!; // forget, 3.875
    const pin = whenRowPin(w, identity, 0, null, 6.625)!;
    expect(pin.srcStart).toBeCloseTo(3.875 - ENTRY_LEAD_SEC, 9);
    expect(pin.srcEnd).toBe(6.625);
  });

  it("never starts before the previous graphic's end plus SCENE_GAP_SEC", () => {
    const w = words[4]!;
    const pin = whenRowPin(w, identity, 0, 3.7, 6.625)!;
    expect(pin.srcStart).toBeCloseTo(3.7 + SCENE_GAP_SEC, 9);
  });

  it("is null when the pin would end at or before it starts, so the caller refuses that word", () => {
    const w = words[6]!; // code, 6.125: starts 5.825 with the lead
    expect(whenRowPin(w, identity, 0, null, 5.825)).toBeNull();
    expect(whenRowPin(w, identity, 0, null, 5.0)).toBeNull();
    // A previous graphic's floor can push the start past the cue's end too.
    expect(whenRowPin(words[4]!, identity, 0, 6.5, 6.5)).toBeNull();
    expect(whenRowPin(w, identity, 0, null, 6.625)).not.toBeNull();
  });

  it("refuses a word with no time on the live clock: only block words are offered", () => {
    expect(() => whenRowPin(words[4]!, forgetCut, 0, null, 6)).toThrow();
  });
});

/**
 * A graphic without the marker shows what renders now (G5, G7;
 * coordinator ruling on Task 6 concern 3): its rows read the live cue's
 * baked item times, until an item change puts word timing in effect.
 */
describe("modalRows from the live cue (no marker)", () => {
  const at = (i: number) => Math.max(0, wordOutputStart(words[i]!, identity)! - ITEM_LEAD_SEC);
  const NODES = ["HALLUCINATE", "FORGET", "CODE"];
  // A planned FlowDiagram whose planner put item 2 on "they" (3), not on
  // "forget" (4) where the live matcher would: the rows must say 3.
  const planned: SceneCue = {
    id: "scene-0",
    layout: "video-top",
    component: "FlowDiagram",
    props: { nodes: NODES },
    startSec: 1.25,
    endSec: 6.625,
    reveal: { itemAtSec: [at(2), at(3), at(6)] },
  };
  const ctx: RowContext = { ...ctxOn(identity), liveCue: planned };

  it("a planned FlowDiagram shows its planned words, auto with no note, timed as it renders", () => {
    const rows = modalRows("FlowDiagram", planned.props!, undefined, ctx);
    expect(pick(rows)).toEqual([
      ["auto", 2, null],
      ["auto", 3, null],
      ["auto", 6, null],
    ]);
    const frames = revealFrames({
      count: 3,
      legacyStepFrames: 6,
      fps: 30,
      durationInFrames: frameWindow(1.25, 6.625, 30).durationInFrames,
      cueStartSec: 1.25,
      itemAtSec: planned.reveal!.itemAtSec,
      props: {},
    });
    expect(rows.map((r) => r.estSec)).toEqual(frames.map((f) => 1.25 + f / 30));
  });

  it("after an item's text is edited, the rows switch to the live resolution and that row re-matches", () => {
    const opened = openModal({ mode: "edit", component: "FlowDiagram", props: planned.props! });
    const before = modalRows("FlowDiagram", opened.props, shownItemPins(opened, opened), ctx);
    expect(before[1]!.word).toBe(3);
    const now = withProps(opened, { nodes: ["HALLUCINATE", "REVIEW", "CODE"] }, before);
    const after = modalRows("FlowDiagram", now.props, shownItemPins(opened, now), ctx);
    expect(pick(after)).toEqual([
      ["auto", 2, null],
      ["auto", 5, null],
      ["auto", 6, null],
    ]);
  });

  it("a null baked time, or one on no word, is unmatched with the renderer's estimate", () => {
    const cue = { ...planned, reveal: { itemAtSec: [at(2), null, 4.0] } };
    const rows = modalRows("FlowDiagram", planned.props!, undefined, { ...ctx, liveCue: cue });
    expect(pick(rows)).toEqual([
      ["auto", 2, null],
      ["unmatched", null, null],
      ["unmatched", null, null],
    ]);
    expect(rows.every((r) => typeof r.estSec === "number")).toBe(true);
  });

  it("a live cue on its component's legacy stagger has no item time to show", () => {
    const stored: SceneCue = { ...planned, component: "BulletList", props: { items: NODES }, reveal: undefined };
    const rows = modalRows("BulletList", stored.props!, undefined, { ...ctx, liveCue: stored });
    expect(rows.map((r) => [r.state, r.word, r.estSec])).toEqual([
      ["unmatched", null, null],
      ["unmatched", null, null],
      ["unmatched", null, null],
    ]);
  });
});
