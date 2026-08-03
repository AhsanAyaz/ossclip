import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { OverrideDocSchema, emptyOverrideDoc } from "@ossclip/core";

/**
 * Where the built editor page lives (R18 §90b): `editor-dist/` inside this
 * package for an npm install (prepack copies the Vite build there so
 * `ossclip edit` works with no build step), else the monorepo sibling's
 * `dist/` for a clone. Null when neither exists — callers own the loud
 * error, and `ossclip doctor` reports it as a check.
 */
export function resolveEditorPageDir(): string | null {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [join(pkgRoot, "editor-dist"), join(pkgRoot, "../editor/dist")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/**
 * The editor's backend: a handful of endpoints and a static file server,
 * deliberately dependency-free. It reads the workdir a `produce` run left
 * behind and owns exactly one file — `overrides.json`. The render endpoint
 * replays the invocation `produce` recorded, never anything a client sent.
 */

/**
 * The invocation `produce` recorded into the workdir (R11 Task 4.1).
 * Validated on read — it's a file on disk like any other user data — and the
 * ONLY thing `/api/render` will ever spawn: this server binds locally, but
 * accepting a client-supplied command would make it a remote shell.
 */
const CommandSchema = z.object({
  execPath: z.string(),
  execArgv: z.array(z.string()).default([]),
  script: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  out: z.string().optional(),
});

/** Ring-buffer cap for captured render output. */
const RENDER_LOG_LINES = 200;
export interface EditServer {
  url: string;
  close: () => void;
}

/** A workdir is exactly "a directory a produce run wrote its props into". */
const isWorkdir = (dir: string): boolean => existsSync(join(dir, "render-props.json"));

/** Where the recent-projects list lives — beside config.json. Overridable
 * for tests, which must not write into the runner's real home. */
const recentsPath = (dir?: string): string =>
  join(dir ?? join(homedir(), ".ossclip"), "recent-projects.json");

/** Recent workdirs, newest first, invalid entries filtered at READ time —
 * a deleted workdir silently drops off the list instead of 404ing a click. */
export async function readRecentProjects(recentDir?: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentsPath(recentDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && isWorkdir(p));
  } catch {
    return [];
  }
}

/**
 * Remember a workdir (R17 §83) — called by `produce` after a successful run
 * and by the edit server on every open, so the picker's "recent" list is the
 * projects you actually touched. Best-effort: a read-only home must never
 * fail a produce run over a convenience file.
 */
export async function recordRecentProject(dir: string, recentDir?: string): Promise<void> {
  try {
    const path = recentsPath(recentDir);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readRecentProjects(recentDir);
    const next = [resolve(dir), ...existing.filter((p) => p !== resolve(dir))].slice(0, 12);
    await writeFile(path, JSON.stringify(next, null, 2));
  } catch {
    // Convenience only.
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

/**
 * Correct-by-construction containment check. `file.startsWith(parent)` is a
 * naive string-prefix test with no separator boundary: it's fooled both by
 * sibling directories that merely share a prefix (`/tmp/wd` vs
 * `/tmp/wd-evil/secret`) and — because `decodeURIComponent` runs AFTER a
 * prefix check would happen — by a `..%2Fsibling%2Ffile` request, whose
 * `%2F` survives WHATWG URL's dot-segment normalization as an opaque
 * segment and only becomes a real `..` once decoded. `path.relative` is
 * asked instead: `child` is inside `parent` iff the relative path from one
 * to the other never has to climb out with `..`.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Parse a `Range: bytes=start-end` header against a known file size, or
 * `undefined` if there's no header, it's malformed, or it's out of bounds. */
function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (!match) return undefined;
  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || end >= size) return undefined;
  return { start, end };
}

/**
 * Serve a file, honouring a `Range: bytes=...` request with 206 +
 * Content-Range when `supportsRange` is set (video seeking needs this);
 * otherwise a plain 200.
 *
 * Headers are written from the stream's `open` handler rather than upfront:
 * a read can still fail after `existsSync` was true (deleted mid-request,
 * permission change), and `createReadStream(...).pipe(res)` has no attached
 * `error` handler by default — an unhandled `error` event on a stream is
 * fatal to the whole process, not just this one request. Deferring the
 * headers means the common failure (open fails outright: ENOENT, EACCES)
 * can still turn into a clean 500 instead of a crash; a failure after open
 * succeeds (e.g. reading a directory) can only get the connection dropped,
 * since the 200 status line is already out the door by then.
 */
function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  contentType: string,
  supportsRange: boolean,
): void {
  const stat = statSync(file);
  const range = supportsRange ? parseRange(req.headers.range, stat.size) : undefined;
  const stream = range ? createReadStream(file, { start: range.start, end: range.end }) : createReadStream(file);

  let headersSent = false;
  stream.once("open", () => {
    headersSent = true;
    if (range) {
      res.writeHead(206, {
        "content-type": contentType,
        "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "accept-ranges": "bytes",
        "content-length": String(range.end - range.start + 1),
      });
    } else {
      res.writeHead(200, {
        "content-type": contentType,
        ...(supportsRange ? { "accept-ranges": "bytes" } : {}),
        "content-length": String(stat.size),
      });
    }
  });
  stream.on("error", (err) => {
    if (!headersSent && !res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

export async function startEditServer(
  workdirArg?: string,
  opts: { port?: number; pageDir?: string; recentDir?: string } = {},
): Promise<EditServer> {
  // MUTABLE since R17 §83: the server can start with no project (the page
  // shows a picker) and switch projects without restarting. Every workdir-
  // touching endpoint guards on null.
  let workdir: string | null = null;
  const propsPath = (): string => join(workdir!, "render-props.json");
  const overridesPath = (): string => join(workdir!, "overrides.json");
  const commandPath = (): string => join(workdir!, "command.json");
  const openWorkdir = async (dirArg: string): Promise<void> => {
    const dir = resolve(dirArg);
    if (!isWorkdir(dir)) {
      // Not "run produce there first" — the reported failure said that to a
      // user who HAD, because produce writes one level down into
      // .ossclip/<name>/ and this wanted that nested directory.
      // The layout is spelled with the host separator, as resolve-workdir.ts
      // does: hardcoded forward slashes here meant a Windows user met both
      // conventions from one product depending on which entry point they hit.
      throw new Error(
        `no render-props.json in ${dir} — produce writes into ` +
          `<video's folder>${sep}.ossclip${sep}<name>${sep}, and that nested folder ` +
          `is what edit opens`,
      );
    }
    workdir = dir;
    await recordRecentProject(dir, opts.recentDir);
  };
  if (workdirArg !== undefined) await openWorkdir(workdirArg);

  // One render at a time (R11 Task 4.2). The child is killed on server
  // close so a Ctrl-C on the edit server never orphans an ffmpeg.
  let renderChild: ChildProcess | null = null;
  let renderLines: string[] = [];
  let renderExit: number | null = null;
  // Spawn time, SERVER-side: the client derives its elapsed clock from this,
  // so a page reload mid-render still shows honest elapsed time rather than
  // restarting from zero.
  let renderStartedAt: number | null = null;
  // Whether the CURRENT run's end was a user cancel (R16 §60) — the child's
  // exit code alone can't say, and "render failed (exit 1)" after a
  // deliberate cancel reads as a bug.
  let renderCancelled = false;
  const pushLines = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      renderLines.push(line);
      if (renderLines.length > RENDER_LOG_LINES) renderLines.shift();
    }
  };

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (url.pathname === "/api/production" && req.method === "GET") {
          if (!workdir) {
            // Not an error — the picker state (R17 §83). Recents ride along
            // so the page needs no second request to draw it.
            return send(200, { noWorkdir: true, recent: await readRecentProjects(opts.recentDir) });
          }
          const renderProps = JSON.parse(await readFile(propsPath(), "utf8"));
          const overrides = existsSync(overridesPath())
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath(), "utf8")))
            : emptyOverrideDoc();
          return send(200, {
            renderProps,
            overrides,
            workdir,
            videoFileName: renderProps.videoFileName,
            // Whether the Render button has a recorded invocation to replay.
            canRender: existsSync(commandPath()),
            // Recents ride along here too, so the top bar's Open picker has
            // a list without a second endpoint.
            recent: await readRecentProjects(opts.recentDir),
          });
        }

        if (url.pathname === "/api/usage" && req.method === "GET") {
          // The run summary (R21 §104): what planned this video and what it
          // cost. Straight reads of the artefacts `produce` already writes —
          // usage.json carries per-run totals, production.json the producer
          // stamp and the clip window; the editor only has to display them.
          if (!workdir) return send(409, { error: "no workdir open" });
          const readJson = async (name: string): Promise<unknown> => {
            try {
              return JSON.parse(await readFile(join(workdir!, name), "utf8"));
            } catch {
              return null;
            }
          };
          const usage = await readJson("usage.json");
          const production = (await readJson("production.json")) as Record<string, unknown> | null;
          return send(200, {
            usage,
            production: production
              ? {
                  producer: production.producer ?? null,
                  clip: production.clip ?? null,
                  cleanup: production.cleanup ?? null,
                  intent: production.intent ?? null,
                  sourceDuration:
                    (production.source as { probe?: { duration?: number } } | undefined)?.probe
                      ?.duration ?? null,
                }
              : null,
          });
        }

        if (url.pathname === "/api/workdir" && req.method === "POST") {
          // Open/switch the project (R17 §83). Refused mid-render: the
          // running child belongs to the CURRENT workdir, and its status
          // reporting against a switched one would lie.
          if (renderChild) return send(409, { error: "a render is running — cancel it first" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = z
            .object({ path: z.string().min(1) })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: "expected { path }" });
          try {
            await openWorkdir(parsed.data.path);
          } catch (err) {
            return send(400, { error: err instanceof Error ? err.message : String(err) });
          }
          return send(200, { ok: true, workdir });
        }

        if (url.pathname === "/api/fs" && req.method === "GET") {
          // The picker's folder browser (R17 §83): directories only, with
          // "this one is a project" flagged. Local tool on a local loopback
          // — the same trust as typing the path as a CLI argument.
          // R21 §103: hidden directories are OMITTED — a dev home holds
          // dozens of dot-dirs, and listing them made the picker read as a
          // wall of noise — EXCEPT `.ossclip`, whose projects are the whole
          // point: its workdirs surface INLINE, so browsing ~/Downloads
          // shows the projects produced there without knowing the
          // convention directory exists.
          const dir = resolve(url.searchParams.get("dir") || homedir());
          try {
            const names = await readdir(dir, { withFileTypes: true });
            const entries: Array<{ name: string; path: string; isWorkdir: boolean }> = [];
            for (const d of names.filter((x) => x.isDirectory())) {
              if (d.name.startsWith(".")) {
                if (d.name !== ".ossclip") continue;
                try {
                  const inner = await readdir(join(dir, d.name), { withFileTypes: true });
                  for (const w of inner.filter((x) => x.isDirectory())) {
                    const path = join(dir, d.name, w.name);
                    if (isWorkdir(path)) {
                      entries.push({ name: `.ossclip/${w.name}`, path, isWorkdir: true });
                    }
                  }
                } catch {
                  // unreadable convention dir — nothing to surface
                }
                continue;
              }
              const path = join(dir, d.name);
              entries.push({ name: d.name, path, isWorkdir: isWorkdir(path) });
            }
            entries.sort((a, b) =>
              a.isWorkdir !== b.isWorkdir ? (a.isWorkdir ? -1 : 1) : a.name.localeCompare(b.name),
            );
            const parent = dirname(dir);
            return send(200, {
              dir,
              parent: parent === dir ? null : parent,
              isWorkdir: isWorkdir(dir),
              entries: entries.slice(0, 500),
            });
          } catch (err) {
            return send(400, { error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (url.pathname === "/api/render" && req.method === "POST") {
          // Replays ONLY the argv `produce` recorded — the request body is
          // never read, let alone executed.
          if (!workdir) return send(409, { error: "no workdir open" });
          if (renderChild) return send(409, { error: "a render is already running" });
          if (!existsSync(commandPath())) {
            return send(412, {
              error:
                "no command.json in this workdir — run `ossclip produce` once from " +
                "the terminal so the invocation is recorded, then Render can replay it",
            });
          }
          const parsed = CommandSchema.safeParse(
            JSON.parse(await readFile(commandPath(), "utf8")),
          );
          if (!parsed.success) return send(500, { error: `command.json is not valid: ${parsed.error.message}` });
          const cmd = parsed.data;
          renderLines = [];
          renderExit = null;
          renderStartedAt = Date.now();
          renderCancelled = false;
          const child = spawn(cmd.execPath, [...cmd.execArgv, cmd.script, ...cmd.args], {
            cwd: cmd.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          renderChild = child;
          child.stdout?.on("data", pushLines);
          child.stderr?.on("data", pushLines);
          child.on("error", (err) => {
            renderLines.push(`spawn failed: ${err.message}`);
            renderExit = 1;
            renderChild = null;
          });
          child.on("exit", (code) => {
            renderExit = code ?? 1;
            renderChild = null;
          });
          return send(202, { ok: true });
        }

        if (url.pathname === "/api/render/cancel" && req.method === "POST") {
          // Kill the replayed child (R16 §60). The exit handler above still
          // runs and clears `renderChild`; the flag lets the status say
          // "cancelled" instead of dressing a deliberate stop as a failure.
          if (!renderChild) return send(409, { error: "no render is running" });
          renderCancelled = true;
          renderChild.kill();
          return send(202, { ok: true });
        }

        if (url.pathname === "/api/render/status" && req.method === "GET") {
          return send(200, {
            running: renderChild !== null,
            exitCode: renderExit,
            lines: renderLines,
            startedAt: renderStartedAt,
            cancelled: renderCancelled,
          });
        }

        if (url.pathname === "/api/overrides" && req.method === "PUT") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = OverrideDocSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // Atomic: the producer may read this file at any moment, and a
          // half-written document would be worse than a stale one.
          const tmp = `${overridesPath()}.tmp`;
          await writeFile(tmp, JSON.stringify(parsed.data, null, 2));
          await rename(tmp, overridesPath());
          return send(200, { ok: true });
        }

        if (url.pathname.startsWith("/media/")) {
          if (!workdir) return send(409, { error: "no workdir open" });
          const file = join(workdir, decodeURIComponent(url.pathname.slice("/media/".length)));
          // Never serve outside the workdir, whatever the path claims.
          if (!isInside(workdir, file) || !existsSync(file)) return send(404, { error: "not found" });
          sendFile(req, res, file, MIME[extname(file)] ?? "application/octet-stream", true);
          return;
        }

        const pageDir = opts.pageDir;
        if (pageDir) {
          const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
          const file = join(pageDir, rel);
          if (isInside(pageDir, file) && existsSync(file)) {
            sendFile(req, res, file, MIME[extname(file)] ?? "text/plain", false);
            return;
          }
        }
        send(404, { error: "not found" });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 5174, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 5174);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      renderChild?.kill();
      server.close();
    },
  };
}
