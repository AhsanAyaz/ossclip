import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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
    expect(body.overrides).toEqual({
      theme: {},
      scenes: {},
      captions: {},
      captionWordsHidden: {},
      captionRangeEdits: [],
      captionLineTiming: {},
      splits: [],
      cuts: [],
      cleanup: { reasons: {}, kept: [], dismissed: [] },
    });
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

  // 2026-08-18 field cascade: a custom out INSIDE a recorded FOLDER input
  // means the next produce ingests the output as a source clip, re-keys the
  // workdir and silently abandons the saved edits. The endpoint mirrors
  // produce's own refusal so the failure is a 400 the page can show, not a
  // spawned child dying in the log tail. The input is derived from the
  // RECORDED command only — never the request body.
  it("400s a custom out inside a recorded folder input, spawning nothing", async () => {
    const dir = await fixtureWorkdir();
    const clips = join(dir, "clips");
    await mkdir(clips);
    await recordCommand(dir, "console.log('must never run')", ["produce", clips, "--llm", "mock"]);
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ out: join(clips, "final.mp4") }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ingest this output as a source clip/);
    // Refused at the gate — no child was spawned.
    const status = await (await fetch(`${server.url}/api/render/status`)).json();
    expect(status.running).toBe(false);
  });

  it("a custom out BESIDE the recorded folder passes through to the spawn", async () => {
    const dir = await fixtureWorkdir();
    const clips = join(dir, "clips");
    await mkdir(clips);
    await recordCommand(dir, "console.log(JSON.stringify(process.argv.slice(2)))", [
      "produce",
      clips,
      "--llm",
      "mock",
    ]);
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    // The default out shape itself: a sibling sharing the folder's prefix,
    // which a naive startsWith containment check would wrongly refuse.
    const out = join(dir, "clips.ossclip.mp4");
    const res = await fetch(`${server.url}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ out }),
    });
    expect(res.status).toBe(202);
    const status = await awaitRenderExit(server.url);
    expect(status.exitCode).toBe(0);
    const argvLine = status.lines.find((l) => l.startsWith("["));
    expect(argvLine).toBeDefined();
    expect(JSON.parse(argvLine!)).toEqual(["produce", clips, "--llm", "mock", "--out", out]);
  });

  it("tells the child which workdir it is replaying (OSSCLIP_REPLAY_WORKDIR)", async () => {
    // Part 3 of the same field cascade: produce compares this against the
    // workdir it derives and warns when the folder re-keyed — the edits in
    // THIS workdir's overrides.json would not apply to that render.
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "console.log('replaying: ' + process.env.OSSCLIP_REPLAY_WORKDIR)");
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    const status = await awaitRenderExit(server.url);
    expect(status.exitCode).toBe(0);
    expect(status.lines.join("\n")).toContain(`replaying: ${dir}`);
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

  it("serves audio.wav as audio/wav — the timing editor's waveform source", async () => {
    // produce writes `audio.wav` into every workdir, and the caption timing
    // editor fetches it through /media. octet-stream happens to satisfy
    // fetch + decodeAudioData, but not a future <audio> element, so the
    // type is pinned here.
    const dir = await fixtureWorkdir();
    await writeFile(join(dir, "audio.wav"), "not-a-real-wav");
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const res = await fetch(`${server.url}/media/audio.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(await res.text()).toBe("not-a-real-wav");
  });
});

describe("reveal output (/api/reveal-output, 2026-08-18)", () => {
  // Every test injects the `reveal` seam (the `generateThumbnail` pattern) —
  // the live path would pop a real Finder/Explorer window on the runner.

  it("412 with no command.json, and with a record that carries no out", async () => {
    const dir = await fixtureWorkdir();
    const revealed: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      reveal: (p) => revealed.push(p),
    });
    close = server.close;
    expect((await fetch(`${server.url}/api/reveal-output`, { method: "POST" })).status).toBe(412);
    // A record without -o/--out (and no top-level out) has nothing to reveal
    // either — same 412, not a guess at produce's default out.
    await recordCommand(dir, "console.log('hi')");
    expect((await fetch(`${server.url}/api/reveal-output`, { method: "POST" })).status).toBe(412);
    expect(revealed).toEqual([]);
  });

  it("404 when an out is recorded but nothing has been rendered there yet", async () => {
    const dir = await fixtureWorkdir();
    await recordCommand(dir, "console.log('hi')", [
      "produce",
      "clip.mp4",
      "-o",
      join(dir, "final.mp4"),
    ]);
    const revealed: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      reveal: (p) => revealed.push(p),
    });
    close = server.close;
    expect((await fetch(`${server.url}/api/reveal-output`, { method: "POST" })).status).toBe(404);
    expect(revealed).toEqual([]);
  });

  it("reveals the recorded out when the file exists", async () => {
    const dir = await fixtureWorkdir();
    const out = join(dir, "final.mp4");
    await writeFile(out, "rendered");
    // The argv spelling — a legacy record without the top-level `out` field
    // still resolves through -o against the recorded cwd (recordedOutPath's
    // one spelling of the rule).
    await recordCommand(dir, "console.log('hi')", ["produce", "clip.mp4", "-o", "final.mp4"]);
    const revealed: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      reveal: (p) => revealed.push(p),
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/reveal-output`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: out });
    expect(revealed).toEqual([out]);
  });

  it("NEVER takes a path from the request body — the recorded out wins", async () => {
    // The security stance at the top of edit.ts: this server binds locally,
    // but an endpoint acting on a client-named path is the same door as
    // spawning a client-supplied command. The decoy EXISTS, so a body-reading
    // implementation would happily 200 on it — only ignoring the body
    // reveals the recorded out instead.
    const dir = await fixtureWorkdir();
    const out = join(dir, "final.mp4");
    await writeFile(out, "rendered");
    await recordCommand(dir, "console.log('hi')", ["produce", "clip.mp4", "-o", out]);
    const revealed: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      reveal: (p) => revealed.push(p),
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/reveal-output`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(dir, "clip.mp4") }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).path).toBe(out);
    expect(revealed).toEqual([out]);
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

describe("cover endpoints (editor panel, 2026-08-19)", () => {
  // EVERY server here injects a `renderCover` seam. Without one
  // `regenerateCover` lazily imports @ossclip/renderer and boots a headless
  // browser — this suite must never do that, which is the whole reason the
  // seam exists (the `generateThumbnail` rule).
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  /** A produced workdir with a recorded out — the baseline a cover needs a
   * destination from. */
  async function coverWorkdir(): Promise<{ dir: string; out: string; coverOut: string }> {
    const dir = await fixtureWorkdir();
    const out = join(dir, "final.mp4");
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4"],
        cwd: dir,
        out,
      }),
    );
    return { dir, out, coverOut: join(dir, "final.cover.jpg") };
  }

  /** The `cover.json` a produce run leaves behind, plus the still it names —
   * together they are the cheap path: a text change runs no ffmpeg at all. */
  async function writeProvenance(
    dir: string,
    coverOut: string,
    over: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(join(dir, "cover-frame.png"), "not-a-real-png");
    await writeFile(
      join(dir, "cover.json"),
      JSON.stringify({
        version: 1,
        text: "SHIP IT",
        textSource: "beatsheet",
        frame: {
          source: "source",
          timeSec: 4.2,
          face: null,
          hasFace: false,
          sharpness: 812.3,
          fileName: "cover-frame.png",
          sourceVideo: "clip.mp4",
          cropVf: null,
        },
        size: { width: 1080, height: 1920 },
        out: coverOut,
        ...over,
      }),
    );
  }

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    expect((await fetch(`${server.url}/api/cover`)).status).toBe(409);
    expect((await fetch(`${server.url}/api/cover/image`)).status).toBe(409);
    expect((await fetch(`${server.url}/api/cover/regenerate`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${server.url}/api/cover/preview`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${server.url}/api/cover/preview-image`)).status).toBe(409);
  });

  it("a produced workdir reports its provenance and a ?ts-busted image URL", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    await writeFile(coverOut, JPEG);
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/cover`)).json();
    expect(body.status).toBe("ready");
    expect(body.reason).toBeUndefined();
    expect(body.provenance).toMatchObject({ text: "SHIP IT", textSource: "beatsheet" });
    expect(body.provenance.frame).toMatchObject({ source: "source", timeSec: 4.2 });
    expect(body.outPath).toBe(coverOut);
    // The ts is the FILE's mtime, not now() — the URL changes exactly when
    // the file does.
    expect(body.imageUrl).toBe(
      `/api/cover/image?ts=${Math.round(statSync(coverOut).mtimeMs)}`,
    );
    const img = await fetch(`${server.url}/api/cover/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([...JPEG]);
  });

  it("a pre-feature workdir: no cover.json, but the recorded out still names a destination", async () => {
    const { dir, coverOut } = await coverWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/cover`)).json();
    // Ready, not unavailable: §corr.3 — the final mp4 plus render-props.json
    // are enough to rebuild a cover with no provenance at all.
    expect(body).toMatchObject({ status: "ready", reason: "never-rendered", provenance: null });
    expect(body.outPath).toBe(coverOut);
    expect(body.imageUrl).toBeNull();
    expect((await fetch(`${server.url}/api/cover/image`)).status).toBe(404);
  });

  it("no cover.json AND no recorded out is unavailable — there is nowhere to write", async () => {
    const dir = await fixtureWorkdir(); // no command.json at all
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/cover`)).json();
    expect(body).toMatchObject({ status: "unavailable", reason: "no-destination", outPath: null });
  });

  it("regenerate: renders through the seam, rewrites cover.json, busts the image URL", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    const calls: Array<{ frameFileName: string; text: string; outPath: string; publicDir: string }> =
      [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async (props, o) => {
        calls.push({
          frameFileName: props.frameFileName,
          text: props.text,
          outPath: o.outPath,
          publicDir: o.publicDir,
        });
        await writeFile(o.outPath, JPEG);
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/cover/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "CWA SHIP KARACHI 2026" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The cheap path: it re-used the still already on disk rather than
    // extracting a frame, and the render got the workdir as its publicDir.
    expect(calls).toEqual([
      {
        frameFileName: "cover-frame.png",
        text: "CWA SHIP KARACHI 2026",
        outPath: coverOut,
        publicDir: dir,
      },
    ]);
    // Provenance rewritten with what the render actually used — and the
    // headline is now user-owned, so a later produce keeps it.
    const written = JSON.parse(await readFile(join(dir, "cover.json"), "utf8"));
    expect(written).toMatchObject({ text: "CWA SHIP KARACHI 2026", textSource: "user" });
    expect(written.frame).toMatchObject({ fileName: "cover-frame.png", timeSec: 4.2 });
    expect(body.provenance).toEqual(written);
    expect(body.imageUrl).toBe(`/api/cover/image?ts=${Math.round(statSync(coverOut).mtimeMs)}`);
    // The panel shows what the CLI prints — a trim, a re-pick — rather than
    // discovering it in the image.
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it("regenerate reports a §35 trim in its notes rather than shipping it silently", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async (_props, o) => {
        await writeFile(o.outPath, JPEG);
      },
    });
    close = server.close;
    const body = await (
      await fetch(`${server.url}/api/cover/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "THE ONE THING NOBODY TELLS YOU ABOUT THE FUTURE OF WORK",
        }),
      })
    ).json();
    expect(body.ok).toBe(true);
    expect(body.notes.join("\n")).toContain("trimmed to fit the 9-word cap");
    expect(body.provenance.text.split(" ")).toHaveLength(9);
  });

  it("NEVER takes a path from the request body — every path is derived server-side", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    const evil = join(dir, "evil.jpg");
    const destinations: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async (_props, o) => {
        destinations.push(o.outPath);
        await writeFile(o.outPath, JPEG);
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/cover/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Every spelling of "write it over here instead" the option surface has:
      // regenerateCover really does take an `outPath`, and `ossclip cover
      // --out` really does pass one — this endpoint deliberately does not.
      body: JSON.stringify({
        text: "PWNED",
        outPath: evil,
        out: evil,
        publicDir: "/etc",
        frameFileName: "/etc/passwd",
      }),
    });
    expect((await res.json()).ok).toBe(true);
    // The render landed at the destination cover.json names, not the body's.
    expect(destinations).toEqual([coverOut]);
    expect(existsSync(evil)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "cover.json"), "utf8")).out).toBe(coverOut);
  });

  it("a typo'd `from` and a negative `atSec` are 400s, and nothing renders", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    let called = false;
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {
        called = true;
      },
    });
    close = server.close;
    // `finall` silently falling back to "final" would rebuild the cover from
    // the wrong video and say nothing — CLAUDE.md's --source-fit rule.
    for (const body of [{ from: "finall" }, { atSec: -3 }, { atSec: "12" }]) {
      const res = await fetch(`${server.url}/api/cover/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("a regeneration that fails is 200/ok:false with the message VERBATIM", async () => {
    const { dir, coverOut } = await coverWorkdir();
    // Provenance whose still is NOT on disk — the cheap path has nothing to
    // re-use, and the message names the fix.
    await writeProvenance(dir, coverOut);
    await unlink(join(dir, "cover-frame.png"));
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const body = await (
      await fetch(`${server.url}/api/cover/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "NEW" }),
      })
    ).json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cover-frame.png");
  });

  it("409 while a regeneration is already in flight", async () => {
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async (_props, o) => {
        started();
        await gate;
        await writeFile(o.outPath, JPEG);
      },
    });
    close = server.close;
    const first = fetch(`${server.url}/api/cover/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ONE" }),
    });
    // Deterministic, not a sleep: the second request goes out only once the
    // first is provably inside the render.
    await startedP;
    const second = await fetch(`${server.url}/api/cover/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "TWO" }),
    });
    expect(second.status).toBe(409);
    release();
    expect(((await (await first).json()) as { ok: boolean }).ok).toBe(true);
  });

  it("preview renders to the one-off path and leaves the canonical cover byte-identical", async () => {
    // handoff-cover-panel §3: before this endpoint every diagnostic attempt
    // DESTROYED the previous cover, so "wrong frame" and "nothing happened"
    // were indistinguishable from the UI. The preview rides the same one-off
    // `--out` machinery as `ossclip cover --out /tmp/try.jpg`.
    //
    // The cheap path (no atSec) on purpose: startEditServer seams only
    // `renderCover`, and a frame extraction would fall through to real
    // ffmpeg — the one thing this suite must never run.
    const { dir, coverOut } = await coverWorkdir();
    await writeProvenance(dir, coverOut);
    await writeFile(coverOut, JPEG);
    // Distinct bytes, so "the canonical cover survived" is provable by
    // content rather than by mtime.
    const PREVIEW_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x42]);
    const destinations: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async (_props, o) => {
        destinations.push(o.outPath);
        await writeFile(o.outPath, PREVIEW_JPEG);
      },
    });
    close = server.close;
    // Nothing previewed yet — a 404, the /api/cover/image posture.
    expect((await fetch(`${server.url}/api/cover/preview-image`)).status).toBe(404);
    const res = await fetch(`${server.url}/api/cover/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "TRY THIS", from: "final" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // (a) the render landed at the workdir's own one-off file, never at the
    // canonical destination and never anywhere the body could name.
    const previewPath = join(dir, "cover-preview.jpg");
    expect(destinations).toEqual([previewPath]);
    expect(existsSync(previewPath)).toBe(true);
    // (b) the canonical cover is byte-identical to before the preview.
    expect([...new Uint8Array(await readFile(coverOut))]).toEqual([...JPEG]);
    // (c) the URL is ?ts-busted on the PREVIEW file's mtime and serves it.
    expect(body.previewImageUrl).toBe(
      `/api/cover/preview-image?ts=${Math.round(statSync(previewPath).mtimeMs)}`,
    );
    const img = await fetch(`${server.url}/api/cover/preview-image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([...PREVIEW_JPEG]);
    // (d) the one-off note rides back — the panel's disclosure that
    // cover.json now describes the previewed frame while the canonical JPEG
    // still shows the old one.
    expect(body.notes.join("\n")).toContain("one-off");
  });

  it("serves the RESOLVED cutlist, never the proposal — the finished mp4's own span set", async () => {
    // The opposite preference from /api/cleanup, on purpose: the cover panel
    // converts the playhead between the output clock and the source clock
    // (handoff-cover-panel §1), and only the resolved `cutlist` — the spans
    // the mp4 was actually assembled from — is that ruler. The proposal
    // still contains the removals the user's vetoes put back.
    const { dir } = await coverWorkdir();
    const cutlist = [
      { srcIn: 0, srcOut: 8, kind: "keep" },
      { srcIn: 11, srcOut: 20, kind: "keep" },
    ];
    await writeFile(
      join(dir, "production.json"),
      JSON.stringify({
        cutlist,
        cutlistProposed: [
          { srcIn: 0, srcOut: 8, kind: "keep" },
          { srcIn: 8, srcOut: 11, kind: "remove", reason: "pause", confidence: 0.9 },
          { srcIn: 11, srcOut: 20, kind: "keep" },
        ],
      }),
    );
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/cover`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cutlist: unknown[] }).cutlist).toEqual(cutlist);
  });

  it("cutlist degrades to [] with no production.json — the panel must still open", async () => {
    // The /api/cleanup posture: a workdir without a production.json (or a
    // corrupt one) costs the clock conversion, never the whole panel.
    const { dir } = await coverWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      renderCover: async () => {},
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/cover`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cutlist: unknown[] }).cutlist).toEqual([]);
  });
});

describe("GET /api/cleanup (cut review step 2, 2026-08-19)", () => {
  const cleanupOf = async (url: string): Promise<{ status: number; cutlist: unknown[] }> => {
    const res = await fetch(`${url}/api/cleanup`);
    const body = (await res.json()) as { cutlist?: unknown[] };
    return { status: res.status, cutlist: body.cutlist ?? [] };
  };

  it("serves the labeled cutlist produce wrote into production.json", async () => {
    const dir = await fixtureWorkdir();
    const cutlist = [
      { srcIn: 0, srcOut: 8, kind: "keep" },
      { srcIn: 8, srcOut: 11, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 11, srcOut: 20, kind: "keep" },
    ];
    await writeFile(join(dir, "production.json"), JSON.stringify({ cutlist }));
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const { status, cutlist: served } = await cleanupOf(server.url);
    expect(status).toBe(200);
    expect(served).toEqual(cutlist);
  });

  it("prefers cutlistProposed over cutlist (cut review step 3) — a declined pause must stay visible", async () => {
    // The resolved `cutlist` has already merged a vetoed removal into a plain
    // keep, so serving it would hide the very veto the checkboxes exist to
    // show; the PROPOSAL is what the editor reasons about, with the user's
    // `cleanup` choices applied client-side through the same pure function
    // produce ran.
    const dir = await fixtureWorkdir();
    const cutlistProposed = [
      { srcIn: 0, srcOut: 8, kind: "keep" },
      { srcIn: 8, srcOut: 11, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 11, srcOut: 20, kind: "keep" },
    ];
    await writeFile(
      join(dir, "production.json"),
      JSON.stringify({
        cutlist: [{ srcIn: 0, srcOut: 20, kind: "keep" }],
        cutlistProposed,
      }),
    );
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await cleanupOf(server.url)).cutlist).toEqual(cutlistProposed);
  });

  it("a hand-edited bad span drops ALONE — the rest of the cutlist survives it", async () => {
    // The zod-per-span rule: one string srcIn must cost exactly one span,
    // not the whole endpoint (a NaN through a cast would position a seam
    // off-screen; a throw would 500 the read path).
    const dir = await fixtureWorkdir();
    await writeFile(
      join(dir, "production.json"),
      JSON.stringify({
        cutlist: [
          { srcIn: 0, srcOut: 8, kind: "keep" },
          { srcIn: "eight", srcOut: 11, kind: "remove", reason: "pause" },
          { srcIn: 11, srcOut: 20, kind: "remove", reason: "retake" },
        ],
      }),
    );
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const { cutlist } = await cleanupOf(server.url);
    expect(cutlist).toEqual([
      { srcIn: 0, srcOut: 8, kind: "keep" },
      { srcIn: 11, srcOut: 20, kind: "remove", reason: "retake" },
    ]);
  });

  it("degrades to an empty cutlist when production.json is missing, corrupt, or cutlist-less", async () => {
    // The /api/usage posture, verbatim: GET paths read leniently — the
    // timeline draws no seams, the editor never sees a 500.
    const missing = await fixtureWorkdir();
    const corrupt = await fixtureWorkdir();
    await writeFile(join(corrupt, "production.json"), "{ not json");
    const cutless = await fixtureWorkdir();
    await writeFile(join(cutless, "production.json"), JSON.stringify({ producer: "llm" }));
    for (const dir of [missing, corrupt, cutless]) {
      const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
      close = server.close;
      expect(await cleanupOf(server.url)).toEqual({ status: 200, cutlist: [] });
      server.close();
      close = undefined;
    }
  });

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/cleanup`)).status).toBe(409);
  });
});

describe("publish endpoints (2026-08-26)", () => {
  const pack = {
    titles: ["How agents actually work", "5 agent mistakes", "Agents in 8 minutes"],
    description: "d",
    hashtags: ["#agents"],
    tags: [],
    linkedinPost: "authored linkedin post",
  };
  const env = { OSSCLIP_POSTIZ_API_KEY: "sekret" } as NodeJS.ProcessEnv;
  const cfg = () => ({ postizUrl: "https://p.example.com" });

  const jsonRes = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** A workdir with a pack, a recorded out AND the final mp4 on disk. */
  async function publishWorkdir(): Promise<{ dir: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-"));
    await writeFile(
      join(dir, "render-props.json"),
      JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
    );
    await writeFile(join(dir, "clip.mp4"), CLIP_CONTENT);
    const out = join(dir, "final.mp4");
    await writeFile(out, "rendered");
    await writeFile(join(dir, "youtube-aaaaaaaa.json"), JSON.stringify(pack));
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4"],
        cwd: dir,
        out,
      }),
    );
    return { dir, out };
  }

  it("unconfigured: GET says so with the fix, POST is 412 — the endpoint exists only once Postiz is set up", async () => {
    const { dir } = await publishWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: () => ({}),
      publishEnv: {} as NodeJS.ProcessEnv,
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/publish`)).json();
    expect(body.configured).toBe(false);
    expect(body.reason).toContain("postizUrl");
    const post = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"] }),
    });
    expect(post.status).toBe(412);
  });

  it("GET lists integrations with the caption the publish WOULD use — the API key never reaches the browser", async () => {
    const { dir } = await publishWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: cfg,
      publishEnv: env,
      publishFetch: async () =>
        jsonRes(200, [{ id: "a", name: "Ahsan", identifier: "linkedin" }]),
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/publish`)).json();
    expect(body).toMatchObject({
      configured: true,
      reachable: true,
      packAvailable: true,
      outPathExists: true,
      receipt: null,
    });
    expect(body.integrations).toEqual([
      { id: "a", provider: "linkedin", name: "Ahsan", caption: "authored linkedin post" },
    ]);
    expect(JSON.stringify(body)).not.toContain("sekret");
  });

  it("an unreachable Postiz is a labeled state, not a 500 — the panel renders the hint", async () => {
    const { dir } = await publishWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: cfg,
      publishEnv: env,
      publishFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/publish`)).json();
    expect(body.configured).toBe(true);
    expect(body.reachable).toBe(false);
  });

  it("POST publishes to the picked integrations and writes the receipt", async () => {
    const { dir } = await publishWorkdir();
    const calls: string[] = [];
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: cfg,
      publishEnv: env,
      publishFetch: async (u) => {
        calls.push(String(u));
        if (String(u).endsWith("/integrations"))
          return jsonRes(200, [{ id: "a", name: "Ahsan", identifier: "linkedin" }]);
        if (String(u).endsWith("/upload")) return jsonRes(200, { id: "m-1", path: "/up/f.mp4" });
        return jsonRes(200, [{ id: "post-1" }]);
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"], captions: { a: "edited caption" } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.receipt.postIds).toEqual(["post-1"]);
    expect(existsSync(join(dir, "publish-receipt.json"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/posts"))).toBe(true);

    // The receipt now guards a double-post: same POST without force is 412.
    const again = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"] }),
    });
    expect(again.status).toBe(412);
    const forced = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"], force: true }),
    });
    expect(forced.status).toBe(200);
  });

  it("zod 400s: no integrationIds; a past schedule time is rejected", async () => {
    const { dir } = await publishWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: cfg,
      publishEnv: env,
      publishFetch: async () => jsonRes(200, []),
    });
    close = server.close;
    const missing = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: [] }),
    });
    expect(missing.status).toBe(400);
    const past = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"], at: "2020-01-01T00:00:00Z" }),
    });
    expect(past.status).toBe(400);
  });

  it("a Postiz-side failure surfaces verbatim as 502 and writes NO receipt", async () => {
    const { dir } = await publishWorkdir();
    const server = await startEditServer(dir, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: cfg,
      publishEnv: env,
      publishFetch: async (u) => {
        if (String(u).endsWith("/integrations"))
          return jsonRes(200, [{ id: "a", name: "Ahsan", identifier: "linkedin" }]);
        return new Response("bad settings", { status: 400 });
      },
    });
    close = server.close;
    const res = await fetch(`${server.url}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ integrationIds: ["a"] }),
    });
    expect(res.status).toBe(502);
    expect(existsSync(join(dir, "publish-receipt.json"))).toBe(false);
  });
});

describe("GET /api/transcript (captions over revived material)", () => {
  it("serves the workdir's transcript verbatim, and null when absent or corrupt", async () => {
    const dir = await fixtureWorkdir();
    await writeFile(
      join(dir, "transcript.json"),
      JSON.stringify({ language: "en", words: [{ text: "um", start: 4.6, end: 4.9 }] }),
    );
    const server = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    const body = await (await fetch(`${server.url}/api/transcript`)).json();
    expect(body.transcript.words).toEqual([{ text: "um", start: 4.6, end: 4.9 }]);

    await writeFile(join(dir, "transcript.json"), "{not json");
    const corrupt = await (await fetch(`${server.url}/api/transcript`)).json();
    expect(corrupt.transcript).toBeNull();
  });

  it("409 with no workdir open, like every workdir endpoint", async () => {
    const server = await startEditServer(undefined, { port: 0, recentDir: SHARED_RECENTS });
    close = server.close;
    expect((await fetch(`${server.url}/api/transcript`)).status).toBe(409);
  });
});
