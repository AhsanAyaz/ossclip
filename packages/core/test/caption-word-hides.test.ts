import { describe, expect, it } from "vitest";
import {
  applyCaptionLayers,
  applyCaptionWordHides,
  OverrideDocSchema,
} from "../src/overrides";
import type { CaptionLine } from "../src/captions";
import { TimeMap } from "../src/timemap";

// This fixture has no cutlist and no `TimeMap`, so nothing here relates
// source time to output time at all. `srcStart` is set equal to `start` as
// an inert stand-in — NOT because the two coincide (§137). Anything that
// needs a source time that genuinely differs must build a map.
const makeLines = (): CaptionLine[] => [
  {
    start: 0,
    // `end` is past the last word's end: the packer's hold (captions.ts
    // :203-213), which the last-word-hide test below asserts is preserved.
    end: 1.35,
    words: [
      { text: "never", start: 0, end: 0.4, srcStart: 0 },
      { text: "gonna", start: 0.4, end: 0.7, srcStart: 0.4 },
      { text: "give", start: 0.7, end: 1, srcStart: 0.7 },
    ],
  },
  {
    start: 1.5,
    end: 2.5,
    words: [{ text: "up", start: 1.5, end: 2.5, srcStart: 1.5 }],
  },
];

describe("applyCaptionWordHides (per-word caption delete)", () => {
  it("hides a MIDDLE word without touching the line's window", () => {
    const lines = makeLines();
    const { lines: out, dropped } = applyCaptionWordHides(lines, {
      w400: { was: "gonna" },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "give"]);
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(1.35);
    expect(out[1]).toBe(lines[1]);
    expect(dropped).toEqual([]);
  });

  it("hides the FIRST word and moves line.start to the first survivor", () => {
    const { lines: out } = applyCaptionWordHides(makeLines(), {
      w0: { was: "never" },
    });
    // Without the recompute the line would linger on screen from 0s with
    // nothing highlighted until "gonna" starts.
    expect(out[0]!.start).toBe(0.4);
    expect(out[0]!.end).toBe(1.35);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["gonna", "give"]);
  });

  it("hides the LAST word and re-bases the packer's hold on the new last word", () => {
    const { lines: out } = applyCaptionWordHides(makeLines(), {
      w700: { was: "give" },
    });
    // The original hold delta was 1.35 - 1.0 = 0.35s past the last word;
    // it now rides on "gonna" (ends 0.7), not on the hidden word's stamp.
    expect(out[0]!.end).toBeCloseTo(0.7 + 0.35, 10);
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna"]);
  });

  it("clamps the re-based end so a line never ends before its own last word", () => {
    // A hold delta clamped NEGATIVE by outputDuration (captions.ts:212) must
    // not drag the window inside the surviving words.
    const lines: CaptionLine[] = [
      {
        start: 0,
        end: 0.9, // < last word's end: the outputDuration clamp case
        words: [
          { text: "one", start: 0, end: 0.5, srcStart: 0 },
          { text: "two", start: 0.5, end: 1, srcStart: 0.5 },
        ],
      },
    ];
    const { lines: out } = applyCaptionWordHides(lines, { w500: { was: "two" } });
    expect(out[0]!.end).toBe(0.5);
  });

  it("omits a line whose words are ALL hidden; other lines stay intact", () => {
    const { lines: out, dropped } = applyCaptionWordHides(makeLines(), {
      w1500: { was: "up" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna", "give"]);
    expect(dropped).toEqual([]);
  });

  it("drops a stale hide with a report instead of deleting the wrong word", () => {
    // The §17 heard-guard pattern: a re-derived stream re-worded the word
    // under a surviving anchor — or the user un-retyped it under the hide.
    const { lines: out, dropped } = applyCaptionWordHides(makeLines(), {
      w400: { was: "something-else" },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna", "give"]);
    expect(dropped).toEqual([{ key: "w400", expected: "something-else", found: "gonna" }]);
  });

  it("reports an unmatched key (a later cut removed the word) with found: null", () => {
    const { lines: out, dropped } = applyCaptionWordHides(makeLines(), {
      w9999: { was: "gone" },
    });
    expect(out.map((l) => l.words.length)).toEqual([3, 1]);
    expect(dropped).toEqual([{ key: "w9999", expected: "gone", found: null }]);
  });

  it("hides only the FIRST of two words sharing a ms-quantised anchor", () => {
    // captions.ts:44-50 manufactures duplicate srcStarts by design (seam
    // preimages, cut-clamped words) — one hide must not fan out onto both.
    const lines: CaptionLine[] = [
      {
        start: 0,
        end: 1,
        words: [
          { text: "the", start: 0, end: 0.5, srcStart: 2 },
          { text: "the", start: 0.5, end: 1, srcStart: 2 },
        ],
      },
    ];
    const { lines: out, dropped } = applyCaptionWordHides(lines, { w2000: { was: "the" } });
    expect(out[0]!.words).toHaveLength(1);
    // The survivor is the SECOND word — the first claimed the anchor.
    expect(out[0]!.words[0]!.start).toBe(0.5);
    expect(dropped).toEqual([
      { key: "w2000", expected: "the", found: "the", reason: "duplicate-anchor" },
    ]);
  });

  it("no hides is the identity fast path", () => {
    const lines = makeLines();
    const { lines: out, dropped } = applyCaptionWordHides(lines, {});
    expect(out).toEqual(lines);
    expect(out).not.toBe(lines);
    expect(dropped).toEqual([]);
  });
});

describe("captionWordsHidden schema", () => {
  it("defaults to {} so an empty doc parses", () => {
    expect(OverrideDocSchema.parse({}).captionWordsHidden).toEqual({});
  });

  it("a pre-existing doc WITHOUT the field still parses", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w500: { text: "escape", was: "scape" } },
    });
    expect(doc.captionWordsHidden).toEqual({});
    expect(doc.captions.w500).toEqual({ text: "escape", was: "scape" });
  });

  it("round-trips entries", () => {
    const doc = OverrideDocSchema.parse({ captionWordsHidden: { w400: { was: "gonna" } } });
    expect(doc.captionWordsHidden).toEqual({ w400: { was: "gonna" } });
    // A JSON.parse(JSON.stringify(...)) round trip is what overrides.json is.
    expect(
      OverrideDocSchema.parse(JSON.parse(JSON.stringify(doc))).captionWordsHidden,
    ).toEqual({ w400: { was: "gonna" } });
  });
});

describe("applyCaptionLayers (the one chokepoint)", () => {
  /**
   * None of these docs hold a `captionLineWindows` entry, so the window layer
   * the composer runs last is inert — this map exists only because it takes
   * one. A single kept span over the whole source also makes its src→output
   * conversion a plain identity, so nothing here reads differently than it did
   * before the layer existed (`applyCaptionLineWindows` is pinned on its own,
   * over a map with a cut in it, in caption-line-windows.test.ts).
   */
  const noWindows = new TimeMap([{ srcIn: 0, srcOut: 3600, kind: "keep" }]);

  it("applies a retype and a hide on different words, tagging drops by layer", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w0: { text: "always", was: "never" } },
      captionWordsHidden: { w400: { was: "gonna" }, w9999: { was: "gone" } },
    });
    const { lines: out, dropped } = applyCaptionLayers(makeLines(), doc, noWindows);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["always", "give"]);
    expect(dropped).toEqual([{ key: "w9999", expected: "gone", found: null, layer: "hide" }]);
  });

  it("a hide whose `was` is the RETYPED text applies — edits run first", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w400: { text: "gunna", was: "gonna" } },
      // `was` is the LIVE text at hide time, i.e. the retype's output.
      captionWordsHidden: { w400: { was: "gunna" } },
    });
    const { lines: out, dropped } = applyCaptionLayers(makeLines(), doc, noWindows);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "give"]);
    expect(dropped).toEqual([]);
  });

  it("tags an edit-layer drop as layer: edit", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w0: { text: "always", was: "not-the-word" } },
    });
    const { dropped } = applyCaptionLayers(makeLines(), doc, noWindows);
    expect(dropped).toEqual([
      { key: "w0", expected: "not-the-word", found: "never", layer: "edit" },
    ]);
  });
});
