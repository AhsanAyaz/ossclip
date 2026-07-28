import { describe, expect, it, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startEditServer } from "../src/edit";

let close: (() => void) | undefined;
afterEach(() => close?.());

const CLIP_CONTENT = "not-a-real-video";

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
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const res = await fetch(`${server.url}/api/production`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.renderProps.videoFileName).toBe("clip.mp4");
    expect(body.overrides).toEqual({ theme: {}, scenes: {}, captions: {} });
  });

  it("saves overrides to disk", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
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
    const server = await startEditServer(dir, { port: 0 });
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
    await expect(startEditServer(dir, { port: 0 })).rejects.toThrow(dir);
  });

  it("refuses a %2F-encoded traversal into a numeric-prefix sibling directory", async () => {
    // Reviewer's concrete failing input: workdir "clip-1"-shaped, sibling
    // "clip-10"-shaped — a naive `file.startsWith(workdir)` check is fooled
    // because "/tmp/clip-10" starts with the string "/tmp/clip-1".
    const dir = await fixtureWorkdir();
    const siblingDir = `${dir}0`; // e.g. ossclip-edit-XXXXXX -> ossclip-edit-XXXXXX0
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, "secret.txt"), "TOP SECRET NUMERIC SIBLING");

    const server = await startEditServer(dir, { port: 0 });
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

    const server = await startEditServer(dir, { port: 0 });
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
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const res = await fetch(`${server.url}/media/clip.mp4`);
    expect(res.status).toBe(500);
    await chmod(join(dir, "clip.mp4"), 0o644);
  });

  it("412 without command.json, and the production doc says the button can't work", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
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
    const server = await startEditServer(dir, { port: 0 });
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
    // The production doc now reports the button usable.
    const prod = await (await fetch(`${server.url}/api/production`)).json();
    expect(prod.canRender).toBe(true);
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
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${server.url}/api/render`, { method: "POST" })).status).toBe(409);
    const status = await (await fetch(`${server.url}/api/render/status`)).json();
    expect(status.running).toBe(true);
    // afterEach's close() kills the child — the suite must not hang on it.
  });

  it("honours a Range request with a 206 and Content-Range", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const res = await fetch(`${server.url}/media/clip.mp4`, { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${CLIP_CONTENT.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = await res.text();
    expect(body).toBe(CLIP_CONTENT.slice(0, 4));
  });
});
