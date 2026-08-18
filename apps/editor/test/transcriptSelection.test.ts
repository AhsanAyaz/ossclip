import { describe, expect, it } from "vitest";
import type { CaptionRangeEdit, CaptionWord } from "@ossclip/core/browser";
import { findOccurrences, type FlatWord } from "../src/transcriptSelection";

/**
 * The "Apply to all (n)" window sweep (2026-08-18). Pure on purpose — the
 * exclusion rules are the whole point (each excluded window is a commit that
 * could not honestly apply), and they must be testable without a DOM.
 */

/** A flat word as the panel's flatten produces it. `srcStart: undefined`
 * models a pre-§137 word — `captionAnchorOf` returns null for it. */
const fw = (index: number, live: string, srcStart: number | undefined, base = live): FlatWord => ({
  index,
  base,
  live,
  synthetic: false,
  word: {
    text: live,
    start: index * 0.3,
    end: index * 0.3 + 0.3,
    srcStart,
  } as CaptionWord,
});

const flat = (specs: Array<[string, number | undefined] | [string, number | undefined, string]>) =>
  specs.map(([live, srcStart, base], i) => fw(i, live, srcStart, base ?? live));

const none = (): CaptionRangeEdit | undefined => undefined;

describe("findOccurrences — single word", () => {
  it("finds every other identical live word, endpoints keyed by srcStart", () => {
    const words = flat([
      ["hello", 10],
      ["x", 11],
      ["hello", 12],
      ["hello", 13],
    ]);
    expect(findOccurrences(words, 0, 0, none)).toEqual([
      { fromSrcStart: 12, toSrcStart: 12, was: "hello", rawWas: "hello" },
      { fromSrcStart: 13, toSrcStart: 13, was: "hello", rawWas: "hello" },
    ]);
  });

  it("matches across NFC forms — composed selection, decomposed candidate", () => {
    // The word carries composed \u0622 (alef-with-madda); the candidate
    // spells the SAME glyph decomposed (\u0627 alef + \u0653 madda). One
    // glyph, different bytes — the trap the panel's search normalizes for.
    // Escapes, not literals: the two render identically, and a literal would
    // let any tool that normalizes on save quietly rewrite this test into a
    // tautology.
    const composed = "\u0622\u0645";
    const decomposed = "\u0627\u0653\u0645";
    const words = flat([
      [composed, 10],
      ["x", 11],
      [decomposed, 12],
    ]);
    expect(findOccurrences(words, 0, 0, none)).toEqual([
      // `was` is NFC-normalized — the RANGE layer normalizes both sides of
      // its whole-run guard. `rawWas` is the base text VERBATIM, for the
      // single-word route: `applyCaptionEdits` compares bytes, so an NFC
      // `was` would never match this decomposed word (2026-08-19 review).
      { fromSrcStart: 12, toSrcStart: 12, was: composed, rawWas: decomposed },
    ]);
  });

  it("skips a candidate sharing the selection's own anchor — a manufactured duplicate, not an occurrence", () => {
    // `backfillSrcStart` manufactures shared source instants
    // (captions.ts:44-50): two spans, one key — "applying" to the duplicate
    // would just rewrite the selection's own entry.
    const words = flat([
      ["foo", 5],
      ["foo", 5],
      ["foo", 9],
    ]);
    expect(findOccurrences(words, 0, 0, none)).toEqual([
      { fromSrcStart: 9, toSrcStart: 9, was: "foo", rawWas: "foo" },
    ]);
  });
});

describe("findOccurrences — multi-word runs", () => {
  it("finds a repeated run; `was` is the BASE join, never the live one", () => {
    // The candidate run carries a retype ("helo"→"hello" style divergence):
    // the reducer scrubs per-word retypes inside each interval in the same
    // commit, so the apply-time whole-run guard reads the BASE run — a
    // live-joined `was` would stale the entry forever (the base-truth rule).
    const words = flat([
      ["hello", 10],
      ["world", 11],
      ["x", 12],
      ["hello", 13, "helo"],
      ["world", 14],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([
      { fromSrcStart: 13, toSrcStart: 14, was: "helo world", rawWas: "helo world" },
    ]);
  });

  it("a window may straddle what were separate caption lines — the flat list has no seams", () => {
    // The panel flattens all lines into one list before the sweep, so a run
    // whose words came from two adjacent lines is still one contiguous
    // window here. Indices 3-4 stand in for a line boundary at 4.
    const words = flat([
      ["a", 10],
      ["b", 11],
      ["x", 12],
      ["a", 13],
      ["b", 14],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([
      { fromSrcStart: 13, toSrcStart: 14, was: "a b", rawWas: "a b" },
    ]);
  });

  it("never claims a word twice — overlapping repeats resolve greedily", () => {
    // "a a a a" after the selection: windows [2,3],[3,4],[4,5] all match,
    // but two overlapping entries in one bulk commit would trip the
    // reducer's overlap scrub — the second appended entry silently deleting
    // the first — so the sweep advances past each accepted match.
    const words = flat([
      ["a", 10],
      ["a", 11],
      ["a", 12],
      ["a", 13],
      ["a", 14],
      ["a", 15],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([
      { fromSrcStart: 12, toSrcStart: 13, was: "a a", rawWas: "a a" },
      { fromSrcStart: 14, toSrcStart: 15, was: "a a", rawWas: "a a" },
    ]);
  });
});

describe("findOccurrences — exclusions", () => {
  it("never returns a window overlapping the selection itself", () => {
    // "a a a": selecting the middle "a a"-sized run of a repeated word must
    // not offer the half-overlapping shifted windows.
    const words = flat([
      ["a", 10],
      ["a", 11],
      ["a", 12],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([]);
    expect(findOccurrences(words, 1, 2, none)).toEqual([]);
  });

  it("skips a window containing an anchorless word (§137)", () => {
    const words = flat([
      ["a", 10],
      ["b", 11],
      ["x", 12],
      ["a", undefined],
      ["b", 14],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([]);
  });

  it("skips a window covered by a live range entry — it cannot be re-keyed", () => {
    // Minted anchors exist only while their entry does (the F2 lesson):
    // re-keying a covered run under a new pair loses both rewrites.
    const words = flat([
      ["a", 10],
      ["x", 11],
      ["a", 12],
      ["a", 13],
    ]);
    const entry: CaptionRangeEdit = { fromKey: "w12000", toKey: "w12000", text: "a", was: "q" };
    const covering = (w: CaptionWord) => (w.srcStart === 12 ? entry : undefined);
    expect(findOccurrences(words, 0, 0, covering)).toEqual([
      { fromSrcStart: 13, toSrcStart: 13, was: "a", rawWas: "a" },
    ]);
  });

  it("returns [] when the text occurs nowhere else", () => {
    const words = flat([
      ["only", 10],
      ["once", 11],
    ]);
    expect(findOccurrences(words, 0, 1, none)).toEqual([]);
    expect(findOccurrences(words, 0, 0, none)).toEqual([]);
  });
});
