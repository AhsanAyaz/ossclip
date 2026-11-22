import { describe, expect, it } from "vitest";
import {
  ITEM_LEAD_SEC,
  OverrideDocSchema,
  applyOverrides,
  mapFromKeptSpans,
  type OverrideDoc,
  type SceneCue,
} from "@ossclip/core/browser";
import { previewItemRoots, previewItemTimings } from "../src/itemTimingPreview";

/**
 * The live preview's item step (graphic-editor-modal §4), without App: the
 * roots taken at the memo's first `applyOverrides`, and the resolve on
 * either exit of `finishOnClock`. Parity with produce is the harness's job
 * (item-timing-parity.test.ts runs one case through these two); here,
 * the guards that keep a project without the marker on the byte-identical
 * path, and the ordinary session's resolve.
 */
const SAID: [string, number, number][] = [
  ["so", 0.0, 0.25], //       0
  ["they", 1.25, 1.5], //     1
  ["hallucinate", 1.625, 2.25], // 2
  ["they", 3.5, 3.75], //     3
  ["forget", 3.875, 4.25], // 4
  ["review", 5.375, 5.75], // 5
  ["code", 6.125, 6.625], //  6
];
const words = SAID.map(([text, start, end]) => ({ text, start, end }));
// No cut: output == source, so a word's time is its start.
const identity = mapFromKeptSpans([{ srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 }]);

const list: SceneCue = {
  id: "scene-0",
  layout: "video-top",
  component: "BulletList",
  props: { items: ["HALLUCINATE", "FORGET", "REVIEW THE CODE"] },
  anchor: { startWord: 1, endWord: 6 },
  startSec: 1.25,
  endSec: 6.625,
};
const docOf = (raw: Record<string, unknown>): OverrideDoc => OverrideDocSchema.parse(raw);
const marked = docOf({
  scenes: {
    "scene-0": { itemPins: { component: "BulletList", pins: [null, { src: 3.875, text: "FORGET" }, null] } },
  },
});

/** The memo's props on the early exit: the cues after its overrides, plus
 * keys the item step must hand through untouched. */
const propsFor = (doc: OverrideDoc) => ({
  sceneCues: applyOverrides([list], doc).cues,
  captionLines: [],
  outputDurationSec: 10,
});

describe("previewItemRoots (graphic-editor-modal §4)", () => {
  it("builds the roots from the unsplit list, one per marked root", () => {
    const roots = previewItemRoots(applyOverrides([list], marked).cues, marked, words, identity, identity);
    expect([...roots!.keys()]).toEqual(["scene-0"]);
    expect(roots!.get("scene-0")!.window).toEqual({ srcStart: 1.25, srcEnd: 6.625 });
  });

  it("is null without a clock or a word list: the pass is skipped, not run on a guess", () => {
    const cues = applyOverrides([list], marked).cues;
    expect(previewItemRoots(cues, marked, words, null, identity)).toBeNull();
    expect(previewItemRoots(cues, marked, words, identity, null)).toBeNull();
    expect(previewItemRoots(cues, marked, null, identity, identity)).toBeNull();
  });
});

describe("previewItemTimings (graphic-editor-modal §4)", () => {
  it("hands back the SAME props object when no root has itemPins", () => {
    const doc = docOf({ scenes: { "scene-0": { props: { title: "EDITED" } } } });
    const props = propsFor(doc);
    const roots = previewItemRoots(props.sceneCues, doc, words, identity, identity);
    const out = previewItemTimings(props, doc, roots, words, identity);
    expect(out.props).toBe(props);
    expect(out.notes).toEqual([]);
  });

  it("hands back the SAME props object with a null clock", () => {
    const props = propsFor(marked);
    const roots = previewItemRoots(props.sceneCues, marked, words, identity, identity);
    expect(previewItemTimings(props, marked, roots, words, null).props).toBe(props);
    // The roots themselves null (App's `oldClockMap === null`).
    expect(previewItemTimings(props, marked, null, words, identity).props).toBe(props);
  });

  it("hands back the SAME props object with a null word list", () => {
    const props = propsFor(marked);
    const roots = previewItemRoots(props.sceneCues, marked, words, identity, identity);
    expect(previewItemTimings(props, marked, roots, null, identity).props).toBe(props);
  });

  it("resolves on the early-exit path: items on their words, synced by the pin, nothing else touched", () => {
    const props = propsFor(marked);
    const roots = previewItemRoots(props.sceneCues, marked, words, identity, identity);
    const out = previewItemTimings(props, marked, roots, words, identity);
    expect(out.props).not.toBe(props);
    const cue = out.props.sceneCues[0]!;
    // Auto "HALLUCINATE" → word 2, pinned "FORGET" → word 4, auto "REVIEW
    // THE CODE" → word 5, each less the lead.
    expect(cue.reveal?.itemAtSec).toEqual([1.625 - ITEM_LEAD_SEC, 3.875 - ITEM_LEAD_SEC, 5.375 - ITEM_LEAD_SEC]);
    expect(cue.props?.reveal).toBe("synced");
    expect([cue.startSec, cue.endSec]).toEqual([list.startSec, list.endSec]);
    expect(out.props.captionLines).toBe(props.captionLines);
    expect(out.props.outputDurationSec).toBe(10);
    expect(out.notes).toEqual([]);
  });

  it("returns the resolver's notes, for the pass's reports", () => {
    // A pin 1 s off every word: "its word moved", the item goes auto.
    const doc = docOf({
      scenes: { "scene-0": { itemPins: { component: "BulletList", pins: [null, { src: 3.0, text: "FORGET" }, null] } } },
    });
    const props = propsFor(doc);
    const roots = previewItemRoots(props.sceneCues, doc, words, identity, identity);
    expect(previewItemTimings(props, doc, roots, words, identity).notes).toEqual([
      'scene "scene-0" item 2: its word moved',
    ]);
  });
});
