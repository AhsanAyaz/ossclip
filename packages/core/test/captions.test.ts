import { describe, expect, it } from "vitest";
import { buildCaptionLines, lineDirection } from "../src/captions";
import { TimeMap } from "../src/timemap";
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
