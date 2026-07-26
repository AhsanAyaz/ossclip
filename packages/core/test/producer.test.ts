import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import { BeatSheetSchema, normalizeBeatSheet } from "../src/producer/beats";
import { generateScenes } from "../src/producer/scene-props";
import { produceScenes } from "../src/producer/index";
import type { Transcript } from "../src/schema";
import type { Moment } from "../src/producer/beats";

const transcript: Transcript = {
  language: "en",
  words: Array.from({ length: 12 }, (_, i) => ({
    text: `word${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  })),
};

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
    const { sheet: fixed, issues } = normalizeBeatSheet(sheet, 12);
    expect(fixed.moments).toHaveLength(2);
    expect(fixed.moments[1]!.startWord).toBe(6);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("demotes excess graphics to 'none', sparing the hook and the payoff (FINDINGS §4)", () => {
    const mk = (i: number, kind: Moment["sceneKind"]): Moment => ({
      startWord: i * 2,
      endWord: i * 2 + 1,
      purpose: `m${i}`,
      onScreenCopy: `M${i}`,
      sceneKind: kind,
    });
    const sheet = BeatSheetSchema.parse({
      hook: "h",
      // 7 of 8 moments carry graphics — the real-footage overshoot.
      moments: [
        mk(0, "TitleCard"),
        mk(1, "StatCard"),
        mk(2, "FlowDiagram"),
        mk(3, "none"),
        mk(4, "TerminalMock"),
        mk(5, "ChatMock"),
        mk(6, "RuleCard"),
        mk(7, "StrikethroughReveal"),
      ],
    });
    const { sheet: fixed, issues } = normalizeBeatSheet(sheet, 100);
    const graphics = fixed.moments.filter((m) => m.sceneKind !== "none");
    expect(graphics.length).toBe(4); // floor(8/2)
    expect(fixed.moments[0]!.sceneKind).toBe("TitleCard"); // hook spared
    expect(fixed.moments[7]!.sceneKind).toBe("StrikethroughReveal"); // payoff spared
    expect(issues.some((i) => i.issue.includes("graphics cap"))).toBe(true);
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
