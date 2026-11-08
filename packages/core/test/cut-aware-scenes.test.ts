import { describe, expect, it } from "vitest";
import { cutWordIndices } from "../src/cutlist";
import {
  CUT_WORDS_RULE,
  buildBeatsUserPrompt,
  normalizeBeatSheet,
  type BeatSheet,
} from "../src/producer/beats";
import { produceScenes } from "../src/producer/index";
import type { LlmProvider } from "../src/producer/provider";
import { generateScenes } from "../src/producer/scene-props";
import type { Segment, Transcript } from "../src/schema";

/**
 * 2026-11-08 field report: a retake the cutlist removed ("Rotate…") still
 * reached the graphics planner verbatim, and the generated graphic quoted it.
 * Every LLM call that writes on-screen copy is now told which words are cut.
 */

/** A transcript from words, at 0.5s per word. */
const speak = (text: string): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 })),
});

// "rotate the keys" (words 0-2) is the cut retake; "rotate keys" (3-4) is kept.
const RETAKE = speak("rotate the keys rotate keys weekly always");
const CUTLIST: Segment[] = [
  { srcIn: 0, srcOut: 1.45, kind: "remove", reason: "retake" },
  { srcIn: 1.45, srcOut: 4, kind: "keep" },
];

describe("cutWordIndices", () => {
  it("marks words whose midpoint lies inside a removal", () => {
    expect([...cutWordIndices(RETAKE.words, CUTLIST)]).toEqual([0, 1, 2]);
  });

  it("does not mark a kept word a tightened pause only grazes", () => {
    // Removal ends 0.1s into word 3 (1.5–1.9): its midpoint is kept.
    const graze: Segment[] = [{ srcIn: 1.42, srcOut: 1.6, kind: "remove", reason: "pause" }];
    expect([...cutWordIndices(RETAKE.words, graze)]).toEqual([]);
  });

  it("is empty for a cutlist with no removals", () => {
    expect(cutWordIndices(RETAKE.words, [{ srcIn: 0, srcOut: 4, kind: "keep" }]).size).toBe(0);
  });
});

describe("buildBeatsUserPrompt marks cut words", () => {
  it("wraps cut words in ⟦ ⟧, keeps their indices, and states the rule", () => {
    const p = buildBeatsUserPrompt(RETAKE, 3, undefined, undefined, undefined, undefined, new Set([0, 1, 2]));
    expect(p).toContain("[0]⟦rotate⟧ [1]⟦the⟧ [2]⟦keys⟧ [3]rotate [4]keys");
    expect(p).toContain(CUT_WORDS_RULE);
    // The rule sits above the transcript it explains.
    expect(p.indexOf(CUT_WORDS_RULE)).toBeLessThan(p.indexOf("Word-indexed transcript"));
  });

  it("is byte-identical to the old prompt when nothing is cut", () => {
    const old = buildBeatsUserPrompt(RETAKE, 3, undefined);
    expect(buildBeatsUserPrompt(RETAKE, 3, undefined, undefined, undefined, undefined, new Set())).toBe(old);
    expect(old).not.toContain("⟦");
  });

  it("counts enumerated beats from the heard words only", () => {
    // A flubbed "first … first" retake must not inflate the graphics target.
    const t = speak("first point here first point here second point third point");
    const kept = buildBeatsUserPrompt(t, 30, undefined, undefined, undefined, undefined, new Set([0, 1, 2]));
    const whole = buildBeatsUserPrompt(t, 30, undefined);
    // Same distinct ordinals either way — the count is over distinct beats.
    expect(kept).toContain("enumerates 3 points");
    expect(whole).toContain("enumerates 3 points");
  });
});

describe("normalizeBeatSheet with cut words", () => {
  const sheet = (moments: BeatSheet["moments"]): BeatSheet => ({ hook: "h", coverText: "c", moments });
  const m = (startWord: number, endWord: number, cueWord?: number) => ({
    startWord,
    endWord,
    purpose: "p",
    onScreenCopy: "ROTATE",
    sceneKind: "StatCard" as const,
    ...(cueWord !== undefined ? { cueWord } : {}),
  });

  it("drops a moment made only of cut words", () => {
    const { sheet: out, issues } = normalizeBeatSheet(sheet([m(0, 2), m(3, 6)]), RETAKE, null, new Set([0, 1, 2]));
    expect(out.moments.map((x) => x.startWord)).toEqual([3]);
    expect(issues.some((i) => i.issue.includes("spans only cut words"))).toBe(true);
  });

  it("keeps a moment that spans the retake and the kept take, minus a cut cueWord", () => {
    const { sheet: out } = normalizeBeatSheet(sheet([m(0, 6, 0)]), RETAKE, null, new Set([0, 1, 2]));
    expect(out.moments).toHaveLength(1);
    expect(out.moments[0]!.cueWord).toBeUndefined();
  });

  it("changes nothing without a cut set", () => {
    const { sheet: out } = normalizeBeatSheet(sheet([m(0, 2, 0)]), RETAKE, null);
    expect(out.moments[0]!.cueWord).toBe(0);
  });
});

describe("generateScenes never hands cut words to the props call", () => {
  const moment = { startWord: 0, endWord: 6, purpose: "p", onScreenCopy: "ROTATE KEYS", sceneKind: "FlowDiagram" as const };

  it("omits cut words from the transcript slice and cues on the kept take", async () => {
    const prompts: string[] = [];
    const provider: LlmProvider = {
      name: "fake",
      usage: [],
      async complete<T>(req: { user: string; schema: { parse(v: unknown): T } }): Promise<T> {
        prompts.push(req.user);
        return req.schema.parse({ nodes: ["ROTATE", "KEYS"] });
      },
    };
    const { scenes } = await generateScenes(provider, [moment], RETAKE, { cut: new Set([0, 1, 2]) });
    expect(prompts[0]).toContain('Transcript slice: "rotate keys weekly always"');
    // "rotate" is said at 0 (cut) and 3 (kept): the entrance is the kept one.
    expect(scenes[0]!.cue?.entryWord).toBe(3);
  });
});

describe("produceScenes", () => {
  it("marks the cut words in the beat-sheet call", async () => {
    const users: string[] = [];
    const provider: LlmProvider = {
      name: "fake",
      usage: [],
      async complete<T>(req: { user: string; schemaName: string; schema: { parse(v: unknown): T } }): Promise<T> {
        users.push(req.user);
        if (req.schemaName === "beat_sheet") {
          return req.schema.parse({
            hook: "h",
            coverText: "c",
            moments: [{ startWord: 0, endWord: 6, purpose: "p", onScreenCopy: "X", sceneKind: "none" }],
          });
        }
        throw new Error("unexpected call");
      },
    };
    await produceScenes(provider, { transcript: RETAKE, outputDuration: 2, cut: new Set([0, 1, 2]) });
    expect(users[0]).toContain("[0]⟦rotate⟧");
  });
});
