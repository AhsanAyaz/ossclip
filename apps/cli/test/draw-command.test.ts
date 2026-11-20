import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod/v4";
import {
  DRAW_EXAMPLE_CHARACTER,
  DRAW_EXAMPLE_KIT,
  MockProvider,
  defaultTheme,
  type DrawIssue,
  type LlmProvider,
  type LlmUsage,
  type ShotHistory,
} from "@ossclip/core";
import type { DrawnRenderProps } from "@ossclip/renderer";
import { DRAW_KIT_EXPORTS } from "@ossclip/scenes/draw/reference";
import {
  DRAW_BLANK_MESSAGE,
  DRAW_RENDER_MESSAGE_MAX,
  DrawSetupError,
  buildDrawCheck,
} from "../src/draw/checks";
import {
  DRAW_STILL_TIMEOUT_MS,
  attemptLine,
  costLine,
  drawProjectFrom,
  stageTimesLine,
  parseDrawFlags,
  runDraw,
  type DrawArgs,
  type DrawDeps,
} from "../src/draw/draw-command";
import { SHOT_HISTORY_BASENAME, loadShot, shotDir, versionPaths } from "../src/draw/shot-store";

/**
 * `ossclip draw` (plan Task 7; §167) with the LLM, the type check, the
 * bundle, the browser and ffmpeg faked. The shot's own files are real, in a
 * temp workdir, because what the command leaves on disk (design §9) is most
 * of what it does.
 */

// ---- The fake world ----------------------------------------------------------

/** Code that passes the static check (the mock's own example). */
const GOOD = DRAW_EXAMPLE_CHARACTER;
/** Code the static check rejects on line 2: `fetch`. */
const BAD_STATIC = `export default function Scene() {\n  fetch("x");\n  return null;\n}\n`;

type Reply = { code: string; said: string } | Error;

/** A provider that answers from a script, records every request, and counts usage like a real one. */
class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly usage: LlmUsage[] = [];
  readonly requests: { system: string; user: string }[] = [];
  constructor(private readonly replies: Reply[]) {}
  async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
    this.requests.push({ system: req.system, user: req.user });
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("scripted provider: out of replies");
    if (reply instanceof Error) throw reply;
    this.usage.push({ provider: this.name, model: "script-1", schemaName: req.schemaName, inputTokens: 1, outputTokens: 1, exact: false, billed: false });
    return req.schema.parse(reply);
  }
}

interface World {
  deps: DrawDeps;
  logs: string[];
  calls: { provider: number; typecheck: string[]; bundle: string[]; stills: { outDir: string; props: DrawnRenderProps; timeoutMs: number }[]; preview: string[]; probe: string[]; fonts: number };
  /** The provider handed out next (created lazily so a test can see whether one was asked for at all). */
  provider: () => LlmProvider;
  typeIssues: () => DrawIssue[];
  blank: boolean;
  renderError: Error | null;
  typecheckThrows: Error | null;
  bundles: string[];
  renderDirs: string[];
}

function makeWorld(work: string): World {
  let clock = 0;
  const w: World = {
    logs: [],
    calls: { provider: 0, typecheck: [], bundle: [], stills: [], preview: [], probe: [], fonts: 0 },
    provider: () => new MockProvider(),
    typeIssues: () => [],
    blank: false,
    renderError: null,
    typecheckThrows: null,
    bundles: [],
    renderDirs: [],
    deps: undefined as unknown as DrawDeps,
  };
  w.deps = {
    readTextFile: (p) => readFileSync(p, "utf8"),
    createProvider: () => {
      w.calls.provider += 1;
      return w.provider();
    },
    defaultProvider: () => "mock",
    typecheck: (p) => {
      w.calls.typecheck.push(p);
      if (w.typecheckThrows) throw w.typecheckThrows;
      return w.typeIssues();
    },
    bundle: async (a) => {
      w.calls.bundle.push(a.scenePath);
      // The caller's contract (renderer drawn/render.ts): a render dir, never the workdir.
      expect(a.publicDir.startsWith(work)).toBe(false);
      const dir = mkdtempSync(join(tmpdir(), "ossclip-draw-test-bundle-"));
      w.bundles.push(dir);
      return dir;
    },
    renderStills: async (a) => {
      w.calls.stills.push({ outDir: a.outDir, props: a.props, timeoutMs: a.timeoutMs });
      if (w.renderError) throw w.renderError;
      mkdirSync(a.outDir, { recursive: true });
      return [1, 2, 3].map((i) => {
        const p = join(a.outDir, `still-${i}.png`);
        writeFileSync(p, "png");
        return p;
      });
    },
    renderPreview: async (a) => {
      w.calls.preview.push(a.outPath);
      writeFileSync(a.outPath, "webm");
    },
    isBlank: async () => w.blank,
    probeImageSize: async (p) => {
      w.calls.probe.push(p);
      return { width: 400, height: 200 };
    },
    stageFonts: () => {
      w.calls.fonts += 1;
    },
    makeRenderDir: () => {
      const dir = mkdtempSync(join(tmpdir(), "ossclip-draw-test-public-"));
      w.renderDirs.push(dir);
      return dir;
    },
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    now: () => (clock += 250),
    log: (line) => w.logs.push(line),
  };
  return w;
}

let work: string;
let world: World;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-draw-command-"));
  writeFileSync(
    join(work, "production.json"),
    JSON.stringify({ render: { width: 1080, height: 1920, fps: 30 }, theme: { ...defaultTheme, accent: "#ff00aa" } }),
  );
  world = makeWorld(work);
});
afterEach(() => {
  // Every bundle and render dir the run made is gone again.
  for (const d of [...world.bundles, ...world.renderDirs]) expect(existsSync(d), d).toBe(false);
  rmSync(work, { recursive: true, force: true });
});

const idea = (over: Partial<Extract<DrawArgs["mode"], { kind: "idea" }>> = {}): DrawArgs => ({
  workdir: work,
  shot: "probe",
  mode: { kind: "idea", idea: "a goldfish swims in and says hello", spokenLine: "and here is the goldfish", durationSec: 4, ...over },
  llm: "mock",
});
const note = (text: string): DrawArgs => ({ workdir: work, shot: "probe", mode: { kind: "note", text }, llm: "mock" });
const preview = (): DrawArgs => ({ workdir: work, shot: "probe", mode: { kind: "preview" } });

/** What is on disk, read the way the next run reads it. */
const onDisk = (): ShotHistory | null => loadShot(work, "probe");
const rawRecord = (): ShotHistory => JSON.parse(readFileSync(join(shotDir(work, "probe"), SHOT_HISTORY_BASENAME), "utf8"));

// ---- The flags -----------------------------------------------------------------

describe("parseDrawFlags", () => {
  it("defaults the duration to 4 and the line to empty", () => {
    expect(parseDrawFlags({ shot: "probe", idea: "a fish" })).toEqual({
      shot: "probe",
      mode: { kind: "idea", idea: "a fish", spokenLine: "", durationSec: 4 },
    });
  });

  it.each(["1", "16", "4x", "", "1e1", "-3"])("rejects --duration %j", (duration) => {
    expect(() => parseDrawFlags({ shot: "probe", idea: "a fish", duration })).toThrow(/--duration wants seconds from 2 to 15/);
  });

  it("accepts --duration 2, 7.5 and 15", () => {
    for (const [d, n] of [["2", 2], ["7.5", 7.5], ["15", 15]] as const) {
      const out = parseDrawFlags({ shot: "probe", idea: "a fish", duration: d });
      expect(out.mode.kind === "idea" && out.mode.durationSec).toBe(n);
    }
  });

  it.each(["../x", "a/b", "Probe", ""])("rejects --shot %j (Review Focus 4)", (shot) => {
    expect(() => parseDrawFlags({ shot, idea: "a fish" })).toThrow(/--shot wants/);
  });

  it("requires --shot and exactly one of --idea, --note, --preview", () => {
    expect(() => parseDrawFlags({ idea: "x" })).toThrow(/--shot <id> is required/);
    expect(() => parseDrawFlags({ shot: "probe" })).toThrow(/say what to do/);
    expect(() => parseDrawFlags({ shot: "probe", idea: "x", note: "y" })).toThrow(/not --idea and --note/);
    expect(() => parseDrawFlags({ shot: "probe", note: "y", preview: true })).toThrow(/not --note and --preview/);
  });

  it("refuses the idea's own flags beside --note and --preview", () => {
    expect(() => parseDrawFlags({ shot: "probe", note: "y", duration: "6" })).toThrow(/--duration goes with --idea only/);
    expect(() => parseDrawFlags({ shot: "probe", note: "y", line: "z" })).toThrow(/--line goes with --idea only/);
    expect(() => parseDrawFlags({ shot: "probe", preview: true, assets: "./a" })).toThrow(/--assets goes with --idea only/);
    expect(() => parseDrawFlags({ shot: "probe", preview: true, llm: "mock" })).toThrow(/--preview makes no LLM call/);
  });

  it("parses --llm, never coerces it", () => {
    expect(parseDrawFlags({ shot: "probe", note: "y", llm: "gemini", llmModel: "g-1" })).toMatchObject({ llm: "gemini", llmModel: "g-1" });
    expect(() => parseDrawFlags({ shot: "probe", note: "y", llm: "gemni" })).toThrow(/--llm wants one of/);
  });

  it("resolves --assets to an absolute path", () => {
    const out = parseDrawFlags({ shot: "probe", idea: "x", assets: "rel/assets" });
    expect(out.mode.kind === "idea" && out.mode.assetsDir).toMatch(/^\/.*rel\/assets$/);
  });
});

describe("pure pieces", () => {
  it("attemptLine", () => {
    expect(attemptLine(2, { issues: [{ line: 14, rule: "type", message: "m" }] })).toBe("attempt 2: 1 issue (type, line 14)");
    expect(attemptLine(1, { issues: [], error: "reply cut off at the token limit\nmore" })).toBe(
      "attempt 1: provider error: reply cut off at the token limit",
    );
    expect(attemptLine(3, { issues: [] })).toBe("attempt 3: ok");
    const four = [1, 2, 3, 4].map((line) => ({ line, rule: "name" as const, message: "m" }));
    expect(attemptLine(1, { issues: four })).toBe("attempt 1: 4 issues (name, line 1; name, line 2; name, line 3; …)");
  });

  it("stageTimesLine", () => {
    expect(stageTimesLine([{ name: "type check", ms: 1_240 }, { name: "bundle", ms: 3_060 }])).toBe("  type check 1.2 s · bundle 3.1 s");
  });

  it("costLine", () => {
    expect(costLine(2, { total: 41_300, draw: 30_100, checks: 9_800 })).toBe("calls 2 · 41.3 s (draw 30.1 s, checks 9.8 s)");
  });

  it("drawProjectFrom reads the frame and theme, with produce's default theme when there is none", () => {
    expect(drawProjectFrom({ render: { width: 1920, height: 1080, fps: 25 } }, "p")).toEqual({
      width: 1920,
      height: 1080,
      fps: 25,
      theme: defaultTheme,
    });
    expect(() => drawProjectFrom({ render: { width: "wide" } }, "p")).toThrow(/p is not valid/);
  });
});

// ---- The check ---------------------------------------------------------------

describe("buildDrawCheck: the stages run in order and stop at the first that reports", () => {
  function stages(over: Partial<Parameters<typeof buildDrawCheck>[0]> = {}) {
    const seen: string[] = [];
    const check = buildDrawCheck({
      kitExports: DRAW_KIT_EXPORTS,
      scenePathFor: () => {
        seen.push("write");
        return "/w/v1.tsx";
      },
      typecheck: () => {
        seen.push("type");
        return [];
      },
      renderStills: async () => {
        seen.push("stills");
        return ["/w/v1/still-1.png", "/w/v1/still-2.png", "/w/v1/still-3.png"];
      },
      isBlank: async () => {
        seen.push("blank");
        return false;
      },
      ...over,
    });
    return { check, seen };
  }

  it("passes good code through every stage", async () => {
    const { check, seen } = stages();
    expect(await check(GOOD)).toEqual([]);
    expect(seen).toEqual(["write", "type", "stills", "blank", "blank", "blank"]);
  });

  it("a static issue: the code is not written, the type check and the render are not called", async () => {
    const { check, seen } = stages();
    const issues = await check(BAD_STATIC);
    expect(issues.map((i) => [i.rule, i.line])).toEqual([["name", 2]]);
    expect(seen).toEqual([]);
  });

  it("a type issue: the render is not called", async () => {
    const { check, seen } = stages({
      typecheck: () => {
        seen.push("type");
        return [{ line: 14, rule: "type", message: "Property 'titel' does not exist (TS2322)" }];
      },
    });
    expect((await check(GOOD)).map((i) => i.rule)).toEqual(["type"]);
    expect(seen).toEqual(["write", "type"]);
  });

  it("a render that rejects is one render issue on line 1, its message capped", async () => {
    const { check, seen } = stages({
      renderStills: async () => {
        throw new Error(`drawn scene: the still at frame 30 did not finish within 30000 ms ${"x".repeat(2000)}`);
      },
    });
    const issues = await check(GOOD);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 1, rule: "render" });
    expect(issues[0]!.message.length).toBe(DRAW_RENDER_MESSAGE_MAX);
    expect(issues[0]!.message).toMatch(/^drawn scene: the still at frame 30/);
    expect(seen).toEqual(["write", "type"]);
  });

  it("three blank stills are one issue: every frame is fully transparent", async () => {
    const { check } = stages({ isBlank: async () => true });
    expect(await check(GOOD)).toEqual([{ line: 1, rule: "render", message: DRAW_BLANK_MESSAGE }]);
    expect(DRAW_BLANK_MESSAGE).toMatch(/^every frame is fully transparent/);
  });

  it("one painted still of three passes", async () => {
    let n = 0;
    const { check } = stages({ isBlank: async () => ++n !== 2 });
    expect(await check(GOOD)).toEqual([]);
  });

  it("an installation fault propagates: a type check that throws, a bundle that fails", async () => {
    const broken = stages({
      typecheck: () => {
        throw new Error("drawn-scene type check: the ossclip install is incomplete");
      },
    });
    await expect(broken.check(GOOD)).rejects.toThrow(/install is incomplete/);
    const unbundled = stages({
      renderStills: async () => {
        throw new DrawSetupError("drawn-scene bundle failed: webpack");
      },
    });
    await expect(unbundled.check(GOOD)).rejects.toBeInstanceOf(DrawSetupError);
  });
});

// ---- The command ---------------------------------------------------------------

describe("runDraw --idea", () => {
  it("a first draw writes v1.tsx, three stills and a history with one ok version, draft 1 and one run", async () => {
    const result = await runDraw(idea(), world.deps);

    const v1 = versionPaths(work, "probe", 1);
    expect(result).toMatchObject({ ok: true, version: 1, calls: 1, stills: [1, 2, 3].map((i) => join(v1.stillsDir, `still-${i}.png`)) });
    expect(readFileSync(v1.code, "utf8")).toBe(GOOD);
    expect(readdirSync(v1.stillsDir).sort()).toEqual(["still-1.png", "still-2.png", "still-3.png"]);

    const h = onDisk()!;
    expect(h).toMatchObject({
      id: "probe",
      idea: "a goldfish swims in and says hello",
      spokenLine: "and here is the goldfish",
      durationSec: 4,
      draft: 1,
      nextVersion: 2,
      notes: [],
    });
    expect(h.versions).toEqual([{ n: 1, result: "ok", kitVersion: 1, promptVersion: 1, said: expect.stringContaining("goldfish") }]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ version: 1, provider: "mock", calls: 1 });
    // The record round-trips: what is on disk is what the next load returns.
    expect(rawRecord()).toEqual(h);

    // The stills were rendered for the project's frame and theme, with the 30 s limit.
    expect(world.calls.stills[0]).toMatchObject({
      timeoutMs: DRAW_STILL_TIMEOUT_MS,
      props: { durationSec: 4, width: 1080, height: 1920, fps: 30, assets: {} },
    });
    expect(world.calls.stills[0]!.props.theme.accent).toBe("#ff00aa");
    expect(world.calls.fonts).toBe(1);

    expect(world.logs).toContain("attempt 1: ok");
    // Each check stage's time, under its attempt (the gate records them, §167).
    expect(world.logs[world.logs.indexOf("attempt 1: ok") + 1]).toMatch(/^  type check \d+\.\d s · bundle \d+\.\d s · stills \d+\.\d s$/);
    for (const s of result.stills) expect(world.logs).toContain(`  ${s}`);
    expect(world.logs[world.logs.length - 1]).toMatch(/^calls 1 · \d+\.\d s \(draw \d+\.\d s, checks \d+\.\d s\)$/);
  });

  it("stages the assets, tells the LLM about them and hands their paths to the render", async () => {
    const assets = mkdtempSync(join(tmpdir(), "ossclip-draw-assets-"));
    try {
      writeFileSync(join(assets, "logo.png"), "png");
      writeFileSync(join(assets, "assets.md"), "logo.png: the EGM logo\n");
      const provider = new ScriptedProvider([{ code: GOOD, said: "fish" }]);
      world.provider = () => provider;
      await runDraw(idea({ assetsDir: assets }), world.deps);
      expect(provider.requests[0]!.user).toContain("logo.png");
      expect(world.calls.stills[0]!.props.assets).toEqual({ "logo.png": "storyboard-assets/logo.png" });
      expect(onDisk()!.assetsDir).toBe(assets);
      expect(onDisk()!.runs[0]).toMatchObject({ provider: "mock", model: "script-1" });
    } finally {
      rmSync(assets, { recursive: true, force: true });
    }
  });

  it("refuses --idea on a shot that is already drawn, naming --note, before any call", async () => {
    await runDraw(idea(), world.deps);
    const before = rawRecord();
    world.calls.provider = 0;
    await expect(runDraw(idea({ idea: "something else" }), world.deps)).rejects.toThrow(/--note/);
    expect(world.calls.provider).toBe(0);
    expect(rawRecord()).toEqual(before);
  });

  it("a draw that fails three times: a failed version, draft unchanged, ok false, no throw", async () => {
    const provider = new ScriptedProvider([
      { code: BAD_STATIC, said: "a" },
      { code: BAD_STATIC, said: "b" },
      { code: BAD_STATIC.replace("fetch", "eval"), said: "c" },
    ]);
    world.provider = () => provider;
    const result = await runDraw(idea(), world.deps);

    expect(result).toMatchObject({ ok: false, version: 1, stills: [], calls: 3 });
    const h = onDisk()!;
    expect(h.draft).toBeNull();
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0]!.result).toEqual({ failed: expect.stringContaining("line 2 [name]") });
    expect(JSON.stringify(h.versions[0]!.result)).toContain("eval");
    expect(h.runs).toEqual([{ version: 1, provider: "mock", model: "script-1", calls: 3, seconds: expect.any(Number) }]);
    // The failed version keeps its LAST code, even though no attempt reached the file.
    expect(readFileSync(versionPaths(work, "probe", 1).code, "utf8")).toContain("eval");
    expect(world.calls.typecheck).toEqual([]);
    expect(world.logs.filter((l) => l.startsWith("attempt "))).toEqual([
      "attempt 1: 1 issue (name, line 2)",
      "attempt 2: 1 issue (name, line 2)",
      "attempt 3: 1 issue (name, line 2)",
    ]);
    expect(world.logs.some((l) => l.includes("line 2 [name]") && l.includes("eval"))).toBe(true);
    expect(rawRecord()).toEqual(h);
  });

  it("three blank renders fail the version with the transparent-frames issue", async () => {
    world.blank = true;
    const result = await runDraw(idea(), world.deps);
    expect(result.ok).toBe(false);
    expect(onDisk()!.versions[0]!.result).toEqual({ failed: expect.stringContaining("every frame is fully transparent") });
    // The stills of a failed version are not kept beside its code.
    expect(existsSync(versionPaths(work, "probe", 1).stillsDir)).toBe(false);
  });

  it("a render that times out every attempt fails the version and the command returns normally (Review Focus 2)", async () => {
    world.renderError = new Error("drawn scene: the still at frame 30 did not finish within 30000 ms");
    const result = await runDraw(idea(), world.deps);
    expect(result.ok).toBe(false);
    expect(onDisk()!.versions[0]!.result).toEqual({ failed: expect.stringContaining("[render] drawn scene: the still at frame 30") });
  });

  it("a provider that throws every time: failed with its error, no code file", async () => {
    const provider = new ScriptedProvider([new Error("cut off"), new Error("cut off"), new Error("timed out after 90 s")]);
    world.provider = () => provider;
    const result = await runDraw(idea(), world.deps);
    expect(result).toMatchObject({ ok: false, calls: 3 });
    expect(onDisk()!.versions[0]!.result).toEqual({ failed: "provider error: timed out after 90 s" });
    expect(existsSync(versionPaths(work, "probe", 1).code)).toBe(false);
    expect(world.logs).toContain("attempt 3: provider error: timed out after 90 s");
  });

  it("a shot whose every version failed is drawn again from --idea, under a new number", async () => {
    world.provider = () => new ScriptedProvider([new Error("x"), new Error("x"), new Error("x")]);
    await runDraw(idea(), world.deps);
    world.provider = () => new MockProvider();
    const result = await runDraw(idea({ durationSec: 6 }), world.deps);
    expect(result).toMatchObject({ ok: true, version: 2 });
    const h = onDisk()!;
    expect(h).toMatchObject({ draft: 2, nextVersion: 3, durationSec: 6 });
    expect(h.versions.map((v) => [v.n, v.result === "ok"])).toEqual([[1, false], [2, true]]);
    expect(h.runs.map((r) => r.version)).toEqual([1, 2]);
  });

  it("an installation fault propagates; the version is left unfinished and discarded on the next load, its number spent", async () => {
    world.typecheckThrows = new Error("drawn-scene type check: the ossclip install is incomplete");
    await expect(runDraw(idea(), world.deps)).rejects.toThrow(/install is incomplete/);
    // On disk: the version, with no result (an interrupted run looks the same).
    expect(rawRecord().versions).toEqual([{ n: 1, kitVersion: 1, promptVersion: 1 }]);
    expect(existsSync(versionPaths(work, "probe", 1).code)).toBe(true);

    const h = onDisk()!;
    expect(h.versions).toEqual([]);
    expect(h.nextVersion).toBe(2);
    expect(existsSync(versionPaths(work, "probe", 1).code)).toBe(false);

    world.typecheckThrows = null;
    expect((await runDraw(idea(), world.deps)).version).toBe(2);
  });

  it("rejects a shot id with path characters before any call (Review Focus 4)", async () => {
    await expect(runDraw({ ...idea(), shot: "../x" }, world.deps)).rejects.toThrow(/shot id/);
    expect(world.calls.provider).toBe(0);
    expect(existsSync(join(work, "storyboard"))).toBe(false);
  });

  it("refuses a workdir with no production.json", async () => {
    rmSync(join(work, "production.json"));
    await expect(runDraw(idea(), world.deps)).rejects.toThrow(/no production\.json/);
  });
});

describe("runDraw --note", () => {
  it("writes v2.tsx, keeps v1.tsx, records the note on version 1 and sets draft 2", async () => {
    await runDraw(idea(), world.deps);
    const provider = new ScriptedProvider([{ code: DRAW_EXAMPLE_KIT, said: "cards instead" }]);
    world.provider = () => provider;
    const result = await runDraw(note("make the fish orange"), world.deps);

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(readFileSync(versionPaths(work, "probe", 1).code, "utf8")).toBe(GOOD);
    expect(readFileSync(versionPaths(work, "probe", 2).code, "utf8")).toBe(DRAW_EXAMPLE_KIT);
    const h = onDisk()!;
    expect(h).toMatchObject({ draft: 2, nextVersion: 3, notes: [{ onVersion: 1, text: "make the fish orange" }] });
    expect(h.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(h.runs.map((r) => [r.version, r.provider])).toEqual([[1, "mock"], [2, "mock"]]);
    // The redraw sends the draft's code, the idea and the note; the stored duration is reused.
    expect(provider.requests[0]!.user).toContain("make the fish orange");
    expect(provider.requests[0]!.user).toContain(GOOD.split("\n")[0]);
    expect(world.calls.stills[1]!.props.durationSec).toBe(4);
    expect(rawRecord()).toEqual(h);
  });

  it("a second note sends the first as an earlier note", async () => {
    await runDraw(idea(), world.deps);
    await runDraw(note("bigger fish"), world.deps);
    const provider = new ScriptedProvider([{ code: GOOD, said: "slower" }]);
    world.provider = () => provider;
    await runDraw(note("slower swim"), world.deps);
    const user = provider.requests[0]!.user;
    expect(user.indexOf("bigger fish")).toBeGreaterThan(-1);
    expect(user.indexOf("slower swim")).toBeGreaterThan(user.indexOf("bigger fish"));
    expect(onDisk()!.notes).toEqual([
      { onVersion: 1, text: "bigger fish" },
      { onVersion: 2, text: "slower swim" },
    ]);
  });

  it("a failed redraw leaves the draft where it was and records no note", async () => {
    await runDraw(idea(), world.deps);
    world.provider = () => new ScriptedProvider([{ code: BAD_STATIC, said: "a" }, { code: BAD_STATIC, said: "b" }, { code: BAD_STATIC, said: "c" }]);
    const result = await runDraw(note("add a hat"), world.deps);
    expect(result).toMatchObject({ ok: false, version: 2 });
    const h = onDisk()!;
    expect(h).toMatchObject({ draft: 1, nextVersion: 3, notes: [] });
    expect(h.versions[1]!.result).toEqual({ failed: expect.stringContaining("[name]") });
    expect(h.runs).toHaveLength(2);
    expect(rawRecord()).toEqual(h);
  });

  it("is refused on a shot never drawn, and on a shot with no ok version, before any call", async () => {
    await expect(runDraw(note("x"), world.deps)).rejects.toThrow(/has not been drawn yet/);
    world.provider = () => new ScriptedProvider([new Error("x"), new Error("x"), new Error("x")]);
    await runDraw(idea(), world.deps);
    world.calls.provider = 0;
    await expect(runDraw(note("x"), world.deps)).rejects.toThrow(/no version that passed its checks.*--idea/);
    expect(world.calls.provider).toBe(0);
  });

  it("stages the stored assets folder again, and fails clearly before any call when it is gone", async () => {
    const assets = mkdtempSync(join(tmpdir(), "ossclip-draw-assets-"));
    writeFileSync(join(assets, "logo.png"), "png");
    await runDraw(idea({ assetsDir: assets }), world.deps);
    expect(world.calls.probe).toHaveLength(1);
    await runDraw(note("logo bigger"), world.deps);
    expect(world.calls.probe).toHaveLength(2);
    expect(world.calls.stills[1]!.props.assets).toEqual({ "logo.png": "storyboard-assets/logo.png" });

    rmSync(assets, { recursive: true, force: true });
    world.calls.provider = 0;
    await expect(runDraw(note("again"), world.deps)).rejects.toThrow(/assets in .* no longer exists/);
    expect(world.calls.provider).toBe(0);
    expect(onDisk()!.nextVersion).toBe(3);
  });
});

describe("runDraw --preview", () => {
  it("renders the draft's preview.webm, makes no LLM call and leaves the record as it was", async () => {
    await runDraw(idea(), world.deps);
    const before = rawRecord();
    world.calls.provider = 0;
    const result = await runDraw(preview(), world.deps);
    const v1 = versionPaths(work, "probe", 1);
    expect(result).toMatchObject({ ok: true, version: 1, calls: 0 });
    expect(world.calls.preview).toEqual([v1.preview]);
    expect(existsSync(v1.preview)).toBe(true);
    expect(world.calls.provider).toBe(0);
    expect(world.calls.bundle[world.calls.bundle.length - 1]).toBe(v1.code);
    expect(world.logs).toContain(`  ${v1.preview}`);
    expect(rawRecord()).toEqual(before);
  });

  it("is refused with no draft", async () => {
    await expect(runDraw(preview(), world.deps)).rejects.toThrow(/no draft to preview/);
    world.provider = () => new ScriptedProvider([new Error("x"), new Error("x"), new Error("x")]);
    await runDraw(idea(), world.deps);
    await expect(runDraw(preview(), world.deps)).rejects.toThrow(/no draft to preview/);
    expect(world.calls.preview).toEqual([]);
  });
});
