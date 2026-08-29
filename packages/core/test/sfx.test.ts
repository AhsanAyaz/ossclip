import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { Transcript } from "../src/schema";
import type { LlmProvider, CallTier } from "../src/producer/provider";
import type { BeatSheet } from "../src/producer/beats";
import type { LoadedSfxSound } from "../src/sfx-pack";
import {
  SFX_MIN_SPACING_SEC,
  SfxPlanSchema,
  buildSfxUserPrompt,
  eligibleSfxSounds,
  formatSfxAccounting,
  generateSfxPlan,
  normalizeSfxPlan,
  sfxBudget,
  type SfxLevel,
  type SfxPlan,
} from "../src/producer/sfx";

const mkTranscript = (n: number, spacing = 0.5): Transcript => ({
  language: "en",
  words: Array.from({ length: n }, (_, i) => ({
    text: `word${i}`,
    start: i * spacing,
    end: i * spacing + spacing * 0.8,
  })),
});

/** Pin the runtime exactly — the budget boundaries are the point of these tests. */
const withRuntime = (t: Transcript, runtimeSec: number): Transcript => ({
  ...t,
  words: t.words.map((w, i) =>
    i === t.words.length - 1 ? { ...w, end: t.words[0]!.start + runtimeSec } : w,
  ),
});

const mkSound = (id: string, tags: string[] = []): LoadedSfxSound => ({
  id,
  kind: "sound",
  file: `${id}.mp3`,
  whenToUse: `use ${id} here`,
  tags,
  gain: 1,
  absPath: `/packs/starter/${id}.mp3`,
  packName: "starter",
});

const sounds = [mkSound("ding"), mkSound("whoosh-soft"), mkSound("scratch", ["meme"])];

const sheet: BeatSheet = {
  hook: "THE HOOK",
  moments: [
    { startWord: 0, endWord: 9, purpose: "open", onScreenCopy: "OPEN", sceneKind: "TitleCard" },
    { startWord: 10, endWord: 19, purpose: "explain", onScreenCopy: "", sceneKind: "none" },
  ],
};

const plan = (...placements: Array<{ soundId: string; word: number }>): SfxPlan =>
  SfxPlanSchema.parse({ placements });

describe("sfxBudget", () => {
  it("is per-minute at the exact boundary", () => {
    const sixty = withRuntime(mkTranscript(100, 0.6), 60);
    expect(sfxBudget(sixty, "subtle").max).toBe(2);
    expect(sfxBudget(sixty, "normal").max).toBe(4);
    expect(sfxBudget(sixty, "meme").max).toBe(8);
    // Just under the minute buys one fewer at normal — the budget floors, and
    // the epsilon only absorbs float noise, not a tenth of a second.
    expect(sfxBudget(withRuntime(mkTranscript(100, 0.6), 59.9), "normal").max).toBe(3);
    expect(sfxBudget(withRuntime(mkTranscript(200, 0.6), 90), "normal").max).toBe(6);
  });

  it("floors a short take rather than rounding it to silence", () => {
    const short = withRuntime(mkTranscript(20, 0.4), 8);
    expect(sfxBudget(short, "subtle").max).toBe(1);
    expect(sfxBudget(short, "normal").max).toBe(2);
    expect(sfxBudget(short, "meme").max).toBe(3);
  });
});

describe("buildSfxUserPrompt", () => {
  const transcript = mkTranscript(20);

  it("lists the eligible menu, the graphics plan and the numbered transcript", () => {
    const prompt = buildSfxUserPrompt(transcript, sheet, sounds, "normal");
    expect(prompt).toContain("- ding: use ding here");
    expect(prompt).toContain("- whoosh-soft: use whoosh-soft here");
    expect(prompt).toContain('words [0..9] TitleCard: "OPEN"');
    expect(prompt).toContain("words [10..19] talking head");
    expect(prompt).toContain('hook: "THE HOOK"');
    expect(prompt).toContain("[0]word0 [1]word1");
    expect(prompt).toContain("Place AT MOST 2 sound effects.");
  });

  it("omits meme sounds from the menu below the meme level", () => {
    for (const level of ["subtle", "normal"] as const) {
      const prompt = buildSfxUserPrompt(transcript, sheet, sounds, level);
      expect(prompt).not.toContain("scratch");
      expect(eligibleSfxSounds(sounds, level).map((s) => s.id)).toEqual(["ding", "whoosh-soft"]);
    }
    expect(buildSfxUserPrompt(transcript, sheet, sounds, "meme")).toContain("- scratch: use scratch here");
    expect(eligibleSfxSounds(sounds, "meme")).toHaveLength(3);
  });
});

describe("normalizeSfxPlan", () => {
  const transcript = withRuntime(mkTranscript(120), 60); // 60s exactly → 4 at normal

  it("drops an unknown soundId", () => {
    const { plan: out, issues } = normalizeSfxPlan(
      plan({ soundId: "airhorn", word: 0 }, { soundId: "ding", word: 10 }),
      transcript,
      sounds,
      "normal",
    );
    expect(out.placements.map((p) => p.soundId)).toEqual(["ding"]);
    expect(issues).toEqual([
      { placement: 0, reason: "unknown sound", issue: 'unknown soundId "airhorn"' },
    ]);
  });

  it("gates meme sounds at every level below meme", () => {
    const p = plan({ soundId: "scratch", word: 0 });
    for (const level of ["subtle", "normal"] as SfxLevel[]) {
      const { plan: out, issues } = normalizeSfxPlan(p, transcript, sounds, level);
      expect(out.placements).toEqual([]);
      expect(issues[0]!.reason).toBe("meme level");
    }
    const { plan: allowed, issues } = normalizeSfxPlan(p, transcript, sounds, "meme");
    expect(allowed.placements).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it("drops an anchor outside the transcript instead of clamping it", () => {
    const { plan: out, issues } = normalizeSfxPlan(
      plan({ soundId: "ding", word: 500 }),
      transcript,
      sounds,
      "normal",
    );
    expect(out.placements).toEqual([]);
    expect(issues[0]).toEqual({
      placement: 0,
      reason: "outside transcript",
      issue: "word 500 beyond transcript (119)",
    });
  });

  it("drops a negative or fractional anchor from a hand-edited cache file", () => {
    // Not reachable through SfxPlanSchema — this is the cached-plan path, where
    // the object arrives as JSON someone may have edited.
    const raw = { placements: [{ soundId: "ding", word: -1 }, { soundId: "ding", word: 2.5 }] } as SfxPlan;
    const { plan: out, issues } = normalizeSfxPlan(raw, transcript, sounds, "normal");
    expect(out.placements).toEqual([]);
    expect(issues.map((i) => i.reason)).toEqual(["outside transcript", "outside transcript"]);
  });

  it("sorts by anchor and drops the LATER of a too-close pair, keeping an exact 1.5s gap", () => {
    // spacing 0.5s/word: word 3 is exactly SFX_MIN_SPACING_SEC after word 0.
    expect(SFX_MIN_SPACING_SEC).toBe(1.5);
    const { plan: out, issues } = normalizeSfxPlan(
      plan(
        { soundId: "ding", word: 3 },
        { soundId: "whoosh-soft", word: 0 },
        { soundId: "ding", word: 4 },
      ),
      transcript,
      sounds,
      "normal",
    );
    expect(out.placements.map((p) => p.word)).toEqual([0, 3]);
    expect(issues).toEqual([
      { placement: 2, reason: "too close", issue: expect.stringContaining("0.50s after") },
    ]);
  });

  it("keeps the earliest N of an over-budget plan (60s at normal → 4)", () => {
    const { plan: out, issues } = normalizeSfxPlan(
      plan(
        { soundId: "ding", word: 0 },
        { soundId: "ding", word: 20 },
        { soundId: "ding", word: 40 },
        { soundId: "ding", word: 60 },
        { soundId: "ding", word: 80 },
      ),
      transcript,
      sounds,
      "normal",
    );
    expect(out.placements.map((p) => p.word)).toEqual([0, 20, 40, 60]);
    expect(issues).toEqual([
      { placement: 4, reason: "over budget", issue: expect.stringContaining("over the 4 placement budget") },
    ]);
  });

  it("honours the floor on a very short take (8s at normal → 2)", () => {
    const short = withRuntime(mkTranscript(20, 0.4), 8);
    const { plan: out, issues } = normalizeSfxPlan(
      plan(
        { soundId: "ding", word: 0 },
        { soundId: "ding", word: 5 },
        { soundId: "ding", word: 10 },
      ),
      short,
      sounds,
      "normal",
    );
    expect(out.placements.map((p) => p.word)).toEqual([0, 5]);
    expect(issues.map((i) => i.reason)).toEqual(["over budget"]);
  });

  it("keeps a per-placement gain and rationale through the passes", () => {
    const raw = SfxPlanSchema.parse({
      placements: [{ soundId: "ding", word: 4, gain: 0.5, rationale: "the takeaway lands" }],
    });
    expect(normalizeSfxPlan(raw, transcript, sounds, "normal").plan.placements[0]).toEqual({
      soundId: "ding",
      word: 4,
      gain: 0.5,
      rationale: "the takeaway lands",
    });
  });

  it("never throws on an empty plan or an empty transcript", () => {
    expect(normalizeSfxPlan(plan(), transcript, sounds, "normal").plan.placements).toEqual([]);
    const empty: Transcript = { language: "en", words: [] };
    const { plan: out, issues } = normalizeSfxPlan(plan({ soundId: "ding", word: 0 }), empty, sounds, "meme");
    expect(out.placements).toEqual([]);
    expect(issues[0]!.reason).toBe("outside transcript");
  });
});

describe("formatSfxAccounting", () => {
  it("names the level and counts the drops by reason, in a fixed order", () => {
    expect(
      formatSfxAccounting(5, 7, "normal", [
        { placement: 6, reason: "over budget", issue: "x" },
        { placement: 2, reason: "cut word", issue: "y" },
      ]),
    ).toBe("sfx: 5 of 7 planned placed (level normal, 2 dropped: 1 cut word, 1 over budget)");
  });

  it("says nothing about drops when everything was placed", () => {
    expect(formatSfxAccounting(3, 3, "meme", [])).toBe("sfx: 3 of 3 planned placed (level meme)");
  });
});

/** Provider that records the one request it receives and answers with canned JSON. */
class ScriptedSfxProvider implements LlmProvider {
  readonly name = "scripted";
  readonly usage = [];
  seen?: { system: string; user: string; schemaName: string; tier?: CallTier };
  constructor(private answer: unknown) {}
  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    tier?: CallTier;
  }): Promise<T> {
    this.seen = { system: req.system, user: req.user, schemaName: req.schemaName, tier: req.tier };
    return req.schema.parse(this.answer);
  }
}

describe("generateSfxPlan", () => {
  it("asks the mechanical tier for an sfx_plan and returns the normalized plan", async () => {
    const transcript = withRuntime(mkTranscript(120), 60);
    const provider = new ScriptedSfxProvider({
      placements: [
        { soundId: "ding", word: 0 },
        { soundId: "scratch", word: 30 }, // meme-tagged at level normal
        { soundId: "nope", word: 60 },
      ],
    });
    const { plan: out, issues, planned } = await generateSfxPlan(
      provider,
      transcript,
      sheet,
      sounds,
      "normal",
    );
    expect(provider.seen?.schemaName).toBe("sfx_plan");
    expect(provider.seen?.tier).toBe("mechanical");
    expect(provider.seen?.user).toContain("- ding: use ding here");
    expect(planned).toBe(3);
    expect(out.placements).toEqual([{ soundId: "ding", word: 0 }]);
    expect(issues.map((i) => i.reason)).toEqual(["meme level", "unknown sound"]);
    expect(formatSfxAccounting(out.placements.length, planned, "normal", issues)).toBe(
      "sfx: 1 of 3 planned placed (level normal, 2 dropped: 1 unknown sound, 1 meme level)",
    );
  });
});
