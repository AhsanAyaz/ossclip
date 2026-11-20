import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import {
  STORYBOARD_PLAN_PROMPT_VERSION,
  StoryboardPlanReplySchema,
  planStoryboard,
  storyboardPlanPrompt,
  type StoryboardPlanInput,
} from "../src/storyboard/plan";

/**
 * The planner call (storyboard design §2, plan Task 2; §168): what the
 * planner is told, and that it is one call. The limits it is told about
 * are enforced afterwards by `enforcePlanLimits` (storyboard-limits.test.ts).
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `w${i}` }));

function input(over: Partial<StoryboardPlanInput> = {}): StoryboardPlanInput {
  return {
    words: [{ text: "so" }, { text: "um" }, { text: "goldfish" }, { text: "forget" }, { text: "fast" }],
    cut: new Set([1]),
    outputDurationSec: 68,
    width: 1080,
    height: 1920,
    intent: "explain why memory tricks work",
    assets: [{ name: "logo.png", width: 512, height: 256, note: "the plugin's logo" }],
    taken: [],
    ...over,
  };
}

interface Call { system: string; user: string; schemaName: string; tier?: string }

function scripted(reply: unknown | Error): { provider: LlmProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider: LlmProvider = {
    name: "scripted",
    usage: [],
    async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string; tier?: "editorial" | "mechanical" }): Promise<T> {
      calls.push({ system: req.system, user: req.user, schemaName: req.schemaName, tier: req.tier });
      if (reply instanceof Error) throw reply;
      return req.schema.parse(reply);
    },
  };
  return { provider, calls };
}

/**
 * Words of two or more capitals. SVG is the one allowed: it is the name of
 * what the artist draws, not emphasis.
 */
const allCaps = (text: string) => (text.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => w !== "SVG");

describe("storyboardPlanPrompt: the user prompt", () => {
  const { user } = storyboardPlanPrompt(input());

  it("lists kept words as [i]word and cut words as [i]⟦word⟧", () => {
    expect(user).toContain("[0]so [1]⟦um⟧ [2]goldfish [3]forget [4]fast");
  });

  it("states the intent, the frame with its orientation and the runtime", () => {
    expect(user).toContain("explain why memory tricks work");
    expect(user).toContain("1080 x 1920 pixels, portrait");
    expect(storyboardPlanPrompt(input({ width: 1920, height: 1080 })).user).toContain("1920 x 1080 pixels, landscape");
    expect(user).toContain("68.0 seconds");
  });

  it("says what it does with no intent", () => {
    expect(storyboardPlanPrompt(input({ intent: undefined })).user).toMatch(/Intent: none given/);
  });

  it("states the coverage limit as at most 60%, in seconds too, and the 2 to 15 second bounds", () => {
    expect(user).toContain("at most 60%");
    expect(user).toContain("40.8 seconds");
    expect(user).toContain("2 to 15 seconds");
  });

  it("names each asset with its size and note", () => {
    expect(user).toContain("- logo.png: 512 x 256 px, the plugin's logo");
  });

  it("with no assets, tells the planner to expect everything to be drawn", () => {
    const u = storyboardPlanPrompt(input({ assets: [] })).user;
    expect(u).toMatch(/no assets/i);
    expect(u).toMatch(/expect everything to be drawn/);
    expect(u).not.toContain("logo.png");
  });

  it("lists each taken span with do not plan here, and says nothing of taken spans when there are none", () => {
    const u = storyboardPlanPrompt(input({ taken: [{ startWord: 2, endWord: 3, idea: "a goldfish forgets its keys" }, { startWord: 4, endWord: 4, idea: "a stopwatch" }] })).user;
    expect(u).toContain('- words 2 to 3, "a goldfish forgets its keys": do not plan here');
    expect(u).toContain('- words 4 to 4, "a stopwatch": do not plan here');
    expect(user).not.toContain("do not plan here");
  });

  it("has no all-caps words of its own", () => {
    expect(allCaps(user)).toEqual([]);
  });
});

describe("storyboardPlanPrompt: the system prompt", () => {
  const { system } = storyboardPlanPrompt(input());

  it("says what a drawn shot can be", () => {
    for (const s of ["talking-head", "characters", "props", "diagrams", "animated SVG", "short labels"]) expect(system.toLowerCase()).toContain(s.toLowerCase());
  });

  it("says what a drawn shot cannot be", () => {
    for (const s of ["photos", "screenshots", "footage", "sound"]) expect(system).toContain(s);
  });

  it("asks for an idea of one or two sentences, what is on screen and how it moves, and a why", () => {
    expect(system).toMatch(/one or two sentences/i);
    expect(system).toContain("what is on screen and how it moves");
    expect(system).toMatch(/\bwhy\b/);
  });

  it("states the limits with their reasons, the word ranges and the priorities", () => {
    expect(system).toContain("2 to 15 seconds");
    expect(system).toContain("at most 60%");
    expect(system).toMatch(/overlap/);
    expect(system).toMatch(/inclusive/);
    expect(system).toMatch(/1 means the video is worse without/);
  });

  it("says the artist sees only the idea and its spoken line, and that the author pays for each drawing", () => {
    expect(system).toMatch(/sees only/);
    expect(system).toMatch(/pays for/);
  });

  it("has no all-caps words", () => {
    expect(allCaps(system)).toEqual([]);
  });

  it("is the same whatever the input: everything that varies is in the user prompt", () => {
    expect(storyboardPlanPrompt(input({ intent: "other", assets: [], width: 1920, height: 1080 })).system).toBe(system);
  });
});

describe("planStoryboard", () => {
  const reply = {
    shots: [
      { startWord: 2, endWord: 4, idea: "a goldfish swims in a circle", why: "the speaker names it", priority: 2, assets: ["logo.png"] },
    ],
  };

  it("makes exactly one editorial call named storyboard_plan and returns the shots", async () => {
    const { provider, calls } = scripted(reply);
    const shots = await planStoryboard(provider, input());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.schemaName).toBe("storyboard_plan");
    expect(calls[0]!.tier).toBe("editorial");
    expect(calls[0]!.user).toBe(storyboardPlanPrompt(input()).user);
    expect(shots).toEqual(reply.shots);
    const p: 1 | 2 | 3 = shots[0]!.priority;
    expect(p).toBe(2);
  });

  it("passes the reply's indices through as they are: limits are the caller's", async () => {
    const { provider } = scripted({ shots: [{ ...reply.shots[0]!, startWord: 9, endWord: -3 }] });
    const shots = await planStoryboard(provider, input());
    expect([shots[0]!.startWord, shots[0]!.endWord]).toEqual([9, -3]);
  });

  it("lets a provider error propagate", async () => {
    const { provider } = scripted(new Error("timeout waiting for response"));
    await expect(planStoryboard(provider, input())).rejects.toThrow("timeout waiting for response");
  });

  it("refuses a reply with a priority outside 1 to 3 or more than 40 shots", () => {
    expect(StoryboardPlanReplySchema.safeParse({ shots: [{ ...reply.shots[0]!, priority: 4 }] }).success).toBe(false);
    expect(StoryboardPlanReplySchema.safeParse({ shots: Array.from({ length: 41 }, () => reply.shots[0]!) }).success).toBe(false);
  });

  it("has its own prompt version", () => {
    expect(STORYBOARD_PLAN_PROMPT_VERSION).toBe("b1");
  });
});

describe("the mock provider: storyboard_plan", () => {
  it("plans one shot per 40 kept words, about 12 kept words each, on kept words, deterministically", async () => {
    const cut = new Set([0, 1, 50, 61]);
    const inp = input({ words: words(100), cut, assets: [] });
    const a = await planStoryboard(new MockProvider(), inp);
    const b = await planStoryboard(new MockProvider(), inp);
    expect(b).toEqual(a);
    // 96 kept words: shots start at kept positions 0, 40 and 80.
    expect(a.map((s) => [s.startWord, s.endWord])).toEqual([
      [2, 13],
      [42, 54],
      [84, 95],
    ]);
    for (const s of a) {
      expect(cut.has(s.startWord) || cut.has(s.endWord)).toBe(false);
    }
    expect(a.map((s) => s.idea)).toEqual(["mock shot 1", "mock shot 2", "mock shot 3"]);
    expect(a.map((s) => s.priority)).toEqual([1, 2, 3]);
  });

  it("plans nothing for a transcript with no kept words", async () => {
    expect(await planStoryboard(new MockProvider(), input({ words: words(3), cut: new Set([0, 1, 2]) }))).toEqual([]);
  });
});
