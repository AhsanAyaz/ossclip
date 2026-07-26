import { describe, expect, it } from "vitest";
import { buildCaptionLines } from "../src/captions.js";
import { TimeMap } from "../src/timemap.js";
import type { Segment, Transcript } from "../src/schema.js";

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
