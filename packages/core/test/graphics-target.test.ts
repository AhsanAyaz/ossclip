import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  BeatSheetSchema,
  PRODUCER_PROMPT_VERSION,
  PRODUCER_SYSTEM,
  SEC_PER_GRAPHIC,
  buildBeatsUserPrompt,
  countEnumeratedBeats,
  formatGraphicsAccounting,
  generateBeatSheet,
  graphicsTarget,
  normalizeBeatSheet,
  producerSystem,
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

/**
 * The system prompt opened with "short-form vertical video (Reels/Shorts/
 * TikTok)" on EVERY run, while the user prompt has said "Output frame:
 * LANDSCAPE 16:9" since R21 §101 — a 16:9 produce shipped both sentences in
 * one call and left the model to reconcile them.
 */
describe("producerSystem — the system prompt describes the frame it will fill", () => {
  /** The opening sentence, byte-pinned: the tuned default must not drift. */
  const PORTRAIT_OPENING =
    "You are the producer for a short-form vertical video (Reels/Shorts/TikTok). " +
    "You receive a word-indexed transcript of a talking-head take that has already " +
    "been cut. Your job is EDITORIAL: segment the take into moments, pick which " +
    "moments deserve a graphic scene, and write the on-screen copy.";

  it("is byte-identical to the shipped prompt when no aspect is given", () => {
    // Every 9:16 run must send exactly the text the virality grammar was
    // tuned against — a silent reword here is a silent re-tune.
    expect(producerSystem().split("\n")[0]).toBe(PORTRAIT_OPENING);
    expect(producerSystem("9:16")).toBe(producerSystem());
    // The back-compat export is the same string, never a second copy.
    expect(PRODUCER_SYSTEM).toBe(producerSystem());
  });

  it("stops calling a landscape output vertical", () => {
    const landscape = producerSystem("16:9");
    expect(landscape).not.toMatch(/vertical/i);
    for (const platform of ["Reels", "Shorts", "TikTok"]) {
      expect(landscape).not.toContain(platform);
    }
    expect(landscape.split("\n")[0]).toContain("landscape video (YouTube)");
  });

  it("changes ONLY the shape sentence — every policy line survives in both", () => {
    // The hook rule, the alternation rule, the coverage budget, FRAMING and
    // COVER are the same editorial policy whatever shape the frame is.
    const rest = (s: string) => s.split("\n").slice(1).join("\n");
    expect(rest(producerSystem("16:9"))).toBe(rest(producerSystem()));
    for (const prompt of [producerSystem(), producerSystem("16:9")]) {
      expect(prompt).toContain("The first moment is the hook");
      expect(prompt).toContain("Pattern interrupts");
      expect(prompt).toContain("- COUNT:");
      expect(prompt).toContain("- COVERAGE:");
      expect(prompt).toContain("- VARIETY:");
      expect(prompt).toContain("- FRAMING:");
      expect(prompt).toContain("- COVER:");
    }
  });

  it("reaches the provider: the system and user halves agree about the frame", async () => {
    // The bug was at the CALL SITE — buildBeatsUserPrompt already took the
    // aspect, generateBeatSheet just never passed it to the system half.
    const sent: { system?: string; user?: string } = {};
    const spy = {
      name: "spy",
      usage: [],
      complete: async (req: { system: string; user: string }) => {
        sent.system = req.system;
        sent.user = req.user;
        return {
          hook: "h",
          moments: [
            { startWord: 0, endWord: 3, purpose: "a", onScreenCopy: "A", sceneKind: "none" },
          ],
        };
      },
    } as unknown as LlmProvider;
    await generateBeatSheet(
      spy,
      speak(filler(60)),
      30,
      undefined,
      undefined,
      undefined,
      undefined,
      "16:9",
    );
    expect(sent.user).toContain("Output frame: LANDSCAPE 16:9");
    expect(sent.system).toBe(producerSystem("16:9"));
  });

  it("PRODUCER_PROMPT_VERSION is pinned — the cache key carries it", () => {
    // Prompt changes change the answer (the §78 posture). If a prompt edit
    // ships without bumping this, every warm workdir keeps serving the sheet
    // the old prompt wrote — this pin makes the bump a conscious act.
    expect(PRODUCER_PROMPT_VERSION).toBe("v2");
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

/**
 * R27 §123. `.max(n)` on model free text is a die-here boundary: two of three
 * real runs came back with a 61-character `onScreenCopy` and the whole produce
 * exited 1, throwing away transcription, analysis and the cut over one
 * character of a headline. §112 says validate where the pipeline can still
 * degrade.
 */
describe("over-long model copy is capped, not fatal (§123)", () => {
  it("truncates at a word boundary instead of throwing", () => {
    const long = "Agent loops are the single most misunderstood idea in AI engineering today";
    const parsed = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 3, purpose: "p", onScreenCopy: long, sceneKind: "StatCard" },
      ],
    });
    const copy = parsed.moments[0]!.onScreenCopy;
    expect(copy.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(copy)).toBe(true);
    expect(copy.endsWith(" ")).toBe(false);
    // A word boundary, not a mid-word chop.
    expect(copy).toBe("Agent loops are the single most misunderstood idea in AI");
  });

  it("the exact case that killed two real runs: 61 characters", () => {
    const sixtyOne = "x".repeat(61);
    expect(() => BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 1, purpose: "p", onScreenCopy: sixtyOne, sceneKind: "none" },
      ],
    })).not.toThrow();
  });

  it("hard-chops a single unbreakable word rather than collapsing it", () => {
    const wall = "y".repeat(90);
    const parsed = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 1, purpose: "p", onScreenCopy: wall, sceneKind: "none" },
      ],
    });
    expect(parsed.moments[0]!.onScreenCopy).toHaveLength(60);
  });

  it("leaves copy within the cap untouched", () => {
    const fine = "Three parts, one loop";
    const parsed = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 1, purpose: "p", onScreenCopy: fine, sceneKind: "none" },
      ],
    });
    expect(parsed.moments[0]!.onScreenCopy).toBe(fine);
  });

  it("still ASKS the model for the limit — maxLength survives in the JSON schema", () => {
    // The point is to stop dying, not to stop constraining: if maxLength
    // vanished from the schema the provider would no longer be told the cap.
    const json = JSON.stringify(z.toJSONSchema(BeatSheetSchema));
    expect(json).toContain('"maxLength":60');
  });
});
