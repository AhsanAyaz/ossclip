import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { OverrideDocSchema, emptyOverrideDoc } from "@ossclip/core";

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
  workdirArg: string,
  opts: { port?: number; pageDir?: string } = {},
): Promise<EditServer> {
  const workdir = resolve(workdirArg);
  const propsPath = join(workdir, "render-props.json");
  if (!existsSync(propsPath)) {
    throw new Error(`no render-props.json in ${workdir} — run \`ossclip produce\` there first`);
  }
  const overridesPath = join(workdir, "overrides.json");
  const commandPath = join(workdir, "command.json");

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
          const renderProps = JSON.parse(await readFile(propsPath, "utf8"));
          const overrides = existsSync(overridesPath)
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath, "utf8")))
            : emptyOverrideDoc();
          return send(200, {
            renderProps,
            overrides,
            videoFileName: renderProps.videoFileName,
            // Whether the Render button has a recorded invocation to replay.
            canRender: existsSync(commandPath),
          });
        }

        if (url.pathname === "/api/render" && req.method === "POST") {
          // Replays ONLY the argv `produce` recorded — the request body is
          // never read, let alone executed.
          if (renderChild) return send(409, { error: "a render is already running" });
          if (!existsSync(commandPath)) {
            return send(412, {
              error:
                "no command.json in this workdir — run `ossclip produce` once from " +
                "the terminal so the invocation is recorded, then Render can replay it",
            });
          }
          const parsed = CommandSchema.safeParse(
            JSON.parse(await readFile(commandPath, "utf8")),
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
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = OverrideDocSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // Atomic: the producer may read this file at any moment, and a
          // half-written document would be worse than a stale one.
          const tmp = `${overridesPath}.tmp`;
          await writeFile(tmp, JSON.stringify(parsed.data, null, 2));
          await rename(tmp, overridesPath);
          return send(200, { ok: true });
        }

        if (url.pathname.startsWith("/media/")) {
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
