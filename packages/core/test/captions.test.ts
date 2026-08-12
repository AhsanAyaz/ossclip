import { describe, expect, it } from "vitest";
import { backfillSrcStart, buildCaptionLines, lineDirection, type CaptionLine } from "../src/captions";
import { TimeMap, type KeptSpan } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";

describe("buildCaptionLines", () => {
  const identity = (duration: number): TimeMap =>
    new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" } satisfies Segment]);

  it("groups words into lines of at most maxWords", () => {
    const transcript: Transcript = {
      language: "en",
      words: Array.from({ length: 7 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.3,
        end: i * 0.3 + 0.25,
      })),
    };
    const lines = buildCaptionLines(transcript, identity(3), { maxWordsPerLine: 3 });
    expect(lines.map((l) => l.words.length)).toEqual([3, 3, 1]);
  });

  it("starts a new line after a long speech gap", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "a", start: 0, end: 0.2 },
        { text: "b", start: 1.5, end: 1.7 }, // 1.3 s gap > default 0.6
      ],
    };
    const lines = buildCaptionLines(transcript, identity(2));
    expect(lines).toHaveLength(2);
  });

  it("drops words that were cut and re-times survivors into output time", () => {
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 1, kind: "keep" },
      { srcIn: 1, srcOut: 3, kind: "remove", reason: "filler" },
      { srcIn: 3, srcOut: 4, kind: "keep" },
    ];
    const map = new TimeMap(cutlist);
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "kept", start: 0.2, end: 0.8 },
        { text: "um", start: 1.5, end: 2.5 }, // fully removed
        { text: "also", start: 3.2, end: 3.8 },
      ],
    };
    const lines = buildCaptionLines(transcript, map);
    const texts = lines.flatMap((l) => l.words.map((w) => w.text));
    expect(texts).toEqual(["kept", "also"]);
    const also = lines.flatMap((l) => l.words).find((w) => w.text === "also")!;
    expect(also.start).toBeCloseTo(1.2, 6); // 3.2 source − 2 s removed
  });

  it("splits lines at scene boundaries and clamps holds to them (FINDINGS §6b)", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "before", start: 0.0, end: 0.4 },
        { text: "after", start: 0.6, end: 1.0 }, // scene boundary at 0.5 sits between them
      ],
    };
    const lines = buildCaptionLines(transcript, identity(3), { breakpoints: [0.5] });
    expect(lines).toHaveLength(2); // would be one line without the boundary
    expect(lines[0]!.end).toBeLessThanOrEqual(0.5 + 1e-9); // hold clamped at the boundary
    expect(lines[1]!.start).toBeCloseTo(0.6, 6);
  });

  it("never extends a line past the next line or the output end", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "a", start: 0, end: 0.2 },
        { text: "b", start: 1.5, end: 1.9 },
      ],
    };
    const map = identity(2);
    const lines = buildCaptionLines(transcript, map);
    expect(lines[0]!.end).toBeLessThanOrEqual(lines[1]!.start + 1e-9);
    expect(lines[lines.length - 1]!.end).toBeLessThanOrEqual(map.outputDuration + 1e-9);
  });
});

describe("CaptionWord.srcStart (§137)", () => {
  it("carries the SOURCE start, not the output start, so a re-cut cannot move it", () => {
    // One kept span starting 2.0s into the source: output 0 === source 2.0.
    // TimeMap's constructor takes a cutlist of `Segment`s and derives the
    // output side itself — only `kind: "keep"` spans contribute to it.
    const map = new TimeMap([{ srcIn: 2, srcOut: 5, kind: "keep" } satisfies Segment]);
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "alpha", start: 2.5, end: 2.9 },
        { text: "beta", start: 3.5, end: 3.9 },
      ],
    };

    const words = buildCaptionLines(transcript, map).flatMap((l) => l.words);

    expect(words.map((w) => w.text)).toEqual(["alpha", "beta"]);
    // output times are shifted by the cut...
    expect(words[0]!.start).toBeCloseTo(0.5, 3);
    // ...the source anchor is not.
    expect(words[0]!.srcStart).toBeCloseTo(2.5, 3);
    expect(words[1]!.srcStart).toBeCloseTo(3.5, 3);
  });
});

describe("backfillSrcStart (§137 — render-props.json predates the field)", () => {
  // A legacy file's words carry only {text,start,end}; the cast the editor
  // loads render props through would let them past the type unchallenged.
  const legacyLine = (words: { text: string; start: number; end: number }[]): CaptionLine =>
    ({ start: words[0]!.start, end: words[words.length - 1]!.end, words }) as unknown as CaptionLine;

  it("recovers the source start the file's own spans imply", () => {
    // The same 2.0s-in kept span, in the form render-props.json stores it.
    const spans: KeptSpan[] = [{ srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 }];
    const lines = [legacyLine([{ text: "alpha", start: 0.5, end: 0.9 }])];

    const out = backfillSrcStart(lines, spans);

    expect(out[0]!.words[0]!.srcStart).toBeCloseTo(2.5, 6);
    expect(out[0]!.words[0]!.start).toBeCloseTo(0.5, 6); // output timing untouched
  });

  it("leaves an already-migrated line alone rather than recomputing it", () => {
    // `srcStart` may have come from a map these spans no longer describe, so a
    // present value wins over anything projection would say (here: 9, not 2.5).
    const spans: KeptSpan[] = [{ srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 }];
    const lines: CaptionLine[] = [
      { start: 0.5, end: 0.9, words: [{ text: "alpha", start: 0.5, end: 0.9, srcStart: 9 }] },
    ];

    const out = backfillSrcStart(lines, spans);

    expect(out[0]!.words[0]!.srcStart).toBe(9);
    expect(out[0]!.words[0]).toBe(lines[0]!.words[0]); // same object, not a copy
  });

  it("survives an empty spans array instead of throwing on a truncated file", () => {
    const out = backfillSrcStart([legacyLine([{ text: "alpha", start: 0.5, end: 0.9 }])], []);
    expect(out[0]!.words[0]!.srcStart).toBe(0); // no spans: nothing to project onto
  });
});

describe("lineDirection — first-strong-character heuristic (UAX #9 P2/P3)", () => {
  it("resolves a pure Urdu line RTL", () => {
    expect(lineDirection("یہ ایک ٹاپک ہے")).toBe("rtl");
  });

  it("resolves a pure English line LTR", () => {
    expect(lineDirection("this is a topic")).toBe("ltr");
  });

  // The Urdu field transcript (2026-08-05) code-switches: a line opening with
  // a Latin loanword resolves by its FIRST STRONG character — LTR — which is
  // the standard bidi answer, not the language code's.
  it("resolves a leading-Latin code-switched Urdu line LTR", () => {
    expect(lineDirection("Fulfillment کیا ہے")).toBe("ltr");
  });

  it("skips digits and punctuation, which are bidi-weak/neutral", () => {
    expect(lineDirection("2026 میں یہ")).toBe("rtl");
    expect(lineDirection('"یہ"')).toBe("rtl");
    expect(lineDirection("2026: a year")).toBe("ltr");
  });

  it("defaults LTR when no strong character exists", () => {
    expect(lineDirection("123 456!")).toBe("ltr");
  });

  it("resolves Hebrew RTL too, not just Arabic script", () => {
    expect(lineDirection("שלום עולם")).toBe("rtl");
  });
});
