import { describe, expect, it } from "vitest";
import { toJSONSchema, type z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import { BeatSheetSchema, normalizeBeatSheet } from "../src/producer/beats";
import { produceScenes } from "../src/producer/index";
import {
  MAX_SCRIPT_CUES,
  ScriptPlanError,
  planScriptMoments,
  type ScriptPlanInput,
} from "../src/producer/script-plan";
import { parseScript, type ScriptCue, type ScriptCueHint } from "../src/script/cues";
import { alignCues, type AlignedCue } from "../src/script/align";
import type { Transcript } from "../src/schema";

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
