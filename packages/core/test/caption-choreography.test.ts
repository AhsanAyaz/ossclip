import { describe, expect, it } from "vitest";
import { captionKeyFor } from "../src/captions";
import {
  buildCaptionChoreographyPrompt,
  CAPTION_CHOREOGRAPHY_PROMPT_VERSION,
  generateCaptionChoreography,
  validateCaptionChoreography,
  type ChoreographyInputWord,
} from "../src/producer/caption-choreography";
import { MockProvider } from "../src/producer/mock";

describe("caption-choreography", () => {
  const sampleWords: ChoreographyInputWord[] = [
    { text: "We", start: 0.0, end: 0.25, srcStart: 10.0 },
    { text: "shipped", start: 0.25, end: 0.55, srcStart: 10.25 },
    { text: "HeyClicky", start: 0.55, end: 0.95, srcStart: 10.55 },
    { text: "in", start: 0.95, end: 1.15, srcStart: 10.95 },
    { text: "48", start: 1.15, end: 1.45, srcStart: 11.15 },
    { text: "hours", start: 1.45, end: 1.85, srcStart: 11.45 },
    { text: "and", start: 2.1, end: 2.3, srcStart: 12.1 },
    { text: "it", start: 2.3, end: 2.5, srcStart: 12.3 },
    { text: "worked", start: 2.5, end: 2.9, srcStart: 12.5 },
  ];

  it("buildCaptionChoreographyPrompt formats indexed words with [index|time] for MockProvider compatibility", () => {
    expect(CAPTION_CHOREOGRAPHY_PROMPT_VERSION).toBe(1);
    const prompt = buildCaptionChoreographyPrompt(sampleWords, "9:16");
    expect(prompt).toContain("[0|0.00s] We");
    expect(prompt).toContain("[2|0.55s] HeyClicky");
    expect(prompt).toContain("9:16");
  });

  it("validateCaptionChoreography repairs uncovered word gaps and splits over-length phrases", () => {
    const raw = {
      // Leaves word 0 uncovered and groups words 1..8 (8 words > portrait ceiling of 5)
      phrases: [{ startWord: 1, endWord: 8, role: "body" as const }],
      emphasis: [],
    };
    const result = validateCaptionChoreography(raw, sampleWords, { aspect: "9:16" });

    // Every word 0..8 must be covered in monotonically increasing source time ranges
    expect(result.phrases.length).toBeGreaterThanOrEqual(3);
    expect(result.phrases[0]!.startSrcSec).toBe(10.0);
    expect(result.phrases[result.phrases.length - 1]!.endSrcSec).toBe(12.5);
    for (let i = 1; i < result.phrases.length; i++) {
      expect(result.phrases[i]!.startSrcSec).toBeGreaterThan(result.phrases[i - 1]!.endSrcSec);
    }
  });

  it("validateCaptionChoreography clamps emphasisScale to [1.0, 1.4] and caps emphasis budget deterministically", () => {
    const raw = {
      phrases: [
        { startWord: 0, endWord: 3, role: "hook" as const },
        { startWord: 4, endWord: 8, role: "body" as const },
      ],
      emphasis: [
        { word: 0, scale: 1.8 }, // clamped to 1.4
        { word: 1, scale: 1.3 },
        { word: 2, scale: 1.3 }, // 3rd in phrase 0 -> dropped by per-phrase cap of 2
        { word: 4, scale: 1.25 },
      ],
    };
    const result = validateCaptionChoreography(raw, sampleWords, { aspect: "9:16" });
    // Total words = 9 -> 25% budget = floor(9 * 0.25) = 2 words max across transcript!
    // Sorted by scale desc, then word index asc: word 0 (1.4) and word 1 (1.3) win.
    expect(Object.keys(result.words)).toEqual([
      captionKeyFor(10.0),
      captionKeyFor(10.25),
    ]);
    expect(result.words[captionKeyFor(10.0)]?.emphasisScale).toBe(1.4);
    expect(result.words[captionKeyFor(10.25)]?.emphasisScale).toBe(1.3);
  });

  it("enforces spatial stability on output timestamps even when source timestamps are offset (--clip)", () => {
    const clipWords: ChoreographyInputWord[] = [
      { text: "Hook", start: 0.2, end: 0.6, srcStart: 240.2 },
      { text: "line", start: 0.6, end: 1.0, srcStart: 240.6 },
      { text: "Late", start: 5.5, end: 5.9, srcStart: 245.5 },
      { text: "hook", start: 5.9, end: 6.3, srcStart: 245.9 },
      { text: "Big", start: 7.0, end: 7.4, srcStart: 247.0 },
      { text: "win", start: 7.4, end: 7.8, srcStart: 247.4 },
      { text: "Too", start: 12.0, end: 12.4, srcStart: 252.0 },
      { text: "soon", start: 12.4, end: 12.8, srcStart: 252.4 },
      { text: "Spaced", start: 24.0, end: 24.4, srcStart: 264.0 },
      { text: "out", start: 24.4, end: 24.8, srcStart: 264.4 },
    ];
    const raw = {
      phrases: [
        { startWord: 0, endWord: 1, role: "hook" as const }, // output 0.2s < 4.0s -> keeps "hook"
        { startWord: 2, endWord: 3, role: "hook" as const }, // output 5.5s >= 4.0s -> downgraded
        { startWord: 4, endWord: 5, role: "impact" as const }, // 2 words + emphasized -> keeps "impact"
        { startWord: 6, endWord: 7, role: "impact" as const }, // only 4.2s after previous impact (< 15s) -> downgraded
        { startWord: 8, endWord: 9, role: "impact" as const }, // > 15s after first impact -> keeps "impact"
      ],
      emphasis: [
        { word: 4, scale: 1.3 },
        { word: 6, scale: 1.25 },
        { word: 8, scale: 1.35 },
      ],
    };

    const result = validateCaptionChoreography(raw, clipWords, { aspect: "9:16" });
    expect(result.phrases.map((p) => p.role)).toEqual([
      "hook",
      undefined,
      "impact",
      undefined,
      "impact",
    ]);
  });

  it("generateCaptionChoreography works end-to-end with MockProvider", async () => {
    const provider = new MockProvider();
    const res = await generateCaptionChoreography(provider, {
      words: sampleWords,
      aspect: "9:16",
    });
    expect(res.phrases.length).toBeGreaterThan(0);
    expect(res.phrases[0]!.role).toBe("hook");
    expect(Object.keys(res.words).length).toBeGreaterThan(0);
  });
});
