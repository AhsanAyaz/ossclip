import { describe, expect, it } from "vitest";
import {
  BeatSheetSchema,
  SEC_PER_GRAPHIC,
  buildBeatsUserPrompt,
  countEnumeratedBeats,
  formatGraphicsAccounting,
  generateBeatSheet,
  graphicsTarget,
  normalizeBeatSheet,
} from "../src/producer/beats";
import type { LlmProvider } from "../src/producer/provider";
import type { Transcript } from "../src/schema";

/**
 * §118: nothing ever told the producer HOW MANY graphics to plan. The
 * coverage budget reads like a target and is only a ceiling — it removes
 * when the model plans too many and is silent when it plans too few.
 */

/** A transcript from words, at 0.5s per word. */
const speak = (text: string): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 })),
});

const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("countEnumeratedBeats — a take that counts itself out loud", () => {
  it("counts spelled ordinals after a counting noun", () => {
    expect(
      countEnumeratedBeats(
        speak("number one slash voice number two double escape number three plan mode"),
      ),
    ).toBe(3);
  });

  it("counts bare ordinal adjectives", () => {
    expect(countEnumeratedBeats(speak("first we cut then second we caption and third we render"))).toBe(3);
  });

  it("counts digits after a counting noun", () => {
    expect(countEnumeratedBeats(speak("step 1 install step 2 configure step 3 ship"))).toBe(3);
  });

  it("de-duplicates a repeated ordinal rather than inflating the target", () => {
    expect(countEnumeratedBeats(speak("number two again number two and number three"))).toBe(2);
  });

  it("ignores a lone ordinal — 'first of all' is not a list", () => {
    expect(countEnumeratedBeats(speak("first of all this is not a list at all"))).toBe(0);
  });

  it("ignores stray numbers with no counting noun in front", () => {
    // The bug this guards: every "one" in a take becoming a beat.
    expect(countEnumeratedBeats(speak("one of the things you want is three or four ideas"))).toBe(0);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(countEnumeratedBeats(speak("Number one, voice. Number two: escape."))).toBe(2);
  });
});

describe("graphicsTarget", () => {
  it("structure wins when the take enumerates: N points + hook + payoff", () => {
    // The real case: a 64s take enumerating five features got three graphics.
    expect(graphicsTarget(64, 5)).toBe(7);
  });

  it("falls back to runtime density when nothing is enumerated", () => {
    expect(graphicsTarget(64, 0)).toBe(Math.round(64 / SEC_PER_GRAPHIC));
    expect(graphicsTarget(90, 0)).toBe(10);
  });

  it("never drops below the §29 short-take floor", () => {
    expect(graphicsTarget(20, 0)).toBe(4);
    expect(graphicsTarget(5, 0)).toBe(4);
  });

  it("takes whichever of structure and runtime is larger", () => {
    // A long take that enumerates only two points still gets runtime density.
    expect(graphicsTarget(120, 2)).toBe(12);
  });

  it("stays inside what the moment schema can carry once alternation counts", () => {
    expect(graphicsTarget(600, 10)).toBe(12);
    expect(graphicsTarget(600, 0)).toBe(12);
  });
});

describe("the count reaches the prompt (§118 — the actual fix)", () => {
  const t = speak(`number one alpha ${filler(20)} number two beta ${filler(20)} number three gamma`);

  it("states an explicit target, and says the take enumerated itself", () => {
    // 60s of runtime outranks the 3 enumerated points (3+2=5) — a minute-long
    // take that lists three things still has everything else in it.
    const p = buildBeatsUserPrompt(t, 60, undefined);
    expect(p).toContain("Graphic moments to plan: 7");
    expect(p).toContain("enumerates 3 points");
  });

  it("structure raises the target on a take too short for runtime density", () => {
    // 30s → runtime density 3, but five enumerated points want 7.
    const five = speak(
      "number one a number two b number three c number four d number five e " + filler(50),
    );
    expect(buildBeatsUserPrompt(five, 30, undefined)).toContain("Graphic moments to plan: 7");
  });

  it("explains the density rule when there is no enumeration", () => {
    const p = buildBeatsUserPrompt(speak(filler(120)), 54, undefined);
    expect(p).toContain("Graphic moments to plan: 6");
    expect(p).toContain(`one per ${SEC_PER_GRAPHIC}s`);
  });

  it("a clip run targets the CLIP length, not the full take", () => {
    const p = buildBeatsUserPrompt(speak(filler(600)), 300, undefined, undefined, {
      targetSec: 60,
    });
    // 60s clip → runtime density, not the 300s take's.
    expect(p).toContain("Graphic moments to plan: 7");
  });
});

describe("§118b: under-delivery is reported, never silent", () => {
  it("says how many graphics were planned versus asked for", () => {
    // 60 words ≈ 30s. One graphic where the target is 4 (short-take floor).
    const t = speak(filler(60));
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 3, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
        { startWord: 4, endWord: 59, purpose: "b", onScreenCopy: "B", sceneKind: "none" },
      ],
    });
    const { issues } = normalizeBeatSheet(sheet, t);
    const shortfall = issues.find((i) => i.issue.startsWith("graphics:"));
    expect(shortfall?.issue).toContain("1 of 4 planned");
  });

  it("names enumeration as the reason when the take counted itself", () => {
    const t = speak(
      `number one alpha ${filler(30)} number two beta ${filler(30)} number three gamma ${filler(30)}`,
    );
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 5, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
        { startWord: 6, endWord: 99, purpose: "b", onScreenCopy: "B", sceneKind: "none" },
      ],
    });
    const { issues } = normalizeBeatSheet(sheet, t);
    const shortfall = issues.find((i) => i.issue.startsWith("graphics:"));
    expect(shortfall?.issue).toContain("enumerates 3 points");
  });

  it("stays quiet when the target is met", () => {
    const t = speak(filler(60));
    const kinds = ["StatCard", "RuleCard", "FlowDiagram", "ChatMock"] as const;
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      moments: kinds.map((k, i) => ({
        startWord: i * 4,
        endWord: i * 4 + 3,
        purpose: `m${i}`,
        onScreenCopy: `M${i}`,
        sceneKind: k,
      })),
    });
    const { issues } = normalizeBeatSheet(sheet, t);
    expect(issues.some((i) => i.issue.startsWith("graphics:"))).toBe(false);
  });
});

describe("§118b: the accounting measures against the ask, not the runtime", () => {
  /** A provider that returns a canned sheet — the ask is what's under test. */
  const canned = (sheet: unknown): LlmProvider =>
    ({ name: "canned", usage: [], complete: async () => sheet }) as unknown as LlmProvider;

  const oneGraphic = {
    hook: "h",
    moments: [
      { startWord: 0, endWord: 3, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
      { startWord: 4, endWord: 59, purpose: "b", onScreenCopy: "B", sceneKind: "none" },
    ],
  };

  it("formats one line for the console issue and report.txt alike", () => {
    expect(formatGraphicsAccounting(6, 7, speak(filler(60)))).toBe(
      `graphics: 6 of 7 planned (target is ~1 per ${SEC_PER_GRAPHIC}s)`,
    );
    expect(
      formatGraphicsAccounting(3, 5, speak("number one a number two b number three c")),
    ).toBe("graphics: 3 of 5 planned — the take enumerates 3 points");
  });

  it("an explicit ask overrides the transcript-span fallback", () => {
    // 60 words ≈ 30s of transcript would derive an ask of 4; the prompt said 9.
    const { issues } = normalizeBeatSheet(BeatSheetSchema.parse(oneGraphic), speak(filler(60)), 9);
    expect(issues.find((i) => i.issue.startsWith("graphics:"))?.issue).toContain("1 of 9 planned");
  });

  it("null skips the check — the pre-slice pass of a clip run", () => {
    const { issues } = normalizeBeatSheet(
      BeatSheetSchema.parse(oneGraphic),
      speak(filler(60)),
      null,
    );
    expect(issues.some((i) => i.issue.startsWith("graphics:"))).toBe(false);
  });

  it("measures a plain run against the duration the prompt stated", async () => {
    // The transcript spans ~5 minutes of SOURCE time, but the prompt said 54s
    // of output — the ask is 6, not the span-derived 12.
    const { asked, issues } = await generateBeatSheet(
      canned(oneGraphic),
      speak(filler(600)),
      54,
      undefined,
    );
    expect(asked).toBe(6);
    expect(issues.find((i) => i.issue.startsWith("graphics:"))?.issue).toContain("1 of 6 planned");
  });

  it("measures a clip run against the clip target, and only once", async () => {
    // Pre-fix this reported against the FULL take's runtime (capped at 12) —
    // a number the prompt never stated — and would have reported again after
    // the slice. The pre-slice pass now stays quiet; `asked` is the clip's.
    const sheet = {
      ...oneGraphic,
      highlight: { startWord: 0, endWord: 59, reason: "r" },
    };
    const { asked, issues } = await generateBeatSheet(
      canned(sheet),
      speak(filler(600)),
      300,
      undefined,
      undefined,
      undefined,
      { targetSec: 60 },
    );
    expect(asked).toBe(7);
    expect(issues.some((i) => i.issue.startsWith("graphics:"))).toBe(false);
  });
});

describe("the moment cap no longer caps graphics (§118)", () => {
  it("accepts enough moments to alternate at the target density", () => {
    // 7 graphics alternating with plain takes needs ~14 moments; the old
    // cap of 12 made that impossible however long the take was.
    const moments = Array.from({ length: 14 }, (_, i) => ({
      startWord: i * 4,
      endWord: i * 4 + 3,
      purpose: `m${i}`,
      onScreenCopy: `M${i}`,
      sceneKind: i % 2 === 0 ? ("StatCard" as const) : ("none" as const),
    }));
    expect(() => BeatSheetSchema.parse({ hook: "h", moments })).not.toThrow();
  });
});
