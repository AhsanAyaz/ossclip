import { describe, expect, it, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: "-e",
        args: ["console.log('hi from the recorded command')"],
        cwd: dir,
      }),
    );
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
    let status = { running: true, exitCode: null as number | null, lines: [] as string[] };
    for (let i = 0; i < 50 && (status.running || status.exitCode === null); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await (await fetch(`${server.url}/api/render/status`)).json();
    }
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

  it("cancel kills the child and the status says CANCELLED, not failed (R16 §60)", async () => {
    const dir = await fixtureWorkdir();
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: "-e",
        args: ["setTimeout(() => {}, 10000)"],
        cwd: dir,
      }),
    );
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
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: "-e",
        args: ["setTimeout(() => {}, 10000)"],
        cwd: dir,
      }),
    );
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
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: "-e",
        args: ["setTimeout(() => {}, 10000)"],
        cwd: dir,
      }),
    );
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
