import { describe, expect, it } from "vitest";
import { MomentSchema, normalizeBeatSheet, type BeatSheet } from "../src/producer/beats";
import type { LlmProvider } from "../src/producer/provider";
import { generateScenes, planCue } from "../src/producer/scene-props";
import { SceneSchema } from "../src/scene-schema";
import type { Transcript } from "../src/schema";

/**
 * Plan-time cue (reveal-timing spec §7): every new scene records the word its
 * graphic enters on and the word each item is spoken on; a scene without
 * `cue` (every old plan) keeps today's timing.
 */

/** A transcript from words, at 0.5s per word. */
const speak = (text: string): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 })),
});

// The field take's scene-16 window, as in reveal-match.test.ts: only
// "framework" of the three chips is ever said.
const FIELD = speak(
  "the way I was able to do this was to build a framework myself which stops me " +
    "from creating more projects or even if I'm having some amazing ideas",
).words;
const idx = (w: string) => FIELD.findIndex((x) => x.text === w);
const fieldMoment = { startWord: 0, endWord: FIELD.length - 1 };

describe("planCue (spec §2, §7)", () => {
  it("enters a FlowDiagram on its first spoken chip, and records every chip's word", () => {
    const cue = planCue(
      "FlowDiagram",
      { nodes: ["NEW IDEA", "FRAMEWORK", "BLOCKED"] },
      fieldMoment,
      FIELD,
    );
    expect(cue.entryWord).toBe(idx("framework"));
    expect(cue.itemWords).toEqual([null, idx("framework"), null]);
  });

  it("falls back to the producer's cueWord when the label is never said", () => {
    // Field scene-12: "matter" is never spoken, so the label must NOT match
    // (the matcher is not loosened for it) and the entrance rides cueWord.
    const words = speak(
      "so after all of this the skills that still count are the ones you practice every day",
    ).words;
    const k = words.findIndex((w) => w.text === "skills");
    const cue = planCue(
      "ScreenshotFrame",
      { label: "SKILLS THAT STILL MATTER" },
      { startWord: 0, endWord: words.length - 1, cueWord: k },
      words,
    );
    expect(cue.entryWord).toBe(k);
    // A single-text component staggers nothing.
    expect(cue.itemWords).toBeUndefined();
  });

  it("locates each entry text on its own, not as one ordered pass", () => {
    // StatCard entry texts are [label, value]; the value is said BEFORE the
    // label. A monotonic pass would lose the value once the label matched.
    const words = speak("we cut it in half compared to the old build time").words;
    const cue = planCue(
      "StatCard",
      { label: "BUILD TIME", value: "HALF" },
      { startWord: 0, endWord: words.length - 1 },
      words,
    );
    expect(cue.entryWord).toBe(words.findIndex((w) => w.text === "half"));
  });

  it("never matches outside the moment's window", () => {
    // "framework" sits at 9; a window starting after it must not see it.
    const cue = planCue(
      "FlowDiagram",
      { nodes: ["FRAMEWORK"] },
      { startWord: idx("framework") + 1, endWord: FIELD.length - 1 },
      FIELD,
    );
    expect(cue.entryWord).toBe(idx("framework") + 1);
    expect(cue.itemWords).toEqual([null]);
  });

  it("drops an out-of-moment cueWord in validation, so the moment's start stands", () => {
    const t = speak(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
    const sheet: BeatSheet = {
      hook: "hook",
      moments: [
        {
          startWord: 0,
          endWord: 10,
          cueWord: 15, // 5 words past endWord
          purpose: "p",
          onScreenCopy: "COPY",
          sceneKind: "ScreenshotFrame",
        },
      ],
    };
    const { sheet: out, issues } = normalizeBeatSheet(sheet, t);
    const m = out.moments[0]!;
    expect(m.cueWord).toBeUndefined();
    expect("cueWord" in m).toBe(false);
    expect(issues.some((x) => x.moment === 0 && /cueWord/.test(x.issue))).toBe(true);
    const cue = planCue("ScreenshotFrame", { label: "NEVER SAID" }, m, t.words);
    expect(cue.entryWord).toBe(m.startWord);
  });

  it("keeps a cueWord inside the moment", () => {
    const t = speak(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
    const { sheet: out } = normalizeBeatSheet(
      {
        hook: "hook",
        moments: [
          { startWord: 0, endWord: 10, cueWord: 7, purpose: "p", onScreenCopy: "C", sceneKind: "none" },
        ],
      },
      t,
    );
    expect(out.moments[0]!.cueWord).toBe(7);
  });

  it("drops a cueWord the overlap repair shifted the moment past", () => {
    // The check runs on the FINAL window: a moment whose start is pushed
    // past its cueWord by de-overlap no longer contains it.
    const t = speak(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
    const { sheet: out } = normalizeBeatSheet(
      {
        hook: "hook",
        moments: [
          { startWord: 0, endWord: 10, purpose: "p", onScreenCopy: "C", sceneKind: "none" },
          { startWord: 8, endWord: 20, cueWord: 9, purpose: "p", onScreenCopy: "C", sceneKind: "none" },
        ],
      },
      t,
    );
    expect(out.moments[1]!.startWord).toBe(11);
    expect(out.moments[1]!.cueWord).toBeUndefined();
  });
});

describe("generateScenes gives every new scene a cue (spec §7)", () => {
  const t = speak("first we build a framework and then we ship it");
  const moment = { startWord: 0, endWord: t.words.length - 1, purpose: "p", onScreenCopy: "SHIP IT" };

  it("on the normal path, matched against the props the LLM wrote", async () => {
    const provider: LlmProvider = {
      name: "fake",
      usage: [],
      async complete<T>(req: { schema: { parse(v: unknown): T } }): Promise<T> {
        return req.schema.parse({ nodes: ["FRAMEWORK", "SHIP"] });
      },
    };
    const { scenes } = await generateScenes(
      provider,
      [{ ...moment, sceneKind: "FlowDiagram" }],
      t,
    );
    expect(scenes[0]!.cue).toEqual({ entryWord: 4, itemWords: [4, 8] });
  });

  it("on the TitleCard fallback, matched against the title it renders", async () => {
    const provider: LlmProvider = {
      name: "fake",
      usage: [],
      async complete<T>(): Promise<T> {
        throw new Error("no props");
      },
    };
    const { scenes } = await generateScenes(
      provider,
      [{ ...moment, sceneKind: "StatCard" }],
      t,
    );
    expect(scenes[0]!.component).toBe("TitleCard");
    expect(scenes[0]!.cue).toEqual({ entryWord: 8 });
  });
});

describe("old plans parse unchanged (spec constraints)", () => {
  it("MomentSchema parses a moment written before cueWord", () => {
    const old = { startWord: 0, endWord: 5, purpose: "p", onScreenCopy: "C", sceneKind: "none" };
    const parsed = MomentSchema.parse(old);
    expect(parsed).toEqual(old);
    expect("cueWord" in parsed).toBe(false);
  });

  it("SceneSchema parses a scene written before cue", () => {
    const old = {
      id: "scene-3",
      anchor: { startWord: 4, endWord: 9 },
      layout: "pip-bubble",
      component: "TitleCard",
      props: { title: "T" },
      overrides: {},
    };
    const parsed = SceneSchema.parse(old);
    expect(parsed).toEqual(old);
    expect("cue" in parsed).toBe(false);
  });

  it("SceneSchema keeps a cue on round-trip", () => {
    const scene = {
      id: "scene-3",
      anchor: { startWord: 4, endWord: 9 },
      layout: "pip-bubble",
      component: "FlowDiagram",
      props: { nodes: ["A", "B"] },
      overrides: {},
      cue: { entryWord: 5, itemWords: [5, null] },
    };
    expect(SceneSchema.parse(scene)).toEqual(scene);
  });
});
