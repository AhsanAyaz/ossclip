import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import {
  OverrideDocSchema,
  THUMBNAIL_APPROVED_BASENAME,
  YOUTUBE_APPROVED_BASENAME,
  YoutubePackSchema,
  formatYoutubeMarkdown,
  trimTagsToLimit,
  type YoutubePack,
  ThumbnailConceptApprovedSchema,
  ThumbnailConceptSchema,
  approvedOverlayText,
  buildThumbnailPrompt,
  emptyOverrideDoc,
  // Static import is fine here: the @google/genai SDK load is LAZY inside
  // this function (core's near-zero-dep rule), so the server pays for it
  // only when a regenerate actually runs.
  generateThumbnailImage,
  loadConfig,
  outInsideInputFolderMessage,
  outPathInsideInput,
  PORTRAIT_MIME_TYPES,
  portraitMimeType,
  readCoverProvenance,
  thumbnailImageCacheName,
  type CoverProvenance,
  type GenerateThumbnailImageOptions,
  type ThumbnailConcept,
  type ThumbnailConceptApproved,
} from "@ossclip/core";
// Static, unlike the picker's `await import` above its call site: the picker
// drags in @ossclip/core's process runner and llm-detect, worth deferring off
// server startup — open.ts is node:child_process + node:path and pure command
// building, with nothing to defer.
import { revealInFileManager } from "./open";
// The recorded-invocation reads live in cover.ts (2026-08-19): `ossclip
// cover` needs the same out-resolution rule this server's thumbnail dest,
// youtube markdown and reveal endpoint derive from, and two spellings of it
// could disagree about which file a replay writes. cover.ts stays free of a
// static @ossclip/renderer import for exactly this reason.
import {
  CoverAtSecondsSchema,
  CoverFromSchema,
  RecordedCommandSchema,
  readRecordedCommand,
  recordedArtifactPath as recordedArtifactPathIn,
  recordedOutPath,
  regenerateCover,
  type CoverSeams,
  type RecordedCommand,
} from "./cover";
import { expandHome } from "./paths";
import {
  PORTRAIT_OVERRIDE_BASENAME,
  portraitExtensionForMime,
  portraitOverridePath,
  resolvePortrait,
  type ResolvedPortrait,
} from "./portrait-override";
import { lastFlagValue, thumbnailPanelState } from "./thumbnail-panel";

/**
 * Where the built editor page lives (R18 §90b): `editor-dist/` inside this
 * package for an npm install (prepack copies the Vite build there so
 * `ossclip edit` works with no build step), else the monorepo sibling's
 * `dist/` for a clone. Null when neither exists — callers own the loud
 * error, and `ossclip doctor` reports it as a check.
 *
 * When BOTH exist, the newer index.html wins (§126): in a clone, a stale
 * `editor-dist/` left behind by a local prepack silently shadowed a fresh
 * `pnpm build` for a whole field session — the user reported a feature
 * missing that had shipped, because the server kept serving the old page.
 * In an npm install only `editor-dist/` exists, so the mtime tiebreak
 * never changes behavior there.
 */
export function resolveEditorPageDir(): string | null {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [join(pkgRoot, "editor-dist"), join(pkgRoot, "../editor/dist")]
    .filter((dir) => existsSync(join(dir, "index.html")))
    .sort(
      (a, b) =>
        statSync(join(b, "index.html")).mtimeMs - statSync(join(a, "index.html")).mtimeMs,
    );
  return candidates[0] ?? null;
}

/**
 * The editor's backend: a handful of endpoints and a static file server,
 * deliberately dependency-free. It reads the workdir a `produce` run left
 * behind and owns exactly one file — `overrides.json`. The render endpoint
 * replays the invocation `produce` recorded, never anything a client sent.
 */

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
  // The caption timing editor's waveform fetches `/media/audio.wav` (produce
  // writes it into every workdir). `fetch` + `decodeAudioData` would accept
  // the octet-stream fallback, but a future `<audio>` element would not, so
  // the type is stated while the change is one line rather than a debugging
  // session.
  ".wav": "audio/wav",
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
  opts: {
    port?: number;
    pageDir?: string;
    recentDir?: string;
    /** The image-generation seam (thumbnailStep's `generate` shape) — tests
     * inject a stub and never import @google/genai. */
    generateThumbnail?: (o: GenerateThumbnailImageOptions) => Promise<Uint8Array>;
    /** Config seam for the thumbnail panel — tests inject `() => ({})` so a
     * run never reads the runner's real ~/.ossclip/config.json (the
     * `recentDir` rule applied to reads). */
    loadCfg?: () => { youtube?: unknown; portrait?: unknown; thumbnailModel?: unknown };
    /** File-manager reveal seam (the `generateThumbnail` pattern) — tests
     * observe the revealed path instead of popping a real Finder/Explorer
     * window on the runner. */
    reveal?: (path: string) => void;
    /**
     * The cover render seam, exactly like `generateThumbnail` above. Without
     * it `regenerateCover` lazily imports @ossclip/renderer and boots a
     * headless browser — which `edit-server.test.ts` must never do, and which
     * is also why cover.ts keeps that import lazy in the first place.
     */
    renderCover?: CoverSeams["renderCover"];
  } = {},
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

  // ---- AI thumbnail (editor panel, 2026-08-17) ----------------------------
  // The panel round-trips through the workdir's approval file
  // (thumbnail-concept-approved.json), NOT overrides.json: the approval file
  // is the contract thumbnailStep already honors on every CLI replay, so an
  // edit persisted there survives into future renders with zero new plumbing.
  const approvedConceptPath = (): string => join(workdir!, THUMBNAIL_APPROVED_BASENAME);
  // One image call at a time — it costs money, and a double-click must not
  // buy two.
  let thumbnailBusy = false;
  /** command.json's recorded invocation, or null when absent/corrupt — the
   * thumbnail panel degrades to the config fallback rather than 500ing.
   * Bound to the CURRENT workdir; the rule itself lives in cover.ts. */
  const readCommandRecord = (): Promise<RecordedCommand | null> => readRecordedCommand(workdir!);
  /** `<out><ext>` from the recorded out, or null when no out was ever
   * recorded. Shared by the thumbnail dest and the youtube markdown. */
  const recordedArtifactPath = (ext: string): Promise<string | null> =>
    recordedArtifactPathIn(workdir!, ext);
  const thumbnailDestPath = (): Promise<string | null> => recordedArtifactPath(".thumbnail.png");
  /** Newest workdir file passing `test`, by mtime — the cache fallbacks. */
  const newestWorkdirFile = async (test: (name: string) => boolean): Promise<string | null> => {
    const names = (await readdir(workdir!)).filter(test);
    const paths = names
      .map((n) => join(workdir!, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return paths[0] ?? null;
  };
  /** The image the panel shows: the destination copy when it exists, else
   * the newest workdir cache — a --no-render run (or a moved output) still
   * has the cache to show. */
  const currentThumbnailImage = async (): Promise<string | null> => {
    const dest = await thumbnailDestPath();
    if (dest !== null && existsSync(dest)) return dest;
    return newestWorkdirFile((n) => n.startsWith("thumbnail-") && n.endsWith(".png"));
  };
  /** The approved file, parsed — null when absent or corrupt (a corrupt
   * decision file must not brick the panel; the next regenerate atomically
   * replaces it). */
  const readApprovedConcept = async (): Promise<ThumbnailConceptApproved | null> => {
    if (!existsSync(approvedConceptPath())) return null;
    try {
      const parsed = ThumbnailConceptApprovedSchema.safeParse(
        JSON.parse(await readFile(approvedConceptPath(), "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  // ---- Cover regeneration (editor panel, 2026-08-19) ----------------------
  // The cover is written on EVERY produce, `--youtube` or not, so this is not
  // a YouTube-menu concern — it has its own top-bar button in the page. The
  // panel round-trips through the workdir's `cover.json`, which is the same
  // provenance `ossclip cover` reads and produce honours (`textSource:
  // "user"`), so an edit made here survives into future renders with no new
  // plumbing — the thumbnail block's approval-file contract, applied.
  //
  // One regeneration at a time: it can shell out to ffmpeg and it boots a
  // headless browser, and a double-click must not run two renders at the same
  // destination. `thumbnailBusy`'s rule, for the same reason.
  let coverBusy = false;
  /** Where the JPEG lives right now: the destination the last cover used,
   * else `<recorded out>.cover.jpg`. Existence is the caller's check — a
   * recorded destination that was never rendered is a real state (the panel
   * shows a placeholder), not an error. */
  const currentCoverImage = async (provenance: CoverProvenance | null): Promise<string | null> => {
    if (provenance !== null && existsSync(provenance.out)) return provenance.out;
    const dest = await recordedArtifactPath(".cover.jpg");
    return dest !== null && existsSync(dest) ? dest : null;
  };
  /** mtime as the ts so the URL changes exactly when the file does — the
   * thumbnail imageUrl's own cache-busting rule (a regenerate REPLACES the
   * file behind this URL). */
  const coverImageUrl = (image: string | null): string | null =>
    image === null ? null : `/api/cover/image?ts=${Math.round(statSync(image).mtimeMs)}`;

  // ---- Portrait override (editor face swap, 2026-08-17) -------------------
  // A per-project `portrait-override.<ext>` in the workdir that outranks the
  // pin and the config (portrait-override.ts has the precedence argument).
  // Decoded size cap for an uploaded portrait — generous for a headshot, but
  // a bound: this whole body is buffered in memory before the write.
  const PORTRAIT_MAX_BYTES = 15 * 1024 * 1024;
  /** The portrait a render would use right now — resolvePortrait is the same
   * helper thumbnailPanelState runs, so the portrait-image endpoint and the
   * DELETE response can never disagree with the panel state. */
  const resolveServerPortrait = async (): Promise<ResolvedPortrait | undefined> => {
    const cmd = await readCommandRecord();
    return resolvePortrait({
      overridePath: portraitOverridePath(workdir!),
      flagPortrait: lastFlagValue(cmd?.args ?? [], ["--portrait"]),
      cfgPortrait: (opts.loadCfg ?? loadConfig)().portrait,
    });
  };
  /** The GET/POST/DELETE responses' portrait block: where to fetch the
   * resolved portrait and which precedence level won — null when none
   * resolved or the resolved path points at nothing. mtime as the ts, the
   * thumbnail imageUrl's own cache-busting rule. */
  const portraitResponse = (resolved: ResolvedPortrait | undefined): { url: string; source: string } | null =>
    resolved !== undefined && existsSync(resolved.path)
      ? {
          url: `/api/thumbnail/portrait-image?ts=${Math.round(statSync(resolved.path).mtimeMs)}`,
          source: resolved.source,
        }
      : null;

  // ---- YouTube SEO pack (editor panel, 2026-08-17) ------------------------
  // The thumbnail block's approval-file contract applied to the pack: the
  // panel round-trips through youtube-pack-approved.json, which produce's Y2
  // block honors VERBATIM on every replay — an edit persisted there survives
  // into future renders with zero new plumbing.
  const approvedPackPath = (): string => join(workdir!, YOUTUBE_APPROVED_BASENAME);
  /** The pack the panel shows: the approved file first (the user's
   * decision), else the newest valid `youtube-<key>.json` cache (what the
   * last produce generated), else null — the run never generated metadata.
   * Lenient reads throughout, the GET-path posture: a corrupt file is
   * skipped, never a 500. */
  const currentYoutubePack = async (): Promise<YoutubePack | null> => {
    const caches = (await readdir(workdir!))
      // The approved basename itself matches the `youtube-` prefix — exclude
      // it from the cache list so it can't be read twice with two postures.
      .filter(
        (n) => n.startsWith("youtube-") && n.endsWith(".json") && n !== YOUTUBE_APPROVED_BASENAME,
      )
      .map((n) => join(workdir!, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const candidates = existsSync(approvedPackPath()) ? [approvedPackPath(), ...caches] : caches;
    for (const path of candidates) {
      try {
        const parsed = YoutubePackSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (parsed.success) return parsed.data;
      } catch {
        // skip a corrupt file
      }
    }
    return null;
  };

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
          // Parsed, never cast — and that parse is also what makes the doc
          // safe to migrate downstream: a literal `"__proto__"` caption key
          // survives `JSON.parse` as an own property, and any later pass that
          // rebuilds the record would assign through it instead of keeping it.
          const overrides = existsSync(overridesPath())
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath(), "utf8")))
            : emptyOverrideDoc();
          // §137 DECISION (Task 6): the pre-§137 caption-key migration does
          // NOT run here. It resolves a positional key by finding the word it
          // named and taking that word's source anchor — and these render
          // props are served exactly as they sit on disk, where a pre-§137
          // file's caption words have no `srcStart` at all. Every word would
          // answer "no anchor", every edit would land in `unresolved`, and the
          // migration would report total loss while doing nothing: a call that
          // passes its own tests and is inert in production.
          // Anchoring them here instead would mean a second copy of the "no
          // usable map, no repair" rule (`anchorCaptionLines`, apps/editor) in
          // this package — the CLI cannot import the editor's source, which it
          // only ever ships as a built `editor-dist/` — and that rule is
          // exactly the one §137 refuses to have two of. So the EDITOR owns
          // the repair, at the one point that holds anchored lines and the doc
          // at the same time (App.tsx's load path), and it loses no reach:
          // this endpoint has exactly one consumer.
          return send(200, {
            renderProps,
            overrides,
            workdir,
            videoFileName: renderProps.videoFileName,
            // Whether the Render button has a recorded invocation to replay.
            canRender: existsSync(commandPath()),
            defaultOutPath: (() => {
              try {
                if (existsSync(commandPath())) {
                  const cmd = JSON.parse(readFileSync(commandPath(), "utf8")) as { args?: string[] };
                  if (Array.isArray(cmd.args)) {
                    const idx = cmd.args.findIndex((a) => a === "-o" || a === "--out");
                    if (idx !== -1 && cmd.args[idx + 1]) return cmd.args[idx + 1];
                  }
                }
              } catch {
                // ignore
              }
              return undefined;
            })(),
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

        if (url.pathname === "/api/pick-save-path" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          let defaultPath: string | undefined;
          try {
            const raw = Buffer.concat(chunks).toString();
            if (raw.trim()) {
              const body = JSON.parse(raw) as { defaultPath?: string };
              if (typeof body.defaultPath === "string") defaultPath = body.defaultPath;
            }
          } catch {
            // ignore
          }
          let startLoc = defaultPath;
          if (!startLoc && workdir) {
            startLoc = dirname(workdir);
          }
          const { pickPath, livePickerDeps } = await import("./interactive/picker");
          const picked = await pickPath("save", livePickerDeps(), startLoc);
          return send(200, { path: picked ?? null });
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
          if (!workdir) return send(409, { error: "no workdir open" });
          if (renderChild) return send(409, { error: "a render is already running" });
          if (!existsSync(commandPath())) {
            return send(412, {
              error:
                "no command.json in this workdir — run `ossclip produce` once from " +
                "the terminal so the invocation is recorded, then Render can replay it",
            });
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          let customOut: string | undefined;
          try {
            const raw = Buffer.concat(chunks).toString();
            if (raw.trim()) {
              const body = JSON.parse(raw) as { out?: string };
              if (typeof body.out === "string" && body.out.trim()) {
                customOut = body.out.trim();
              }
            }
          } catch {
            // ignore
          }
          const parsed = RecordedCommandSchema.safeParse(
            JSON.parse(await readFile(commandPath(), "utf8")),
          );
          if (!parsed.success) return send(500, { error: `command.json is not valid: ${parsed.error.message}` });
          const cmd = parsed.data;
          // §129: heal legacy records at replay. Before the fix, wizard and
          // bare-path runs recorded process.argv — the ORIGINAL invocation,
          // missing the `produce` literal the re-entered parse actually ran —
          // so replaying them verbatim dies at commander's front door with
          // "error: unknown option '--llm'". produce is the ONLY command that
          // ever writes command.json, so an args array not starting with
          // "produce" can only be that bug: prepend the literal to
          // reconstruct the command that ran. A modern record — and a legacy
          // directly-typed `ossclip produce …` — already starts with it and
          // is untouched.
          let args = cmd.args[0] === "produce" ? [...cmd.args] : ["produce", ...cmd.args];
          // 2026-08-18 field cascade: mirror produce's own inside-the-input
          // refusal at this boundary, so the failure is a 400 the page can
          // show instead of a spawned child dying in the log tail. The input
          // is derived from the RECORDED command only — the security stance
          // above: beyond the out path it already controls, nothing the
          // client sent may steer what this endpoint checks or touches.
          // args[1] after the §129 heal is the recorded input positional;
          // when a record put flags before the input, or the input no longer
          // stats, the gate stays open and produce's own refusal still
          // protects the replay.
          if (customOut !== undefined && args[1] !== undefined) {
            const inputAbs = resolve(cmd.cwd, expandHome(args[1]));
            let inputIsFolder = false;
            try {
              inputIsFolder = statSync(inputAbs).isDirectory();
            } catch {
              // input gone/unreadable — the replay will fail on its own terms
            }
            if (inputIsFolder && outPathInsideInput(resolve(cmd.cwd, expandHome(customOut)), inputAbs)) {
              return send(400, { error: outInsideInputFolderMessage(inputAbs) });
            }
          }
          if (customOut) {
            const filteredArgs: string[] = [];
            for (let i = 0; i < args.length; i++) {
              if (args[i] === "-o" || args[i] === "--out") {
                i++;
              } else {
                filteredArgs.push(args[i]!);
              }
            }
            filteredArgs.push("--out", customOut);
            args = filteredArgs;
          }
          renderLines = [];
          renderExit = null;
          renderStartedAt = Date.now();
          renderCancelled = false;
          const child = spawn(cmd.execPath, [...cmd.execArgv, cmd.script, ...args], {
            cwd: cmd.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            // Which workdir's command.json this replay came from (2026-08-18
            // field cascade, part 3): a re-keyed folder input makes produce
            // derive a DIFFERENT workdir, silently abandoning the overrides
            // saved here — produce compares against this and prints a loud ⚠
            // into the log tail (replayWorkdirWarning, produce.ts).
            env: { ...process.env, OSSCLIP_REPLAY_WORKDIR: workdir! },
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

        if (url.pathname === "/api/reveal-output" && req.method === "POST") {
          // Show the finished render in the file manager (2026-08-18). The
          // path comes from command.json's recorded out and NOWHERE else —
          // the request body is deliberately never read. The security stance
          // at the top of this file: this server binds locally, but an
          // endpoint that reveals (and one day might do more to) a
          // client-named path is the same door as spawning a client-supplied
          // command.
          if (!workdir) return send(409, { error: "no workdir open" });
          const cmd = await readCommandRecord();
          const out = cmd === null ? null : recordedOutPath(cmd);
          if (out === null) {
            return send(412, { error: "no recorded output path in this workdir" });
          }
          if (!existsSync(out)) {
            // Recorded but not rendered yet (or moved since) — a 404 the
            // page treats as "nothing to show", not a failure.
            return send(404, { error: `no output at ${out} yet` });
          }
          (opts.reveal ?? revealInFileManager)(out);
          return send(200, { ok: true, path: out });
        }

        if (url.pathname === "/api/overrides" && req.method === "PUT") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = OverrideDocSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // NO `.bak` HERE, and that is a decision, not an omission (final
          // review, Important 5). This write is safe without one only because
          // it ROUND-TRIPS: whatever the editor loaded, it saves back, plus
          // the change the user just made. §137 briefly broke that property —
          // `migrateLoadedDoc` stripped the caption edits the migration could
          // not place before `edits.load` (which also clears undo), so the
          // first save after opening a legacy project deleted them
          // permanently. The fix is in `migrateLoadedDoc`, which now keeps
          // them, rather than here.
          //
          // Adding produce's `.bak` to this handler was the other option and
          // is actively worse: `overrides.json.bak` is single-generation and
          // SHARED with produce's write, so a routine ⌘S would spend the one
          // the user's pre-cut save is sitting in — which on the §137 field
          // workdir is the only artefact their deleted split half can ever be
          // recovered from (`legacySplitId`). That is the review's own
          // Critical 2 reintroduced through the editor.
          //
          // Atomic: the producer may read this file at any moment, and a
          // half-written document would be worse than a stale one.
          const tmp = `${overridesPath()}.tmp`;
          await writeFile(tmp, JSON.stringify(parsed.data, null, 2));
          await rename(tmp, overridesPath());
          return send(200, { ok: true });
        }

        if (url.pathname === "/api/thumbnail" && req.method === "GET") {
          // The panel's one status call (2026-08-17): availability, the
          // concept to prefill, and where the current image is. All reads —
          // the panel owns no state on the server.
          if (!workdir) return send(409, { error: "no workdir open" });
          const cmd = await readCommandRecord();
          const approved = await readApprovedConcept();
          const approvedSkip = approved !== null && "skip" in approved;
          let concept: ThumbnailConcept | null = approved !== null && !("skip" in approved) ? approved : null;
          if (concept === null) {
            // No approval on file — prefill from the newest concept cache, so
            // the panel starts from what the last produce actually prompted
            // with. Opportunistic: a corrupt cache is skipped, never a 500.
            const names = (await readdir(workdir)).filter(
              (n) =>
                n.startsWith("thumbnail-concept-") &&
                n.endsWith(".json") &&
                n !== THUMBNAIL_APPROVED_BASENAME,
            );
            const byNewest = names
              .map((n) => join(workdir!, n))
              .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
            for (const cache of byNewest) {
              try {
                const parsed = ThumbnailConceptSchema.safeParse(
                  JSON.parse(await readFile(cache, "utf8")),
                );
                if (parsed.success) {
                  concept = parsed.data;
                  break;
                }
              } catch {
                // skip a corrupt cache file
              }
            }
          }
          const image = await currentThumbnailImage();
          const key = process.env.GEMINI_API_KEY;
          const state = thumbnailPanelState({
            commandArgs: cmd?.args ?? null,
            cfg: (opts.loadCfg ?? loadConfig)(),
            hasKey: key !== undefined && key !== "",
            approvedSkip,
            hasConcept: concept !== null,
            hasImage: image !== null,
            portraitExists: existsSync,
            ...(portraitOverridePath(workdir) !== null
              ? { overridePortraitPath: portraitOverridePath(workdir)! }
              : {}),
          });
          return send(200, {
            status: state.status,
            ...(state.reason !== undefined ? { reason: state.reason } : {}),
            concept,
            // mtime as the ts so the URL changes exactly when the file does —
            // the panel appends it verbatim and the browser cache stays out
            // of the way.
            imageUrl:
              image !== null
                ? `/api/thumbnail/image?ts=${Math.round(statSync(image).mtimeMs)}`
                : null,
            model: state.model,
            // The swap strip's state: which portrait a render would use and
            // where to preview it. Built from the SAME resolution the state
            // above ran, via portraitResponse's existence check.
            portrait: portraitResponse(
              state.portraitPath !== undefined && state.portraitSource !== undefined
                ? { path: state.portraitPath, source: state.portraitSource }
                : undefined,
            ),
          });
        }

        if (url.pathname === "/api/thumbnail/image" && req.method === "GET") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const image = await currentThumbnailImage();
          if (image === null) return send(404, { error: "no thumbnail image" });
          // Whole-file read rather than sendFile: a thumbnail is ~1-2MB and
          // this response wants a no-store header — a regenerate REPLACES the
          // file behind a URL the panel busts with ?ts, and a cached 200
          // would show the old image against the new ts on some proxies.
          const bytes = await readFile(image);
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "no-store",
            "content-length": String(bytes.length),
          });
          res.end(bytes);
          return;
        }

        if (url.pathname === "/api/thumbnail/portrait-image" && req.method === "GET") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const resolved = await resolveServerPortrait();
          if (resolved === undefined || !existsSync(resolved.path)) {
            return send(404, { error: "no portrait resolved for this project" });
          }
          // Whole-file read + no-store, the thumbnail image endpoint's exact
          // posture: a swap REPLACES the file behind a URL the panel busts
          // with ?ts, and a cached 200 would show the old face.
          const bytes = await readFile(resolved.path);
          res.writeHead(200, {
            "content-type": portraitMimeType(resolved.path) ?? "application/octet-stream",
            "cache-control": "no-store",
            "content-length": String(bytes.length),
          });
          res.end(bytes);
          return;
        }

        if (url.pathname === "/api/thumbnail/portrait" && req.method === "POST") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = z
            .object({ data: z.string().min(1), mimeType: z.string() })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: "expected { data: base64, mimeType }" });
          // The extension comes from the SAME table portraitMimeType reads,
          // so an accepted upload can never later be an "unsupported portrait
          // format" skip. The 400 names the accepted set — the exact-set
          // posture the CLI's own skip message uses.
          const ext = portraitExtensionForMime(parsed.data.mimeType);
          if (ext === undefined) {
            const accepted = [...new Set(Object.values(PORTRAIT_MIME_TYPES))].join(", ");
            return send(400, {
              error: `unsupported portrait mimeType "${parsed.data.mimeType}" — accepted: ${accepted}`,
            });
          }
          const bytes = Buffer.from(parsed.data.data, "base64");
          if (bytes.length === 0) return send(400, { error: "portrait data decoded to zero bytes" });
          if (bytes.length > PORTRAIT_MAX_BYTES) {
            return send(400, {
              error: `portrait too large (${(bytes.length / (1024 * 1024)).toFixed(1)}MB) — the override is capped at 15MB`,
            });
          }
          // ONE override, ever: drop any other-extension override BEFORE the
          // write, not after — in the between-window the resolution falls back
          // to the flag/config portrait, which beats portraitOverridePath's
          // table-order pick serving the STALE face next to the new one.
          for (const other of Object.keys(PORTRAIT_MIME_TYPES)) {
            if (other === ext) continue;
            const stale = join(workdir, `${PORTRAIT_OVERRIDE_BASENAME}.${other}`);
            if (existsSync(stale)) await unlink(stale);
          }
          // Atomic like the overrides write: a produce replay may resolve the
          // portrait at any moment, and half a face is worse than the old one.
          const dest = join(workdir, `${PORTRAIT_OVERRIDE_BASENAME}.${ext}`);
          const tmp = `${dest}.tmp`;
          await writeFile(tmp, bytes);
          await rename(tmp, dest);
          // No auto-regenerate: an image call costs money, and swap → edit
          // text → ONE Regenerate is the intended loop. The panel just
          // updates its strip from this response.
          return send(200, { ok: true, portrait: portraitResponse({ path: dest, source: "override" }) });
        }

        if (url.pathname === "/api/thumbnail/portrait" && req.method === "DELETE") {
          if (!workdir) return send(409, { error: "no workdir open" });
          // Every extension, not just the resolved one — a hand-copied second
          // override must not survive a "Use default".
          for (const ext of Object.keys(PORTRAIT_MIME_TYPES)) {
            const path = join(workdir, `${PORTRAIT_OVERRIDE_BASENAME}.${ext}`);
            if (existsSync(path)) await unlink(path);
          }
          // Respond with the re-resolved state — the flag/config fallback the
          // project now renders with, or null when there never was one.
          return send(200, { ok: true, portrait: portraitResponse(await resolveServerPortrait()) });
        }

        if (url.pathname === "/api/thumbnail/regenerate" && req.method === "POST") {
          if (!workdir) return send(409, { error: "no workdir open" });
          // An image call costs money — one at a time, a second is a 409
          // like a second render.
          if (thumbnailBusy) return send(409, { error: "a thumbnail generation is already running" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = z
            .object({ concept: ThumbnailConceptSchema })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // The §35 word cap, thumbnailStep's exact treatment via the shared
          // helper — the capped text is what the approval file, the prompt
          // AND the image cache key all hold.
          const concept: ThumbnailConcept = {
            ...parsed.data.concept,
            overlayText: approvedOverlayText(parsed.data.concept.overlayText),
          };
          const cmd = await readCommandRecord();
          const key = process.env.GEMINI_API_KEY;
          const state = thumbnailPanelState({
            commandArgs: cmd?.args ?? null,
            cfg: (opts.loadCfg ?? loadConfig)(),
            hasKey: key !== undefined && key !== "",
            // Only availability matters here — a skip file does not block a
            // regenerate (writing the approved concept below REPLACES the
            // skip, which is exactly what the user is asking for), and the
            // has-concept/has-image distinction is a GET-only nicety.
            approvedSkip: false,
            hasConcept: true,
            hasImage: true,
            portraitExists: existsSync,
            // The swapped face rides the same resolution here as the GET —
            // regenerating with the config headshot after a swap would be
            // the panel lying about its own strip.
            ...(portraitOverridePath(workdir) !== null
              ? { overridePortraitPath: portraitOverridePath(workdir)! }
              : {}),
          });
          if (state.status === "unavailable") {
            // Precondition, not a generation failure — 412 like a render
            // without command.json.
            return send(412, {
              error:
                `thumbnail unavailable (${state.reason}) — it needs a produce run with ` +
                "--youtube, a portrait photo and GEMINI_API_KEY in the environment",
            });
          }
          const portraitPath = state.portraitPath!;
          const mimeType = portraitMimeType(portraitPath);
          if (mimeType === undefined) {
            return send(412, {
              error: `unsupported portrait format "${portraitPath}" — use png, jpg, jpeg or webp`,
            });
          }
          // Persist the edited concept BEFORE generating (the approval-file
          // contract): the edit is the user's decision, and it must survive
          // both a failed generation and every future CLI replay —
          // thumbnailStep reads this file verbatim and never asks a model
          // again. Atomic like the overrides write: produce may read it at
          // any moment.
          const tmp = `${approvedConceptPath()}.tmp`;
          await writeFile(tmp, JSON.stringify(concept, null, 2));
          await rename(tmp, approvedConceptPath());
          thumbnailBusy = true;
          try {
            const portraitBytes = await readFile(portraitPath);
            let bytes: Uint8Array;
            try {
              bytes = await (opts.generateThumbnail ?? generateThumbnailImage)({
                apiKey: key!,
                model: state.model,
                prompt: buildThumbnailPrompt(concept, true),
                portrait: { data: portraitBytes.toString("base64"), mimeType },
              });
            } catch (err) {
              // 200 with ok:false — the panel shows this inline, and the API
              // message rides VERBATIM (§132 posture: the model slug is
              // user-specified, its rejection is deterministic, no
              // paraphrase). The approved concept above is already on disk.
              return send(200, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            // The same cache name thumbnailStep would compute for this exact
            // concept, so a later produce replay is a cache hit, not a second
            // paid call — then the destination copy, when an out is recorded.
            const cache = join(
              workdir,
              thumbnailImageCacheName(
                state.model,
                concept,
                createHash("sha1").update(portraitBytes).digest("hex"),
              ),
            );
            await writeFile(cache, bytes);
            const dest = await thumbnailDestPath();
            if (dest !== null) await copyFile(cache, dest);
            return send(200, { ok: true, imageUrl: `/api/thumbnail/image?ts=${Date.now()}` });
          } finally {
            thumbnailBusy = false;
          }
        }

        if (url.pathname === "/api/youtube" && req.method === "GET") {
          // The SEO panel's one status call (2026-08-17): the pack to
          // prefill and where the markdown lands. All reads — the panel owns
          // no state on the server.
          if (!workdir) return send(409, { error: "no workdir open" });
          const pack = await currentYoutubePack();
          return send(200, {
            available: pack !== null,
            // no-pack is the ONE reason: the run never generated metadata
            // (no --youtube, no provider, or the call failed) — the panel
            // copy names the fix.
            ...(pack === null ? { reason: "no-pack" as const } : {}),
            pack,
            mdPath: await recordedArtifactPath(".youtube.md"),
          });
        }

        if (url.pathname === "/api/youtube" && req.method === "PUT") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = z
            .object({ pack: YoutubePackSchema })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // generateYoutubePack's own post-parse guard applied to the edit:
          // the schema cannot express the 500-char joined cap, and dropping
          // tags from the end is cheaper than refusing the whole save.
          const pack: YoutubePack = {
            ...parsed.data.pack,
            tags: trimTagsToLimit(parsed.data.pack.tags),
          };
          // The approval-file contract (the thumbnail regenerate above): the
          // edit is the user's decision, and produce's Y2 block reads this
          // file verbatim instead of ever asking a model again. Atomic like
          // the overrides write — produce may read it at any moment.
          const tmp = `${approvedPackPath()}.tmp`;
          await writeFile(tmp, JSON.stringify(pack, null, 2));
          await rename(tmp, approvedPackPath());
          // Rewrite the paste-ready markdown NOW when the recorded out says
          // where it lives; skipped silently otherwise, with mdPath: null as
          // the response's note — the file regenerates on the next produce
          // from the approved pack anyway.
          const mdPath = await recordedArtifactPath(".youtube.md");
          if (mdPath !== null) await writeFile(mdPath, formatYoutubeMarkdown(pack));
          return send(200, { ok: true, mdPath });
        }

        if (url.pathname === "/api/cover" && req.method === "GET") {
          // The cover panel's one status call (2026-08-19): the provenance to
          // prefill and where the current image is. All reads — the panel
          // owns no state on the server.
          if (!workdir) return send(409, { error: "no workdir open" });
          const provenance = await readCoverProvenance(workdir);
          const image = await currentCoverImage(provenance);
          // Where a regeneration would WRITE. `coverDestination`'s canonical
          // ladder: the destination the last cover used, else
          // `<recorded out>.cover.jpg`. Neither means regenerateCover would
          // throw for want of a destination, and the panel says so up front
          // rather than after a click.
          const outPath = provenance?.out ?? (await recordedArtifactPath(".cover.jpg"));
          return send(200, {
            status: outPath === null ? "unavailable" : "ready",
            ...(outPath === null
              ? { reason: "no-destination" as const }
              : image === null
                ? { reason: "never-rendered" as const }
                : {}),
            provenance,
            outPath,
            imageUrl: coverImageUrl(image),
          });
        }

        if (url.pathname === "/api/cover/image" && req.method === "GET") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const image = await currentCoverImage(await readCoverProvenance(workdir));
          if (image === null) return send(404, { error: "no cover image" });
          // Whole-file read + no-store, the thumbnail image endpoint's exact
          // posture and for the same reason: a regenerate REPLACES the file
          // behind a URL the panel busts with ?ts, and a cached 200 would show
          // the old cover against the new ts on some proxies.
          const bytes = await readFile(image);
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "cache-control": "no-store",
            "content-length": String(bytes.length),
          });
          res.end(bytes);
          return;
        }

        if (url.pathname === "/api/cover/regenerate" && req.method === "POST") {
          if (!workdir) return send(409, { error: "no workdir open" });
          // A regeneration can shell out to ffmpeg and it boots a headless
          // browser — one at a time, a second is a 409 like a second render.
          if (coverBusy) return send(409, { error: "a cover regeneration is already running" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // Three steerable values and NOTHING else. `atSec` rides the CLI's
          // own schema so a negative seek is refused at both surfaces, and
          // `from` rides the enum so a typo'd "finall" is a 400 rather than a
          // cover quietly rebuilt from the wrong video (CLAUDE.md's
          // --source-fit rule). Unknown keys are stripped by the parse, which
          // is the load-bearing half of the paragraph below.
          const parsed = z
            .object({
              text: z.string().optional(),
              atSec: CoverAtSecondsSchema.optional(),
              from: CoverFromSchema.optional(),
            })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          coverBusy = true;
          try {
            // Every PATH is derived server-side — from command.json,
            // cover.json and render-props.json — and never from the body: the
            // stance the render and reveal endpoints already hold. This server
            // binds locally, but an endpoint that WRITES a file wherever a
            // client names is the same door as spawning a client-supplied
            // command. Note the absent `outPath`: it exists on
            // CoverRegenerateOptions for `ossclip cover --out`, and passing
            // one through from here is exactly the bug this omission prevents.
            const notes: string[] = [];
            const provenance = await regenerateCover(
              workdir,
              { text: parsed.data.text, atSec: parsed.data.atSec, from: parsed.data.from },
              { renderCover: opts.renderCover, log: (line) => notes.push(line) },
            );
            const image = await currentCoverImage(provenance);
            // The notes ride back so the panel can show what the CLI PRINTS —
            // a headline trimmed to nine words, or a re-picked frame. Silence
            // on either is how a user ships a cover they did not write.
            return send(200, {
              ok: true,
              provenance,
              notes,
              outPath: provenance.out,
              imageUrl: coverImageUrl(image),
            });
          } catch (err) {
            // 200 with ok:false, the thumbnail regenerate's posture: these
            // failures are user-actionable sentences ("is the timestamp past
            // the end?", "--from source needs cover.json") and the panel shows
            // them inline VERBATIM rather than as a dead 500.
            return send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
          } finally {
            coverBusy = false;
          }
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
