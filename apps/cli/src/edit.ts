import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  appendUsageRun,
  // The SFX plan route's word-space derivation (Phase 4) — the repaired
  // transcript rebuilt from production.json's own stored pair, which is the
  // index space `production.sfx.placements[].word` counts in.
  applyRepairs,
  ProductionSfxSchema,
  approvedOverlayText,
  buildThumbnailPrompt,
  captionCap,
  captionForProvider,
  checkDurationCaps,
  createPostizProvider,
  createProvider,
  encodeEta,
  formatUsageLine,
  generateCaptionRegen,
  generateYoutubePack,
  YOUTUBE_PROMPT_VERSION,
  deliveryEncodePlan,
  ensureDeliveryFile,
  PLATFORM_DURATION_CAPS_SEC,
  PLATFORM_SIZE_CAP_BYTES,
  probe,
  alignRestamp,
  emptyOverrideDoc,
  extractAudioSpan,
  // Static import is fine here: the @google/genai SDK load is LAZY inside
  // this function (core's near-zero-dep rule), so the server pays for it
  // only when a regenerate actually runs.
  generateThumbnailImage,
  loadConfig,
  // The SFX palette's one source of sounds (2026-08-29): the same loader
  // produce plans against, so the dropdown can never offer a sound a render
  // would not find.
  loadSfxLibrary,
  outInsideInputFolderMessage,
  outPathInsideInput,
  PORTRAIT_MIME_TYPES,
  portraitMimeType,
  readCoverProvenance,
  runWhisper,
  SegmentSchema,
  spliceTranscript,
  TranscriptSchema,
  ungroundedTokens,
  whisperPromptFor,
  wordsInSpan,
  type ModelPrice,
  type Segment,
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
import { loadEnvFiles } from "./env";
import { revealInFileManager } from "./open";
import { REVIEWED_SCENES_BASENAME, renderReplayArgs } from "./render-replay-args";
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
// The model-path and implied-language rules, from THE source doctor, setup and
// produce all resolve through — a second copy here would send a user to a
// model file the rest of the tool never looks for.
import { modelImpliedLanguage, whisperModelPath } from "./setup/manifest";
import {
  PORTRAIT_OVERRIDE_BASENAME,
  portraitExtensionForMime,
  portraitOverridePath,
  resolvePortrait,
  type ResolvedPortrait,
} from "./portrait-override";
import { lastFlagValue, thumbnailPanelState } from "./thumbnail-panel";
import { captionRegenProvider } from "./caption-regen-panel";
import { binOnPath } from "./llm-detect";
import {
  attachDeliveryMedia,
  buildPublishPosts,
  publishConfigured,
  publishReceiptPath,
  readPublishReceipt,
  sizeCapGroups,
} from "./publish";

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
 * The config keys `/api/retranscribe-range` needs. Spelled structurally
 * rather than as `OssclipConfig` so the `loadCfg` seam keeps accepting a test
 * stub that supplies only what a case is about — the same shape the youtube/
 * portrait keys above it are declared with.
 */
export interface RetranscribeConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  whisperPath?: string;
  model?: string;
  modelDir?: string;
  language?: unknown;
  dictionary?: unknown;
}

/**
 * How to spawn whisper for a range re-decode, or why we cannot.
 *
 * Pure — the `openCommand`/`openInBrowser` split — so the whole
 * config × missing-binary × malformed-dictionary matrix is testable without
 * whisper.cpp or a model on the runner.
 *
 * FROM THE CONFIG, not from the workdir's `transcript-key.json`, and that is
 * a knowing limitation: reading the key would mean importing produce.ts,
 * which statically pulls in @ossclip/renderer AND imports this module back
 * (a cycle), for a server whose whole point is to start instantly. The
 * failure when the two disagree is safe and REPORTED rather than silent: a
 * range re-decoded with a different model produces words that match nothing,
 * and `alignRestamp` answers "matched none — stamps left as they were".
 *
 * The dictionary is validated all-or-nothing, `validDictionary`'s rule
 * (produce.ts): a hand-edited list with a number in it biases whisper with a
 * vocabulary the user never reviewed, so the whole key is dropped instead.
 * Same for `language`: typeof+trim, never truthiness, never coerced.
 */
export function retranscribeSettings(
  cfg: RetranscribeConfig,
):
  | {
      tools: { ffmpegPath: string; ffprobePath: string };
      whisperPath: string;
      modelPath: string;
      language?: string;
      prompt?: string;
    }
  | { error: string } {
  if (!cfg.ffmpegPath || !cfg.ffprobePath || !cfg.whisperPath || !cfg.model || !cfg.modelDir) {
    return {
      error:
        "ffmpeg or whisper is not configured — run `ossclip doctor` to see what is missing, " +
        "then `ossclip setup` to install it.",
    };
  }
  const dict = Array.isArray(cfg.dictionary)
    && cfg.dictionary.length > 0
    && cfg.dictionary.every((t) => typeof t === "string" && t.trim().length > 0)
    ? (cfg.dictionary as string[]).map((t) => t.trim())
    : [];
  const language = typeof cfg.language === "string" && cfg.language.trim().length > 0
    ? cfg.language.trim()
    : modelImpliedLanguage(cfg.model);
  const prompt = whisperPromptFor(dict);
  return {
    tools: { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath },
    whisperPath: cfg.whisperPath,
    modelPath: whisperModelPath(cfg.model, cfg.modelDir),
    ...(language !== undefined ? { language } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };
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
  // The sound-effect preview (`/api/sfx/audio`) and the staged `sfx/` copies
  // the workdir serves over `/media/`: the starter pack is mono mp3, and an
  // `<audio>` element handed an octet-stream is exactly the sniffing-dependent
  // preview the `.jpg` note below refuses to rely on. Anything else a user
  // pack ships still falls back to octet-stream rather than being refused.
  ".mp3": "audio/mpeg",
  // The `--cover-in-video` overlay: produce stages the cover into the workdir
  // as well as the render's public dir, and the Player fetches it through
  // `/media/`. Browsers do sniff an image served as octet-stream, but a
  // preview that depends on sniffing is a preview that breaks the first time
  // something in front of it (a proxy, a stricter engine) declines to.
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
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
    loadCfg?: () => {
      youtube?: unknown;
      portrait?: unknown;
      thumbnailModel?: unknown;
      postizUrl?: string;
      /** produce's config fallback for `--audience` — the on-demand pack
       * generation reads it the same way (typeof, never truthiness). */
      audience?: unknown;
      /** The caption-regenerate spend report prices through the same table
       * produce does — absent in a stub, the defaults apply. */
      pricing?: Record<string, ModelPrice>;
    } & RetranscribeConfig;
    /** Env seam for the publish endpoints — tests inject their own so the
     * runner's real OSSCLIP_POSTIZ_API_KEY (or its absence) never decides a
     * test (the loadCfg rule applied to the environment). */
    publishEnv?: NodeJS.ProcessEnv;
    /** Fetch seam for the publish endpoints — tests stub Postiz instead of
     * needing an instance on the runner (createPostizProvider's fetchImpl). */
    publishFetch?: typeof fetch;
    /** The publish endpoints' two ffmpeg-family shell-outs (the sliceAudio/
     * runWhisper seam pattern) — tests stub a probe and a delivery encode
     * instead of needing ffmpeg/ffprobe and a real render on the runner. */
    probeVideo?: typeof probe;
    ensureDelivery?: typeof ensureDeliveryFile;
    /** File-manager reveal seam (the `generateThumbnail` pattern) — tests
     * observe the revealed path instead of popping a real Finder/Explorer
     * window on the runner. */
    reveal?: (path: string) => void;
    /** The caption-regenerate LLM seam (the `generateThumbnail` pattern for
     * text): tests inject a fake provider factory and never touch a model. */
    makeLlmProvider?: typeof createProvider;
    /**
     * The cover render seam, exactly like `generateThumbnail` above. Without
     * it `regenerateCover` lazily imports @ossclip/renderer and boots a
     * headless browser — which `edit-server.test.ts` must never do, and which
     * is also why cover.ts keeps that import lazy in the first place.
     */
    renderCover?: CoverSeams["renderCover"];
    /**
     * The two shell-outs `/api/retranscribe-range` makes — the
     * `generateThumbnail` seam pattern, twice: tests stub a decode instead of
     * needing ffmpeg, whisper.cpp and a multi-gigabyte model on the runner
     * (`edit-server.test.ts` must stay a unit test).
     */
    sliceAudio?: typeof extractAudioSpan;
    runWhisper?: typeof runWhisper;
    /**
     * The sound library the SFX routes serve (`loadCfg`'s rule applied to the
     * pack loader): tests inject a hand-written library over a tmp dir, so the
     * suite never depends on the bundled pack riding a given runner's checkout
     * — nor on whatever the developer happens to have in ~/.ossclip/sfx, which
     * the real loader merges in.
     */
    loadSfx?: typeof loadSfxLibrary;
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
  /**
   * One range re-decode at a time (`/api/retranscribe-range`). whisper is a
   * CPU-bound spawn AND the endpoint read-modify-writes transcript.json, so
   * two in flight is both a stalled box and a lost splice — the second write
   * would be built on a transcript read before the first one landed.
   * `coverBusy`'s rule with a second reason on top.
   */
  let retranscribeBusy = false;
  /**
   * One caption regeneration at a time (`/api/publish/regenerate`) — an LLM
   * call costs money, and a double-click must not buy two. `thumbnailBusy`'s
   * rule, its own flag: a caption rewrite must not block a thumbnail.
   */
  let captionRegenBusy = false;
  /**
   * One pack generation at a time (`/api/youtube/generate`) — an LLM call
   * costs money, and a double-click must not buy two. `captionRegenBusy`'s
   * rule, its own flag: generating the pack must not block a caption rewrite
   * already in flight (they are different buttons in different panels).
   */
  let packGenBusy = false;
  /**
   * Where the in-flight publish is right now, for the panel's poll
   * (2026-08-29): the POST runs the delivery encode synchronously — minutes
   * of x264 behind one fetch — so `GET /api/publish/progress` reads this
   * instead of the panel staring at a static button. Null whenever no publish
   * is in flight; a POST's `finally` owns the reset so an error can't leave a
   * stale "encoding" behind. Per server instance like the busy flags above.
   */
  let publishProgress: {
    phase: "encoding" | "uploading";
    pct: number | null;
    etaSec: number | null;
    speed: number | null;
    /** The delivery file being encoded (from onStart) — a size-capped
     * publish runs two sequential encodes, and a bare pct that resets to 0
     * mid-publish looks like a hang unless the label names which file it
     * restarted for. Null before the first onStart and while uploading. */
    file: string | null;
  } | null = null;
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
  /** Where the Preview button's one-off render lands (handoff-cover-panel
   * §3): a fixed name IN the workdir — never a client-named path, and never
   * the canonical `.cover.jpg` a real Apply owns. Each preview overwrites the
   * last; the file is scratch, like the frame-sampler's cache. */
  const coverPreviewPath = (): string => join(workdir!, "cover-preview.jpg");

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
  /**
   * The publish config, resolved FRESH per request — both halves of it.
   *
   * `loadConfig()` already re-read `config.json` every time, but the API key
   * came from the process env, which is populated once at CLI startup: a user
   * who set up Postiz while the editor was open got "not configured" until a
   * restart, with `postizUrl` live and the key stale (2026-08-27). Re-running
   * `loadEnvFiles` costs two small file reads on a button press and keeps the
   * documented precedence exactly — it never clobbers a key the real
   * environment already set, so a shell-provided key still wins.
   *
   * Skipped entirely when the caller injected `publishEnv` (tests own their
   * environment, and reading the developer's real `~/.ossclip/.env` into a
   * test would make the suite depend on the machine it runs on).
   */
  const resolvePublishConfig = (): ReturnType<typeof publishConfigured> => {
    if (opts.publishEnv === undefined) loadEnvFiles();
    return publishConfigured((opts.loadCfg ?? loadConfig)(), opts.publishEnv ?? process.env);
  };
  /** ffmpeg/ffprobe for the publish endpoints' probe + delivery encode —
   * from the same config read the rest of the panel resolves through. The
   * `?? "ffmpeg"` legs exist only for the narrowed `loadCfg` seam; the real
   * `loadConfig()` always fills both. */
  const publishTools = (): { ffmpegPath: string; ffprobePath: string } => {
    const cfg = (opts.loadCfg ?? loadConfig)();
    return { ffmpegPath: cfg.ffmpegPath ?? "ffmpeg", ffprobePath: cfg.ffprobePath ?? "ffprobe" };
  };
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

        if (url.pathname === "/api/transcript" && req.method === "GET") {
          // The FULL transcript, source-timed words included (cut-review
          // rework follow-up): the editor rebuilds the caption track over
          // REVIVED material with produce's own `buildCaptionLines`, and
          // render-props' captionLines only cover what the last render kept
          // — the revived words exist nowhere else client-side. Lenient like
          // /api/cleanup: a missing or corrupt transcript.json degrades to
          // null (captions over revived material stay absent, never a 500).
          if (!workdir) return send(409, { error: "no workdir open" });
          try {
            const raw = JSON.parse(await readFile(join(workdir, "transcript.json"), "utf8")) as {
              language?: unknown;
              words?: unknown;
            };
            if (!Array.isArray(raw.words)) return send(200, { transcript: null });
            return send(200, { transcript: raw });
          } catch {
            return send(200, { transcript: null });
          }
        }

        if (url.pathname === "/api/retranscribe-range" && req.method === "POST") {
          // Re-decode ONE source span and re-stamp the words already there
          // (Phase A, 2026-08-26): inside a kept retake whisper mis-POSITIONS
          // words — the caption says "has its" while the audio says "could
          // read 50 files" — because the first decode ran over material the
          // cut had removed. See restamp.ts for why the splice is
          // stamps-only.
          if (!workdir) return send(409, { error: "no workdir open" });
          if (retranscribeBusy) {
            return send(409, { error: "a re-transcription is already running" });
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // TWO steerable values, both times, and nothing else — the cover
          // regenerate rule: unknown keys are stripped by the parse, and an
          // ordered non-negative pair is checked HERE rather than trusted,
          // since an inverted range would slice a negative duration out of
          // ffmpeg (CLAUDE.md's parse-never-coerce).
          const parsed = z
            .object({ srcIn: z.number().nonnegative(), srcOut: z.number().nonnegative() })
            .refine((v) => v.srcOut > v.srcIn, { message: "srcOut must be after srcIn" })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          const { srcIn, srcOut } = parsed.data;
          // Every path server-derived, never from the body — the regenerate
          // endpoint's stance. `whisper-range` is a distinct outBase from
          // produce's `whisper`, so a range decode can never overwrite the
          // artefact of the full one.
          const dir = workdir;
          const tmpWav = join(dir, "whisper-range.wav");
          const outBase = join(dir, "whisper-range");
          retranscribeBusy = true;
          try {
            const audio = join(dir, "audio.wav");
            if (!existsSync(audio)) {
              return send(200, {
                ok: false,
                error: "this workdir has no audio.wav to re-decode — re-run `ossclip produce`.",
              });
            }
            const transcriptPath = join(dir, "transcript.json");
            if (!existsSync(transcriptPath)) {
              return send(200, {
                ok: false,
                error: "this workdir has no transcript.json to re-stamp — re-run `ossclip produce`.",
              });
            }
            const settings = retranscribeSettings((opts.loadCfg ?? loadConfig)());
            if ("error" in settings) return send(200, { ok: false, error: settings.error });
            if (!existsSync(settings.modelPath)) {
              // The `--transcript`-only install: whisper was never needed to
              // make this project, so say what to run rather than 500ing.
              return send(200, {
                ok: false,
                error:
                  `whisper model not found at ${settings.modelPath} — run \`ossclip setup\` ` +
                  `to download it.`,
              });
            }
            // Parsed, not cast: this file is about to be rewritten, and a
            // truncated one must fail loudly here rather than become the new
            // transcript.
            const transcript = TranscriptSchema.parse(
              JSON.parse(await readFile(transcriptPath, "utf8")),
            );
            const range = wordsInSpan(transcript.words, srcIn, srcOut);
            if (range.to === range.from) {
              // Silence, or a range whose words all straddle its edges.
              // Nothing to re-stamp is a SUCCESS with an empty mapping — the
              // editor's no-op — not a failure the user has to read.
              return send(200, {
                ok: true,
                mapping: [],
                reports: ["no transcript words lie wholly inside that range"],
              });
            }
            await (opts.sliceAudio ?? extractAudioSpan)(
              settings.tools,
              audio,
              tmpWav,
              srcIn,
              srcOut - srcIn,
            );
            const fresh = await (opts.runWhisper ?? runWhisper)(
              {
                whisperPath: settings.whisperPath,
                modelPath: settings.modelPath,
                outBase,
                ...(settings.language !== undefined ? { language: settings.language } : {}),
                ...(settings.prompt !== undefined ? { prompt: settings.prompt } : {}),
              },
              tmpWav,
            );
            const restamped = alignRestamp(
              transcript.words.slice(range.from, range.to),
              fresh.words,
              srcIn,
            );
            const next = spliceTranscript(transcript, range, restamped.words);
            // Atomic, like the overrides write: produce may read this file at
            // any moment (its cache-reuse branch reads it verbatim and writes
            // back what it read), and a half-written transcript is worse than
            // a stale one.
            const tmp = `${transcriptPath}.tmp`;
            await writeFile(tmp, JSON.stringify(next, null, 2));
            await rename(tmp, transcriptPath);
            // `overrides.json` IS NOT TOUCHED HERE, on purpose: the doc is
            // client-owned — the editor holds unsaved edits and an undo stack
            // over it — so the caption RE-KEY rides back as `mapping` and is
            // applied by the `useEdits` reducer, one commit, one undo step.
            return send(200, { ok: true, mapping: restamped.mapping, reports: restamped.reports });
          } catch (err) {
            // 200 {ok:false}, the cover regenerate posture: a missing whisper
            // binary or a failed decode is a sentence the panel shows, not a
            // dead 500 — and the editor keeps working on the old stamps.
            const message = err instanceof Error ? err.message : String(err);
            return send(200, {
              ok: false,
              error: `${message} — run \`ossclip doctor\` if ffmpeg or whisper is the problem.`,
            });
          } finally {
            retranscribeBusy = false;
            // Both artefacts are per-request scratch. `.catch()` because a
            // decode that never got as far as writing one must not turn a
            // reported failure into an unhandled rejection.
            await unlink(tmpWav).catch(() => {});
            await unlink(`${outBase}.json`).catch(() => {});
          }
        }

        if (url.pathname === "/api/cleanup" && req.method === "GET") {
          // The labeled removals: since cut review step 3 this serves the
          // PROPOSAL (`cutlistProposed` — the automatic cutlist before the
          // user's cleanup vetoes and user cuts), because that is what the
          // editor's checkboxes and seams reason about: a DECLINED pause has
          // already merged into a plain keep in the resolved `cutlist`, so
          // serving that would make the veto invisible the moment it worked.
          // The fallback to `cutlist` keeps pre-step-3 workdirs drawing their
          // seams — back then the recorded cutlist WAS the proposal (plus
          // applied user cuts, whose seams the applied-cut restore marker
          // draws independently anyway). Same lenient-read posture as
          // /api/usage above: a missing or corrupt production.json degrades
          // to an empty cutlist, never a 500 — the timeline simply draws no
          // removal seams.
          if (!workdir) return send(409, { error: "no workdir open" });
          let cutlist: Segment[] = [];
          try {
            const production = JSON.parse(
              await readFile(join(workdir, "production.json"), "utf8"),
            ) as { cutlist?: unknown; cutlistProposed?: unknown };
            const source = Array.isArray(production.cutlistProposed)
              ? production.cutlistProposed
              : production.cutlist;
            if (Array.isArray(source)) {
              // Each span parses ALONE: a hand-edited production.json with
              // one bad span (a string srcIn, a negative time) drops that
              // span and keeps the rest, instead of either 500ing or letting
              // a NaN through to position a seam off-screen. zod parse, not
              // a cast — the house rule for anything a user can have edited.
              cutlist = source.flatMap((s) => {
                const parsed = SegmentSchema.safeParse(s);
                return parsed.success ? [parsed.data] : [];
              });
            }
          } catch {
            // degrade — same as /api/usage's readJson
          }
          return send(200, { cutlist });
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
          let replan = false;
          try {
            const raw = Buffer.concat(chunks).toString();
            if (raw.trim()) {
              const body = JSON.parse(raw) as { out?: string; replan?: boolean };
              if (typeof body.out === "string" && body.out.trim()) {
                customOut = body.out.trim();
              }
              // Opt back into a fresh LLM plan (renderReplayArgs' why).
              replan = body.replan === true;
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
          // THE EDITOR IS THE AUTHORITY for a render started here: pin the
          // plan the user just reviewed (`production.json`'s scenes) instead
          // of letting `--produce` plan a fresh one that renumbers scenes and
          // orphans their edits (renderReplayArgs owns the full why). Written
          // to its own file rather than reusing `scenes-<key>.json`, which is
          // keyed to a beat sheet this render may no longer match.
          let scenesPath: string | undefined;
          if (!replan) {
            try {
              const production = JSON.parse(
                await readFile(join(workdir!, "production.json"), "utf8"),
              ) as { scenes?: unknown };
              if (Array.isArray(production.scenes) && production.scenes.length > 0) {
                scenesPath = join(workdir!, REVIEWED_SCENES_BASENAME);
                await writeFile(scenesPath, `${JSON.stringify(production.scenes, null, 2)}\n`);
              }
            } catch {
              // No production.json, an old one without `scenes`, or an
              // unwritable workdir: replay the recorded command rather than
              // refuse to render (renderReplayArgs' no-plan case).
              scenesPath = undefined;
            }
          }
          args = renderReplayArgs(args, { scenesPath, replan });
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

        if (url.pathname === "/api/youtube/generate" && req.method === "POST") {
          // Generate the pack ON DEMAND (2026-08-29): a render produced
          // without --youtube has no caption pack, and the publish modal
          // dead-ended on "run produce with --youtube" — a full re-produce
          // just to buy one LLM call. This writes the same CACHE file
          // produce's Y2 block would have, never the approved file: approval
          // stays the user's explicit act (PUT /api/youtube), and the user
          // still reviews the captions before anything sends.
          if (!workdir) return send(409, { error: "no workdir open" });
          // An LLM call costs money — one at a time, a second is a 409 like
          // a second caption rewrite.
          if (packGenBusy) {
            return send(409, { error: "a caption-pack generation is already running" });
          }
          // Lenient transcript read but a 412 when it yields nothing — the
          // /api/publish/regenerate posture, same reason: a pack with no
          // transcript would be invented metadata. The words joined raw is
          // the honest input the server has (regenerate made the same call);
          // produce's stamped transcript needs the cut map, which only a
          // produce run holds — the prompt tolerates plain text, the model
          // just gets no measured chapters worth trusting.
          let words: Array<{ text: string }> = [];
          let lastWordEnd: number | null = null;
          try {
            const raw = JSON.parse(await readFile(join(workdir, "transcript.json"), "utf8")) as {
              words?: unknown;
            };
            if (Array.isArray(raw.words)) {
              words = raw.words.filter(
                (w): w is { text: string } =>
                  typeof (w as { text?: unknown } | null)?.text === "string",
              );
              for (const w of raw.words) {
                const end = (w as { end?: unknown } | null)?.end;
                if (typeof end === "number" && Number.isFinite(end)) {
                  lastWordEnd = Math.max(lastWordEnd ?? 0, end);
                }
              }
            }
          } catch {
            // absent/corrupt → the 412 below
          }
          if (words.length === 0) {
            return send(412, {
              error:
                "no transcript in this workdir — the pack would have nothing to ground " +
                "against; re-run `ossclip produce`.",
            });
          }
          // The prompt's runtime ceiling: the output duration produce
          // measured (render-props.json), else the transcript's last word
          // end — source-clock, but the honest number available, and a
          // raw-text transcript gets no measured chapters anyway.
          let durationSec: number | null = null;
          try {
            const props = JSON.parse(await readFile(propsPath(), "utf8")) as {
              outputDurationSec?: unknown;
            };
            if (
              typeof props.outputDurationSec === "number" &&
              Number.isFinite(props.outputDurationSec) &&
              props.outputDurationSec > 0
            ) {
              durationSec = props.outputDurationSec;
            }
          } catch {
            // corrupt props — the transcript fallback below
          }
          if (durationSec === null && lastWordEnd !== null && lastWordEnd > 0) {
            durationSec = lastWordEnd;
          }
          if (durationSec === null) {
            return send(412, {
              error: "cannot determine the video's duration — re-run `ossclip produce`.",
            });
          }
          const cmd = await readCommandRecord();
          const cfg = (opts.loadCfg ?? loadConfig)();
          // The editorial steer produce would have used: the recorded flags
          // first, then produce's own defaults when a flag is absent —
          // intent has none, audience falls back to the config's `audience`
          // (produce.ts's typed read: typeof, never truthiness).
          const intent = lastFlagValue(cmd?.args ?? [], ["--intent"]);
          const audience =
            lastFlagValue(cmd?.args ?? [], ["--audience"]) ??
            (typeof cfg.audience === "string" ? cfg.audience : undefined);
          // hook/coverText come from the beat sheet in produce; a produce
          // run that planned left its sheet cached in the workdir. The
          // shipped cover headline (cover.json, possibly the user's own
          // words) backstops coverText. All optional — buildYoutubePrompt
          // omits absent lines, exactly as a no-beat-sheet produce does.
          let hook: string | undefined;
          let coverText: string | undefined;
          const beatCache = await newestWorkdirFile(
            (n) => n.startsWith("beatsheet-") && n.endsWith(".json"),
          );
          if (beatCache !== null) {
            try {
              const sheet = JSON.parse(await readFile(beatCache, "utf8")) as {
                hook?: unknown;
                coverText?: unknown;
              };
              if (typeof sheet.hook === "string" && sheet.hook.trim().length > 0) {
                hook = sheet.hook;
              }
              if (typeof sheet.coverText === "string" && sheet.coverText.trim().length > 0) {
                coverText = sheet.coverText;
              }
            } catch {
              // a corrupt cache loses a steer line, never the generation
            }
          }
          if (coverText === undefined) {
            const provenance = await readCoverProvenance(workdir);
            if (provenance !== null && provenance.text.trim().length > 0) {
              coverText = provenance.text;
            }
          }
          // Env fresh per press, then the caption regenerate's provider
          // resolution verbatim — the same "which LLM does this project
          // use" question with the same three-rung answer.
          if (opts.publishEnv === undefined) loadEnvFiles();
          const env = opts.publishEnv ?? process.env;
          const usagePath = join(workdir, "usage.json");
          let usageLog: unknown = null;
          try {
            usageLog = JSON.parse(await readFile(usagePath, "utf8"));
          } catch {
            // no log yet — the resolution falls through to the pin/detection
          }
          const resolved = captionRegenProvider({
            usageLog,
            commandArgs: cmd?.args ?? null,
            env,
            hasBin: (bin) => binOnPath(bin, env),
          });
          if (resolved.status === "unavailable") {
            return send(412, { error: resolved.reason });
          }
          const provider = (opts.makeLlmProvider ?? createProvider)(resolved.provider);
          packGenBusy = true;
          try {
            let pack: YoutubePack;
            try {
              pack = await generateYoutubePack(provider, {
                transcriptText: words.map((w) => w.text).join(" "),
                ...(intent !== undefined ? { intent } : {}),
                ...(hook !== undefined ? { hook } : {}),
                ...(coverText !== undefined ? { coverText } : {}),
                ...(audience !== undefined ? { audience } : {}),
                durationSec,
              });
            } catch (err) {
              // 200 with ok:false, the caption regenerate's posture: a
              // provider failure is a sentence the panel shows VERBATIM,
              // never a dead 500. Nothing is cached (§106).
              return send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
            const pricing = cfg.pricing ?? {};
            // The spend is real, so it survives the session — the caption
            // regenerate's append, atomically.
            const nextLog = appendUsageRun(
              usageLog,
              { at: new Date().toISOString(), records: provider.usage },
              pricing,
            );
            const usageTmp = `${usagePath}.tmp`;
            await writeFile(usageTmp, JSON.stringify(nextLog, null, 2));
            await rename(usageTmp, usagePath);
            // A `youtube-<key>.json` cache, keyed on the provider asked like
            // produce's Y2 write — deliberately NOT produce's exact key: that
            // key hashes the cut map's spans and the stamped transcript,
            // which only a produce run holds, and matching it would falsely
            // claim cache identity with an answer built from different
            // inputs. mtime is what makes this pack current: both
            // currentYoutubePack and loadPublishPack sort caches newest
            // first. Atomic like the approved-pack write.
            const key = createHash("sha1")
              .update(
                JSON.stringify([
                  YOUTUBE_PROMPT_VERSION,
                  resolved.provider,
                  intent ?? "",
                  audience ?? "",
                  words.map((w) => w.text),
                ]),
              )
              .digest("hex")
              .slice(0, 8);
            const packPath = join(workdir, `youtube-${key}.json`);
            const packTmp = `${packPath}.tmp`;
            await writeFile(packTmp, JSON.stringify(pack, null, 2));
            await rename(packTmp, packPath);
            return send(200, { ok: true, usage: formatUsageLine(provider.usage, pricing) });
          } finally {
            packGenBusy = false;
          }
        }

        // ---- Publish (2026-08-26) -----------------------------------------
        // The server's FIRST outbound-network endpoints, against the
        // roadmap's "replay-only by deliberate design" posture — allowed
        // because all three gates hold: they exist behaviorally only when the
        // user configured their own Postiz instance (unconfigured → a hint,
        // never a control), they fire only on an explicit button press, and
        // the API key never reaches the browser — the server (already running
        // in the user's shell env) does the upload.
        if (url.pathname === "/api/publish" && req.method === "GET") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const configured = resolvePublishConfig();
          if (!configured.ok) {
            return send(200, { configured: false, reason: configured.message });
          }
          const cmd = await readCommandRecord();
          const out = cmd ? recordedOutPath(cmd) : null;
          const pack = await currentYoutubePack();
          // Pre-flight duration for the panel, read leniently (the
          // /api/cleanup posture): a missing ffprobe or an unreadable render
          // degrades to null — the panel loses the gray-out, never the modal —
          // and POST re-checks the caps authoritatively anyway.
          let durationSec: number | null = null;
          if (out !== null && existsSync(out)) {
            try {
              durationSec = (await (opts.probeVideo ?? probe)(publishTools(), out)).duration;
            } catch {
              // degrade — the caps still apply server-side on POST
            }
          }
          let integrations: Array<{
            id: string;
            provider: string;
            name: string;
            caption: string;
            durationCapSec: number | null;
            sizeCapBytes: number | null;
          }> = [];
          try {
            const provider = createPostizProvider({
              baseUrl: configured.baseUrl,
              apiKey: configured.apiKey,
              fetchImpl: opts.publishFetch,
            });
            const targets = await provider.listTargets();
            integrations = targets.map((t) => ({
              ...t,
              // The caption the publish WOULD use — authored-else-derived —
              // so the panel previews truth, not a guess of it.
              caption: pack !== null ? captionForProvider(pack, t.provider) : "",
              // Null = no cap (limits.ts: absence means unlimited) — the
              // panel grays out a channel only against a cap that exists.
              durationCapSec: PLATFORM_DURATION_CAPS_SEC[t.provider] ?? null,
              // The platform's upload byte ceiling, same posture: null means
              // uncapped, a number means this channel gets its own smaller
              // delivery encode (limits.ts: Instagram's ~100MB URL-fetch cap).
              sizeCapBytes: PLATFORM_SIZE_CAP_BYTES[t.provider] ?? null,
            }));
          } catch (err) {
            return send(200, {
              configured: true,
              reachable: false,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          return send(200, {
            configured: true,
            reachable: true,
            integrations,
            packAvailable: pack !== null,
            outPathExists: out !== null && existsSync(out),
            durationSec,
            receipt: await readPublishReceipt(workdir),
          });
        }

        if (url.pathname === "/api/publish" && req.method === "POST") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const configured = resolvePublishConfig();
          if (!configured.ok) return send(412, { error: configured.message });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = z
            .object({
              integrationIds: z.array(z.string()).min(1),
              // ISO-8601, validated as a real FUTURE instant below — zod can
              // say "string", only a clock can say "future".
              at: z.string().optional(),
              // Per-integration caption overrides typed in the panel; absent
              // ids fall back to the pack's authored-else-derived caption.
              captions: z.record(z.string(), z.string()).optional(),
              force: z.boolean().optional(),
              // What uploads (the CLI's --delivery): auto (default) builds
              // the cached delivery encode, master sends the untouched render.
              delivery: z.enum(["auto", "master"]).optional(),
            })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          let when: { kind: "now" } | { kind: "at"; iso: string } = { kind: "now" };
          if (parsed.data.at !== undefined) {
            const ms = Date.parse(parsed.data.at);
            if (Number.isNaN(ms)) return send(400, { error: `not an ISO-8601 time: "${parsed.data.at}"` });
            if (ms <= Date.now()) return send(400, { error: `schedule time already passed: "${parsed.data.at}"` });
            when = { kind: "at", iso: new Date(ms).toISOString() };
          }
          const cmd = await readCommandRecord();
          const out = cmd ? recordedOutPath(cmd) : null;
          if (out === null || !existsSync(out)) {
            return send(412, { error: "no finished render to publish — render first" });
          }
          const pack = await currentYoutubePack();
          if (pack === null) {
            return send(412, { error: "no YouTube pack — approve one in the SEO panel first" });
          }
          const receipt = await readPublishReceipt(workdir);
          if (receipt !== null && parsed.data.force !== true) {
            return send(412, {
              error: `already published on ${receipt.publishedAt} — pass force to publish again`,
              receipt,
            });
          }
          try {
            const provider = createPostizProvider({
              baseUrl: configured.baseUrl,
              apiKey: configured.apiKey,
              fetchImpl: opts.publishFetch,
            });
            const targets = await provider.listTargets();
            let picked = parsed.data.integrationIds.map((id) => {
              const hit = targets.find((t) => t.id === id);
              if (!hit) throw new Error(`no integration with id "${id}" in Postiz`);
              return hit;
            });
            // Same core helpers, same semantics as the CLI (checkDurationCaps
            // + ensureDeliveryFile — one spelling of the rules): drop the
            // channels this video can never land on, publish the rest, and
            // only when EVERY pick is over its cap refuse the whole request.
            const tools = publishTools();
            const masterProbe = await (opts.probeVideo ?? probe)(tools, out);
            const violations = checkDurationCaps(picked, masterProbe.duration);
            // Duration entries keep their original shape; size entries carry
            // a `reason` and the cap that doomed them — additive fields only,
            // so an older panel reading `dropped` keeps working.
            const dropped: Array<Record<string, unknown>> = violations.map((v) => ({
              id: v.target.id,
              provider: v.target.provider,
              name: v.target.name,
              capSec: v.capSec,
            }));
            if (violations.length > 0) {
              const over = new Set(violations.map((v) => v.target.id));
              picked = picked.filter((t) => !over.has(t.id));
              if (picked.length === 0) {
                return send(412, {
                  error:
                    `every picked channel refuses a ${Math.round(masterProbe.duration)}s video — ` +
                    "nothing to publish",
                  dropped,
                });
              }
            }
            // Size-cap pre-check with the pure plan (the CLI's semantics,
            // one spelling): an unattainable cap drops the channel BEFORE
            // any encode — ensureDeliveryFile THROWS on unattainable, and a
            // 502 with ffmpeg arithmetic in it is not a drop-and-continue.
            const masterSizeBytes = (await stat(out)).size;
            const src = {
              width: masterProbe.width,
              height: masterProbe.height,
              fps: masterProbe.fps,
              duration: masterProbe.duration,
              sizeBytes: masterSizeBytes,
            };
            let capGroups = sizeCapGroups(picked);
            if (parsed.data.delivery !== "master") {
              for (const [capBytes, group] of capGroups) {
                const capped = deliveryEncodePlan(src, { sizeCapBytes: capBytes });
                if (capped !== null && "unattainable" in capped) {
                  for (const t of group) {
                    dropped.push({
                      id: t.id,
                      provider: t.provider,
                      name: t.name,
                      sizeCapBytes: capBytes,
                      reason: "size",
                    });
                  }
                  const over = new Set(group.map((t) => t.id));
                  picked = picked.filter((t) => !over.has(t.id));
                }
              }
              if (picked.length === 0) {
                return send(412, {
                  error:
                    `every picked channel's size cap is unattainable for a ` +
                    `${Math.round(masterProbe.duration)}s video — nothing to publish`,
                  dropped,
                });
              }
              capGroups = sizeCapGroups(picked);
            }
            const posts = buildPublishPosts(pack, picked).map((p) => ({
              ...p,
              caption: parsed.data.captions?.[p.target.id] ?? p.caption,
            }));
            // Synchronous encodes (~1–3 min each, fetch won't time out) — a
            // job/poll model for the WORK is a noted follow-up, but the
            // PROGRESS is polled: /api/publish/progress reads the state the
            // onProgress callback below keeps current. Sequential per cap
            // group (two ffmpegs racing for cores would slow both), so pct
            // simply runs 0→100 once per file and `file` names which one.
            let uploadPath = out;
            const cappedPaths = new Map<number, string>();
            if (parsed.data.delivery !== "master") {
              // `workdir` is a mutable binding, so its non-null narrowing
              // from the top of the handler doesn't survive into a closure —
              // capture it while narrowed.
              const wd = workdir;
              const runEnsure = async (
                sizeCapBytes?: number,
              ): ReturnType<typeof ensureDeliveryFile> => {
                let currentFile: string | null = null;
                publishProgress = { phase: "encoding", pct: 0, etaSec: null, speed: null, file: null };
                return (opts.ensureDelivery ?? ensureDeliveryFile)(tools, wd, out, {
                  ...(sizeCapBytes !== undefined ? { sizeCapBytes } : {}),
                  onStart: (name) => {
                    currentFile = name;
                    publishProgress = { phase: "encoding", pct: 0, etaSec: null, speed: null, file: name };
                  },
                  onProgress: (p) => {
                    publishProgress = {
                      phase: "encoding",
                      // Percent against the MASTER's duration — the delivery
                      // encode preserves it, so out_time maps 1:1.
                      pct:
                        p.outTimeSec !== undefined && masterProbe.duration > 0
                          ? Math.min(
                              100,
                              Math.round((p.outTimeSec / masterProbe.duration) * 100),
                            )
                          : null,
                      etaSec:
                        p.outTimeSec !== undefined && p.speed !== undefined
                          ? encodeEta(masterProbe.duration, p.outTimeSec, p.speed)
                          : null,
                      speed: p.speed ?? null,
                      file: currentFile,
                    };
                  },
                });
              };
              uploadPath = (await runEnsure()).path;
              // One encode per DISTINCT cap — the bitrate-bearing filename is
              // the cache key, so a capped plan that lands on the default
              // file's name cache-hits instead of re-encoding.
              for (const capBytes of capGroups.keys()) {
                cappedPaths.set(capBytes, (await runEnsure(capBytes)).path);
              }
            }
            // No upload ETA — Postiz's multipart upload gives us nothing to
            // measure, so the phase alone is the signal.
            publishProgress = { phase: "uploading", pct: null, etaSec: null, speed: null, file: null };
            const result = await provider.publish({
              videoPath: uploadPath,
              posts: attachDeliveryMedia(posts, uploadPath, cappedPaths),
              when,
            });
            await writeFile(publishReceiptPath(workdir), `${JSON.stringify(result, null, 2)}\n`);
            return send(200, { ok: true, receipt: result, dropped });
          } catch (err) {
            // Fail loud, verbatim — Postiz's own validation message is the
            // most specific thing anyone has (per-provider settings are its
            // domain, not ours).
            return send(502, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            publishProgress = null;
          }
        }

        if (url.pathname === "/api/publish/progress" && req.method === "GET") {
          // Where the in-flight publish is — 200 always, `progress: null`
          // when idle (a cache hit or a skip-plan publish never enters the
          // encoding phase, and the panel keeps its static line for that).
          return send(200, { progress: publishProgress });
        }

        if (url.pathname === "/api/publish/regenerate" && req.method === "POST") {
          // Rewrite ONE network's caption with the LLM the produce run used
          // (handoff 2026-08-29 item 4): the prompt carries the transcript,
          // the caption AS THE PANEL HOLDS IT and the user's correction, and
          // the replacement text rides back into the panel's box. Nothing
          // auto-sends and nothing writes to the pack — the user still
          // reviews, edits and presses Publish.
          if (!workdir) return send(409, { error: "no workdir open" });
          // An LLM call costs money — one at a time, a second is a 409 like
          // a second thumbnail.
          if (captionRegenBusy) {
            return send(409, { error: "a caption regeneration is already running" });
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // `currentCaption` is deliberately the client's text — the ONE
          // body-steered value beyond the ask itself, because the box may
          // hold the user's manual edits and the model must see what the
          // user sees. It steers only prompt text, never a path or a spawn.
          const parsed = z
            .object({
              network: z.string().min(1),
              instruction: z.string().min(1),
              currentCaption: z.string(),
            })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // Lenient transcript read (the GET /api/transcript posture), but a
          // 412 when it yields nothing: a rewrite with no transcript would be
          // a rewrite with no factual evidence, which is the exact failure
          // this endpoint exists to repair.
          let transcript: { language: string; words: Array<{ text: string }> } | null = null;
          try {
            const raw = JSON.parse(await readFile(join(workdir, "transcript.json"), "utf8")) as {
              language?: unknown;
              words?: unknown;
            };
            if (Array.isArray(raw.words)) {
              transcript = {
                language: typeof raw.language === "string" ? raw.language : "en",
                words: raw.words.filter(
                  (w): w is { text: string } =>
                    typeof (w as { text?: unknown } | null)?.text === "string",
                ),
              };
            }
          } catch {
            // absent/corrupt → the 412 below
          }
          if (transcript === null || transcript.words.length === 0) {
            return send(412, {
              error:
                "no transcript in this workdir — the rewrite would have nothing to " +
                "ground against; re-run `ossclip produce`.",
            });
          }
          // Env fresh per press, resolvePublishConfig's rule: a key set after
          // startup must count. Skipped when tests own the environment.
          if (opts.publishEnv === undefined) loadEnvFiles();
          const env = opts.publishEnv ?? process.env;
          const usagePath = join(workdir, "usage.json");
          let usageLog: unknown = null;
          try {
            usageLog = JSON.parse(await readFile(usagePath, "utf8"));
          } catch {
            // no log yet — the resolution falls through to the pin/detection
          }
          const cmd = await readCommandRecord();
          const resolved = captionRegenProvider({
            usageLog,
            commandArgs: cmd?.args ?? null,
            env,
            hasBin: (bin) => binOnPath(bin, env),
          });
          if (resolved.status === "unavailable") {
            // Precondition, not a generation failure — 412 like a thumbnail
            // regenerate on an unavailable project.
            return send(412, { error: resolved.reason });
          }
          const provider = (opts.makeLlmProvider ?? createProvider)(resolved.provider);
          captionRegenBusy = true;
          try {
            let caption: string;
            try {
              caption = await generateCaptionRegen(provider, {
                network: parsed.data.network,
                currentCaption: parsed.data.currentCaption,
                instruction: parsed.data.instruction,
                transcriptText: transcript.words.map((w) => w.text).join(" "),
                charCap: captionCap(parsed.data.network),
              });
            } catch (err) {
              // 200 with ok:false, the thumbnail regenerate's posture: a
              // provider failure is a sentence the panel shows VERBATIM,
              // never a dead 500.
              return send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
            const pricing = (opts.loadCfg ?? loadConfig)().pricing ?? {};
            // The spend is real, so it survives the session: appended into
            // the workdir's usage log the way produce appends its runs.
            // Atomic like the overrides write — /api/usage may read it at
            // any moment.
            const nextLog = appendUsageRun(
              usageLog,
              { at: new Date().toISOString(), records: provider.usage },
              pricing,
            );
            const tmp = `${usagePath}.tmp`;
            await writeFile(tmp, JSON.stringify(nextLog, null, 2));
            await rename(tmp, usagePath);
            // Advisory ONLY, never a block: captions legitimately carry
            // brand and platform words the take never speaks. The `--speaker`
            // pin counts as spoken vocabulary for checkGrounding's §39
            // reason — the channel name is in nearly every caption.
            const speaker = lastFlagValue(cmd?.args ?? [], ["--speaker"]);
            const notes = [...new Set(ungroundedTokens(caption, transcript, speaker))].map(
              (token) => `⚠ grounding: "${token}" — not in the take`,
            );
            return send(200, {
              ok: true,
              caption,
              usage: formatUsageLine(provider.usage, pricing),
              notes,
            });
          } finally {
            captionRegenBusy = false;
          }
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
          // The finished mp4's OWN span set — the RESOLVED cutlist, never the
          // proposal /api/cleanup serves: the panel converts the playhead
          // between the output clock and the source clock
          // (handoff-cover-panel §1), and a proposal the user's vetoes already
          // changed is the wrong ruler. Lenient per-span parse, [] on a
          // missing or corrupt production.json — a cover panel that cannot
          // convert must still open.
          let coverCutlist: Segment[] = [];
          try {
            const production = JSON.parse(
              await readFile(join(workdir, "production.json"), "utf8"),
            ) as { cutlist?: unknown };
            if (Array.isArray(production.cutlist)) {
              coverCutlist = production.cutlist.flatMap((s) => {
                const p = SegmentSchema.safeParse(s);
                return p.success ? [p.data] : [];
              });
            }
          } catch {
            // degrade — same as /api/cleanup
          }
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
            cutlist: coverCutlist,
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

        if (url.pathname === "/api/cover/preview-image" && req.method === "GET") {
          if (!workdir) return send(409, { error: "no workdir open" });
          const image = coverPreviewPath();
          if (!existsSync(image)) return send(404, { error: "no preview image" });
          // /api/cover/image's exact posture, for its exact reason: every
          // preview REPLACES the file behind a URL the panel busts with ?ts,
          // and a cached 200 would show the old preview against the new ts.
          const bytes = await readFile(image);
          res.writeHead(200, {
            "content-type": "image/jpeg",
            "cache-control": "no-store",
            "content-length": String(bytes.length),
          });
          res.end(bytes);
          return;
        }

        if (url.pathname === "/api/cover/preview" && req.method === "POST") {
          // The regenerate handler above, verbatim, up to the outPath: a
          // preview is a full cover render — it boots the same headless
          // browser (hence the same coverBusy gate), takes the same three
          // steerable values and nothing else, and fails with the same
          // 200-with-ok:false verbatim-message posture.
          if (!workdir) return send(409, { error: "no workdir open" });
          if (coverBusy) return send(409, { error: "a cover regeneration is already running" });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
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
            const notes: string[] = [];
            await regenerateCover(
              workdir,
              {
                text: parsed.data.text,
                atSec: parsed.data.atSec,
                from: parsed.data.from,
                // The ONE-OFF path, derived HERE and never from the body (the
                // regenerate handler's comment owns why). Same machinery as
                // `ossclip cover --out` (handoff-cover-panel §3): the
                // canonical cover is untouched, provenance updates to
                // describe the previewed frame — which is what makes a
                // follow-up blank-field Apply adopt it via the cheap path,
                // and the one-off note riding back is the panel's disclosure
                // of exactly that.
                outPath: coverPreviewPath(),
              },
              { renderCover: opts.renderCover, log: (line) => notes.push(line) },
            );
            return send(200, {
              ok: true,
              notes,
              // coverImageUrl's mtime rule, aimed at the preview file: the
              // URL changes exactly when the file does.
              previewImageUrl: `/api/cover/preview-image?ts=${Math.round(
                statSync(coverPreviewPath()).mtimeMs,
              )}`,
            });
          } catch (err) {
            return send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
          } finally {
            coverBusy = false;
          }
        }

        if (url.pathname === "/api/sfx/plan" && req.method === "GET") {
          // The MODEL's placement plan plus the word space it is written in
          // (Phase 4). Two values, one route, because they are useless apart:
          // a placement is `{soundId, word}` and `word` is an INDEX, so the
          // editor can only draw a marker — or write one — against the exact
          // array produce counted.
          //
          // And that array is NOT `transcript.json`, which is what
          // /api/transcript serves: produce writes that file straight off
          // whisper (produce.ts, `writeFile(transcriptCache, …)`) and only
          // THEN applies repairs and the `--clip` slice, planning sound
          // effects against the result. `applyRepairs` splices, so the two
          // index spaces need not line up at all — clip.ts's own note on
          // slicing says it outright ("repairs may change word counts, so raw
          // and repaired index spaces need not line up"). An editor drawing
          // this lane off transcript.json would place every marker on the
          // wrong word the moment one repair changed a word count, and its
          // drags would WRITE those wrong indices into overrides.json, where
          // produce reads them in the other space. So the derivation happens
          // HERE, once, on the server that has the pieces.
          //
          // The derivation is `ProductionSchema.repairs`' own stated contract:
          // `applyRepairs(transcript, repairs.filter(r => r.applied))`
          // reconstructs exactly what was rendered. No clip windowing on top:
          // production.json's `transcript` is ALREADY the sliced raw one and
          // its `repairs` were re-indexed with it (produce.ts's `--clip`
          // block: `rawTranscript = rawSlice.transcript` / `repairs =
          // sliceRepairs(…)`), so a second slice here would shift every index
          // by the clip's offset — the very bug this route exists to avoid.
          //
          // Its own route rather than a field on /api/production: that endpoint
          // is the page's hot load path and reads render-props.json, and this
          // needs production.json plus a repair replay. Lenient throughout —
          // any missing or corrupt piece answers `null` and the editor hides
          // the lane, exactly the /api/cleanup posture. A sound-effect lane is
          // never worth a 500.
          if (!workdir) return send(409, { error: "no workdir open" });
          let production: Record<string, unknown> | null = null;
          try {
            production = JSON.parse(
              await readFile(join(workdir, "production.json"), "utf8"),
            ) as Record<string, unknown>;
          } catch {
            return send(200, { sfx: null, words: null });
          }
          // Parsed, never cast (CLAUDE.md) — production.json is a file a user
          // can hand-edit, and the editor has no zod of its own, so the parse
          // that guards this payload has to be this one. A `sfx` field that
          // fails it is the same as none: no lane.
          const parsedSfx = ProductionSfxSchema.safeParse(production.sfx);
          const parsedTranscript = TranscriptSchema.safeParse(production.transcript);
          let words: Array<{ text: string; start: number; end: number }> | null = null;
          if (parsedTranscript.success) {
            const stored = Array.isArray(production.repairs)
              ? (production.repairs as Array<Record<string, unknown>>)
              : [];
            const applied = stored.filter((r) => r.applied === true);
            if (applied.length === 0) {
              words = parsedTranscript.data.words;
            } else {
              // The dictionary rides along for the reason produce's own repair
              // REPLAY passes it (its cached-repairs block): a
              // dictionary-vouched correction clears the phonetic gate only
              // when the vouched set is present, and `applyRepairs` re-decides
              // every proposal it is handed rather than trusting the stored
              // verdict.
              // `dictionary` is `unknown` on the config (file-only, validated
              // at the consumer — config.ts's posture), narrowed here the same
              // way `retranscribeSettings` narrows it a few hundred lines up.
              const rawDict = (opts.loadCfg ?? loadConfig)().dictionary;
              const dictionary =
                Array.isArray(rawDict) && rawDict.every((t) => typeof t === "string")
                  ? (rawDict as string[])
                  : undefined;
              const decided = applyRepairs(
                parsedTranscript.data,
                applied.map((r) => ({
                  startWord: Number(r.startWord),
                  endWord: Number(r.endWord),
                  heard: String(r.heard),
                  correction: String(r.correction),
                })),
                { dictionary },
              );
              // A repair that produce APPLIED but this replay refuses means the
              // reconstruction is not the array the placements were counted
              // against — and a refused splice can change the word count, so
              // every index after it would be off by one with nothing to say
              // so. Refuse the whole word list rather than serve a plausible
              // wrong one (§137's never-misapply rule): the lane hides, and no
              // gesture can write an index into the wrong space.
              words = decided.applied.every((r) => r.applied)
                ? decided.transcript.words
                : null;
            }
          }
          return send(200, {
            sfx: parsedSfx.success ? parsedSfx.data : null,
            // METADATA only, like the library route: text and SOURCE seconds,
            // which is all the client needs to map an index through its own
            // live TimeMap.
            words:
              words === null
                ? null
                : words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
          });
        }

        if (url.pathname === "/api/sfx/library" && req.method === "GET") {
          // The sound palette: what the swap dropdown offers and what a
          // click-to-preview can play. NO workdir guard, unlike its siblings —
          // the library is machine-global (the bundled pack plus every pack in
          // ~/.ossclip/sfx), so it has nothing to do with which project is
          // open, and the panel can render its menu before one is.
          const library = (opts.loadSfx ?? loadSfxLibrary)();
          return send(200, {
            // METADATA only: `absPath` stays server-side. The client addresses
            // a sound by id through /api/sfx/audio, which is what keeps the
            // filesystem out of a value the page could ever hand back (the
            // audio route's path rule is the other half of the same decision).
            sounds: library.sounds.map((s) => ({
              id: s.id,
              whenToUse: s.whenToUse,
              tags: s.tags,
              gain: s.gain,
              ...(s.durationSec !== undefined ? { durationSec: s.durationSec } : {}),
              packName: s.packName,
            })),
            // A user pack with a typo is a thing to SHOW, not to swallow: the
            // loader already degraded rather than throwing, and the panel is
            // the only surface a `~/.ossclip/sfx` author ever sees.
            issues: library.issues,
          });
        }

        if (url.pathname === "/api/sfx/audio" && req.method === "GET") {
          // Click-to-preview. The path comes from the LOADED LIBRARY, never
          // from the client: the query carries an id, the id is looked up, and
          // the file that answers is whatever `loadSfxLibrary` resolved for it.
          // A traversal attempt is therefore not a path to reject but an id
          // nothing answers to — a plain 404, the same as any other unknown id
          // (and `SfxSoundSchema.id` is a slug, so no id can ever spell a path
          // in the first place).
          const id = url.searchParams.get("id") ?? "";
          const sound = (opts.loadSfx ?? loadSfxLibrary)().sounds.find((s) => s.id === id);
          // Existence is re-checked here for `resolveSfxCues`' reason: a pack
          // deleted since the library was read must be a 404, not a 500 out of
          // `statSync` inside `sendFile`.
          if (sound === undefined || !existsSync(sound.absPath)) {
            return send(404, { error: `no sound "${id}" in the library` });
          }
          // No range support: these are sub-second files an `<audio>` element
          // plays whole, and a preview has nothing to seek through.
          sendFile(
            req,
            res,
            sound.absPath,
            MIME[extname(sound.absPath).toLowerCase()] ?? "application/octet-stream",
            false,
          );
          return;
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
