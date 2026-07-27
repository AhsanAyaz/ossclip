import { createReadStream, existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { OverrideDocSchema, emptyOverrideDoc } from "@ossclip/core";

/**
 * The editor's backend: three endpoints and a static file server, deliberately
 * dependency-free. It reads the workdir a `produce` run left behind and owns
 * exactly one file — `overrides.json`.
 */
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      try {
        if (url.pathname === "/api/production" && req.method === "GET") {
          const renderProps = JSON.parse(await readFile(propsPath, "utf8"));
          const overrides = existsSync(overridesPath)
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath, "utf8")))
            : emptyOverrideDoc();
          return send(200, { renderProps, overrides, videoFileName: renderProps.videoFileName });
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
          if (!file.startsWith(workdir) || !existsSync(file)) return send(404, { error: "not found" });
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return void createReadStream(file).pipe(res);
        }

        const pageDir = opts.pageDir;
        if (pageDir) {
          const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const file = join(pageDir, rel);
          if (file.startsWith(pageDir) && existsSync(file)) {
            res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
            return void createReadStream(file).pipe(res);
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
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
