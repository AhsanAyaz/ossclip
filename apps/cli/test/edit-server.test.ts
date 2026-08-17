import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { GenerateThumbnailImageOptions } from "@ossclip/core";
import { startEditServer } from "../src/edit";

let close: (() => void) | undefined;
afterEach(() => close?.());

const CLIP_CONTENT = "not-a-real-video";

// Opening a workdir records it as a recent project (R17 §83) — EVERY server
// in this suite must aim that write at a tmp dir, or a test run appends its
// throwaway fixtures to the runner's real ~/.ossclip picker list.
const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");

async function fixtureWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
  );
  await writeFile(join(dir, "clip.mp4"), CLIP_CONTENT);
  return dir;
}

/**
 * A command.json whose "render" is a real node SCRIPT FILE, not `node -e`:
 * since §129 the render endpoint prepends the `produce` literal to any
 * recorded args that lack it, and with `-e` the first arg IS the program
 * text — the healed argv would evaluate the string "produce" instead of the
 * fixture. A script file keeps args in the modern `["produce", …]` shape
 * the endpoint leaves untouched (the §129 tests below pass legacy args on
 * purpose).
 */
async function recordCommand(dir: string, code: string, args: string[] = ["produce"]): Promise<void> {
  await writeFile(join(dir, "recorded.cjs"), code);
  await writeFile(
    join(dir, "command.json"),
    JSON.stringify({
      execPath: process.execPath,
      execArgv: [],
      script: join(dir, "recorded.cjs"),
      args,
      cwd: dir,
    }),
  );
}

/** Poll the render status until the child exits (or ~5s passes). */
async function awaitRenderExit(url: string): Promise<{ exitCode: number | null; lines: string[] }> {
  let status = { running: true, exitCode: null as number | null, lines: [] as string[] };
  for (let i = 0; i < 50 && (status.running || status.exitCode === null); i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = await (await fetch(`${url}/api/render/status`)).json();
  }
  return status;
}

describe("edit server", () => {
  it("serves the production document", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/production`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.renderProps.videoFileName).toBe("clip.mp4");
    expect(body.overrides).toEqual({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: [] });
  });

  it("saves overrides to disk", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const doc = { theme: {}, scenes: { "scene-0": { props: { value: "999%" }, elements: {} } } };
    const res = await fetch(`${server.url}/api/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(join(dir, "overrides.json"), "utf8"));
    expect(onDisk.scenes["scene-0"].props.value).toBe("999%");
  });

  it("serves a pre-§137 doc as parsed — the caption key migration is the EDITOR's job", async () => {
    // §137 Task 6's decision, pinned at the endpoint it was made about. The
    // migration resolves a positional key by taking the source anchor of the
    // word it named, and THESE ARE THE WORDS IT WOULD ASK: served exactly as
    // the pre-§137 file holds them, with no `srcStart` on any of them. A
    // `migrateCaptionKeys` call here would therefore resolve nothing, report
    // every edit as lost, and return an empty caption map — inert in
    // production while passing a test written against repaired lines. The
    // editor backfills these words on load (`anchorCaptionLines`) and
    // migrates against the result, which is the only place both halves exist.
    // If the repair ever DOES move server-side, this test is the thing to
    // change deliberately rather than the thing to notice afterwards.
    const dir = await fixtureWorkdir();
    await writeFile(
      join(dir, "render-props.json"),
      JSON.stringify({
        videoFileName: "clip.mp4",
        sceneCues: [],
        spans: [{ srcIn: 10, srcOut: 41.9, outIn: 0, outOut: 31.9 }],
        captionLines: [
          { words: [{ text: "batch,", start: 0.09, end: 0.47 }], start: 0.09, end: 0.47 },
        ],
      }),
    );
    await writeFile(
      join(dir, "overrides.json"),
      JSON.stringify({ captions: { "0": { text: "Bash,", was: "batch," } } }),
    );
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/production`)).json();
    expect(Object.keys(body.overrides.captions)).toEqual(["0"]);
    expect(body.renderProps.captionLines[0].words[0].srcStart).toBeUndefined();
  });

  it("rejects a malformed override document rather than writing it", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenes: { "scene-0": { elements: { v: { scale: -3 } } } } }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a workdir with no production in it, naming the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-empty-"));
    await expect(startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS })).rejects.toThrow(dir);
  });

  it("refuses a %2F-encoded traversal into a numeric-prefix sibling directory", async () => {
    // Reviewer's concrete failing input: workdir "clip-1"-shaped, sibling
    // "clip-10"-shaped — a naive `file.startsWith(workdir)` check is fooled
    // because "/tmp/clip-10" starts with the string "/tmp/clip-1".
    const dir = await fixtureWorkdir();
    const siblingDir = `${dir}0`; // e.g. ossclip-edit-XXXXXX -> ossclip-edit-XXXXXX0
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, "secret.txt"), "TOP SECRET NUMERIC SIBLING");

    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/media/..%2F${basename(siblingDir)}%2Fsecret.txt`);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain("TOP SECRET NUMERIC SIBLING");
  });

  it("refuses a %2F-encoded traversal into a hyphen-suffixed sibling directory", async () => {
    // Reviewer's second concrete input: "/tmp/wd" vs "/tmp/wd-evil/secret" —
    // same class of bug, different sibling-naming shape.
    const dir = await fixtureWorkdir();
    const siblingDir = `${dir}-evil`;
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, "secret.txt"), "TOP SECRET HYPHEN SIBLING");

    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/media/..%2F${basename(siblingDir)}%2Fsecret.txt`);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain("TOP SECRET HYPHEN SIBLING");
  });

  // chmod 000 does not stop root — the read succeeds and the 500 path never
  // fires. Skipped rather than left red in containered CI running as root.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "turns a mid-stream read failure into a 500 instead of crashing",
  async () => {
    const dir = await fixtureWorkdir();
    // Passes the existsSync check but fails when the stream actually opens.
    await chmod(join(dir, "clip.mp4"), 0o000);
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/media/clip.mp4`);
    expect(res.status).toBe(500);
    await chmod(join(dir, "clip.mp4"), 0o644);
  });

  it("412 without command.json, and the production doc says the button can't work", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/render`, { method: "POST" });
    expect(res.status).toBe(412);
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.canRender).toBe(false);
  });

  it("replays ONLY the recorded argv, capturing output — the request body is never executed", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "console.log('hi from the recorded command')");
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    // A client-supplied command in the body must be IGNORED outright — a
    // locally-bound server that ran it would still be a browser-reachable
    // shell.
    const res = await fetch(`${server.url}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execPath: "/bin/sh", script: "-c", args: ["echo pwned"] }),
    });
    expect(res.status).toBe(202);
    const status = await awaitRenderExit(server.url);
    expect(status.exitCode).toBe(0);
    expect(status.lines.join("\n")).toContain("hi from the recorded command");
    expect(status.lines.join("\n")).not.toContain("pwned");
    // The spawn stamp rides along (R13) — the panel's elapsed clock derives
    // from the SERVER's time so a page reload mid-render stays honest.
    expect(typeof (status as { startedAt?: number }).startedAt).toBe("number");
    // The production doc now reports the button usable.
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.canRender).toBe(true);
  });

  it("§129: a legacy record missing the `produce` literal is healed at spawn", async () => {
    // The field artifact's exact shape: a pre-fix wizard/bare-path run
    // recorded process.argv — `["./folder", "--llm", …]`, no `produce` — and
    // replaying it verbatim died with "error: unknown option '--llm'". The
    // endpoint must prepend the literal so the existing workdir renders
    // WITHOUT re-producing.
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "console.log(JSON.stringify(process.argv.slice(2)))", [
      "./folder",
      "--llm",
      "mock",
    ]);
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    const status = await awaitRenderExit(server.url);
    expect(status.exitCode).toBe(0);
    const argvLine = status.lines.find((l) => l.startsWith("["));
    expect(argvLine).toBeDefined();
    expect(JSON.parse(argvLine!)).toEqual(["produce", "./folder", "--llm", "mock"]);
  });

  it("§129: a modern record already starting with `produce` replays untouched", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "console.log(JSON.stringify(process.argv.slice(2)))", [
      "produce",
      "./folder",
      "--llm",
      "mock",
    ]);
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    const status = await awaitRenderExit(server.url);
    expect(status.exitCode).toBe(0);
    const argvLine = status.lines.find((l) => l.startsWith("["));
    expect(argvLine).toBeDefined();
    // Exactly one `produce` — the heal must never stack a second one.
    expect(JSON.parse(argvLine!)).toEqual(["produce", "./folder", "--llm", "mock"]);
  });

  it("cancel kills the child and the status says CANCELLED, not failed (R16 §60)", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "setTimeout(() => {}, 10000)");
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    // Nothing to cancel yet — 409, not a silent ok.
    expect((await fetch(`${server.url}/api/render/cancel`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${server.url}/api/render/cancel`, { method: "POST" })).status).toBe(202);
    let status = { running: true, exitCode: null as number | null, cancelled: false };
    for (let i = 0; i < 50 && (status.running || status.exitCode === null); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await (await fetch(`${server.url}/api/render/status`)).json();
    }
    expect(status.running).toBe(false);
    expect(status.cancelled).toBe(true);
    // A NEW render resets the flag — the last run's cancel is not this run's.
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    const fresh = await (await fetch(`${server.url}/api/render/status`)).json();
    expect(fresh.cancelled).toBe(false);
  });

  it("409 while a render is already running; server close kills the child", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "setTimeout(() => {}, 10000)");
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(409);
    const status = await (await fetch(`${server.url}/api/render/status`)).json();
    expect(status.running).toBe(true);
    // afterEach's close() kills the child — the suite must not hang on it.
  });

  it("honours a Range request with a 206 and Content-Range", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/media/clip.mp4`, { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${CLIP_CONTENT.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = await res.text();
    expect(body).toBe(CLIP_CONTENT.slice(0, 4));
  });
});

describe("project open and switch (R17 §83)", () => {
  // Every test points `recentDir` at its own tmp dir — the suite must never
  // read or write the runner's real ~/.ossclip.
  const tmpRecentDir = (): Promise<string> => mkdtemp(join(tmpdir(), "ossclip-recent-"));

  it("starts with NO workdir: production says so, and workdir endpoints 409", async () => {
    const server = await startEditServer(undefined, { port: 0, recentDir: await tmpRecentDir() });
    close = server.close;
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.noWorkdir).toBe(true);
    expect(prod.recent).toEqual([]);
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${server.url}/media/clip.mp4`)).status).toBe(409);
    const put = await fetch(`${server.url}/api/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: {}, scenes: {}, captions: {}, splits: [] }),
    });
    expect(put.status).toBe(409);
  });

  it("POST /api/workdir opens a project and records it recent; a bad dir 400s", async () => {
    const recentDir = await tmpRecentDir();
    const dir = await fixtureWorkdir();
    const server = await startEditServer(undefined, { port: 0, recentDir });
    close = server.close;
    const bad = await fetch(`${server.url}/api/workdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(dir, "nope") }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("render-props.json");
    const ok = await fetch(`${server.url}/api/workdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(ok.status).toBe(200);
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.noWorkdir).toBeUndefined();
    expect(prod.workdir).toBe(dir);
    expect(prod.renderProps.videoFileName).toBe("clip.mp4");
    expect(prod.recent).toContain(dir);
    // Media serves from the opened project — the 409 state is over.
    expect((await fetch(`${server.url}/media/clip.mp4`)).status).toBe(200);
  });

  it("switching projects swaps the served workdir and stacks recents newest-first", async () => {
    const recentDir = await tmpRecentDir();
    const a = await fixtureWorkdir();
    const b = await fixtureWorkdir();
    await writeFile(join(b, "clip.mp4"), "b-clip");
    const server = await startEditServer(a, { port: 0, recentDir });
    close = server.close;
    const res = await fetch(`${server.url}/api/workdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: b }),
    });
    expect(res.status).toBe(200);
    expect(await (await fetch(`${server.url}/media/clip.mp4`)).text()).toBe("b-clip");
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.workdir).toBe(b);
    expect(prod.recent.slice(0, 2)).toEqual([b, a]);
  });

  it("refuses a switch while a render is running", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "setTimeout(() => {}, 10000)");
    const other = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: await tmpRecentDir() });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    const res = await fetch(`${server.url}/api/workdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: other }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /api/fs lists directories only, projects flagged and sorted first", async () => {
    const root = await mkdtemp(join(tmpdir(), "ossclip-fs-"));
    await mkdir(join(root, "aaa-plain"));
    await mkdir(join(root, "zzz-proj"));
    await writeFile(join(root, "zzz-proj", "render-props.json"), "{}");
    await writeFile(join(root, "some-file.txt"), "not a directory");
    const server = await startEditServer(undefined, { port: 0, recentDir: await tmpRecentDir() });
    close = server.close;
    const res = await fetch(`${server.url}/api/fs?dir=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dir: string;
      parent: string | null;
      isWorkdir: boolean;
      entries: Array<{ name: string; path: string; isWorkdir: boolean }>;
    };
    expect(body.dir).toBe(root);
    expect(body.parent).toBe(tmpdir());
    expect(body.isWorkdir).toBe(false);
    // The project sorts FIRST despite its name sorting last — flag beats name.
    expect(body.entries.map((e) => e.name)).toEqual(["zzz-proj", "aaa-plain"]);
    expect(body.entries[0]!.isWorkdir).toBe(true);
    expect(body.entries[1]!.isWorkdir).toBe(false);
  });
});

describe("AI thumbnail endpoints (2026-08-17)", () => {
  // EVERY server here injects `loadCfg: () => ({})` — the panel's config
  // fallback must never read the runner's real ~/.ossclip/config.json (the
  // SHARED_RECENTS rule applied to reads).
  const noCfg = (): Record<string, never> => ({});
  afterEach(() => vi.unstubAllEnvs());

  /** A workdir whose command.json pins --youtube + a portrait that exists,
   * plus a recorded out — the fully-configured baseline. */
  async function thumbnailWorkdir(): Promise<{ dir: string; portrait: string; out: string }> {
    const dir = await fixtureWorkdir();
    const portrait = join(dir, "portrait.png");
    await writeFile(portrait, "not-a-real-png");
    const out = join(dir, "final.mp4");
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4", "--youtube", "--portrait", portrait],
        cwd: dir,
        out,
      }),
    );
    return { dir, portrait, out };
  }

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
    });
    close = server.close;
    expect((await fetch(`${server.url}/api/thumbnail`)).status).toBe(409);
    expect((await fetch(`${server.url}/api/thumbnail/image`)).status).toBe(409);
    expect(
      (await fetch(`${server.url}/api/thumbnail/regenerate`, { method: "POST" })).status,
    ).toBe(409);
  });

  it("a pinned --no-youtube reads unavailable/no-youtube — the pin is the replay truth", async () => {
    const dir = await fixtureWorkdir();
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4", "--no-youtube"],
        cwd: dir,
      }),
    );
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(body).toMatchObject({ status: "unavailable", reason: "no-youtube", concept: null });
    expect(body.imageUrl).toBeNull();
    // Regenerate against an unavailable project is a precondition failure —
    // 412 like a render without command.json, never a paid call.
    const regen = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concept: { scene: "s", overlayText: "o", styleNotes: "n" } }),
    });
    expect(regen.status).toBe(412);
  });

  it("fully configured but nothing generated yet: ready/never-generated, null concept and image", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(body).toMatchObject({ status: "ready", reason: "never-generated", concept: null });
    expect(body.imageUrl).toBeNull();
    expect(typeof body.model).toBe("string");
    expect((await fetch(`${server.url}/api/thumbnail/image`)).status).toBe(404);
  });

  it("the approved concept wins the prefill; a {skip:true} file reads as skipped", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    const concept = { scene: "a terminal", overlayText: "SHIP IT", styleNotes: "dark" };
    // A cache the approved file must outrank — the approval is the user's
    // decision, the cache is only what the last produce prompted with.
    await writeFile(join(dir, "thumbnail-concept-aaaaaaaa.json"), JSON.stringify({
      scene: "cached scene", overlayText: "CACHED", styleNotes: "cached",
    }));
    await writeFile(join(dir, "thumbnail-concept-approved.json"), JSON.stringify(concept));
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(body.status).toBe("ready");
    expect(body.concept).toEqual(concept);

    await writeFile(join(dir, "thumbnail-concept-approved.json"), JSON.stringify({ skip: true }));
    const skipped = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(skipped).toMatchObject({ status: "skipped", reason: "skip-file" });
    // With the approval now a skip, the cache is the prefill again.
    expect(skipped.concept).toEqual({
      scene: "cached scene",
      overlayText: "CACHED",
      styleNotes: "cached",
    });
  });

  it("regenerate: persists the approved concept, writes the cache and <out>.thumbnail.png", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir, out } = await thumbnailWorkdir();
    const calls: GenerateThumbnailImageOptions[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      generateThumbnail: async (o) => {
        calls.push(o);
        return new Uint8Array([137, 80, 78, 71]);
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        concept: { scene: "a glowing terminal", overlayText: "AGENTS EXPLAINED", styleNotes: "dark blue" },
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.imageUrl).toMatch(/^\/api\/thumbnail\/image\?ts=\d+$/);
    // The approval-file contract: the edit is on disk for future CLI replays.
    const approved = JSON.parse(await readFile(join(dir, "thumbnail-concept-approved.json"), "utf8"));
    expect(approved.overlayText).toBe("AGENTS EXPLAINED");
    // The generate call carried the key, the portrait bytes and the concept.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe("test-key");
    expect(calls[0]!.prompt).toContain("AGENTS EXPLAINED");
    expect(calls[0]!.portrait).toEqual({
      data: Buffer.from("not-a-real-png").toString("base64"),
      mimeType: "image/png",
    });
    // Destination copy beside the recorded out.
    const dest = join(dir, "final.thumbnail.png");
    expect(existsSync(dest)).toBe(true);
    expect([...(await readFile(dest))]).toEqual([137, 80, 78, 71]);
    // The image endpoint serves it, no-store.
    const img = await fetch(`${server.url}/api/thumbnail/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    // And the panel state now reports it.
    const state = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(state.status).toBe("ready");
    expect(state.imageUrl).toMatch(/^\/api\/thumbnail\/image\?ts=\d+$/);
  });

  it("regenerate word-caps the overlay before persisting — thumbnailStep parity", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      generateThumbnail: async () => new Uint8Array([1]),
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        concept: {
          scene: "s",
          overlayText: "this framework changes absolutely everything about how teams ship",
          styleNotes: "n",
        },
      }),
    });
    expect((await res.json()).ok).toBe(true);
    const approved = JSON.parse(await readFile(join(dir, "thumbnail-concept-approved.json"), "utf8"));
    expect(approved.overlayText.split(" ").length).toBeLessThanOrEqual(9);
  });

  it("a generation failure is 200/ok:false with the message VERBATIM, and the edit survives", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      generateThumbnail: async () => {
        throw new Error("models/nope is not found");
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concept: { scene: "s", overlayText: "OK THEN", styleNotes: "n" } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: false, error: "models/nope is not found" });
    // Persisted BEFORE the failed generation — the user's decision stands.
    const approved = JSON.parse(await readFile(join(dir, "thumbnail-concept-approved.json"), "utf8"));
    expect(approved.overlayText).toBe("OK THEN");
    expect(existsSync(join(dir, "final.thumbnail.png"))).toBe(false);
  });

  it("a malformed body is a 400, never a paid call", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    let called = false;
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      generateThumbnail: async () => {
        called = true;
        return new Uint8Array([1]);
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concept: { scene: "only a scene" } }),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("409 while a generation is already in flight — an image call costs money", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await thumbnailWorkdir();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      generateThumbnail: async () => {
        started();
        await gate;
        return new Uint8Array([1]);
      },
    });
    close = server.close;
    const conceptBody = JSON.stringify({
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
    });
    const first = fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: conceptBody,
    });
    // Deterministic, not a sleep: the second request goes out only once the
    // first is provably inside the generate call.
    await startedP;
    const second = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: conceptBody,
    });
    expect(second.status).toBe(409);
    release();
    expect(((await (await first).json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("portrait override endpoints (editor face swap, 2026-08-17)", () => {
  const noCfg = (): Record<string, never> => ({});
  afterEach(() => vi.unstubAllEnvs());

  /** thumbnailWorkdir's shape, restated: a pinned --youtube + --portrait
   * baseline the override must OUTRANK. */
  async function portraitWorkdir(): Promise<{ dir: string; portrait: string }> {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-"));
    await writeFile(
      join(dir, "render-props.json"),
      JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
    );
    const portrait = join(dir, "portrait.png");
    await writeFile(portrait, "default-face-bytes");
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4", "--youtube", "--portrait", portrait],
        cwd: dir,
        out: join(dir, "final.mp4"),
      }),
    );
    return { dir, portrait };
  }

  const serve = async (dir: string, generateThumbnail?: (o: GenerateThumbnailImageOptions) => Promise<Uint8Array>) => {
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
      ...(generateThumbnail ? { generateThumbnail } : {}),
    });
    close = server.close;
    return server;
  };

  it("GET /api/thumbnail reports the flag portrait, and portrait-image serves it no-store", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await portraitWorkdir();
    const server = await serve(dir);
    const body = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(body.portrait.source).toBe("flag");
    expect(body.portrait.url).toMatch(/^\/api\/thumbnail\/portrait-image\?ts=\d+$/);
    const img = await fetch(`${server.url}${body.portrait.url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe("default-face-bytes");
  });

  it("no portrait anywhere: GET reports null and portrait-image 404s", async () => {
    const dir = await fixtureWorkdir();
    const server = await serve(dir);
    const body = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(body.portrait).toBeNull();
    expect((await fetch(`${server.url}/api/thumbnail/portrait-image`)).status).toBe(404);
  });

  it("POST swaps the face: override wins the GET, feeds portrait-image AND the regenerate", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await portraitWorkdir();
    const calls: GenerateThumbnailImageOptions[] = [];
    const server = await serve(dir, async (o) => {
      calls.push(o);
      return new Uint8Array([1]);
    });
    const res = await fetch(`${server.url}/api/thumbnail/portrait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from("swapped-face-bytes").toString("base64"),
        mimeType: "image/jpeg",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.portrait.source).toBe("override");
    // image/jpeg lands as .jpg — portraitExtensionForMime's tiebreak.
    const override = join(dir, "portrait-override.jpg");
    expect(await readFile(override, "utf8")).toBe("swapped-face-bytes");
    // No stray .tmp left behind by the atomic write.
    expect(existsSync(`${override}.tmp`)).toBe(false);
    // The GET now reports the override, and portrait-image serves ITS bytes.
    const state = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(state.portrait.source).toBe("override");
    const img = await fetch(`${server.url}${state.portrait.url}`);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe("swapped-face-bytes");
    // A regenerate prompts with the SWAPPED face, not the pinned one — and
    // since thumbnailImageCacheName keys on the portrait BYTES' sha1, the
    // swap misses the old cache naturally.
    const regen = await fetch(`${server.url}/api/thumbnail/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concept: { scene: "s", overlayText: "GO", styleNotes: "n" } }),
    });
    expect(((await regen.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.portrait).toEqual({
      data: Buffer.from("swapped-face-bytes").toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("one override, ever: a new upload with a different type removes the old extension", async () => {
    const { dir } = await portraitWorkdir();
    const server = await serve(dir);
    const post = (mimeType: string): Promise<Response> =>
      fetch(`${server.url}/api/thumbnail/portrait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: Buffer.from("x").toString("base64"), mimeType }),
      });
    expect((await post("image/png")).status).toBe(200);
    expect(existsSync(join(dir, "portrait-override.png"))).toBe(true);
    expect((await post("image/webp")).status).toBe(200);
    expect(existsSync(join(dir, "portrait-override.png"))).toBe(false);
    expect(existsSync(join(dir, "portrait-override.webp"))).toBe(true);
  });

  it("400 on a mime outside the table, naming the accepted set — no file written", async () => {
    const { dir } = await portraitWorkdir();
    const server = await serve(dir);
    const res = await fetch(`${server.url}/api/thumbnail/portrait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: Buffer.from("x").toString("base64"), mimeType: "image/gif" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("image/gif");
    expect(body.error).toContain("image/png, image/jpeg, image/webp");
    expect(existsSync(join(dir, "portrait-override.gif"))).toBe(false);
  });

  it("400 over the 15MB decoded cap, and on a malformed body", async () => {
    const { dir } = await portraitWorkdir();
    const server = await serve(dir);
    const huge = await fetch(`${server.url}/api/thumbnail/portrait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: Buffer.alloc(15 * 1024 * 1024 + 1).toString("base64"),
        mimeType: "image/png",
      }),
    });
    expect(huge.status).toBe(400);
    expect(((await huge.json()) as { error: string }).error).toContain("15MB");
    expect(existsSync(join(dir, "portrait-override.png"))).toBe(false);
    const malformed = await fetch(`${server.url}/api/thumbnail/portrait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png" }),
    });
    expect(malformed.status).toBe(400);
  });

  it("DELETE reverts to the flag/config portrait — or to none when there never was one", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { dir } = await portraitWorkdir();
    const server = await serve(dir);
    await fetch(`${server.url}/api/thumbnail/portrait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: Buffer.from("x").toString("base64"), mimeType: "image/png" }),
    });
    const res = await fetch(`${server.url}/api/thumbnail/portrait`, { method: "DELETE" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Re-resolved: the pinned --portrait is the fallback headshot again.
    expect(body.portrait.source).toBe("flag");
    expect(existsSync(join(dir, "portrait-override.png"))).toBe(false);
    const state = await (await fetch(`${server.url}/api/thumbnail`)).json();
    expect(state.portrait.source).toBe("flag");
  });

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: noCfg,
    });
    close = server.close;
    expect((await fetch(`${server.url}/api/thumbnail/portrait-image`)).status).toBe(409);
    expect(
      (await fetch(`${server.url}/api/thumbnail/portrait`, { method: "POST" })).status,
    ).toBe(409);
    expect(
      (await fetch(`${server.url}/api/thumbnail/portrait`, { method: "DELETE" })).status,
    ).toBe(409);
  });
});

describe("YouTube SEO pack endpoints (2026-08-17)", () => {
  const validPack = {
    titles: ["How agents actually work", "5 agent mistakes", "Agents in 8 minutes"],
    description: "The one agent pattern nobody explains.\n\n#agents",
    hashtags: ["#agents", "#llm"],
    tags: ["ai agents", "llm tutorial"],
  };

  /** A workdir with a recorded out, so the markdown has somewhere to land. */
  async function youtubeWorkdir(): Promise<{ dir: string; out: string }> {
    const dir = await fixtureWorkdir();
    const out = join(dir, "final.mp4");
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4", "--youtube"],
        cwd: dir,
        out,
      }),
    );
    return { dir, out };
  }

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/youtube`)).status).toBe(409);
    expect((await fetch(`${server.url}/api/youtube`, { method: "PUT" })).status).toBe(409);
  });

  it("no pack anywhere: available false, reason no-pack — the run never generated metadata", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/youtube`)).json();
    expect(body).toEqual({ available: false, reason: "no-pack", pack: null, mdPath: null });
  });

  it("the approved file outranks a NEWER cache — the approval is the user's decision", async () => {
    const { dir, out } = await youtubeWorkdir();
    const approved = { ...validPack, titles: ["edited", "by the", "user"] };
    await writeFile(join(dir, "youtube-pack-approved.json"), JSON.stringify(approved));
    // Written AFTER the approved file, so it is the newer of the two by
    // mtime — the approved file must still win on rank, not on recency.
    await writeFile(join(dir, "youtube-aaaaaaaa.json"), JSON.stringify(validPack));
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/youtube`)).json();
    expect(body.available).toBe(true);
    expect(body.pack.titles).toEqual(["edited", "by the", "user"]);
    expect(body.mdPath).toBe(join(dir, "final.youtube.md"));
  });

  it("a corrupt approved file degrades to the cache, never a 500 (read-side leniency)", async () => {
    const { dir } = await youtubeWorkdir();
    await writeFile(join(dir, "youtube-pack-approved.json"), "{not json");
    await writeFile(join(dir, "youtube-aaaaaaaa.json"), JSON.stringify(validPack));
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/youtube`)).json();
    expect(body.available).toBe(true);
    expect(body.pack).toEqual(validPack);
  });

  it("PUT validates, trims tags to the 500 budget, persists the approval and rewrites the markdown", async () => {
    const { dir } = await youtubeWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    // Two tags at the budget plus one over it — the trailing tag must go
    // (trimTagsToLimit drops from the END, relevance order).
    const tags = ["a".repeat(249), "b".repeat(249), "over-budget"];
    const res = await fetch(`${server.url}/api/youtube`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pack: { ...validPack, tags } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mdPath).toBe(join(dir, "final.youtube.md"));
    // The approval-file contract: on disk for produce's Y2 block to honor.
    const approved = JSON.parse(await readFile(join(dir, "youtube-pack-approved.json"), "utf8"));
    expect(approved.titles).toEqual(validPack.titles);
    expect(approved.tags).toEqual(tags.slice(0, 2));
    // The paste-ready markdown is rewritten NOW, from the trimmed pack.
    const md = await readFile(join(dir, "final.youtube.md"), "utf8");
    expect(md).toContain("How agents actually work");
    expect(md).not.toContain("over-budget");
    // And the GET reflects the save immediately.
    const state = await (await fetch(`${server.url}/api/youtube`)).json();
    expect(state.pack.tags).toEqual(tags.slice(0, 2));
  });

  it("PUT without a recorded out still saves the approval — mdPath null is the note", async () => {
    const dir = await fixtureWorkdir(); // no command.json at all
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/youtube`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pack: validPack }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, mdPath: null });
    expect(existsSync(join(dir, "youtube-pack-approved.json"))).toBe(true);
  });

  it("a malformed pack is a 400, never written", async () => {
    const { dir } = await youtubeWorkdir();
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/youtube`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // Two titles — under the schema's 3-5 bound the UI also enforces.
      body: JSON.stringify({ pack: { ...validPack, titles: ["one", "two"] } }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "youtube-pack-approved.json"))).toBe(false);
  });
});
