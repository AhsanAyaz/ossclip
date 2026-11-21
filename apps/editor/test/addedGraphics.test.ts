import { describe, expect, it } from "vitest";
import { mapFromKeptSpans, type SceneCue } from "@ossclip/core/browser";
import { addedSkippedHeading, addedSkippedRows, previewBaseCues } from "../src/addedGraphics";
import { editReducer, initialEditState } from "../src/useEdits";

/** 20 words, 0.5 s apart, 0.4 s long — source-timed, the repaired list's shape. */
const words = Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
const identity = mapFromKeptSpans([{ srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 }]);

const cue = (id: string, startSec: number, endSec: number, extra: Partial<SceneCue> = {}): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "L", value: "V" },
  startSec,
  endSec,
  ...extra,
});

/** What a past run baked for `added-1` over words 2-4. */
const baked = cue("added-1", 1, 2.5, { component: "TitleCard", props: { title: "BAKED" } });

const add = { component: "TitleCard", props: { title: "HELLO" }, srcStart: 1, srcEnd: 2.4 };

describe("previewBaseCues (editor-added-graphics §4)", () => {
  it("undo of an add a run already baked: the baked cue is gone from the preview", () => {
    let s = editReducer(initialEditState(), { type: "addScene", ...add, baseIds: [] });
    // The run happened: base cues now hold `added-1`. Then the author undoes.
    s = editReducer(s, { type: "undo" });
    const { cues } = previewBaseCues({
      baseCues: [baked, cue("scene-0", 6, 8)],
      added: s.doc.addedScenes ?? [],
      issueIds: new Set(),
      words,
      map: identity,
    });
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
  });

  it("remove then re-add on the same words before a run: a NEW id with a fresh cue, the old one gone", () => {
    const baseCues = [baked, cue("scene-0", 6, 8)];
    let s = {
      ...initialEditState(),
      doc: editReducer(initialEditState(), { type: "addScene", ...add, baseIds: [] }).doc,
    };
    s = editReducer(s, { type: "removeAddedScene", id: "added-1" });
    s = editReducer(s, { type: "addScene", ...add, baseIds: baseCues.map((c) => c.id) });
    expect(s.doc.addedScenes!.map((e) => e.id)).toEqual(["added-2"]);
    const { cues } = previewBaseCues({
      baseCues,
      added: s.doc.addedScenes!,
      issueIds: new Set(),
      words,
      map: identity,
    });
    expect(cues.map((c) => c.id)).toEqual(["added-2", "scene-0"]);
    // The new add's own props, never the old baked look.
    expect(cues[0]!.props).toEqual({ title: "HELLO" });
  });

  it("with no clock the drop rule still runs, but nothing new is added", () => {
    const { cues, skipped } = previewBaseCues({
      baseCues: [baked, cue("scene-0", 6, 8)],
      added: [{ id: "added-2", ...add }],
      issueIds: new Set(),
      words,
      map: null,
    });
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
    expect(skipped).toEqual([]);
  });

  it("with no word list it behaves as with no clock", () => {
    const { cues } = previewBaseCues({
      baseCues: [baked],
      added: [{ id: "added-1", ...add }, { id: "added-2", ...add, srcStart: 6, srcEnd: 7 }],
      issueIds: new Set(),
      words: null,
      map: identity,
    });
    expect(cues.map((c) => c.id)).toEqual(["added-1"]);
  });
});

describe("addedSkippedRows (§7)", () => {
  const doc = [
    { id: "added-1", ...add },
    { id: "added-2", ...add, component: "OldCard" },
    { id: "added-3", ...add, component: "StatCard" },
  ];

  it("joins produce's issues with the preview's skips, once per id, in doc order", () => {
    const rows = addedSkippedRows(
      doc,
      [
        { id: "added-2", reason: "graphic type OldCard no longer exists" },
        { id: "added-3", reason: "all words cut" },
      ],
      [
        { id: "added-3", reason: "a second opinion" },
        { id: "added-1", reason: "its words are no longer in the transcript" },
      ],
    );
    expect(rows).toEqual([
      { id: "added-1", component: "TitleCard", reason: "its words are no longer in the transcript" },
      { id: "added-2", component: "OldCard", reason: "graphic type OldCard no longer exists" },
      // Produce's reason wins: it is what the next run will say again.
      { id: "added-3", component: "StatCard", reason: "all words cut" },
    ]);
  });

  it("lists only ids still in the doc — a removed entry leaves the list at once", () => {
    const rows = addedSkippedRows(doc.slice(0, 1), [{ id: "added-2", reason: "x" }], []);
    expect(rows).toEqual([]);
  });
});

describe("addedSkippedHeading (§7)", () => {
  it("says 'graphic is' for one and 'graphics are' for more", () => {
    expect(addedSkippedHeading(1)).toBe("1 added graphic is not shown");
    expect(addedSkippedHeading(2)).toBe("2 added graphics are not shown");
  });
});
