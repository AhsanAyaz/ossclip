import { describe, expect, it } from "vitest";
import { takeWindows, sliceWavArgs, stitchTakeTranscripts } from "../src/transcribe/take-transcripts";

describe("takeWindows", () => {
  it("tiles the concat timeline with each clip's duration", () => {
    const w = takeWindows([5.3, 5.6, 10.2]);
    const expected = [
      [0, 5.3],
      [5.3, 10.9],
      [10.9, 21.1],
    ];
    expect(w).toHaveLength(3);
    w.forEach((win, i) => {
      expect(win.startSec).toBeCloseTo(expected[i]![0]!, 9);
      expect(win.endSec).toBeCloseTo(expected[i]![1]!, 9);
    });
    // Contiguous: each window starts exactly where the previous one ended.
    expect(w[1]!.startSec).toBe(w[0]!.endSec);
    expect(w[2]!.startSec).toBe(w[1]!.endSec);
  });

  it("returns no windows for no clips", () => {
    expect(takeWindows([])).toEqual([]);
  });
});

describe("stitchTakeTranscripts", () => {
  it("shifts each clip's words by its window start", () => {
    const out = stitchTakeTranscripts([
      {
        window: { startSec: 0, endSec: 5 },
        transcript: { language: "en", words: [{ text: "hello", start: 1, end: 1.5 }] },
      },
      {
        window: { startSec: 5, endSec: 9 },
        transcript: { language: "en", words: [{ text: "again", start: 0.5, end: 1 }] },
      },
    ]);
    expect(out).toEqual({
      language: "en",
      words: [
        { text: "hello", start: 1, end: 1.5 },
        { text: "again", start: 5.5, end: 6 },
      ],
    });
  });

  // The field case (2026-11-13, "AI And Coding"): a take whose audio stops
  // mid-word, where whole-file whisper stamped the cut-off sentence 2.5s
  // into the NEXT take. A per-clip decode can still overhang its own window
  // (whisper pads the final word out) — that overhang is clamped, never
  // allowed to overlap the next take.
  it("clamps a word that overhangs its clip's end", () => {
    const out = stitchTakeTranscripts([
      {
        window: { startSec: 0, endSec: 5 },
        transcript: { language: "en", words: [{ text: "Angular.", start: 4.8, end: 5.4 }] },
      },
    ]);
    expect(out.words).toEqual([{ text: "Angular.", start: 4.8, end: 5 }]);
  });

  it("drops a word stamped wholly past its clip's end", () => {
    const out = stitchTakeTranscripts([
      {
        window: { startSec: 0, endSec: 5 },
        transcript: {
          language: "en",
          words: [
            { text: "used", start: 4.5, end: 4.9 },
            { text: "to.", start: 5, end: 5.3 },
          ],
        },
      },
    ]);
    expect(out.words.map((w) => w.text)).toEqual(["used"]);
  });

  it("keeps confidence and takes the first clip's language", () => {
    const out = stitchTakeTranscripts([
      {
        window: { startSec: 0, endSec: 2 },
        transcript: { language: "ur", words: [{ text: "a", start: 0, end: 1, conf: 0.4 }] },
      },
      { window: { startSec: 2, endSec: 4 }, transcript: { language: "en", words: [] } },
    ]);
    expect(out).toEqual({ language: "ur", words: [{ text: "a", start: 0, end: 1, conf: 0.4 }] });
  });

  it("is empty-safe", () => {
    expect(stitchTakeTranscripts([])).toEqual({ language: "en", words: [] });
  });
});

describe("sliceWavArgs", () => {
  it("seeks after -i so the cut is sample-accurate", () => {
    expect(sliceWavArgs("/w/audio.wav", "/w/clip-1.wav", { startSec: 5.3, endSec: 10.9 })).toEqual([
      "-y",
      "-i", "/w/audio.wav",
      "-ss", "5.3",
      "-t", "5.6",
      "-c:a", "pcm_s16le",
      "/w/clip-1.wav",
    ]);
  });
});
