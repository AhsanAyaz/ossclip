import { describe, expect, it } from "vitest";
import { OverrideDocSchema } from "../src/overrides";
import {
  alignRestamp,
  captionKeyMs,
  rekeyCaptionRecords,
  spliceTranscript,
  wordsInSpan,
  type StampMove,
} from "../src/restamp";
import type { Transcript, Word } from "../src/schema";

/** Chained stamps, the shape `transcribe.ts` guarantees (`next.start = w.end`). */
const words = (spec: Array<[string, number, number]>): Word[] =>
  spec.map(([text, start, end]) => ({ text, start, end }));

describe("alignRestamp", () => {
  it("gives every matched word the new decode's stamps, offset by the span start", () => {
    const old = words([["could", 0, 1], ["read", 1, 2], ["files", 2, 3]]);
    // The clip decode says the same three words, 0.5s later inside a slice
    // that starts at 10s.
    const fresh = words([["could", 0.5, 1.5], ["read", 1.5, 2.5], ["files", 2.5, 3.5]]);
    const out = alignRestamp(old, fresh, 10);
    expect(out.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["could", 10.5, 11.5],
      ["read", 11.5, 12.5],
      ["files", 12.5, 13.5],
    ]);
    expect(out.reports).toEqual([]);
  });

  it("keeps diverged TEXT and interpolates its stamps between the matched neighbours", () => {
    const old = words([["could", 0, 1], ["50", 1, 2], ["files", 2, 3]]);
    // The decode heard "fifty" where the transcript says "50" — the text must
    // survive (word indices!), the stamps must come from the audio.
    const fresh = words([["could", 0, 1], ["fifty", 1, 3], ["files", 3, 4]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.words.map((w) => w.text)).toEqual(["could", "50", "files"]);
    expect(out.words[1]).toMatchObject({ start: 1, end: 3 });
  });

  it("splits a multi-word gap evenly across the interval its neighbours left", () => {
    const old = words([["a", 0, 1], ["x", 1, 2], ["y", 2, 3], ["b", 3, 4]]);
    const fresh = words([["a", 0, 1], ["zzz", 1, 5], ["b", 5, 6]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.words.map((w) => [w.start, w.end])).toEqual([
      [0, 1],
      [1, 3],
      [3, 5],
      [5, 6],
    ]);
  });

  it("anchors a LEADING gap to the span start and a TRAILING one to the decode's end", () => {
    const old = words([["x", 0, 1], ["b", 1, 2], ["y", 2, 3]]);
    const fresh = words([["b", 1, 2]]);
    const out = alignRestamp(old, fresh, 10);
    expect(out.words[0]).toMatchObject({ start: 10, end: 11 });
    expect(out.words[1]).toMatchObject({ start: 11, end: 12 });
    expect(out.words[2]).toMatchObject({ start: 12, end: 12 });
  });

  it("never changes the text or the count — the whole doctrine of the splice", () => {
    const old = words([["one", 0, 1], ["two", 1, 2], ["three", 2, 3], ["four", 3, 4]]);
    const fresh = words([["one", 0, 0.5], ["banana", 0.5, 1], ["four", 1, 1.5], ["extra", 1.5, 2]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.words).toHaveLength(old.length);
    expect(out.words.map((w) => w.text)).toEqual(["one", "two", "three", "four"]);
  });

  it("matches on the normalized token, so punctuation and case do not break the anchor", () => {
    const old = words([["Could,", 0, 1], ["read.", 1, 2]]);
    const fresh = words([["could", 2, 3], ["READ", 3, 4]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.words.map((w) => [w.text, w.start])).toEqual([
      ["Could,", 2],
      ["read.", 3],
    ]);
  });

  it("reports and leaves the stamps alone when NOTHING matched", () => {
    const old = words([["alpha", 0, 1], ["beta", 1, 2]]);
    const out = alignRestamp(old, words([["gamma", 5, 6]]), 3);
    expect(out.words).toEqual(old);
    expect(out.mapping).toEqual([]);
    expect(out.reports.join(" ")).toContain("matched none");
  });

  it("reports the words a shorter decode squeezed to zero length", () => {
    const old = words([["a", 0, 1], ["gone", 1, 2], ["b", 2, 3]]);
    // The decode chained a straight into b — there is no room between them.
    const fresh = words([["a", 0, 1], ["b", 1, 2]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.words[1]).toMatchObject({ start: 1, end: 1 });
    expect(out.reports.join(" ")).toContain("zero-length");
  });

  it("reports only the anchors that MOVED, at captionKeyFor's ms quantization", () => {
    const old = words([["a", 1, 2], ["b", 2, 3]]);
    const fresh = words([["a", 1, 2], ["b", 2.4213, 3]]);
    const out = alignRestamp(old, fresh, 0);
    expect(out.mapping).toEqual<StampMove[]>([{ fromMs: 2000, toMs: 2421 }]);
    expect(captionKeyMs(2.4213)).toBe(2421);
  });

  it("stays monotone and non-negative on an empty decode", () => {
    const out = alignRestamp(words([["a", 1, 2]]), [], 0);
    expect(out.words).toEqual(words([["a", 1, 2]]));
  });
});

describe("rekeyCaptionRecords", () => {
  const doc = OverrideDocSchema.parse({
    captions: { w1000: { text: "JSON", was: "Jason" }, w9000: { text: "keep", was: "kept" } },
    captionWordsHidden: { w1000: { was: "um" } },
    captionLineTiming: { w1000: { lead: -0.2, tail: 0.3 } },
    captionLineWindows: { w1000: { srcStart: 3, srcEnd: 4.5 } },
    captionRangeEdits: [{ fromKey: "w1000", toKey: "w2000", text: "new run", was: "old run" }],
  });

  it("moves every source-keyed record onto the new stamp", () => {
    const { doc: out, reports } = rekeyCaptionRecords(doc, [
      { fromMs: 1000, toMs: 1500 },
      { fromMs: 2000, toMs: 2600 },
    ]);
    expect(Object.keys(out.captions).sort()).toEqual(["w1500", "w9000"]);
    expect(out.captions.w1500).toEqual({ text: "JSON", was: "Jason" });
    expect(out.captionWordsHidden).toEqual({ w1500: { was: "um" } });
    expect(out.captionLineTiming).toEqual({ w1500: { lead: -0.2, tail: 0.3 } });
    // The KEY moves, the WINDOW does not: the key names the word whose stamp
    // the re-decode just corrected, while the window is where the user placed
    // the caption against audio the re-decode did not touch.
    expect(out.captionLineWindows).toEqual({ w1500: { srcStart: 3, srcEnd: 4.5 } });
    expect(out.captionRangeEdits[0]).toMatchObject({ fromKey: "w1500", toKey: "w2600" });
    expect(reports).toEqual([]);
  });

  it("is identity — same object — on an empty mapping", () => {
    const out = rekeyCaptionRecords(doc, []);
    expect(out.doc).toBe(doc);
    expect(out.reports).toEqual([]);
  });

  it("leaves records the mapping does not name alone", () => {
    const out = rekeyCaptionRecords(doc, [{ fromMs: 7777, toMs: 8888 }]);
    expect(Object.keys(out.doc.captions).sort()).toEqual(["w1000", "w9000"]);
  });

  it("parks the loser of a quantization collision at its own key and reports it", () => {
    const two = OverrideDocSchema.parse({
      captions: { w1000: { text: "first", was: "a" }, w1200: { text: "second", was: "b" } },
    });
    const { doc: out, reports } = rekeyCaptionRecords(two, [
      { fromMs: 1000, toMs: 1500 },
      { fromMs: 1200, toMs: 1500 },
    ]);
    expect(out.captions.w1500).toEqual({ text: "first", was: "a" });
    expect(out.captions.w1200).toEqual({ text: "second", was: "b" });
    expect(reports.join(" ")).toContain("w1200");
  });

  it("does not touch splits or cuts — a re-decode moves no footage", () => {
    const withSplits = OverrideDocSchema.parse({
      splits: [{ id: "s1", src: 1, at: 1 }],
      captions: { w1000: { text: "x", was: "y" } },
    });
    const out = rekeyCaptionRecords(withSplits, [{ fromMs: 1000, toMs: 1500 }]);
    expect(out.doc.splits).toEqual(withSplits.splits);
  });
});

describe("wordsInSpan", () => {
  const ws = words([["a", 0, 1], ["b", 1, 2], ["c", 2, 3], ["d", 3, 4]]);

  it("takes only the words that fit WHOLLY inside the span", () => {
    expect(wordsInSpan(ws, 1, 3)).toEqual({ from: 1, to: 3 });
  });

  it("excludes a word straddling either boundary — the slice never heard all of it", () => {
    expect(wordsInSpan(ws, 1.5, 3.5)).toEqual({ from: 2, to: 3 });
  });

  it("answers an empty range at zero when nothing fits", () => {
    expect(wordsInSpan(ws, 10, 20)).toEqual({ from: 0, to: 0 });
  });
});

describe("spliceTranscript", () => {
  const transcript: Transcript = {
    language: "en",
    words: words([["a", 0, 1], ["b", 1, 2], ["c", 2, 3]]),
  };

  it("replaces the range in place and carries everything else through", () => {
    const out = spliceTranscript(transcript, { from: 1, to: 2 }, words([["b", 1.4, 1.9]]));
    expect(out.language).toBe("en");
    expect(out.words.map((w) => [w.text, w.start])).toEqual([
      ["a", 0],
      ["b", 1.4],
      ["c", 2],
    ]);
  });

  it("refuses a count that would move every scene anchor", () => {
    expect(() => spliceTranscript(transcript, { from: 0, to: 2 }, words([["a", 0, 1]]))).toThrow(
      /stamps-only/,
    );
  });

  it("refuses a range outside the words array", () => {
    expect(() => spliceTranscript(transcript, { from: 0, to: 9 }, [])).toThrow(/outside/);
  });

  it("is a no-op on the empty range wordsInSpan answers with", () => {
    expect(spliceTranscript(transcript, { from: 0, to: 0 }, [])).toEqual(transcript);
  });
});
