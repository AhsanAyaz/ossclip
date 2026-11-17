import { describe, expect, it } from "vitest";
import { toJSONSchema, type z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import { BeatSheetSchema, normalizeBeatSheet } from "../src/producer/beats";
import { produceScenes } from "../src/producer/index";
import {
  MAX_SCRIPT_CUES,
  SCRIPT_MIN_SCENE_SEC,
  ScriptPlanError,
  planScriptMoments,
  scriptSceneEndWords,
  type ScriptPlanInput,
  type WordOutputTime,
} from "../src/producer/script-plan";
import { parseScript, type ScriptCue, type ScriptCueHint } from "../src/script/cues";
import { alignCues, type AlignedCue } from "../src/script/align";
import type { Transcript } from "../src/schema";
import type { Scene } from "../src/scene-schema";
import { assembleScenes } from "../src/assemble";
import { TimeMap } from "../src/timemap";

/** One word per space-separated token, 0.3 s each — the alignment tests' helper. */
const t = (text: string): Transcript => ({
  language: "en",
  words: text.split(" ").map((w, i) => ({ text: w, start: i * 0.3, end: (i + 1) * 0.3 })),
});

const TRANSCRIPT = t("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu");

const cue = (index: number, cueText: string, hint: ScriptCueHint = { kind: "none" }): ScriptCue => ({
  id: `cue-${index}-test`,
  index,
  cueText,
  hint,
  spoken: [`spoken line ${index}`],
  line: index + 1,
});

/** Cue i on words [3i, 3i+2]. */
const at = (c: ScriptCue): AlignedCue => ({ cue: c, startWord: c.index * 3, endWord: c.index * 3 + 2, score: 1 });

/** Records every request and answers `script_plan` with whatever the test hands it. */
class StubProvider implements LlmProvider {
  readonly name = "stub";
  readonly usage = [];
  readonly calls: Array<{ schemaName: string; user: string; system: string }> = [];
  constructor(private reply: (n: number) => unknown) {}
  async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
    this.calls.push({ schemaName: req.schemaName, user: req.user, system: req.system });
    const out = this.reply(this.calls.length - 1);
    if (out instanceof Error) throw out;
    return req.schema.parse(out);
  }
}

describe("planScriptMoments", () => {
  it("moments carry the alignment's word spans whatever the reply says", async () => {
    const aligned = [at(cue(0, "A big claim")), at(cue(1, "Another claim"))];
    const provider = new StubProvider(() => ({
      // The reply has no word fields at all — and any it invented would be ignored.
      cues: [
        { id: "cue-0-test", sceneKind: "StatCard", onScreenCopy: "BIG" },
        { id: "cue-1-test", sceneKind: "RuleCard", onScreenCopy: "OTHER" },
      ],
    }));
    const { moments, issues } = await planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    expect(moments.map((m) => [m.startWord, m.endWord])).toEqual([[0, 2], [3, 5]]);
    expect(moments.map((m) => m.sceneKind)).toEqual(["StatCard", "RuleCard"]);
    expect(moments[0]!.onScreenCopy).toBe("BIG");
    expect(moments[0]!.purpose).toBe("A big claim");
    expect(issues).toEqual([]);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["script_plan"]);
  });

  it("a clip cue gets no LLM entry, a \"none\" moment and a ClipScene", async () => {
    const clip = cue(1, "clips/a.mov", { kind: "clip", path: "clips/a.mov" });
    const aligned = [at(cue(0, "A claim")), at(clip)];
    const provider = new StubProvider(() => ({
      cues: [{ id: "cue-0-test", sceneKind: "TitleCard", onScreenCopy: "CLAIM" }],
    }));
    const input: ScriptPlanInput = {
      aligned,
      clips: [{ cueId: "cue-1-test", src: "clips/0123456789ab.webm", durationSec: 4.6 }],
    };
    const { moments, clipScenes } = await planScriptMoments(provider, input, TRANSCRIPT);
    expect(provider.calls[0]!.user).toContain("cue-0-test");
    expect(provider.calls[0]!.user).not.toContain("cue-1-test");
    expect(moments[1]!.sceneKind).toBe("none");
    expect(clipScenes).toEqual([
      {
        id: "scene-1",
        component: "ClipScene",
        layout: "full-bleed",
        anchor: { startWord: 3, endWord: 5 },
        props: { src: "clips/0123456789ab.webm", durationSec: 4.6 },
        overrides: {},
        rationale: "script clip",
      },
    ]);
  });

  it("a script of only clips makes no LLM call", async () => {
    const clip = cue(0, "clips/a.mov", { kind: "clip", path: "clips/a.mov" });
    const provider = new StubProvider(() => new Error("must not be called"));
    const { moments, clipScenes } = await planScriptMoments(
      provider,
      { aligned: [at(clip)], clips: [{ cueId: clip.id, src: "clips/x.webm", durationSec: 2 }] },
      TRANSCRIPT,
    );
    expect(provider.calls).toEqual([]);
    expect(moments).toHaveLength(1);
    expect(clipScenes).toHaveLength(1);
  });

  it("a clip cue with no imported clip is an error naming the path", async () => {
    const clip = cue(0, "clips/a.mov", { kind: "clip", path: "clips/a.mov" });
    await expect(
      planScriptMoments(new StubProvider(() => ({ cues: [] })), { aligned: [at(clip)], clips: [] }, TRANSCRIPT),
    ).rejects.toThrow(/clips\/a\.mov/);
  });

  it("a [StatCard] hint forces the kind; [Nope] throws listing the valid names", async () => {
    const provider = new StubProvider(() => ({
      cues: [{ id: "cue-0-test", sceneKind: "TitleCard", onScreenCopy: "42%" }],
    }));
    const { moments } = await planScriptMoments(
      provider,
      { aligned: [at(cue(0, "the number", { kind: "component", component: "StatCard" }))], clips: [] },
      TRANSCRIPT,
    );
    expect(moments[0]!.sceneKind).toBe("StatCard");
    expect(moments[0]!.onScreenCopy).toBe("42%");

    const bad = planScriptMoments(
      new StubProvider(() => ({ cues: [] })),
      { aligned: [at(cue(0, "x", { kind: "component", component: "Nope" }))], clips: [] },
      TRANSCRIPT,
    );
    await expect(bad).rejects.toBeInstanceOf(ScriptPlanError);
    await expect(bad).rejects.toThrow(/Nope/);
    await expect(bad).rejects.toThrow(/TitleCard/);
  });

  it("a hint names only planner components: [ClipScene] is unknown", async () => {
    const bad = planScriptMoments(
      new StubProvider(() => ({ cues: [] })),
      { aligned: [at(cue(0, "x", { kind: "component", component: "ClipScene" }))], clips: [] },
      TRANSCRIPT,
    );
    await expect(bad).rejects.toBeInstanceOf(ScriptPlanError);
  });

  it("a [CardRow] hint is a script component; [CardRows] lists CardRow among the valid names", async () => {
    const provider = new StubProvider(() => ({
      cues: [{ id: "cue-0-test", sceneKind: "TitleCard", onScreenCopy: "steps" }],
    }));
    const { moments } = await planScriptMoments(
      provider,
      { aligned: [at(cue(0, "three steps", { kind: "component", component: "CardRow" }))], clips: [] },
      TRANSCRIPT,
    );
    expect(moments[0]!.sceneKind).toBe("CardRow");

    const bad = planScriptMoments(
      new StubProvider(() => ({ cues: [] })),
      { aligned: [at(cue(0, "x", { kind: "component", component: "CardRows" }))], clips: [] },
      TRANSCRIPT,
    );
    await expect(bad).rejects.toBeInstanceOf(ScriptPlanError);
    await expect(bad).rejects.toThrow(/valid names: .*CardRow/);
  });

  it("a reply of sceneKind \"CardRow\" plans a CardRow moment (script-only, §161)", async () => {
    const provider = new StubProvider(() => ({
      cues: [{ id: "cue-0-test", sceneKind: "CardRow", onScreenCopy: "DRAFT REVIEW SHIP" }],
    }));
    const { moments, issues } = await planScriptMoments(
      provider,
      { aligned: [at(cue(0, "the three steps"))], clips: [] },
      TRANSCRIPT,
    );
    expect(moments.map((m) => m.sceneKind)).toEqual(["CardRow"]);
    expect(issues).toEqual([]);
  });

  it(`more than ${MAX_SCRIPT_CUES} aligned cues is an error stating the count`, async () => {
    const aligned = Array.from({ length: 41 }, (_, i) => ({ ...at(cue(i, `c${i}`)), startWord: 0, endWord: 0 }));
    const provider = new StubProvider(() => ({ cues: [] }));
    const run = planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    await expect(run).rejects.toBeInstanceOf(ScriptPlanError);
    await expect(run).rejects.toThrow(/41/);
    expect(provider.calls).toEqual([]);
  });

  it("a provider that throws twice yields TitleCard moments and one issue per cue", async () => {
    const aligned = [at(cue(0, "First cue text")), at(cue(1, "Second cue text"))];
    const provider = new StubProvider(() => new Error("provider down"));
    const { moments, issues } = await planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    expect(provider.calls).toHaveLength(2);
    expect(moments.map((m) => m.sceneKind)).toEqual(["TitleCard", "TitleCard"]);
    expect(moments.map((m) => m.onScreenCopy)).toEqual(["First cue text", "Second cue text"]);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.moment)).toEqual([0, 1]);
  });

  it("one thrown call is retried once and the retry's answer is used", async () => {
    const aligned = [at(cue(0, "First cue text"))];
    const provider = new StubProvider((n) =>
      n === 0 ? new Error("flake") : { cues: [{ id: "cue-0-test", sceneKind: "StatCard", onScreenCopy: "ONE" }] },
    );
    const { moments, issues } = await planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    expect(provider.calls).toHaveLength(2);
    expect(moments[0]!.sceneKind).toBe("StatCard");
    expect(issues).toEqual([]);
  });

  it("the fallback copy is the cue text cut to 60 characters at a word boundary", async () => {
    const long = "This cue text is deliberately much longer than sixty characters so it must be cut";
    const provider = new StubProvider(() => new Error("down"));
    const { moments } = await planScriptMoments(provider, { aligned: [at(cue(0, long))], clips: [] }, TRANSCRIPT);
    expect(moments[0]!.onScreenCopy).toBe("This cue text is deliberately much longer than sixty");
  });

  it("a reply missing one cue id falls back for that cue only", async () => {
    const aligned = [at(cue(0, "First")), at(cue(1, "Second"))];
    const provider = new StubProvider(() => ({
      cues: [{ id: "cue-0-test", sceneKind: "RuleCard", onScreenCopy: "ONE" }],
    }));
    const { moments, issues } = await planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    expect(moments.map((m) => m.sceneKind)).toEqual(["RuleCard", "TitleCard"]);
    expect(moments[1]!.onScreenCopy).toBe("Second");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.moment).toBe(1);
    expect(issues[0]!.issue).toContain("cue-1-test");
  });

  it("a \"none\" reply is a footage cue that stays talking head; a hinted cue ignores it", async () => {
    const aligned = [
      at(cue(0, "Screen recording: the editor")),
      at(cue(1, "the number", { kind: "component", component: "StatCard" })),
    ];
    const provider = new StubProvider(() => ({
      cues: [
        { id: "cue-0-test", sceneKind: "none", onScreenCopy: "" },
        { id: "cue-1-test", sceneKind: "none", onScreenCopy: "42%" },
      ],
    }));
    const { moments, issues } = await planScriptMoments(provider, { aligned, clips: [] }, TRANSCRIPT);
    expect(moments.map((m) => m.sceneKind)).toEqual(["none", "StatCard"]);
    expect(issues).toEqual([{ moment: 0, issue: expect.stringContaining("footage cue") }]);
    expect(issues[0]!.issue).toContain("cue-0-test");
  });

  it("the prompt lists each cue's id, cue text and spoken text, and the planner menu only", async () => {
    const provider = new StubProvider(() => ({ cues: [] }));
    await planScriptMoments(provider, { aligned: [at(cue(0, "A big claim"))], clips: [] }, TRANSCRIPT);
    const { user, system } = provider.calls[0]!;
    expect(user).toContain("cue-0-test");
    expect(user).toContain("A big claim");
    expect(user).toContain("spoken line 0");
    expect(user).toContain("- BulletList:");
    expect(user).not.toContain("ClipScene");
    expect(system).toMatch(/footage/i);
  });

  it("the script menu offers the script-only cards after the nine (§161, plan Task 4)", async () => {
    const provider = new StubProvider(() => ({ cues: [] }));
    await planScriptMoments(provider, { aligned: [at(cue(0, "A big claim"))], clips: [] }, TRANSCRIPT);
    const { user } = provider.calls[0]!;
    expect(user).toContain("- CardRow:");
    expect(user).not.toContain("ClipScene");
    expect(user.indexOf("- CardRow:")).toBeGreaterThan(user.indexOf("- BulletList:"));
  });
});

describe("normalizeBeatSheet mode", () => {
  // 100 words at 0.5 s ≈ 50 s: past the §29 short-take floor, so in "auto"
  // mode only the coverage budget and the variety pass act on this sheet.
  const words100: Transcript = {
    language: "en",
    words: Array.from({ length: 100 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })),
  };
  // Three adjacent StatCards over words 0..79: ~80% of the runtime.
  const sheet = BeatSheetSchema.parse({
    hook: "h",
    moments: [
      { startWord: 0, endWord: 26, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
      { startWord: 27, endWord: 53, purpose: "b", onScreenCopy: "B", sceneKind: "StatCard" },
      { startWord: 54, endWord: 79, purpose: "c", onScreenCopy: "C", sceneKind: "StatCard" },
    ],
  });

  it("\"script\" keeps three adjacent same-kind moments at 80% coverage", () => {
    const { sheet: out, issues } = normalizeBeatSheet(sheet, words100, null, undefined, "script");
    expect(out.moments.map((m) => m.sceneKind)).toEqual(["StatCard", "StatCard", "StatCard"]);
    expect(issues.some((i) => i.issue.includes("demoted"))).toBe(false);
  });

  it("\"auto\" (the default) demotes the same sheet as today", () => {
    const explicit = normalizeBeatSheet(sheet, words100, null, undefined, "auto");
    const implicit = normalizeBeatSheet(sheet, words100, null);
    expect(explicit).toEqual(implicit);
    expect(implicit.sheet.moments.map((m) => m.sceneKind)).toEqual(["StatCard", "none", "StatCard"]);
    expect(implicit.issues.some((i) => i.issue.includes("demoted"))).toBe(true);
  });

  it("\"script\" still repairs overlap and drops a cut-only moment", () => {
    const s = BeatSheetSchema.parse({
      hook: "h",
      moments: [
        { startWord: 0, endWord: 5, purpose: "a", onScreenCopy: "A", sceneKind: "StatCard" },
        { startWord: 3, endWord: 8, purpose: "b", onScreenCopy: "B", sceneKind: "StatCard" },
        { startWord: 10, endWord: 12, purpose: "c", onScreenCopy: "C", sceneKind: "StatCard" },
      ],
    });
    const { sheet: out } = normalizeBeatSheet(s, words100, null, new Set([10, 11, 12]), "script");
    expect(out.moments.map((m) => [m.startWord, m.endWord])).toEqual([[0, 5], [6, 8]]);
  });
});

describe("produceScenes with a script", () => {
  const SCRIPT =
    "🎬 Big claim\n🗣️ alpha beta gamma\n" +
    "🎬 clip: clips/a.mov\n🗣️ delta epsilon zeta\n" +
    "🎬 [StatCard] the number\n🗣️ eta theta iota";
  const cues = parseScript(SCRIPT);
  const { aligned } = alignCues(cues, TRANSCRIPT);
  const script: ScriptPlanInput = {
    aligned,
    clips: [{ cueId: cues[1]!.id, src: "clips/0123456789ab.webm", durationSec: 4.6 }],
  };

  /** The mock, with every schema name it is asked for recorded. */
  const spy = () => {
    const mock = new MockProvider();
    const seen: string[] = [];
    const provider: LlmProvider = {
      name: "spy",
      usage: mock.usage,
      async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
        seen.push(req.schemaName);
        return mock.complete(req);
      },
    };
    return { provider, seen };
  };

  it("returns a scene for every cue, the clip included, and never asks for a beat sheet", async () => {
    expect(aligned).toHaveLength(3);
    const { provider, seen } = spy();
    const result = await produceScenes(provider, { transcript: TRANSCRIPT, outputDuration: 3.6, script });
    expect(seen).not.toContain("beat_sheet");
    expect(seen).toContain("script_plan");
    const byId = Object.fromEntries(result.scenes.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["scene-0", "scene-1", "scene-2"]);
    expect(byId["scene-0"]!.component).toBe("TitleCard");
    expect(byId["scene-1"]!.component).toBe("ClipScene");
    expect(byId["scene-1"]!.anchor).toEqual({ startWord: 3, endWord: 5 });
    expect(byId["scene-2"]!.component).toBe("StatCard");
    expect(result.beatSheet.hook).toBe(result.beatSheet.moments[0]!.onScreenCopy);
    expect(result.graphics).toEqual({ asked: 3, delivered: 3 });
  });

  it("a CardRow cue becomes a CardRow scene with the props call's copy", async () => {
    const cardScript = parseScript("🎬 [CardRow] the three steps\n🗣️ alpha beta gamma");
    const { aligned: cardAligned } = alignCues(cardScript, TRANSCRIPT);
    const { provider, seen } = spy();
    const result = await produceScenes(provider, {
      transcript: TRANSCRIPT,
      outputDuration: 3.6,
      script: { aligned: cardAligned, clips: [] },
    });
    expect(seen).toContain("CardRow_props");
    expect(result.scenes.map((s) => s.component)).toEqual(["CardRow"]);
    expect(result.failures).toEqual([]);
    // Full frame over the speaker: the registry's own layout.
    expect(result.scenes[0]!.layout).toBe("full-bleed");
    expect(result.beatSheet.moments[0]!.sceneKind).toBe("CardRow");
  });

  it("the mock answers a hinted cue's component, and TitleCard for an unhinted one", async () => {
    // Plan Task 9 Step 1. `planScriptMoments` already keeps a hint whatever
    // the reply says; this is the mock's REPLY, so the offline path shows the
    // planner obeying the prompt's "(fixed)" line rather than being overruled.
    const twoScript = parseScript(
      "🎬 Big claim\n🗣️ alpha beta gamma\n🎬 [PhoneDemo] the captions\n🗣️ delta epsilon zeta",
    );
    const { aligned: twoAligned } = alignCues(twoScript, TRANSCRIPT);
    let reply: unknown;
    const mock = new MockProvider();
    const provider: LlmProvider = {
      name: "spy",
      usage: mock.usage,
      async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
        const out = await mock.complete(req);
        if (req.schemaName === "script_plan") reply = out;
        return out;
      },
    };
    await planScriptMoments(provider, { aligned: twoAligned, clips: [] }, TRANSCRIPT);
    expect((reply as { cues: Array<{ id: string; sceneKind: string }> }).cues).toEqual([
      expect.objectContaining({ id: twoScript[0]!.id, sceneKind: "TitleCard" }),
      expect.objectContaining({ id: twoScript[1]!.id, sceneKind: "PhoneDemo" }),
    ]);
  });

  it("offers a script's props call the script-only props, and a run without one does not", async () => {
    // Plan Task 8 (G6): `badge` is in the TerminalMock schema the provider is
    // handed only when the run came from a script.
    const recording = () => {
      const mock = new MockProvider();
      const schemas: Record<string, string> = {};
      const provider: LlmProvider = {
        name: "rec",
        usage: mock.usage,
        async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
          schemas[req.schemaName] = JSON.stringify(toJSONSchema(req.schema));
          return mock.complete(req);
        },
      };
      return { provider, schemas };
    };
    const termScript = parseScript("🎬 [TerminalMock] the command\n🗣️ alpha beta gamma");
    const { aligned: termAligned } = alignCues(termScript, TRANSCRIPT);
    const scripted = recording();
    const result = await produceScenes(scripted.provider, {
      transcript: TRANSCRIPT,
      outputDuration: 3.6,
      script: { aligned: termAligned, clips: [] },
    });
    expect(result.scenes.map((s) => s.component)).toEqual(["TerminalMock"]);
    expect(scripted.schemas["TerminalMock_props"]).toContain("badge");

    const auto = recording();
    await produceScenes(auto.provider, {
      transcript: TRANSCRIPT,
      outputDuration: 3.6,
      forceComponent: "TerminalMock",
    });
    expect(auto.schemas["TerminalMock_props"]).toBeDefined();
    expect(auto.schemas["TerminalMock_props"]).not.toContain("badge");
  });

  it("the planner's layout is ignored in 16:9 and used in 9:16 (scene-backdrop-choice design §1)", async () => {
    // The mock never sets `layout`; this provider adds one to its script_plan
    // reply, as a real planner may. In 16:9 a full-frame card that took it
    // came out as the speaker blurred under the card (the design's "half-used").
    const cardScript = parseScript("🎬 [CardRow] the three steps\n🗣️ alpha beta gamma");
    const { aligned: cardAligned } = alignCues(cardScript, TRANSCRIPT);
    const withLayout = (): LlmProvider => {
      const mock = new MockProvider();
      return {
        name: "layout",
        usage: mock.usage,
        async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
          const out = await mock.complete(req);
          if (req.schemaName !== "script_plan") return out;
          const reply = out as { cues: Array<Record<string, unknown>> };
          return req.schema.parse({ cues: reply.cues.map((c) => ({ ...c, layout: "graphic-only" })) });
        },
      };
    };
    const plan = (aspect?: "9:16" | "16:9") =>
      produceScenes(withLayout(), {
        transcript: TRANSCRIPT,
        outputDuration: 3.6,
        ...(aspect ? { aspect } : {}),
        script: { aligned: cardAligned, clips: [] },
      });
    const landscape = await plan("16:9");
    expect(landscape.scenes.map((s) => [s.component, s.layout])).toEqual([["CardRow", "full-bleed"]]);
    expect(landscape.beatSheet.moments[0]!.layout).toBeUndefined();
    // 9:16, and a caller that names no aspect (portrait), use it as today.
    for (const portrait of [await plan("9:16"), await plan()]) {
      expect(portrait.scenes.map((s) => [s.component, s.layout])).toEqual([["CardRow", "graphic-only"]]);
    }
  });

  it("rejects --clip together with --script", async () => {
    await expect(
      produceScenes(new MockProvider(), {
        transcript: TRANSCRIPT,
        outputDuration: 3.6,
        script,
        clip: { targetSec: 30 },
      }),
    ).rejects.toThrow(/clip/);
  });
});

describe("scriptSceneEndWords (a script scene lasts at least SCRIPT_MIN_SCENE_SEC)", () => {
  // Twelve back-to-back half-second words on the output clock: word i spans
  // [0.5i, 0.5i + 0.5].
  const half: WordOutputTime[] = Array.from({ length: 12 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.5 }));
  const span = (c: ScriptCue, startWord: number, endWord: number): AlignedCue => ({ cue: c, startWord, endWord, score: 1 });

  it("is four seconds", () => {
    expect(SCRIPT_MIN_SCENE_SEC).toBe(4);
  });

  it("moves a short cue's END to the last kept word ending by start + 4 s, never its start", () => {
    // Words 0-2 are 1.5 s; word 7 ends at exactly 4.0 s, word 8 at 4.5 s.
    const aligned = [span(cue(0, "A"), 0, 2), span(cue(1, "B"), 10, 11)];
    expect(scriptSceneEndWords(aligned, half)).toEqual([7, 11]);
  });

  it("stops at the word before the next placed cue when that comes sooner", () => {
    // B, from 2.5 s, may run to 6.5 s: the last word (11) ends at 6.0 s.
    const aligned = [span(cue(0, "A"), 0, 2), span(cue(1, "B"), 5, 6)];
    expect(scriptSceneEndWords(aligned, half)).toEqual([4, 11]);
  });

  it("a next cue on the very next word leaves the scene as spoken", () => {
    const aligned = [span(cue(0, "A"), 0, 2), span(cue(1, "B"), 3, 4)];
    expect(scriptSceneEndWords(aligned, half)[0]).toBe(2);
  });

  it("lands only on kept words: a cut word (null) is passed over, never ended on", () => {
    const times = half.map((t, i) => (i === 7 ? null : t));
    expect(scriptSceneEndWords([span(cue(0, "A"), 0, 2)], times)).toEqual([6]);
  });

  it("never past the last kept word", () => {
    const times = half.slice(0, 5).concat([null, null]);
    expect(scriptSceneEndWords([span(cue(0, "A"), 0, 2)], times)).toEqual([4]);
  });

  it("leaves a cue already at least four seconds long alone", () => {
    expect(scriptSceneEndWords([span(cue(0, "A"), 0, 7)], half)).toEqual([7]);
    expect(scriptSceneEndWords([span(cue(0, "A"), 0, 9)], half)).toEqual([9]);
  });

  it("leaves a clip: cue alone — a ClipScene keeps its own length", () => {
    const clip = cue(0, "clips/a.mov", { kind: "clip", path: "clips/a.mov" });
    expect(scriptSceneEndWords([span(clip, 0, 1)], half)).toEqual([1]);
  });

  it("measures on the OUTPUT clock: a pause the cut kept is screen time", () => {
    // 2 s of kept silence before word 3: only word 3 (ending at 4.0 s) fits.
    const gap = half.map((t, i) => (t && i >= 3 ? { start: t.start + 2, end: t.end + 2 } : t));
    expect(scriptSceneEndWords([span(cue(0, "A"), 0, 2)], gap)).toEqual([3]);
  });

  it("the overlap repair in normalizeBeatSheet(\"script\") finds nothing to repair afterwards", () => {
    const aligned = [span(cue(0, "A"), 0, 2), span(cue(1, "B"), 5, 6), span(cue(2, "C"), 9, 9)];
    const ends = scriptSceneEndWords(aligned, half);
    const moments = aligned.map((a, i) => ({
      startWord: a.startWord,
      endWord: ends[i]!,
      purpose: "p",
      onScreenCopy: "c",
      sceneKind: "TitleCard" as const,
    }));
    const words12: Transcript = { language: "en", words: half.map((t, i) => ({ text: `w${i}`, ...t! })) };
    const { sheet, issues } = normalizeBeatSheet({ hook: "h", moments }, words12, null, undefined, "script");
    expect(issues).toEqual([]);
    expect(sheet.moments.map((m) => [m.startWord, m.endWord])).toEqual(moments.map((m) => [m.startWord, m.endWord]));
  });
});

describe("scriptSceneEndWords counts the four seconds from the scene's entry word (EGM run, 2026-11-17)", () => {
  // The EGM case: a 12-word line over 3.68 s whose graphic enters on a word
  // 1.97 s in, so the scene STARTS at 1.67 s (the entry lead is 0.3 s) and
  // was on screen 2.0 s. Counted from the line's first word the scene
  // already looked 3.68 s long and was never extended.
  // Words 0-4 every 0.3 s, the entry word 5 at 1.97 s, words 6-11 every
  // 0.25 s from 2.25 s, the last ending at 3.68 s.
  const line: WordOutputTime[] = Array.from({ length: 12 }, (_, i) =>
    i < 5
      ? { start: i * 0.3, end: i * 0.3 + 0.25 }
      : i === 5
        ? { start: 1.97, end: 2.2 }
        : { start: 2.25 + (i - 6) * 0.25, end: i === 11 ? 3.68 : 2.45 + (i - 6) * 0.25 },
  );
  // Words after the line, 0.35 s apart: word 12+j ends at 4.05 + 0.35 j.
  const after: WordOutputTime[] = Array.from({ length: 9 }, (_, j) => ({ start: 3.75 + 0.35 * j, end: 4.05 + 0.35 * j }));
  const times = [...line, ...after];
  const lineCue: AlignedCue = { cue: cue(0, "My test case"), startWord: 0, endWord: 11, score: 1 };

  it("from the line's first word (no entry word) the 3.68 s line is not extended", () => {
    expect(scriptSceneEndWords([lineCue], times)).toEqual([11]);
  });

  it("from the entry word, the scene runs to the last word ending by entry - lead + 4 s", () => {
    // Start 1.67 s → until 5.67 s: word 16 ends 5.45 s, word 17 at 5.80 s.
    expect(scriptSceneEndWords([lineCue], times, { scenes: [{ kind: "graphic", entryWord: 5 }] })).toEqual([16]);
  });

  it("an entry word outside the cue's span is ignored; a cut entry word enters on the next kept one", () => {
    expect(scriptSceneEndWords([lineCue], times, { scenes: [{ kind: "graphic", entryWord: 40 }] })).toEqual([11]);
    // Word 5 cut: the scene enters on the next kept word, 6, at 2.25 s →
    // start 1.95 s, until 5.95 s: word 17 ends 5.80 s, word 18 at 6.15 s.
    const cut5 = times.map((t, i) => (i === 5 ? null : t));
    expect(scriptSceneEndWords([lineCue], cut5, { scenes: [{ kind: "graphic", entryWord: 5 }] })).toEqual([17]);
  });

  it("never starts the count before the line's first word (the legacy start is the floor)", () => {
    // An entry on the first word: 0 - 0.3 is floored at 0, as assembly floors it.
    expect(scriptSceneEndWords([lineCue], times, { scenes: [{ kind: "graphic", entryWord: 0 }] })).toEqual([11]);
  });
});

describe("scriptSceneEndWords counts from where the previous scene ends (EGM plan-only run, 2026-11-17)", () => {
  // Back-to-back half-second words: word i spans [0.5i, 0.5i + 0.4].
  const words = (n: number): WordOutputTime[] =>
    Array.from({ length: n }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4 }));
  const span = (c: ScriptCue, startWord: number, endWord: number): AlignedCue => ({ cue: c, startWord, endWord, score: 1 });
  const clipCue = cue(0, "clips/a.mov", { kind: "clip", path: "clips/a.mov" });

  it("a line spoken while the previous 5.2 s clip still plays counts from the clip's end + the gap", () => {
    // The clip is placed on words 0-1 (from 0 s) and plays to 5.2 s; the
    // TitleCard's line is words 2-5 (1.0-2.9 s) and enters on word 2. It
    // really starts at 5.25 s, so it may run to 9.25 s: word 18 ends 9.4 s,
    // word 17 at 8.9 s.
    const times = words(30);
    const aligned = [span(clipCue, 0, 1), span(cue(1, "Title"), 2, 5)];
    const scenes = [
      { kind: "clip" as const, durationSec: 5.2 },
      { kind: "graphic" as const, entryWord: 2 },
    ];
    // The old rule, as if nothing played before it: counted from the line's
    // first word (1.0 s, which floors entry - lead), to 5.0 s — word 9.
    expect(scriptSceneEndWords(aligned, times, { scenes: [{ kind: "none" }, scenes[1]!] })).toEqual([1, 9]);
    expect(scriptSceneEndWords(aligned, times, { scenes })).toEqual([1, 17]);

    // What assembly then draws: the TitleCard from 5.25 s to 8.9 s, where
    // the old count (word 9, ending 4.9 s) left it 5.25-6.45 s (the 1.2 s floor).
    const map = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const transcript: Transcript = { language: "en", words: times.map((t, i) => ({ text: `w${i}`, ...t! })) };
    const plan = (titleEnd: number) =>
      assembleScenes(
        [
          {
            id: "scene-0",
            anchor: { startWord: 0, endWord: 1 },
            layout: "full-bleed",
            component: "ClipScene",
            props: { src: "clips/0123456789ab.webm", durationSec: 5.2 },
            overrides: {},
          },
          {
            id: "scene-1",
            anchor: { startWord: 2, endWord: titleEnd },
            layout: "full-bleed",
            component: "TitleCard",
            props: { title: "Title" },
            overrides: {},
            cue: { entryWord: 2 },
          },
        ],
        transcript,
        map,
      ).cues[1]!;
    const before = plan(9);
    expect(before.startSec).toBeCloseTo(5.25);
    expect(before.endSec - before.startSec).toBeCloseTo(1.2);
    const after = plan(17);
    expect(after.startSec).toBeCloseTo(5.25);
    expect(after.endSec).toBeCloseTo(8.9);
  });

  it("a clip pushed by ITS predecessor ends its own length after that pushed start", () => {
    // A 1.2 s-floored card on word 0 ends 1.2 s; the clip on words 1-2 is
    // pushed to 1.25 s and plays to 6.45 s; the card after it (words 3-4)
    // starts 6.5 s and may run to 10.5 s: word 20 ends 10.4 s.
    const times = words(30);
    const aligned = [span(cue(0, "A"), 0, 0), span({ ...clipCue, index: 1, id: "cue-1-test" }, 1, 2), span(cue(2, "B"), 3, 4)];
    const scenes = [
      { kind: "graphic" as const },
      { kind: "clip" as const, durationSec: 5.2 },
      { kind: "graphic" as const },
    ];
    expect(scriptSceneEndWords(aligned, times, { scenes, sceneFloorSec: 1.2 })).toEqual([0, 2, 20]);
  });

  it("a clip longer than the 15 s cap ends at the cap, as assembly cuts it", () => {
    const times = words(60);
    const aligned = [span(clipCue, 0, 1), span(cue(1, "Title"), 2, 3)];
    // Clip from 0 s, capped to 15 s: the card starts 15.05 s → 19.05 s: word 37 ends 18.9 s.
    expect(
      scriptSceneEndWords(aligned, times, { scenes: [{ kind: "clip", durationSec: 40 }, { kind: "graphic" }] }),
    ).toEqual([1, 37]);
  });

  it("three graphic cues in a row: the first's end (floored by assembly) pushes the second, which still reaches the minimum", () => {
    // A is one word (0-0.4 s) with B's line on the very next word, so it
    // cannot grow; assembly floors it to 1.2 s, which pushes B (words 1-2,
    // from 0.5 s) to 1.25 s. B then runs to 5.25 s: word 9 ends 4.9 s. C
    // (words 10-11, from 5.0 s) is clear of B and runs to 9.0 s: word 17.
    const times = words(30);
    const aligned = [span(cue(0, "A"), 0, 0), span(cue(1, "B"), 1, 2), span(cue(2, "C"), 10, 11)];
    const graphic = { kind: "graphic" as const };
    expect(
      scriptSceneEndWords(aligned, times, { scenes: [graphic, graphic, graphic], sceneFloorSec: 1.2 }),
    ).toEqual([0, 9, 17]);
    // Counted from B's own line (0.5 s) it would stop at word 8 and be on
    // screen 1.25-4.4 s.
    expect(scriptSceneEndWords(aligned, times, { scenes: [{ kind: "none" }, graphic, graphic] })).toEqual([0, 8, 17]);

    // And assembly agrees: B is on screen 1.25-4.9 s, C 5.0-8.9 s.
    const map = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const transcript: Transcript = { language: "en", words: times.map((t, i) => ({ text: `w${i}`, ...t! })) };
    const sc = (id: string, startWord: number, endWord: number): Scene => ({
      id,
      anchor: { startWord, endWord },
      layout: "full-bleed",
      component: "TitleCard",
      props: { title: id },
      overrides: {},
    });
    const cues = assembleScenes([sc("a", 0, 0), sc("b", 1, 9), sc("c", 10, 17)], transcript, map).cues;
    expect(cues.map((c) => [c.startSec, c.endSec].map((x) => Math.round(x * 100) / 100))).toEqual([
      [0, 1.2],
      [1.25, 4.9],
      [5, 8.9],
    ]);
  });

  it("a footage cue (no scene) does not constrain the next one", () => {
    const times = words(30);
    const aligned = [span(cue(0, "Footage"), 0, 0), span(cue(1, "B"), 1, 2)];
    // Floored or not, a cue with no scene puts nothing on screen to push B.
    expect(
      scriptSceneEndWords(aligned, times, { scenes: [{ kind: "none" }, { kind: "graphic" }], sceneFloorSec: 1.2 }),
    ).toEqual([0, 8]);
  });
});

describe("produceScenes with a script and word times: the minimum scene length", () => {
  // "Brainstorm. Draft. Review." is a 2.3 s line; the words after it belong
  // to no cue. "the" ends at 3.8 s and "plan" at 4.2 s, so a 4 s minimum
  // from the line's start ends on "the".
  const said: Array<[string, number, number]> = [
    ["Brainstorm.", 0, 0.6],
    ["Draft.", 0.9, 1.4],
    ["Review.", 1.8, 2.3],
    ["Then", 2.6, 2.9],
    ["we", 3.0, 3.2],
    ["write", 3.3, 3.6],
    ["the", 3.7, 3.8],
    ["plan", 3.9, 4.2],
    ["down.", 4.3, 4.7],
  ];
  const transcript: Transcript = {
    language: "en",
    words: said.map(([text, start, end]) => ({ text, start, end })),
  };
  // Nothing cut: output time is source time.
  const map = new TimeMap([{ srcIn: 0, srcOut: 6, kind: "keep" }]);
  const wordTimes = transcript.words.map((w) => map.mapWord(w));

  /** Answers the plan with a CardRow and its props with the three spoken steps. */
  class CardRowProvider implements LlmProvider {
    readonly name = "cards";
    readonly usage = [];
    readonly asked: string[] = [];
    async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
      this.asked.push(req.user);
      const id = /id: (\S+)/.exec(req.user)?.[1] ?? "";
      const out =
        req.schemaName === "script_plan"
          ? { cues: [{ id, sceneKind: "CardRow", onScreenCopy: "THREE STEPS" }] }
          : { cards: [{ text: "Brainstorm" }, { text: "Draft" }, { text: "Review" }] };
      return req.schema.parse(out);
    }
  }

  const plan = async (times?: readonly WordOutputTime[]) => {
    const cues = parseScript("🎬 [CardRow] three steps\n🗣️ Brainstorm. Draft. Review.");
    const { aligned } = alignCues(cues, transcript);
    expect(aligned.map((a) => [a.startWord, a.endWord])).toEqual([[0, 2]]);
    const provider = new CardRowProvider();
    const result = await produceScenes(provider, {
      transcript,
      outputDuration: map.outputDuration,
      script: { aligned, clips: [], ...(times ? { wordTimes: times } : {}) },
    });
    return { result, provider, assembled: assembleScenes(result.scenes, transcript, map) };
  };

  it("a three-item CardRow over a 2.3 s line keeps its item times and gains a longer end", async () => {
    const short = await plan();
    const long = await plan(wordTimes);
    const [s] = short.result.scenes;
    const [l] = long.result.scenes;
    expect(s!.anchor).toEqual({ startWord: 0, endWord: 2 });
    expect(l!.anchor).toEqual({ startWord: 0, endWord: 6 });
    // The plan-time cue is matched on the line's own words, so the entry
    // word and the items' words are the same plan either way.
    expect(l!.cue).toEqual(s!.cue);
    expect(s!.cue!.itemWords).toEqual([0, 1, 2]);
    // The props call saw the same slice: the copy is the line's, not the
    // words the scene was held over.
    expect(long.provider.asked.at(-1)).toBe(short.provider.asked.at(-1));

    const [sc] = short.assembled.cues;
    const [lc] = long.assembled.cues;
    expect(lc!.reveal).toEqual(sc!.reveal);
    expect(lc!.reveal!.itemAtSec).toHaveLength(3);
    expect(lc!.startSec).toBe(sc!.startSec);
    expect(sc!.endSec).toBeCloseTo(2.3);
    expect(lc!.endSec).toBeCloseTo(3.8);
    // The moment the cache and --sfx read follows its scene.
    expect(long.result.beatSheet.moments[0]).toMatchObject({ startWord: 0, endWord: 6 });
  });

  it("EGM: a 3.68 s line whose graphic enters 1.97 s in is held to entry - lead + 4 s, not left at 2.0 s", async () => {
    const egm: Transcript = {
      language: "en",
      words: [
        ..."my test case is a".split(" ").map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 })),
        { text: "ninety", start: 1.97, end: 2.2 },
        ..."second clip of my open editor"
          .split(" ")
          .map((text, i) => ({ text, start: 2.25 + i * 0.25, end: i === 5 ? 3.68 : 2.45 + i * 0.25 })),
        ..."and it cuts the bloopers out for me today"
          .split(" ")
          .map((text, j) => ({ text, start: 3.75 + 0.35 * j, end: 4.05 + 0.35 * j })),
      ],
    };
    const egmMap = new TimeMap([{ srcIn: 0, srcOut: 8, kind: "keep" }]);
    const cues = parseScript("🎬 [StatCard] the clip\n🗣️ My test case is a ninety second clip of my open editor");
    const { aligned } = alignCues(cues, egm);
    expect(aligned.map((a) => [a.startWord, a.endWord])).toEqual([[0, 11]]);
    const provider = new StubProvider((n) =>
      n === 0
        ? { cues: [{ id: cues[0]!.id, sceneKind: "StatCard", onScreenCopy: "NINETY" }] }
        : // The value is said on word 5; the label is not said at all.
          { label: "Zebra crossings", value: "ninety" },
    );
    const planOnce = async (times?: readonly WordOutputTime[]) => {
      const result = await produceScenes(provider, {
        transcript: egm,
        outputDuration: egmMap.outputDuration,
        script: { aligned, clips: [], ...(times ? { wordTimes: times } : {}) },
      });
      return { result, cue: assembleScenes(result.scenes, egm, egmMap).cues[0]! };
    };
    const before = await planOnce();
    expect(before.result.scenes[0]!.cue!.entryWord).toBe(5);
    expect(before.cue.startSec).toBeCloseTo(1.67);
    expect(before.cue.endSec - before.cue.startSec).toBeCloseTo(2.01);

    const after = await planOnce(egm.words.map((w) => egmMap.mapWord(w)));
    // Until 1.67 + 4 = 5.67 s: "out" ends 5.45 s, "for" 5.80 s.
    expect(after.result.scenes[0]!.anchor).toEqual({ startWord: 0, endWord: 16 });
    expect(after.cue.startSec).toBeCloseTo(1.67);
    expect(after.cue.endSec).toBeCloseTo(5.45);
  });

  it("a card spoken while the clip before it still plays is held from the clip's end (EGM plan-only run)", async () => {
    const words: Transcript = {
      language: "en",
      words: Array.from({ length: 30 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })),
    };
    const clipMap = new TimeMap([{ srcIn: 0, srcOut: 60, kind: "keep" }]);
    const cues = parseScript("🎬 clip: clips/a.mov\n🗣️ w0 w1\n🎬 [TitleCard] the card\n🗣️ w2 w3 w4 w5");
    const { aligned } = alignCues(cues, words);
    const provider = new StubProvider((n) =>
      n === 0 ? { cues: [{ id: cues[1]!.id, sceneKind: "TitleCard", onScreenCopy: "CARD" }] } : { title: "Zebra" },
    );
    const result = await produceScenes(provider, {
      transcript: words,
      outputDuration: clipMap.outputDuration,
      script: {
        aligned,
        clips: [{ cueId: cues[0]!.id, src: "clips/0123456789ab.webm", durationSec: 5.2 }],
        wordTimes: words.words.map((w) => clipMap.mapWord(w)),
      },
    });
    const card = result.scenes.find((sc) => sc.component === "TitleCard")!;
    // The clip plays 0-5.2 s, so the card starts 5.25 s and runs to 9.25 s.
    expect(card.anchor).toEqual({ startWord: 2, endWord: 17 });
    const cue = assembleScenes(result.scenes, words, clipMap).cues.find((c) => c.component === "TitleCard")!;
    expect(cue.startSec).toBeCloseTo(5.25);
    expect(cue.endSec).toBeCloseTo(8.9);
  });

  it("without word times nothing is lengthened (the minimum needs the output clock)", async () => {
    const { result } = await plan();
    expect(result.beatSheet.moments[0]).toMatchObject({ startWord: 0, endWord: 2 });
  });

  it("a footage cue and a clip cue keep their spans", async () => {
    const script =
      "🎬 Screen recording: the editor\n🗣️ Brainstorm. Draft.\n" +
      "🎬 clip: clips/a.mov\n🗣️ Review.";
    const cues = parseScript(script);
    const { aligned } = alignCues(cues, transcript);
    expect(aligned.map((a) => [a.startWord, a.endWord])).toEqual([[0, 1], [2, 2]]);
    const provider = new StubProvider(() => ({
      cues: [{ id: cues[0]!.id, sceneKind: "none", onScreenCopy: "" }],
    }));
    const result = await produceScenes(provider, {
      transcript,
      outputDuration: map.outputDuration,
      script: {
        aligned,
        clips: [{ cueId: cues[1]!.id, src: "clips/0123456789ab.webm", durationSec: 1.5 }],
        wordTimes,
      },
    });
    expect(result.beatSheet.moments.map((m) => [m.startWord, m.endWord])).toEqual([[0, 1], [2, 2]]);
    expect(result.scenes.map((s) => [s.component, s.anchor.endWord])).toEqual([["ClipScene", 2]]);
  });
});
