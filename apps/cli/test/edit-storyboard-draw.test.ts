import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAW_EXAMPLE_CHARACTER, defaultTheme, type LlmProvider, type LlmUsage, type ShotApproval } from "@ossclip/core";
import { startEditServer } from "../src/edit";
import { runDraw, type DrawDeps } from "../src/draw/draw-command";
import type { ApproveArgs } from "../src/storyboard/approve";

/**
 * The editor server's storyboard jobs (plan B2a Task 4; §169): draw,
 * redraw, preview and approve through HTTP. The LLM is `makeLlmProvider`'s;
 * the draw is the real `runDraw` with the bundler, browser and type check
 * faked, and the approve is a fake, so no browser and no render start. The
 * sync run an approval starts is the recorded command, a node script that
 * prints its argv (the `/api/render` tests' fixture).
 */

let close: (() => void) | undefined;
afterEach(() => close?.());

const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");

// 160 words, one every 0.4 s, on a render that kept the whole 64 s take.
const WORDS = Array.from({ length: 160 }, (_, i) => ({ text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
const shot = (over: Record<string, unknown> & { id: string; startWord: number; endWord: number }) => ({
  idea: `the idea of ${over.id}`,
  why: "",
  priority: 2,
  assets: [],
  kept: true,
  origin: "planner",
  touched: false,
  ...over,
});
const STORYBOARD = {
  version: 1,
  nextShot: 4,
  shots: [
    shot({ id: "s1", startWord: 0, endWord: 9 }),
    shot({ id: "s2", startWord: 20, endWord: 34 }),
    shot({ id: "s3", startWord: 50, endWord: 64, kept: false, touched: true }),
  ],
};
/** s1 runs from word 0's start (0.0 s) to word 9's end (3.9 s) on the live clock. */
const S1_LENGTH = 3.9;
const APPROVAL: ShotApproval = { version: 1, durationSec: S1_LENGTH, clipKey: "key", clip: "storyboard/s1/approved.mov", src: "clips/s1.webm" };

async function storyboardWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-draw-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({
      videoFileName: "clip.mp4",
      sceneCues: [],
      captionLines: [],
      spans: [{ srcIn: 0, srcOut: 64, outIn: 0, outOut: 64 }],
      settings: { width: 1080, height: 1920, fps: 30 },
      outputDurationSec: 64,
      theme: { ...defaultTheme, accent: "#ff00aa" },
    }),
  );
  await writeFile(join(dir, "clip.mp4"), "not-a-real-video");
  await writeFile(join(dir, "transcript.json"), JSON.stringify({ language: "en", words: WORDS }));
  await writeFile(
    join(dir, "usage.json"),
    JSON.stringify({
      runs: [{ at: "2026-11-20T00:00:00.000Z", provider: "gemini", models: [], cached: false, records: [], totals: {} }],
      records: [],
      totals: {},
    }),
  );
  await writeFile(join(dir, "storyboard.json"), JSON.stringify(STORYBOARD, null, 2));
  return dir;
}

/** A recorded command that prints its argv, as `/api/render`'s tests record one. */
async function recordCommand(dir: string, args: string[], code = "console.log(JSON.stringify(process.argv.slice(2)))"): Promise<void> {
  await writeFile(join(dir, "recorded.cjs"), code);
  await writeFile(
    join(dir, "command.json"),
    JSON.stringify({ execPath: process.execPath, execArgv: [], script: join(dir, "recorded.cjs"), args, cwd: dir }),
  );
}

/** A shot drawn once: v1 ok and the draft, its code on disk. */
async function drawnShot(dir: string, id: string, over: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(dir, "storyboard", id), { recursive: true });
  await writeFile(join(dir, "storyboard", id, "v1.tsx"), DRAW_EXAMPLE_CHARACTER);
  await writeFile(
    join(dir, "storyboard", id, "history.json"),
    JSON.stringify({
      id,
      idea: `the idea of ${id}`,
      spokenLine: "",
      durationSec: 4,
      versions: [{ n: 1, result: "ok", kitVersion: 1, idea: `the idea of ${id}`, durationSec: 4 }],
      draft: 1,
      nextVersion: 2,
      notes: [],
      runs: [],
      ...over,
    }),
  );
}

/** The LLM: answers a scene that passes the static check, or what `answer` does; counts usage like a real one. */
function drawProvider(answer: () => Promise<unknown> = async () => ({ code: DRAW_EXAMPLE_CHARACTER, said: "a character" })) {
  const requests: string[] = [];
  const make = (): LlmProvider => {
    const usage: LlmUsage[] = [];
    return {
      name: "gemini",
      usage,
      async complete(req) {
        requests.push(req.user);
        const reply = await answer();
        usage.push({ provider: "gemini", model: "gemini-3.5-flash", schemaName: req.schemaName, inputTokens: 10, outputTokens: 10, exact: true, billed: true });
        return req.schema.parse(reply);
      },
    };
  };
  return { make, requests };
}

/** runDraw's deps with no browser, no bundler and no type check; the shot files are real. */
function fakeDrawDeps(): Omit<DrawDeps, "createProvider" | "log"> {
  return {
    readTextFile: (p) => readFileSync(p, "utf8"),
    defaultProvider: () => "mock",
    typecheck: () => [],
    bundle: async () => mkdtempSync(join(tmpdir(), "ossclip-edit-draw-bundle-")),
    renderStills: async (a) => {
      await mkdir(a.outDir, { recursive: true });
      return [1, 2, 3].map((i) => {
        const p = join(a.outDir, `still-${i}.png`);
        writeFileSync(p, "png");
        return p;
      });
    },
    renderPreview: async (a) => writeFileSync(a.outPath, "webm"),
    isBlank: async () => false,
    probeImageSize: async () => ({ width: 10, height: 10 }),
    stageFonts: () => {},
    makeRenderDir: () => mkdtempSync(join(tmpdir(), "ossclip-edit-draw-public-")),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    now: () => Date.now(),
  };
}

interface Started {
  url: string;
  drawArgs: Parameters<typeof runDraw>[0][];
  approveArgs: ApproveArgs[];
}

async function start(
  dir: string | undefined,
  o: { provider?: () => LlmProvider; approve?: (a: ApproveArgs) => Promise<ShotApproval> } = {},
): Promise<Started> {
  const drawArgs: Started["drawArgs"] = [];
  const approveArgs: ApproveArgs[] = [];
  const server = await startEditServer(dir, {
    port: 0,
    recentDir: SHARED_RECENTS,
    loadCfg: () => ({}),
    publishEnv: {},
    ...(o.provider ? { makeLlmProvider: o.provider as never } : {}),
    storyboardDraw: (args, env) => {
      drawArgs.push(args);
      return runDraw(args, { ...fakeDrawDeps(), createProvider: env.createProvider, log: env.log });
    },
    storyboardApprove: async (args) => {
      approveArgs.push(args);
      return (o.approve ?? (async () => APPROVAL))(args);
    },
  });
  close = server.close;
  return { url: server.url, drawArgs, approveArgs };
}

const post = (url: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

type JobState = { kind: string; shots: string[]; current: string | null; done: { id: string; ok: boolean; error?: string }[]; lines: string[]; calls: number; stopping: boolean };

/** Polls the job until it has ended, and returns the finished job. */
async function jobEnd(url: string): Promise<JobState> {
  for (let i = 0; i < 100; i++) {
    const s = (await (await fetch(`${url}/api/storyboard/job`)).json()) as { job: JobState | null; last: JobState | null };
    if (s.job === null && s.last !== null) return s.last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the storyboard job did not end");
}

/** Polls the render child until it has exited, and returns its output. */
async function renderEnd(url: string): Promise<{ exitCode: number | null; lines: string[] }> {
  let status = { running: true, exitCode: null as number | null, lines: [] as string[] };
  for (let i = 0; i < 50 && (status.running || status.exitCode === null); i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = await (await fetch(`${url}/api/render/status`)).json();
  }
  return status;
}
const argvOf = (lines: string[]): string[] => JSON.parse(lines.find((l) => l.startsWith("["))!) as string[];

const history = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, "storyboard", id, "history.json"), "utf8"));
const table = (dir: string) => JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8"));

/** A held provider: `started` resolves once the first call is in, `release` lets it answer. */
function heldProvider() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const p = drawProvider(async () => {
    started();
    await gate;
    return { code: DRAW_EXAMPLE_CHARACTER, said: "held" };
  });
  return { ...p, release, started: startedP };
}

describe("storyboard draw jobs (plan B2a Task 4; §169)", () => {
  it("draw on two shots: 202, both drafts set from the shot's idea, line and live length, one usage run appended", async () => {
    const dir = await storyboardWorkdir();
    const provider = drawProvider();
    const s = await start(dir, { provider: provider.make });
    const res = await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s2"] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const job = await jobEnd(s.url);
    expect(job).toMatchObject({ kind: "draw", shots: ["s1", "s2"], calls: 2, stopping: false });
    expect(job.done).toEqual([
      { id: "s1", ok: true },
      { id: "s2", ok: true },
    ]);
    expect(history(dir, "s1")).toMatchObject({ draft: 1, idea: "the idea of s1", spokenLine: "w0 w1 w2 w3 w4 w5 w6 w7 w8 w9", durationSec: S1_LENGTH });
    expect(history(dir, "s2").draft).toBe(1);
    // Drawn for the live theme (render-props.json's), at the frame of the composition.
    expect(s.drawArgs[0]!.project).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(s.drawArgs[0]!.project!.theme.accent).toBe("#ff00aa");
    expect(s.drawArgs[0]!.llm).toBe("gemini");
    const log = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
    expect(log.runs).toHaveLength(2);
    expect(log.runs[1].records.map((r: { schemaName: string }) => r.schemaName)).toEqual(["drawn_scene", "drawn_scene"]);

    // GET serves the shot view's detail and the finished job.
    const got = await (await fetch(`${s.url}/api/storyboard`)).json();
    expect(got.detail.s1).toMatchObject({ draft: 1, drawnIdea: "the idea of s1" });
    expect(got.detail.s1.versions[0].stills).toEqual([1, 2, 3].map((k) => `/media/storyboard/s1/v1/still-${k}.png`));
    expect(got.job).toMatchObject({ job: null, last: { kind: "draw" } });
    // The still is served from the workdir.
    expect((await fetch(`${s.url}${got.detail.s1.versions[0].stills[0]}`)).status).toBe(200);
  });

  it("while a job runs: a second draw, Plan again, Render and a project switch are 409; cancel sets stopping and no later shot starts", async () => {
    const dir = await storyboardWorkdir();
    await recordCommand(dir, ["produce", "./take.mp4"]);
    const held = heldProvider();
    const s = await start(dir, { provider: held.make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s2"] })).status).toBe(202);
    await held.started;

    const second = await post(s.url, "/api/storyboard/draw", { ids: ["s2"] });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("a storyboard job is running");
    expect((await post(s.url, "/api/storyboard/plan")).status).toBe(409);
    const render = await post(s.url, "/api/render");
    expect(render.status).toBe(409);
    expect((await render.json()).error).toBe("a storyboard job is running");
    const sw = await post(s.url, "/api/workdir", { path: dir });
    expect(sw.status).toBe(409);
    expect((await sw.json()).error).toBe("a storyboard job is running");
    expect((await post(s.url, "/api/storyboard/draft", { id: "s1", version: 1 })).status).toBe(409);

    const running = await (await fetch(`${s.url}/api/storyboard/job`)).json();
    expect(running.job).toMatchObject({ current: "s1", stopping: false });
    expect((await post(s.url, "/api/storyboard/cancel")).status).toBe(202);
    expect((await (await fetch(`${s.url}/api/storyboard/job`)).json()).job.stopping).toBe(true);
    held.release();
    const job = await jobEnd(s.url);
    expect(job.stopping).toBe(true);
    expect(job.done.map((d) => d.id)).toEqual(["s1"]);
    expect(existsSync(join(dir, "storyboard", "s2"))).toBe(false);
    expect((await post(s.url, "/api/storyboard/cancel")).status).toBe(409);
    // Render is open again once the job has ended.
    expect((await post(s.url, "/api/render")).status).toBe(202);
    await renderEnd(s.url);
  });

  it("while Plan again runs, the job routes are 409", async () => {
    const dir = await storyboardWorkdir();
    await drawnShot(dir, "s1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const provider = drawProvider(async () => {
      started();
      await gate;
      return { shots: [] };
    });
    const s = await start(dir, { provider: provider.make });
    const plan = post(s.url, "/api/storyboard/plan");
    await startedP;
    for (const [path, body] of [
      ["/api/storyboard/draw", { ids: ["s2"] }],
      ["/api/storyboard/note", { id: "s1", text: "bigger" }],
      ["/api/storyboard/preview", { id: "s1" }],
      ["/api/storyboard/approve", { id: "s1" }],
    ] as const) {
      const res = await post(s.url, path, body);
      expect(res.status, path).toBe(409);
      expect((await res.json()).error, path).toContain("Plan again is running");
    }
    release();
    expect((await (await plan).json()).ok).toBe(true);
  });

  it("a provider that throws: 202 on the POST, and the job ends with ok false for that shot and its error (never a 500)", async () => {
    const dir = await storyboardWorkdir();
    const provider = drawProvider(async () => {
      throw new Error("quota exceeded for gemini-3.5-flash");
    });
    const s = await start(dir, { provider: provider.make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s2"] })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job.done).toEqual([
      { id: "s1", ok: false, error: "provider error: quota exceeded for gemini-3.5-flash" },
      { id: "s2", ok: false, error: "provider error: quota exceeded for gemini-3.5-flash" },
    ]);
    expect(job.calls).toBe(6);
    expect(history(dir, "s1").draft).toBeNull();
  });

  it("a shot whose every word is cut is recorded as failed, and the next shot still draws", async () => {
    const dir = await storyboardWorkdir();
    // The author cut 0.0-3.95 s since the last render: every word of s1.
    await writeFile(join(dir, "overrides.json"), JSON.stringify({ cuts: [{ startSec: 0, endSec: 3.95, src: { startSec: 0, endSec: 3.95 } }] }));
    const s = await start(dir, { provider: drawProvider().make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s2"] })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job.done).toEqual([
      { id: "s1", ok: false, error: "every word of this shot is cut" },
      { id: "s2", ok: true },
    ]);
  });

  it("a drawn shot is skipped when its idea is unchanged, and drawn again as a first draft when it changed (Draw again)", async () => {
    const dir = await storyboardWorkdir();
    await drawnShot(dir, "s1");
    await drawnShot(dir, "s2", {
      idea: "an older idea",
      versions: [{ n: 1, result: "ok", kitVersion: 1, idea: "an older idea", durationSec: 4 }],
      notes: [{ onVersion: 1, text: "bigger" }],
    });
    const provider = drawProvider();
    const s = await start(dir, { provider: provider.make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s2"] })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job.done).toEqual([
      { id: "s1", ok: true },
      { id: "s2", ok: true },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toContain("the idea of s2");
    expect(history(dir, "s1").versions).toHaveLength(1);
    const s2 = history(dir, "s2");
    expect(s2).toMatchObject({ idea: "the idea of s2", draft: 2, notes: [{ onVersion: 1, text: "bigger" }] });
    expect(s2.versions.map((v: { n: number; idea: string }) => [v.n, v.idea])).toEqual([
      [1, "an older idea"],
      [2, "the idea of s2"],
    ]);
    const got = await (await fetch(`${s.url}/api/storyboard`)).json();
    expect(got.detail.s2.drawnIdea).toBe("the idea of s2");
  });

  it("Review Focus 2: an interrupted draw, seen by a fresh server, is not in detail, the job state is empty, and the shot draws", async () => {
    const dir = await storyboardWorkdir();
    await mkdir(join(dir, "storyboard", "s1"), { recursive: true });
    await writeFile(join(dir, "storyboard", "s1", "v1.tsx"), "half a scene");
    await writeFile(
      join(dir, "storyboard", "s1", "history.json"),
      JSON.stringify({
        id: "s1",
        idea: "the idea of s1",
        spokenLine: "",
        durationSec: 4,
        versions: [{ n: 1, kitVersion: 1 }],
        draft: null,
        nextVersion: 2,
        notes: [],
        runs: [],
      }),
    );
    const s = await start(dir, { provider: drawProvider().make });
    const got = await (await fetch(`${s.url}/api/storyboard`)).json();
    expect(got.detail.s1.versions).toEqual([]);
    expect(got.detail.s1.draft).toBeNull();
    expect(got.job).toEqual({ job: null, last: null });
    expect(await (await fetch(`${s.url}/api/storyboard/job`)).json()).toEqual({ job: null, last: null });

    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1"] })).status).toBe(202);
    expect((await jobEnd(s.url)).done).toEqual([{ id: "s1", ok: true }]);
    const h = history(dir, "s1");
    expect(h.versions.map((v: { n: number; result: unknown }) => [v.n, v.result])).toEqual([[2, "ok"]]);
    expect(h.draft).toBe(2);
  });

  it("draw: 400 for an id that is not a kept shot or a bad body, 409 with no storyboard, 412 for a missing input", async () => {
    const dir = await storyboardWorkdir();
    const s = await start(dir, { provider: drawProvider().make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s3"] })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s9"] })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draw", { ids: [] })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s1", "s1"] })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["../x"] })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draw", { ids: Array.from({ length: 41 }, (_, i) => `s${i}`) })).status).toBe(400);

    // render-props.json without a theme: the shot cannot be drawn to match.
    const props = JSON.parse(await readFile(join(dir, "render-props.json"), "utf8"));
    delete props.theme;
    await writeFile(join(dir, "render-props.json"), JSON.stringify(props));
    const noTheme = await post(s.url, "/api/storyboard/draw", { ids: ["s1"] });
    expect(noTheme.status).toBe(412);
    expect((await noTheme.json()).error).toContain("render-props.json");
    close?.();

    // No provider: no usage log, no env, no binary.
    const dir2 = await storyboardWorkdir();
    rmSync(join(dir2, "usage.json"));
    const bare = await start(dir2);
    const noLlm = await post(bare.url, "/api/storyboard/draw", { ids: ["s1"] });
    expect(noLlm.status).toBe(412);
    expect((await noLlm.json()).error).toContain("no LLM provider available");
    close?.();

    const dir3 = await storyboardWorkdir();
    rmSync(join(dir3, "storyboard.json"));
    const none = await start(dir3, { provider: drawProvider().make });
    expect((await post(none.url, "/api/storyboard/draw", { ids: ["s1"] })).status).toBe(409);
    close?.();

    const noDir = await start(undefined);
    for (const path of ["/api/storyboard/draw", "/api/storyboard/note", "/api/storyboard/preview", "/api/storyboard/draft", "/api/storyboard/approve", "/api/storyboard/cancel"]) {
      expect((await post(noDir.url, path, {})).status, path).toBe(409);
    }
    expect((await fetch(`${noDir.url}/api/storyboard/job`)).status).toBe(409);
  });
});

describe("storyboard redraw, preview and draft (plan B2a Task 4; §169)", () => {
  it("note: 409 with no draft; otherwise a redraw job that records the note and sets the new draft", async () => {
    const dir = await storyboardWorkdir();
    const provider = drawProvider();
    const s = await start(dir, { provider: provider.make });
    expect((await post(s.url, "/api/storyboard/note", { id: "s1", text: "bigger" })).status).toBe(409);
    await drawnShot(dir, "s1");
    expect((await post(s.url, "/api/storyboard/note", { id: "s1", text: "   " })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/note", { id: "s1", text: "x".repeat(1001) })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/note", { id: "s1", text: " make it bigger " })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job).toMatchObject({ kind: "redraw", done: [{ id: "s1", ok: true }], calls: 1 });
    expect(history(dir, "s1")).toMatchObject({ draft: 2, notes: [{ onVersion: 1, text: "make it bigger" }] });
    expect(provider.requests[0]).toContain("make it bigger");
  });

  it("preview: 409 with no draft; otherwise a preview job that writes the draft's preview, with no LLM call and no usage run", async () => {
    const dir = await storyboardWorkdir();
    const provider = drawProvider();
    const s = await start(dir, { provider: provider.make });
    expect((await post(s.url, "/api/storyboard/preview", { id: "s1" })).status).toBe(409);
    await drawnShot(dir, "s1");
    expect((await post(s.url, "/api/storyboard/preview", { id: "s1" })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job).toMatchObject({ kind: "preview", done: [{ id: "s1", ok: true }], calls: 0 });
    expect(existsSync(join(dir, "storyboard", "s1", "v1", "preview.webm"))).toBe(true);
    expect(provider.requests).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "usage.json"), "utf8")).runs).toHaveLength(1);
    const got = await (await fetch(`${s.url}/api/storyboard`)).json();
    expect(got.detail.s1.versions[0].preview).toBe("/media/storyboard/s1/v1/preview.webm");
  });

  it("draft: sets an ok version as the draft; a failed or unknown version is a 400", async () => {
    const dir = await storyboardWorkdir();
    await drawnShot(dir, "s1", {
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: { failed: "line 2 [name] fetch" }, kitVersion: 1 },
        { n: 3, result: "ok", kitVersion: 1 },
      ],
      draft: 3,
      nextVersion: 4,
    });
    const s = await start(dir);
    const failed = await post(s.url, "/api/storyboard/draft", { id: "s1", version: 2 });
    expect(failed.status).toBe(400);
    expect((await failed.json()).ok).toBe(false);
    expect((await post(s.url, "/api/storyboard/draft", { id: "s1", version: 9 })).status).toBe(400);
    expect((await post(s.url, "/api/storyboard/draft", { id: "s2", version: 1 })).status).toBe(400);
    expect(history(dir, "s1").draft).toBe(3);
    const ok = await post(s.url, "/api/storyboard/draft", { id: "s1", version: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(history(dir, "s1").draft).toBe(1);
  });
});

describe("storyboard approve and the sync run (plan B2a Task 4; §169)", () => {
  it("approve: the clip at the live length, the approval saved, and the sync run of a storyboard command", async () => {
    const dir = await storyboardWorkdir();
    await drawnShot(dir, "s1", { assetsDir: "/v/drawn-with" });
    await writeFile(join(dir, "storyboard.json"), JSON.stringify({ ...STORYBOARD, assetsDir: "/v/table" }));
    await recordCommand(dir, ["produce", "./take.mp4", "--storyboard", "--assets", "/v/old", "--no-render"]);
    const s = await start(dir);
    expect((await post(s.url, "/api/storyboard/approve", { id: "s1" })).status).toBe(202);
    const job = await jobEnd(s.url);
    expect(job).toMatchObject({ kind: "approve", done: [{ id: "s1", ok: true }] });
    expect(s.approveArgs).toHaveLength(1);
    expect(s.approveArgs[0]).toMatchObject({ workdir: dir, shotId: "s1", durationSec: S1_LENGTH, assetsDir: "/v/drawn-with" });
    expect(s.approveArgs[0]!.project.theme.accent).toBe("#ff00aa");
    expect(table(dir).shots[0].approval).toEqual(APPROVAL);
    const run = await renderEnd(s.url);
    expect(run.exitCode).toBe(0);
    const argv = argvOf(run.lines);
    expect(argv).toContain("--storyboard");
    expect(argv).toContain("--no-open-editor");
    expect(argv).not.toContain("--scenes");
    expect(argv).not.toContain("--no-render");
    expect(argv.slice(argv.indexOf("--assets"), argv.indexOf("--assets") + 2)).toEqual(["--assets", "/v/table"]);
    expect(argv.filter((a) => a === "--assets")).toHaveLength(1);
  });

  it("approve after a Render: the recorded --scenes command still makes a storyboard sync run", async () => {
    const dir = await storyboardWorkdir();
    await drawnShot(dir, "s1");
    await recordCommand(dir, ["produce", "./take.mp4", "--scenes", join(dir, "x.json")]);
    const s = await start(dir);
    expect((await post(s.url, "/api/storyboard/approve", { id: "s1" })).status).toBe(202);
    expect((await jobEnd(s.url)).done).toEqual([{ id: "s1", ok: true }]);
    const argv = argvOf((await renderEnd(s.url)).lines);
    expect(argv).toEqual(["produce", "./take.mp4", "--storyboard", "--no-open-editor"]);
  });

  it("approve: 409 with no draft, while a render runs, and for a shot whose every word is cut; a failed render is ok false and saves nothing", async () => {
    const dir = await storyboardWorkdir();
    await recordCommand(dir, ["produce", "./take.mp4"], "setTimeout(() => {}, 1500)");
    const s = await start(dir, {
      approve: async () => {
        throw new Error("the clip render failed: browser crashed");
      },
    });
    expect((await post(s.url, "/api/storyboard/approve", { id: "s1" })).status).toBe(409);
    await drawnShot(dir, "s1");
    expect((await post(s.url, "/api/storyboard/approve", { id: "s3" })).status).toBe(400);

    expect((await post(s.url, "/api/render")).status).toBe(202);
    const during = await post(s.url, "/api/storyboard/approve", { id: "s1" });
    expect(during.status).toBe(409);
    expect((await during.json()).error).toContain("render is running");
    await renderEnd(s.url);

    expect((await post(s.url, "/api/storyboard/approve", { id: "s1" })).status).toBe(202);
    expect((await jobEnd(s.url)).done).toEqual([{ id: "s1", ok: false, error: "the clip render failed: browser crashed" }]);
    expect(table(dir).shots[0].approval).toBeUndefined();

    await writeFile(join(dir, "overrides.json"), JSON.stringify({ cuts: [{ startSec: 0, endSec: 3.95, src: { startSec: 0, endSec: 3.95 } }] }));
    const cut = await post(s.url, "/api/storyboard/approve", { id: "s1" });
    expect(cut.status).toBe(409);
    expect((await cut.json()).error).toContain("every word of shot s1 is cut");
  });

  it("the edit route refuses op approve: an approval is only the server's to make", async () => {
    const dir = await storyboardWorkdir();
    const s = await start(dir);
    const res = await post(s.url, "/api/storyboard/edit", { op: "approve", id: "s1", approval: APPROVAL });
    expect(res.status).toBe(400);
    expect(table(dir).shots[0].approval).toBeUndefined();
  });

  it("drop, restore and unapprove of an approved shot save, start the sync run and say replay; of another shot they do not", async () => {
    const dir = await storyboardWorkdir();
    await writeFile(
      join(dir, "storyboard.json"),
      JSON.stringify({ ...STORYBOARD, shots: [{ ...STORYBOARD.shots[0], approval: APPROVAL }, ...STORYBOARD.shots.slice(1)] }),
    );
    await recordCommand(dir, ["produce", "./take.mp4", "--scenes", join(dir, "x.json")]);
    const s = await start(dir);

    const plain = await post(s.url, "/api/storyboard/edit", { op: "drop", id: "s2" });
    expect(plain.status).toBe(200);
    expect("replay" in (await plain.json())).toBe(false);
    expect((await (await fetch(`${s.url}/api/render/status`)).json()).startedAt).toBeNull();

    for (const op of ["drop", "restore", "unapprove"]) {
      const res = await post(s.url, "/api/storyboard/edit", { op, id: "s1" });
      expect(res.status, op).toBe(200);
      const body = await res.json();
      expect(body, op).toMatchObject({ ok: true, replay: true });
      expect(table(dir)).toEqual(body.storyboard);
      const argv = argvOf((await renderEnd(s.url)).lines);
      expect(argv, op).toEqual(["produce", "./take.mp4", "--storyboard", "--no-open-editor"]);
    }
    expect(table(dir).shots[0].approval).toBeUndefined();
  });

  it("an edit of an approved shot is a 409 while a job runs, and while a render runs", async () => {
    const dir = await storyboardWorkdir();
    await writeFile(
      join(dir, "storyboard.json"),
      JSON.stringify({ ...STORYBOARD, shots: [{ ...STORYBOARD.shots[0], approval: APPROVAL }, ...STORYBOARD.shots.slice(1)] }),
    );
    await recordCommand(dir, ["produce", "./take.mp4"], "setTimeout(() => {}, 1500)");
    const held = heldProvider();
    const s = await start(dir, { provider: held.make });
    expect((await post(s.url, "/api/storyboard/draw", { ids: ["s2"] })).status).toBe(202);
    await held.started;
    const during = await post(s.url, "/api/storyboard/edit", { op: "unapprove", id: "s1" });
    expect(during.status).toBe(409);
    expect((await during.json()).error).toContain("a storyboard job is running");
    held.release();
    await jobEnd(s.url);

    expect((await post(s.url, "/api/render")).status).toBe(202);
    expect((await post(s.url, "/api/storyboard/edit", { op: "unapprove", id: "s1" })).status).toBe(409);
    await renderEnd(s.url);
    expect(table(dir).shots[0].approval).toEqual(APPROVAL);
  });

  it("GET /api/production says storyboardProject when storyboard.json exists, or production.json holds the record", async () => {
    const dir = await storyboardWorkdir();
    const s = await start(dir);
    expect((await (await fetch(`${s.url}/api/production`)).json()).storyboardProject).toBe(true);
    rmSync(join(dir, "storyboard.json"));
    expect((await (await fetch(`${s.url}/api/production`)).json()).storyboardProject).toBe(false);
    await writeFile(
      join(dir, "production.json"),
      JSON.stringify({ storyboard: { shots: [{ id: "s1", startWord: 0, endWord: 9, clip: "storyboard/s1/approved.mov", src: "clips/s1.webm", durationSec: 3.9 }] } }),
    );
    expect((await (await fetch(`${s.url}/api/production`)).json()).storyboardProject).toBe(true);
  });
});
