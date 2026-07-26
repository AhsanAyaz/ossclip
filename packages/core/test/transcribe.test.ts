import { describe, expect, it } from "vitest";
import { parseWhisperJson, type WhisperJson } from "../src/transcribe.js";

/** Trimmed sample of real whisper.cpp `-oj -ml 1` output structure. */
const sample: WhisperJson = {
  result: { language: "en" },
  transcription: [
    { offsets: { from: 0, to: 320 }, text: " Hello" },
    { offsets: { from: 320, to: 700 }, text: " everyone" },
    { offsets: { from: 700, to: 760 }, text: "," },
    { offsets: { from: 900, to: 1200 }, text: " it" },
    { offsets: { from: 1200, to: 1450 }, text: "'s" },
    { offsets: { from: 1500, to: 1800 }, text: " work" },
    { offsets: { from: 1800, to: 2050 }, text: "ing" },
    { offsets: { from: 2100, to: 2400 }, text: " [BLANK_AUDIO]" },
    { offsets: { from: 2500, to: 2600 }, text: "   " },
    { offsets: { from: 2700, to: 3000 }, text: " done" },
  ],
};

describe("parseWhisperJson", () => {
  it("merges sub-word continuations into whole words", () => {
    const t = parseWhisperJson(sample);
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "everyone,", "it's", "working", "done"]);
  });

  it("converts millisecond offsets to seconds and keeps monotonic stamps", () => {
    const t = parseWhisperJson(sample);
    expect(t.words[0]).toMatchObject({ start: 0, end: 0.32 });
    // "it's" spans its continuation token
    const its = t.words.find((w) => w.text === "it's")!;
    expect(its.start).toBeCloseTo(0.9);
    expect(its.end).toBeCloseTo(1.45);
    for (let i = 0; i < t.words.length - 1; i++) {
      expect(t.words[i + 1]!.start).toBeGreaterThanOrEqual(t.words[i]!.end);
    }
  });

  it("drops noise markers and whitespace-only tokens", () => {
    const t = parseWhisperJson(sample);
    expect(t.words.some((w) => w.text.includes("BLANK"))).toBe(false);
  });

  it("repairs zero-length and inverted timestamps", () => {
    const t = parseWhisperJson({
      transcription: [
        { offsets: { from: 100, to: 100 }, text: " a" },
        { offsets: { from: 90, to: 400 }, text: " b" },
      ],
    });
    expect(t.words[0]!.end).toBeGreaterThan(t.words[0]!.start);
    expect(t.words[1]!.start).toBeGreaterThanOrEqual(t.words[0]!.end);
  });
});
