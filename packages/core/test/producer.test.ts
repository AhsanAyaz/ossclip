import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import { BeatSheetSchema, GRAPHICS_COVERAGE_TARGET, normalizeBeatSheet } from "../src/producer/beats";
import { generateScenes } from "../src/producer/scene-props";
import { produceScenes } from "../src/producer/index";
import type { Transcript } from "../src/schema";
import type { Moment } from "../src/producer/beats";

const mkTranscript = (n: number): Transcript => ({
  language: "en",
  words: Array.from({ length: n }, (_, i) => ({
    text: `word${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  })),
});
const transcript = mkTranscript(12);

const moment = (sceneKind: Moment["sceneKind"]): Moment => ({
  startWord: 0,
  endWord: 3,
  purpose: "test beat",
  onScreenCopy: "TEST COPY",
  sceneKind,
});

/** Provider scripted per-call: throws or returns each queued behavior in order. */
class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  calls = 0;
  constructor(private script: Array<unknown | Error>) {}
  async complete<T>(req: { schema: z.ZodType<T> }): Promise<T> {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)];
    if (step instanceof Error) throw step;
    return req.schema.parse(step);
  }
}

describe("producer brain", () => {
  it("mock provider drives the full pipeline deterministically", async () => {
    const result = await produceScenes(new MockProvider(), {
      transcript,
      outputDuration: 6,
      intent: "test",
    });
    expect(result.beatSheet.moments.length).toBeGreaterThan(0);
    expect(result.scenes.length).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(0);
    const again = await produceScenes(new MockProvider(), {
      transcript,
      outputDuration: 6,
      intent: "test",
    });
    expect(again).toEqual(result);
  });

  it("normalizeBeatSheet clamps, de-overlaps and reports issues", () => {
    const sheet = BeatSheetSchema.parse({
      hook: "hook",
      moments: [
        { startWord: 0, endWord: 5, purpose: "a", onScreenCopy: "A", sceneKind: "none" },
        { startWord: 3, endWord: 8, purpose: "b", onScreenCopy: "B", sceneKind: "none" }, // overlaps
        { startWord: 90, endWord: 95, purpose: "c", onScreenCopy: "C", sceneKind: "none" }, // beyond
      ],
    });
    const { sheet: fixed, issues } = normalizeBeatSheet(sheet, mkTranscript(12));
    expect(fixed.moments).toHaveLength(2);
    expect(fixed.moments[1]!.startWord).toBe(6);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("budgets graphics by COVERAGE and keeps survivors spread (FINDINGS §7/§8)", () => {
    // 120 words → ~60s runtime; 8 moments of 15 words (≈7.4s each, est show 5s).
    // 8×5s = 40s of graphics vs a budget of 45% × 59.9s ≈ 27s → demote 3.
    const t = mkTranscript(120);
    const kinds = ["TitleCard", "StatCard", "FlowDiagram", "RuleCard", "ChatMock", "TerminalMock", "StrikethroughReveal", "ScreenshotFrame"] as const;
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      moments: kinds.map((k, i) => ({
        startWord: i * 15,
        endWord: i * 15 + 14,
        purpose: `m${i}`,
        onScreenCopy: `M${i}`,
        sceneKind: k,
      })),
    });
    const { sheet: fixed, issues } = normalizeBeatSheet(sheet, t);
    const survivors = fixed.moments.flatMap((m, i) => (m.sceneKind !== "none" ? [i] : []));
    const runtime = t.words[t.words.length - 1]!.end - t.words[0]!.start;
    const shown = survivors.length * 5;
    expect(shown).toBeLessThanOrEqual(GRAPHICS_COVERAGE_TARGET * runtime + 1e-6);
    // Hook and payoff spared.
    expect(fixed.moments[0]!.sceneKind).toBe("TitleCard");
    expect(fixed.moments[7]!.sceneKind).toBe("ScreenshotFrame");
    // No drought: consecutive survivors never more than ~1/3 of runtime apart.
    const mids = survivors.map((i) => {
      const m = fixed.moments[i]!;
      return (t.words[m.startWord]!.start + t.words[m.endWord]!.end) / 2;
    });
    for (let i = 1; i < mids.length; i++) {
      expect(mids[i]! - mids[i - 1]!).toBeLessThanOrEqual(runtime / 3 + 1e-6);
    }
    expect(issues.some((i) => i.issue.includes("coverage"))).toBe(true);
  });

  it("demotes the later of adjacent same-kind graphics even within budget (FINDINGS §9)", () => {
    // 40 words ≈ 20s runtime → budget ≈ 9s; three ~2s graphics sit WELL
    // within it, so only the variety pass can be responsible for a demotion.
    const t = mkTranscript(40);
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 3, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
        { startWord: 4, endWord: 7, purpose: "b", onScreenCopy: "B", sceneKind: "StatCard" },
        { startWord: 8, endWord: 11, purpose: "c", onScreenCopy: "C", sceneKind: "none" },
        { startWord: 36, endWord: 39, purpose: "d", onScreenCopy: "D", sceneKind: "RuleCard" },
      ],
    });
    const { sheet: fixed, issues } = normalizeBeatSheet(sheet, t);
    expect(fixed.moments[0]!.sceneKind).toBe("StatCard"); // hook spared
    expect(fixed.moments[1]!.sceneKind).toBe("none"); // duplicate demoted
    expect(fixed.moments[3]!.sceneKind).toBe("RuleCard"); // payoff spared
    expect(issues.some((i) => i.issue.includes("duplicate adjacent"))).toBe(true);
  });

  it("retries once on invalid props, then succeeds", async () => {
    const provider = new ScriptedProvider([
      { title: "" }, // schema-invalid → thrown by schema.parse inside provider
      { title: "FIXED TITLE" },
    ]);
    const { scenes, failures } = await generateScenes(provider, [moment("TitleCard")], transcript);
    expect(provider.calls).toBe(2);
    expect(failures).toHaveLength(0);
    expect(scenes[0]!.props).toMatchObject({ title: "FIXED TITLE" });
  });

  it("falls back to TitleCard with the moment copy after two failures", async () => {
    const provider = new ScriptedProvider([
      new Error("truncated JSON"),
      new Error("still broken"),
    ]);
    const { scenes, failures } = await generateScenes(provider, [moment("StatCard")], transcript);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ component: "StatCard", fellBackTo: "TitleCard" });
    expect(scenes[0]!.component).toBe("TitleCard");
    expect(scenes[0]!.props).toMatchObject({ title: "TEST COPY" });
    // The render must still complete — fallback props validate.
    expect(scenes[0]!.anchor).toEqual({ startWord: 0, endWord: 3 });
  });

  it("'none' moments produce no scene", async () => {
    const provider = new ScriptedProvider([]);
    const { scenes } = await generateScenes(provider, [moment("none")], transcript);
    expect(scenes).toHaveLength(0);
    expect(provider.calls).toBe(0);
  });
});
