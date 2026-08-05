import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  LayoutSchema,
  SceneSchema,
  TimeMap,
  type KeptSpan,
  mapFromKeptSpans,
  TranscriptSchema,
  analyze,
  applyOverrides,
  applyRepairs,
  assembleScenes,
  applyCaptionEdits,
  buildCaptionLines,
  buildCutlist,
  buildZoomPlan,
  checkGrounding,
  rejectCtaKeyword,
  concatFolder,
  folderManifestKey,
  listFolderVideos,
  coverHeadline,
  cropFilter,
  detectContentRect,
  letterboxedSeconds,
  type ContentRect,
  createFaceDetector,
  createProvider,
  createTieredProvider,
  defaultProviderName,
  defaultTheme,
  detectSilences,
  dropHiddenCues,
  splitThenDropHidden,
  emptyOverrideDoc,
  extractAudio,
  fillPlainCues,
  splitCues,
  landscapeLayout,
  formatCutReport,
  formatGraphicsAccounting,
  findBloopSpans,
  formatBloopSpan,
  findRetakeGroups,
  formatRetakeGroup,
  formatUsageLine,
  formatUsageReport,
  applyUserCuts,
  loadConfig,
  loudnorm,
  MAX_NORMALIZE_UPSCALE,
  ZOOM_MAX_SCALE,
  assessCueFraming,
  bakeNormalizedSource,
  planNormalization,
  type NormalizePlan,
  makeMezzanine,
  measureFace,
  measureFaceInWindows,
  pickCoverFrame,
  measureLevels,
  probe,
  produceScenes,
  reclampPinnedTiming,
  reconcileCopy,
  repairTranscript,
  resolveTheme,
  run,
  runWhisper,
  scanSourceText,
  appendUsageRun,
  OverrideDocSchema,
  CLIP_SNAP_TOLERANCE,
  ClipWindowSchema,
  boundCutlistToWindow,
  formatClipTime,
  parseClipWindowPin,
  sliceRawTranscript,
  sliceRepairs,
  sliceTranscript,
  type Analysis,
  type AppliedRepair,
  type BeatsValidationIssue,
  type CleanupLevel,
  type ClipWindow,
  type LlmProvider,
  type Production,
  type ProviderName,
  type Scene,
  type SceneComponentId,
  type Segment,
  type Transcript,
} from "@ossclip/core";
import { recordRecentProject } from "./edit";
import { editHint } from "./interactive/edit-hint";
import { recordedProduceArgs } from "./replay-argv";
import { renderCover, renderProduction } from "@ossclip/renderer";
import {
  coverTextRect,
  layoutSlots,
  regionsDuring,
  routeAroundSourceText,
} from "@ossclip/scenes/geometry";

/**
 * What a finished run tells its caller. The workdir is what the post-produce
 * editor offer opens; `rendered` is false for a --no-render run, which has
 * props but no video.
 */
export interface ProduceResult {
  workdir: string;
  out?: string;
  rendered: boolean;
}

/**
 * What produced the workdir's transcript.json — written beside it as
 * transcript-key.json (review fix, Urdu field test 2026-08-05). Parsed with
 * zod like the transcript itself: a hand-edited or truncated key must error,
 * not silently decide whether a cache is reused.
 */
export const TranscriptKeySchema = z.object({
  model: z.string(),
  language: z.string().optional(),
});
export type TranscriptKey = z.infer<typeof TranscriptKeySchema>;

/**
 * Whether the cached transcript answers the current request. Pure so all
 * four corners (matching key, differing key, keyless + default, keyless +
 * non-default) are testable without a workdir. A missing key means a workdir
 * from before the key existed; every one of those was transcribed with the
 * config-default model and no -l, so it is treated as exactly that — old
 * workdirs must not all re-transcribe spuriously, but a non-default request
 * against a keyless cache must.
 */
export function transcriptCacheReusable(
  recorded: TranscriptKey | null,
  requested: TranscriptKey,
  defaultModel: string,
): { reuse: boolean; recorded: TranscriptKey } {
  const effective = recorded ?? { model: defaultModel };
  return {
    reuse:
      effective.model === requested.model &&
      // "" and absent both mean whisper's en default — program.ts rejects an
      // empty code, but a key file predating that guard must not wedge.
      (effective.language ?? "") === (requested.language ?? ""),
    recorded: effective,
  };
}

export interface ProduceOptions {
  out?: string;
  cleanup: CleanupLevel;
  transcript?: string;
  render: boolean;
  mezzanine: boolean;
  workdir?: string;
  inspect?: boolean;
  /** Override the measured silence threshold (dBFS). */
  noiseDb?: number;
  /** Hand-authored scenes JSON (Scene[]) — skips the LLM entirely. */
  scenes?: string;
  /** Run the producer brain to plan scenes. */
  produce?: boolean;
  intent?: string;
  provider?: ProviderName;
  llmModel?: string;
  /** Model for mechanical calls; "same" sends everything to the main model. */
  llmFastModel?: string;
  /** Who is on camera — steers repair and exempts their name from grounding. */
  speaker?: string;
  /** Repair ASR mishearings before captions/producer/grounding (default on). */
  repair?: boolean;
  /** Override the whisper model for this run (A/B base.en vs small.en). */
  whisperModel?: string;
  /**
   * `-l` language code for whisper (e.g. "ur", "auto"). Unset keeps whisper's
   * English default — required for a non-English fine-tune, which otherwise
   * decodes garbage (Urdu field test 2026-08-05).
   */
  whisperLanguage?: string;
  /** Debug: force every graphic moment to this component. */
  forceComponent?: SceneComponentId;
  /** Write a cover image beside the video (default on). */
  cover?: boolean;
  /** Explicit cover output path, overriding <out>.cover.jpg. */
  coverPath?: string;
  /** Treat the source as an already-edited reel with burned-in graphics. */
  sourceIsEdited?: boolean;
  /**
   * Spoken blooper marker (R27 §122) — `--blooper-marker blooper`. Saying it
   * on camera cuts the attempt it spoiled, back to that sentence's start.
   */
  blooperMarker?: string;
  /**
   * `--collapse-retakes` (R27 §128): deterministically collapse consecutive
   * near-identical sentences — the flub the speaker did NOT mark out loud.
   * Opt-in, default off for v1: the promotion criterion is clean field runs
   * recorded in this same report appendix, the mechanism this whole findings
   * doc uses to decide when an opt-in flag has earned default-on.
   */
  collapseRetakes?: boolean;
  /**
   * How the source meets the vertical frame. `cover` (default) crops it to
   * fill; `contain` shows the WHOLE frame inset against the backdrop, which is
   * the answer for a landscape take whose content matters beyond the speaker's
   * face.
   */
  sourceFit?: "cover" | "contain";
  /**
   * Output shape (R15). `9:16` is the vertical default every layout was tuned
   * for; `16:9` exports 1920×1080 for YouTube/desktop, where there is no
   * platform chrome to dodge and a landscape source needs no cropping at all.
   */
  aspect?: "9:16" | "16:9";
  /**
   * `--clip <seconds>` (R19 §93): produce only the strongest ~N-second window
   * of a long take, chosen by the producer in the same editorial call as the
   * beat sheet. Requires `--produce`; a source already at or under the target
   * (+20% tolerance) is a no-op, not an error.
   */
  clip?: number;
  /**
   * `--clip-window <start:end>` (§93g): the RESOLVED window's word range,
   * recorded into `command.json` so the editor's Render replays the SAME
   * window with zero LLM calls. Written by clip runs; not for hand use.
   */
  clipWindow?: string;
  /**
   * `--watermark` / `--no-watermark` tri-state: true/false when TYPED,
   * undefined when not — undefined lets the config's `watermark` key supply
   * the default (`resolveWatermark`). Opt-in by design: the default is off
   * for everyone, because a forced watermark on an open-source tool reads as
   * a free-tier limitation; this is voluntary attribution.
   */
  watermark?: boolean;
  /**
   * `<input>` a DIRECTORY: order its clips before concatenating them into the
   * source produce runs on (folder-input-brief.md). `name` (default) is a
   * plain codepoint sort, matching `ls`; `mtime` is oldest-first. Ignored for
   * a file input.
   */
  sort?: "name" | "mtime";
  /**
   * Whether `--sort` was TYPED, as opposed to commander filling in its
   * `"name"` default. `sort` alone can't tell those apart, and `--sort` does
   * nothing on a file input — final-review fix wave, cheap minor c: print a
   * notice instead of silently ignoring a flag the user explicitly reached
   * for.
   */
  sortExplicit?: boolean;
}

/**
 * The effective watermark switch: a TYPED flag always wins (so
 * `--no-watermark` beats a config-on), and only then does the config supply
 * the default. The config side is `=== true`, never truthiness — the value
 * comes from a hand-editable JSON file loadConfig doesn't zod-parse, and a
 * typo'd `"watermark": "no"` coercing a credit ON is exactly the
 * parse-don't-coerce failure CLAUDE.md forbids; for an opt-in credit, off is
 * the only safe reading of anything malformed. Pure so the whole
 * flag × config matrix is testable without a config file on disk.
 */
export function resolveWatermark(
  flag: boolean | undefined,
  configValue: boolean | undefined,
): boolean {
  return flag ?? configValue === true;
}

function sha1File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha1");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

/**
 * Byte-for-byte comparison, used only to decide `planScreenshotSrcCopy`'s
 * `identical` input for a same-basename `side-images/` collision. Side
 * images are screenshots, not multi-gigabyte video — a size check plus a
 * full read is simpler and strictly more correct than hashing (no collision
 * risk to reason about) at a cost this call site never notices. IO glue,
 * kept out of the pure decision function on purpose.
 */
function filesIdentical(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Where a run's cache/work directory lives, keyed off `identity` — the input
 * file for an ordinary run, or the FOLDER itself for `produce <folder>`
 * (folder-input-brief.md: hashing is the caller's job because the two cases
 * hash different things — a file's bytes vs. a folder's path — this only
 * places the result). `--workdir` overrides the root; the identity's own
 * basename still names the subfolder so two different inputs sharing one
 * `--workdir` don't collide.
 */
function deriveWorkdir(
  identity: string,
  hash: string,
  workdirOpt: string | undefined,
  landscape: boolean,
): string {
  const workRoot = workdirOpt ? resolve(workdirOpt) : join(dirname(identity), ".ossclip");
  return join(
    workRoot,
    `${basename(identity).replace(/\.[^.]+$/, "")}-${hash}${landscape ? "-16x9" : ""}`,
  );
}

/**
 * Default output path when `--out` is not given. MUST be derived from the
 * ORIGINAL input the user typed, never from `input` after a folder run
 * reassigns it — review fix on the first cut of folder-input-brief.md: `input`
 * by render time is `<workdir>/source-concat.mp4`, so deriving the default
 * from it put `ossclip produce ~/Downloads/MyClips`'s output INSIDE the
 * hidden `.ossclip` workdir (`.../MyClips-<hash>/source-concat.ossclip.mp4`)
 * instead of beside the folder (`~/Downloads/MyClips.ossclip.mp4`), where a
 * file input's equivalent default already lands.
 */
export function defaultOutPath(originalInput: string): string {
  return originalInput.replace(/(\.[^.]+)?$/, ".ossclip.mp4");
}

/**
 * Which directory the Remotion render will bundle its `publicDir` from,
 * given the SAME `mezzanineWillBuild` boolean `produce()` computes once and
 * feeds to the real `renderVideo` assignment further down — passed in,
 * rather than recomputed here, so the two can never read a different answer
 * to "will a mezzanine get built" than each other.
 *
 * Finding 3 (final-review fix wave): `dirname(renderVideo)` is where
 * Remotion's `staticFile()` looks; a side-image accepted from some OTHER
 * directory (a folder run's clips folder, or — the reviewer's pre-existing
 * "latent" case — a file run's own folder once a mezzanine gets built)
 * passes the accept check and then 404s inside the render, after the run has
 * already spent the minutes getting there. `analysisInput` becomes something
 * other than `input` only via the framing bake, and that bake always writes
 * into `work`; the mezzanine build is the other path into `work`.
 */
export function planRenderPublicDir(p: {
  input: string;
  inputIsAnalysisInput: boolean;
  mezzanineWillBuild: boolean;
  work: string;
}): string {
  return !p.inputIsAnalysisInput || p.mezzanineWillBuild ? p.work : dirname(p.input);
}

/** Fixed subfolder every copied side-image lands in — see `planScreenshotSrcCopy`. */
export const SIDE_IMAGE_SUBDIR = "side-images";

/**
 * An http(s) URL `src` is ScreenshotFrame's own documented territory — the
 * component resolves `/^https?:\/\//` itself instead of calling
 * `staticFile()` (ScreenshotFrame.tsx) — so produce must pass it through
 * untouched: no filesystem lookup, no copy, no rewrite (audit fix: the
 * safe-src check used to reject a URL as "names a path, not a bare filename",
 * a misleading message about a shape the renderer explicitly supports).
 */
export function isRemoteScreenshotSrc(src: string): boolean {
  return /^https?:\/\//.test(src);
}

/** A bare filename: no separator of either flavor, and not a `.`/`..` segment. */
function isBareSafeName(name: string): boolean {
  return name.length > 0 && !/[\\/]/.test(name) && name !== "." && name !== "..";
}

/**
 * Whether an LLM-authored `ScreenshotFrame` `src` is safe to let drive
 * filesystem access AT ALL. Checked BEFORE the accept-list lookup, not just
 * before the copy — a crafted `src` could otherwise use `existsSync` itself
 * as a path-existence oracle. `src` is unconstrained free text the producer
 * invents from the transcript (R22 §112's comment on `ScreenshotFrameProps.
 * src` — "will happily invent... from the transcript"); a value containing a
 * path separator or a bare `.`/`..` segment is refused outright, never
 * sanitized down to a bare name and used anyway (CLAUDE.md: values from
 * outside are parsed, not coerced — a stripped `../../etc/passwd` silently
 * becoming `passwd` is exactly the kind of "looks handled" bug that rule
 * exists to prevent).
 *
 * ONE exception, and it is exactly one shape: `<SIDE_IMAGE_SUBDIR>/<bare
 * safe name>` — the self-namespaced form `produce()` itself writes back into
 * `production.json` post-copy (`planScreenshotSrcCopy`'s `destRel`).
 * `--scenes <path>` re-ingests a PRIOR run's scenes array as the documented
 * no-LLM tweak workflow (program.ts: "hand-authored scenes JSON — no LLM in
 * the loop"), and that array can legitimately already contain this exact
 * shape from the run it came from. Refusing it here would drop the image to
 * a placeholder on every `--scenes` re-run of a previously-produced project
 * — a regression this fix must not introduce while closing the traversal
 * hole. This is NOT a general "one slash is fine" rule: `side-images/../x`,
 * `side-images/a/b.png`, and `other/foo.png` all still fail below, since
 * only a first segment matching the fixed subfolder AND a bare name after
 * it qualifies.
 *
 * Deliberately NOT enforced as a zod `.refine` on `ScreenshotFrameProps.src`
 * itself: the schema has no notion of "this run's own accepted output," so
 * it can't distinguish the one safe slash-shape from every unsafe one
 * without duplicating this exact logic — and getting it wrong there would
 * reject produce's own accepted output on every future parse (the editor
 * re-parses `production.json` through this same schema). The boundary that
 * needs to refuse the LLM's raw guess (and allow its own prior output back
 * in) is produce()'s, not the schema's.
 */
export function isSafeScreenshotSrc(src: string): boolean {
  if (isBareSafeName(src)) return true;
  const parts = src.split("/");
  return parts.length === 2 && parts[0] === SIDE_IMAGE_SUBDIR && isBareSafeName(parts[1]!);
}

/**
 * What to do with an accepted side-image that has to leave `foundDir` and
 * land in the render's public dir. Landing inside a FIXED `side-images/`
 * subfolder (`SIDE_IMAGE_SUBDIR`, never the public dir's root) makes a
 * collision with a reserved pipeline filename (`mezzanine.mp4`,
 * `source-concat.mp4`, …) impossible BY CONSTRUCTION — those artifacts never
 * live in that subfolder — rather than something this function has to
 * detect. Important finding (final-review fix wave, second pass on Finding 3):
 * the original copy wrote straight to `join(publicDir, src)`, so a `src`
 * equal to `mezzanine.mp4` silently overwrote the real mezzanine BEFORE its
 * own `existsSync` guard ran, skipping the build and feeding a still image
 * to the renderer as `renderVideo`; on a folder run with mezzanine off, the
 * equivalent collision (`source-concat.mp4`) corrupted the actual analyzed
 * source for the run and every cache reuse after it. What namespacing
 * doesn't resolve on its own: whether the (now collision-free) destination
 * is free, already holds the identical bytes (a re-run, or two scenes
 * sharing one image — skip the redundant copy, still point `src` at it), or
 * holds something else under that name (two different images that happen to
 * share a basename — refuse rather than let the second clobber the first).
 */
export function planScreenshotSrcCopy(dest: {
  exists: boolean;
  identical: boolean;
}): "copy" | "skip-identical" | "conflict" {
  if (!dest.exists) return "copy";
  return dest.identical ? "skip-identical" : "conflict";
}

/**
 * The served relative URL a copied side-image is rewritten to. MUST be
 * POSIX-literal — never `path.join()` — because this string is a SERVED
 * URL, not a filesystem path: it gets written into `holder.props.src` and
 * read back by Remotion's `staticFile()`, which splits ONLY on `/`
 * (`static-file.js`: `path.split('/')`). `path.join()` uses the platform
 * separator, so on Windows this would silently become
 * `side-images\foo.png`, which `staticFile()` then encodes as ONE opaque
 * segment (`side-images%5Cfoo.png`) that matches nothing on disk — every
 * side-image render breaking on Windows, the exact shape of the 0.1.4→0.1.5
 * cautionary tale (CLAUDE.md's Releases section). Pulled out as its own
 * function so this literal can be pinned by a test independent of the
 * platform running that test.
 */
export function sideImageDestRel(src: string): string {
  return `${SIDE_IMAGE_SUBDIR}/${basename(src)}`;
}

/**
 * Frame-area share above which a layout's video slot is the SUBJECT rather
 * than an inset. `video-top` is 42% and full-bleed 100%; the pip bubble is 5%.
 */
const PRIMARY_VIDEO_SLOT_AREA = 0.2;

async function preflight(bin: string, hint: string): Promise<void> {
  try {
    await run(bin, ["-version"], { allowNonZero: true });
  } catch {
    try {
      await run(bin, ["--help"], { allowNonZero: true });
    } catch {
      throw new Error(`'${bin}' not found. ${hint}`);
    }
  }
}

export async function produce(inputArg: string, opts: ProduceOptions): Promise<ProduceResult> {
  const cfg = loadConfig();
  // `let`, not `const`: a folder input is reassigned to the concat
  // intermediate below (folder-input-brief.md) so nothing past that point has
  // to know a folder was ever involved. `originalInput` keeps what the user
  // actually typed — review fix: the default --out path and the "beside the
  // video" image lookup both used to read the REASSIGNED `input`, which for a
  // folder run is a file inside the hidden workdir, not anything the user
  // would recognise.
  const originalInput = resolve(inputArg);
  let input = originalInput;
  if (!existsSync(input)) throw new Error(`input not found: ${input}`);

  // §93b: the window is an editorial judgement, and there is deliberately no
  // heuristic fallback — an automatically-guessed 60 seconds reads as a bug,
  // not a limitation. Refused up front, before any work is spent.
  if (opts.clip !== undefined) {
    if (opts.scenes) {
      throw new Error(
        "--clip cannot be combined with hand-authored --scenes — the window is the producer's call.",
      );
    }
    if (!opts.produce) {
      throw new Error(
        "--clip needs the producer's editorial judgement: add --produce. " +
          "There is no heuristic fallback for picking the window.",
      );
    }
  }
  if (opts.clipWindow !== undefined && opts.clip === undefined) {
    throw new Error("--clip-window is recorded by --clip runs for replay — pass --clip too.");
  }

  await preflight(cfg.ffmpegPath, "Run `ossclip setup`, install ffmpeg yourself (brew/apt/winget), or set OSSCLIP_FFMPEG.");
  await preflight(cfg.ffprobePath, "Run `ossclip setup`, install ffmpeg (provides ffprobe), or set OSSCLIP_FFPROBE.");

  // The output frame — every rect downstream is a fraction of THIS, and the
  // stage geometry now takes it as an argument rather than assuming portrait.
  const landscape = opts.aspect === "16:9";
  const frame = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const tools = { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath };

  // Folder input (folder-input-brief.md, 2026-08-05 field request). The
  // workdir hash is derived from the folder's CONTENT — `folderManifestKey`
  // over the enumerated clips — not the folder path. Review fix: a path-only
  // hash is stable across content changes, but everything else this run
  // caches into the same workdir (audio.wav, transcript.json, the
  // content-rect cache, the mezzanine) is keyed on EXISTENCE, not content. A
  // path-only hash meant adding a take rebuilt `source-concat.mp4` correctly
  // but silently reused all of those against the OLD concat, producing a
  // video with captions transcribed against a different edit. Hashing the
  // manifest content gives a folder input the same invariant a file input
  // already has via `sha1File`: content changes ⇒ a fresh workdir.
  const isFolder = statSync(input).isDirectory();
  // Final-review fix wave, cheap minor c: --sort only means anything for a
  // folder input; on a file it did nothing, silently. Gated on `sortExplicit`
  // (whether the user TYPED it) rather than on `opts.sort` itself, since
  // commander's own "name" default would otherwise print this on every plain
  // file run.
  if (!isFolder && opts.sortExplicit) {
    console.log("▸ --sort is ignored — <input> is a file, not a folder of clips");
  }
  let folderListing: Awaited<ReturnType<typeof listFolderVideos>> | undefined;
  let hash: string;
  if (isFolder) {
    folderListing = await listFolderVideos(input);
    hash = createHash("sha1")
      .update(folderManifestKey(folderListing.entries, opts.sort ?? "name"))
      .digest("hex")
      .slice(0, 8);
  } else {
    hash = (await sha1File(input)).slice(0, 8);
  }
  const work = deriveWorkdir(input, hash, opts.workdir, landscape);
  await mkdir(work, { recursive: true });
  console.log(`▸ workdir ${work}`);

  if (isFolder && folderListing) {
    const sort = opts.sort ?? "name";
    const result = await concatFolder(tools, input, folderListing, work, sort, {
      w: frame.width,
      h: frame.height,
    });
    console.log(
      `▸ folder: ${result.clips.length} clip(s), sorted by ${sort}, ` +
        `concat ${result.durationSec.toFixed(1)}s${result.cached ? " (cached)" : ""}`,
    );
    if (result.nonVideoCount > 0) {
      console.log(
        `  ${result.nonVideoCount} non-video file${result.nonVideoCount === 1 ? "" : "s"} ignored`,
      );
    }
    // Order visible immediately (folder-input-brief.md) — a wrong order is a
    // silent bug otherwise, invisible until someone watches the whole thing.
    result.clips.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name} (${c.durationSec.toFixed(2)}s)`);
    });
    input = result.path;
  }

  const sourceProbe = await probe(tools, input);
  console.log(
    `▸ source ${sourceProbe.width}x${sourceProbe.height} @ ${sourceProbe.fps.toFixed(2)}fps · ${sourceProbe.duration.toFixed(2)}s`,
  );
  if (!sourceProbe.hasAudio) throw new Error("source has no audio stream — nothing to cut by");

  // §93c: a source already at or under the target is a no-op, not an error —
  // nobody should have to remember to drop the flag per input. The tolerance
  // matches the sentence-snap band, so "just over" doesn't force a selection.
  let clipTargetSec = opts.clip;
  if (
    clipTargetSec !== undefined &&
    sourceProbe.duration <= clipTargetSec * (1 + CLIP_SNAP_TOLERANCE)
  ) {
    console.log(
      `▸ source is ${sourceProbe.duration.toFixed(1)}s — already within the ` +
        `${clipTargetSec}s clip target (+${(CLIP_SNAP_TOLERANCE * 100).toFixed(0)}% tolerance); ` +
        "producing the whole take",
    );
    clipTargetSec = undefined;
  }

  const audioPath = join(work, "audio.wav");
  if (!existsSync(audioPath)) {
    console.log("▸ extracting audio…");
    await extractAudio(tools, input, audioPath);
  }

  // Letterbox detection (PLAN Task 7): a file's frame is not always its
  // picture — bars baked into the pixels wasted most of the video slot on one
  // real clip. Measured once, before anything geometric; every downstream
  // pass crops to the content rect so the bars stop existing.
  const detection = await detectContentRect(tools, input, sourceProbe, { cacheDir: work });
  const contentTimeline = detection.timeline;
  const cropVf = cropFilter(detection.uniform);
  if (detection.uniform && !detection.uniform.full) {
    console.log(
      `▸ source is letterboxed: content ${detection.uniform.w}×${detection.uniform.h} at ` +
        `x ${detection.uniform.x}, y ${detection.uniform.y} (bars trimmed everywhere downstream)`,
    );
  }


  let transcript: Transcript;
  const transcriptCache = join(work, "transcript.json");
  // Which model/language WROTE transcript.json, recorded beside it (review
  // fix, Urdu field test 2026-08-05): the cache used to be reused on
  // existence alone, so a warm workdir silently served the stale English
  // transcript on the first `--whisper-language ur` retry — the exact run
  // the flag exists for — and equally defeated the model A/B the
  // --whisper-model help text advertises.
  const transcriptKeyPath = join(work, "transcript-key.json");
  const requestedKey: TranscriptKey = {
    model: opts.whisperModel ?? cfg.model,
    ...(opts.whisperLanguage !== undefined ? { language: opts.whisperLanguage } : {}),
  };
  let cacheVerdict: ReturnType<typeof transcriptCacheReusable> | null = null;
  if (!opts.transcript && existsSync(transcriptCache)) {
    const recorded = existsSync(transcriptKeyPath)
      ? TranscriptKeySchema.parse(JSON.parse(await readFile(transcriptKeyPath, "utf8")))
      : null;
    cacheVerdict = transcriptCacheReusable(recorded, requestedKey, cfg.model);
  }
  if (opts.transcript) {
    transcript = TranscriptSchema.parse(JSON.parse(await readFile(resolve(opts.transcript), "utf8")));
    console.log(`▸ transcript injected from ${opts.transcript} (${transcript.words.length} words)`);
    // An injected transcript came from no whisper run at all, so any key left
    // by an earlier one would mislabel the cache this branch overwrites below.
    // Keyless-as-default keeps today's behavior: later default runs reuse it,
    // and only an explicit model/language request re-transcribes over it.
    await rm(transcriptKeyPath, { force: true });
  } else if (cacheVerdict?.reuse) {
    transcript = TranscriptSchema.parse(JSON.parse(await readFile(transcriptCache, "utf8")));
    console.log(`▸ transcript cached (${transcript.words.length} words)`);
  } else {
    if (cacheVerdict !== null) {
      const fmt = (k: TranscriptKey) => `${k.model}/lang ${k.language ?? "default"}`;
      console.log(
        `▸ transcript cache is for model ${fmt(cacheVerdict.recorded)} — ` +
          `re-transcribing with ${fmt(requestedKey)}`,
      );
    }
    await preflight(
      cfg.whisperPath,
      "Run `ossclip setup`, install whisper.cpp yourself (https://github.com/ggml-org/whisper.cpp), or set OSSCLIP_WHISPER.",
    );
    const model = requestedKey.model;
    const modelPath = isAbsolute(model) ? model : join(cfg.modelDir, `ggml-${model}.bin`);
    if (!existsSync(modelPath)) {
      throw new Error(
        `whisper model not found at ${modelPath}.\n` +
          `Run \`ossclip setup${model === cfg.model ? "" : ` --model ${model}`}\` to download it — or manually:\n` +
          `  curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
      );
    }
    console.log(`▸ transcribing (${basename(modelPath)})…`);
    transcript = await runWhisper(
      {
        whisperPath: cfg.whisperPath,
        modelPath,
        outBase: join(work, "whisper"),
        language: opts.whisperLanguage,
      },
      audioPath,
    );
    console.log(`▸ transcribed ${transcript.words.length} words`);
    await writeFile(transcriptKeyPath, JSON.stringify(requestedKey, null, 2));
  }
  await writeFile(transcriptCache, JSON.stringify(transcript, null, 2));

  const levels = await measureLevels({ ffmpegPath: cfg.ffmpegPath }, audioPath);
  console.log(
    `▸ levels: floor ${levels.floorDb.toFixed(1)} dB · speech ${levels.speechDb.toFixed(1)} dB ` +
      `→ silence threshold ${levels.thresholdDb.toFixed(1)} dB`,
  );
  console.log("▸ analyzing silences…");
  const silences = await detectSilences(
    { ffmpegPath: cfg.ffmpegPath, noiseDb: opts.noiseDb ?? levels.thresholdDb },
    audioPath,
  );
  // `let`, not `const` (R19 §93): a clip run re-derives all three from the
  // transcript sliced to the chosen window, further down.
  let analysis: Analysis = analyze(transcript, silences, sourceProbe.duration, levels);
  // Spoken blooper markers (R27 §122). Detected on the RAW transcript, before
  // repair — the repair pass reads a bare "blooper." as an oddity and has
  // already been observed proposing "break loop." for it. Detecting first
  // means the marker cannot be rewritten out from under the detector.
  let bloops = opts.blooperMarker ? findBloopSpans(transcript, opts.blooperMarker) : [];
  if (opts.blooperMarker) {
    console.log(
      bloops.length > 0
        ? `▸ blooper marker "${opts.blooperMarker}": ${bloops.length} take(s) cut`
        : `▸ blooper marker "${opts.blooperMarker}": never said — nothing cut`,
    );
    for (const b of bloops) console.log(`  ▸ ${formatBloopSpan(transcript, b)}`);
  }
  // Deterministic retake collapse (R27 §128) — the flub the speaker did NOT
  // mark. Same RAW-transcript-before-repair ordering as the blooper marker
  // above and for the same reason: repair reading a stray restart as an
  // oddity would rewrite the exact pattern this looks for.
  let retakeGroups = opts.collapseRetakes
    ? findRetakeGroups(transcript, analysis, { transparentMarker: opts.blooperMarker })
    : [];
  let retakes = retakeGroups.flatMap((g) => g.cuts);
  if (opts.collapseRetakes) {
    // `exact` never cuts anything — buildCutlist's own early return collapses
    // to one whole-duration `keep` regardless of what's in `retakes` — so
    // "N group(s), M take(s) cut" here was a claim the run never honored.
    // Same fact `valveFired` below already checks; gated the same way
    // (final-review fix wave, cheap minor b).
    if (opts.cleanup === "exact") {
      console.log("▸ collapse-retakes: --cleanup exact wins — nothing cut");
    } else {
      console.log(
        retakeGroups.length > 0
          ? `▸ collapse-retakes: ${retakeGroups.length} group(s), ${retakes.length} take(s) cut`
          : "▸ collapse-retakes: no retakes found",
      );
      for (const g of retakeGroups) {
        for (const line of formatRetakeGroup(transcript, g).split("\n")) console.log(`  ▸ ${line}`);
      }
    }
  }
  let cutlist: Segment[] = buildCutlist({
    transcript,
    analysis,
    duration: sourceProbe.duration,
    level: opts.cleanup,
    bloops,
    retakes,
  });
  let map = new TimeMap(cutlist);
  // Known limit (§128): the sanity valve can cancel a legitimate retake cut
  // along with everything else if analysis went haywire elsewhere. Silence
  // there would be wrong — a collapse the user asked for quietly vanished.
  // Detected directly off buildCutlist's own valve shape (one `keep` segment
  // spanning the whole duration) rather than "no retake reason survived":
  // the merge step reassigns a removal's `reason` to whichever piece is
  // LONGER when it folds two removals together (cutlist.ts, `curDur >
  // prevDur`), so a retake genuinely cut but merged into a longer silence
  // removal would read as "no retake reason survived" even though the cut
  // happened — a false alarm the direct check can't produce.
  // `exact` also collapses to this exact single-keep shape (buildCutlist's
  // own early return) and is not the valve — "touch nothing" is the ask, not
  // a failure, so it's excluded here rather than misreported as one.
  const valveFired = opts.cleanup !== "exact" && cutlist.length === 1 && cutlist[0]!.kind === "keep";
  if (retakes.length > 0 && valveFired) {
    console.log(
      "  ⚠ collapse-retakes found a retake, but the sanity valve reset the whole cutlist — nothing was cut",
    );
  }

  // ---- Transcript repair (FINDINGS §17/§21) --------------------------------
  // Deliberately AFTER the cutlist: the cut is computed from raw ASR, so the
  // same input and --cleanup always produce the same edit whether or not an
  // LLM ran. Everything downstream that a viewer READS — captions, scene copy,
  // the grounding check — uses the repaired transcript instead, so a
  // mishearing can't reach the screen twice in two different spellings.
  const providerName = opts.provider ?? defaultProviderName();
  let provider: LlmProvider | null = null;
  const needsLlm = opts.produce === true;
  if (needsLlm) {
    if (!opts.provider) {
      console.log(
        providerName === "claude-cli"
          ? "▸ no ANTHROPIC_API_KEY — using the Claude Code CLI (subscription auth)"
          : "▸ ANTHROPIC_API_KEY found — using the Claude API",
      );
    }
    provider = createTieredProvider(providerName, {
      model: opts.llmModel,
      fastModel: opts.llmFastModel ?? cfg.fastModel,
    });
  }

  let rawTranscript = transcript;
  let repairs: AppliedRepair[] = [];
  if (provider && opts.repair !== false) {
    const rawKey = createHash("sha1")
      .update(
        JSON.stringify([
          providerName,
          opts.llmModel,
          opts.llmFastModel ?? cfg.fastModel,
          opts.speaker ?? cfg.speaker,
          rawTranscript.words.map((w) => w.text),
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    const repairCache = join(work, `repairs-${rawKey}.json`);
    if (existsSync(repairCache)) {
      repairs = JSON.parse(await readFile(repairCache, "utf8")) as AppliedRepair[];
      transcript = applyRepairs(
        rawTranscript,
        repairs.filter((r) => r.applied),
      ).transcript;
      console.log(`▸ repairs cached (${repairs.filter((r) => r.applied).length})`);
    } else {
      const result = await repairTranscript(provider, rawTranscript, {
        speaker: opts.speaker ?? cfg.speaker,
        // A repair may not merge words across a cut.
        isCut: (startSec, endSec) =>
          cutlist.some(
            (s) => s.kind === "remove" && s.srcIn < endSec && s.srcOut > startSec,
          ),
      });
      transcript = result.transcript;
      repairs = result.applied;
      if (result.error) {
        // NEVER cache a FAILURE (§106). `repairTranscript` fails soft — a
        // dead provider returns zero repairs, which on disk is
        // indistinguishable from "this take needed none". Caching it made the
        // failure permanent: every later run read `[]` and skipped the pass
        // entirely, so the mishearings stayed in the captions and no amount
        // of re-running could fix them. Same family as §78 — an artefact
        // describing a state that isn't the one it was produced under.
        console.log(
          `  ⚠ transcript repair unavailable: ${result.error}\n` +
            "    (not cached — the next run retries the pass)",
        );
      } else {
        await writeFile(repairCache, JSON.stringify(repairs, null, 2));
      }
    }
    for (const r of repairs) {
      console.log(
        r.applied
          ? `  ▸ repaired "${r.heard}" → "${r.correction}"`
          : `  ⚠ repair refused: "${r.heard}" → "${r.correction}" (${r.rejected})`,
      );
    }
  }

  // ---- Framing measurement (PLAN Tasks A+B) --------------------------------
  /**
   * Mixed framing (option (a), decided with the author 2026-07-28): a source
   * that alternates framings is NORMALIZED — every segment cropped to the
   * tightest field of view the take ever shows, placed on that segment's own
   * measured face, and baked into one uniform file. The PLAN is computed here,
   * before the producer, because the producer needs the framing brief: which
   * word ranges are close shots, and which layouts those rule out. The BAKE
   * itself runs after the scenes exist.
   */
  let framingPlan: NormalizePlan | null = null;
  if (!detection.uniform) {
    const boxed = letterboxedSeconds(contentTimeline);
    console.log(
      `▸ source framing CHANGES mid-take: ${contentTimeline.length} segments, ` +
        `${boxed.toFixed(1)}s of ${sourceProbe.duration.toFixed(1)}s letterboxed`,
    );
    for (const seg of contentTimeline) {
      console.log(
        `  · ${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s ` +
          (seg.rect.full
            ? "full frame"
            : `content ${seg.rect.w}×${seg.rect.h} at x ${seg.rect.x}, y ${seg.rect.y}`),
      );
    }
    // Each segment's face, measured inside ITS OWN rect — a single median
    // across mixed framings averages two coordinate systems and points the
    // crop at neither (the old C5 gap; it put the eyes at the top of the
    // frame on the motivating clip).
    const segmentFaces = await measureFaceInWindows(
      tools,
      input,
      contentTimeline.map((seg) => ({
        startSec: seg.startSec,
        endSec: seg.endSec,
        cropVf: cropFilter(seg.rect),
      })),
      { workDir: work },
    );
    framingPlan = planNormalization(contentTimeline, segmentFaces, frame);
  }

  // ---- Scenes: hand-authored file, or the producer brain (PHASE1 §4) ----
  let scenes: Scene[] = [];
  /** Editorial output kept for the cover (§31): hook + its thumbnail form. */
  let beatSheet: { hook: string; coverText?: string } | undefined;
  /** The graphics accounting line for report.txt (§118b), and the beat-sheet
   * issues that explain it. Cached alongside the beat sheet so a cached
   * re-run's report keeps the accounting instead of erasing it (§78). */
  let graphicsLine: string | undefined;
  let beatIssues: BeatsValidationIssue[] = [];
  /** Who planned this run (R16 §78) — stamped into production.json below. */
  let producerStamp: Production["producer"];
  /** The resolved `--clip` window (R19 §93) — set only on a clip run; feeds
   * `production.json`, the report, and the command.json pin below. */
  let clipWindow: ClipWindow | null = null;
  if (opts.scenes) {
    scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(resolve(opts.scenes), "utf8")));
    console.log(`▸ scenes injected from ${opts.scenes} (${scenes.length})`);
  } else if (provider) {
    // Keyed on the repaired transcript's TEXT, not its word count: a repair
    // that swaps "coach and" for "code churn" leaves the count identical, and
    // a count-keyed cache would silently replan from the stale wording.
    // Camera-framing constraints for the producer (PLAN Tasks A+B): windows
    // and canvas from the normalization plan, slot shapes from the stage —
    // injected here because core must stay scenes-free. Only primary slots
    // (video is the subject) are subject to the head-fits rule; a pip bubble
    // is MEANT to be a tight head shot.
    const framingCtx = framingPlan
      ? {
          windows: framingPlan.segments.map((s, i) => ({
            startSec: s.startSec,
            endSec: s.endSec,
            faceFracOfCanvas: framingPlan.faceFracOfCanvas[i] ?? 0,
          })),
          canvasAspect: framingPlan.canvas.width / framingPlan.canvas.height,
          layouts: LayoutSchema.options.map((layout) => {
            const v = layoutSlots(layout).video;
            return {
              layout,
              slotAspect: (v.rect.w * frame.width) / (v.rect.h * frame.height),
              primary: v.opacity > 0 && v.rect.w * v.rect.h >= PRIMARY_VIDEO_SLOT_AREA,
            };
          }),
          zoom: ZOOM_MAX_SCALE,
        }
      : undefined;
    // ---- Clip window resolution (R19 §93) ---------------------------------
    // Authority order: the command.json pin (§93g — the editor's Render must
    // replay the SAME window) > the workdir's window cache > ONE extended
    // beat-sheet call (§93d). Pin and cache both yield a window with zero LLM
    // calls; only a first run selects.
    let clipFresh: Awaited<ReturnType<typeof produceScenes>> | null = null;
    if (clipTargetSec !== undefined) {
      const windowKey = createHash("sha1")
        .update(
          JSON.stringify([
            providerName,
            opts.llmModel,
            opts.intent,
            clipTargetSec,
            framingCtx ?? null,
            transcript.words.map((w) => w.text),
          ]),
        )
        .digest("hex")
        .slice(0, 8);
      const clipWindowCache = join(work, `clipwindow-${windowKey}.json`);
      if (opts.clipWindow) {
        clipWindow = parseClipWindowPin(transcript, opts.clipWindow);
        console.log(
          `▸ clip window pinned by the recorded command: words ` +
            `${clipWindow.startWord}–${clipWindow.endWord}`,
        );
      } else if (existsSync(clipWindowCache)) {
        clipWindow = ClipWindowSchema.parse(JSON.parse(await readFile(clipWindowCache, "utf8")));
        console.log("▸ clip window cached");
      } else {
        console.log(`▸ selecting the strongest ~${clipTargetSec}s window (${providerName})…`);
        clipFresh = await produceScenes(provider, {
          transcript,
          outputDuration: clipTargetSec,
          intent: opts.intent,
          speaker: opts.speaker ?? cfg.speaker,
          forceComponent: opts.forceComponent,
          framing: framingCtx,
          clip: { targetSec: clipTargetSec },
          aspect: landscape ? "16:9" : "9:16",
        });
        clipWindow = clipFresh.clip!.window;
        for (const note of clipFresh.clip!.notes) console.log(`  ▸ ${note}`);
        await writeFile(clipWindowCache, JSON.stringify(clipWindow, null, 2));
      }

      // Slice the pipeline state to the window (§93.1), then let everything
      // downstream — captions, scenes, zoom, the editor — run unchanged on
      // the slice. The raw transcript slices by TIME (repairs may change word
      // counts, so raw and repaired index spaces need not line up); repairs
      // shift with it so production.json stays a reproducible pair.
      console.log(
        `▸ clip: ${formatClipTime(clipWindow.startSec)}–${formatClipTime(clipWindow.endSec)} ` +
          `of ${formatClipTime(sourceProbe.duration)} — ${clipWindow.reason}`,
      );
      const rawSlice = sliceRawTranscript(rawTranscript, clipWindow);
      repairs = sliceRepairs(repairs, rawSlice.offset, rawSlice.transcript.words.length);
      rawTranscript = rawSlice.transcript;
      transcript = sliceTranscript(transcript, clipWindow);
      analysis = analyze(rawTranscript, silences, sourceProbe.duration, levels);
      // Re-detect on the SLICE: word indices moved, so the spans found against
      // the full take no longer address the same words.
      bloops = opts.blooperMarker ? findBloopSpans(rawTranscript, opts.blooperMarker) : [];
      retakeGroups = opts.collapseRetakes
        ? findRetakeGroups(rawTranscript, analysis, { transparentMarker: opts.blooperMarker })
        : [];
      retakes = retakeGroups.flatMap((g) => g.cuts);
      cutlist = boundCutlistToWindow(
        buildCutlist({
          transcript: rawTranscript,
          analysis,
          duration: sourceProbe.duration,
          level: opts.cleanup,
          bloops,
          retakes,
        }),
        clipWindow,
        sourceProbe.duration,
      );
      map = new TimeMap(cutlist);
    }

    const cacheKey = createHash("sha1")
      .update(
        JSON.stringify([
          providerName,
          opts.llmModel,
          opts.intent,
          opts.cleanup,
          opts.forceComponent ?? null,
          // The framing constraints steer layout choice, so a change in the
          // measured framing must invalidate the cached plan.
          framingCtx ?? null,
          // §93f: the clip target and the RESOLVED window key the plan too —
          // without them a clip run and a full run of the same source would
          // collide and answer from each other's cache (the §78 failure
          // mode). Keyed POST-resolution so a replay that derives the same
          // window hits the same entries.
          clipTargetSec ?? null,
          clipWindow ? `${clipWindow.startWord}:${clipWindow.endWord}` : null,
          transcript.words.map((w) => w.text),
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    const sceneCache = join(work, `scenes-${cacheKey}.json`);
    // The cover needs the editorial copy, which is not in the scene list — a
    // cached run must still be able to write one.
    const beatCache = join(work, `beatsheet-${cacheKey}.json`);
    if (clipFresh) {
      // The selection call already planned the scenes (§93d: ONE editorial
      // call chooses the window and the beats inside it) — adopt them and
      // cache under the post-resolution key so re-runs and replays hit it.
      scenes = clipFresh.scenes;
      beatSheet = { hook: clipFresh.beatSheet.hook, coverText: clipFresh.beatSheet.coverText };
      console.log(`▸ hook: ${clipFresh.beatSheet.hook}`);
      console.log(
        `▸ planned ${clipFresh.beatSheet.moments.length} moments, ${scenes.length} scenes` +
          (clipFresh.failures.length > 0
            ? ` (${clipFresh.failures.length} fell back to TitleCard)`
            : ""),
      );
      for (const issue of clipFresh.beatIssues) {
        console.log(`  ⚠ moment ${issue.moment}: ${issue.issue}`);
      }
      beatIssues = clipFresh.beatIssues;
      // `transcript` is the slice here — the space the accounting was made in.
      graphicsLine = formatGraphicsAccounting(
        clipFresh.graphics.delivered,
        clipFresh.graphics.asked,
        transcript,
      );
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(
        beatCache,
        JSON.stringify({ ...beatSheet, graphics: graphicsLine, issues: beatIssues }, null, 2),
      );
    } else if (existsSync(sceneCache)) {
      scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(sceneCache, "utf8")));
      console.log(`▸ scenes cached (${scenes.length})`);
      if (existsSync(beatCache)) {
        // Pre-§118b caches carry no accounting — the report then simply
        // omits the graphics section rather than guessing one.
        const cached = JSON.parse(await readFile(beatCache, "utf8")) as {
          hook: string;
          coverText?: string;
          graphics?: string;
          issues?: BeatsValidationIssue[];
        };
        beatSheet = { hook: cached.hook, coverText: cached.coverText };
        graphicsLine = cached.graphics;
        beatIssues = cached.issues ?? [];
      }
    } else {
      console.log(`▸ producing scenes (${providerName})…`);
      if (opts.forceComponent) console.log(`▸ forcing every graphic to ${opts.forceComponent}`);
      const result = await produceScenes(provider, {
        transcript,
        outputDuration: map.outputDuration,
        intent: opts.intent,
        speaker: opts.speaker ?? cfg.speaker,
        forceComponent: opts.forceComponent,
        framing: framingCtx,
        aspect: landscape ? "16:9" : "9:16",
      });
      scenes = result.scenes;
      beatSheet = { hook: result.beatSheet.hook, coverText: result.beatSheet.coverText };
      console.log(`▸ hook: ${result.beatSheet.hook}`);
      console.log(
        `▸ planned ${result.beatSheet.moments.length} moments, ${scenes.length} scenes` +
          (result.failures.length > 0 ? ` (${result.failures.length} fell back to TitleCard)` : ""),
      );
      for (const issue of result.beatIssues) {
        console.log(`  ⚠ moment ${issue.moment}: ${issue.issue}`);
      }
      beatIssues = result.beatIssues;
      graphicsLine = formatGraphicsAccounting(
        result.graphics.delivered,
        result.graphics.asked,
        transcript,
      );
      // Cache props only — overrides are user-owned and live in overrides.json,
      // never in production.json (that file is derived and every `produce`
      // run overwrites it, per the merge rule in `overrides.ts`).
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(
        beatCache,
        JSON.stringify({ ...beatSheet, graphics: graphicsLine, issues: beatIssues }, null, 2),
      );
    }
  }

  // Every LLM call is behind us — repair, beat sheet, one per scene — so this
  // is where a run can finally answer "what did that cost" (FINDINGS §36).
  // A cached run legitimately spends nothing, and says so rather than
  // reporting a zero that looks like a bug.
  if (provider) {
    console.log(
      provider.usage.length === 0
        ? "▸ llm: no calls — repairs and scenes came from the workdir cache"
        : formatUsageLine(provider.usage, cfg.pricing),
    );
    // APPEND, never replace (R16 §78): a fully-cached re-run makes no calls,
    // and overwriting the file with `records: []` erased which provider had
    // planned the video. A malformed or pre-§78 file is a valid input — it
    // becomes the history's first entry rather than an error.
    const logPath = join(work, "usage.json");
    let existing: unknown = {};
    try {
      existing = JSON.parse(await readFile(logPath, "utf8"));
    } catch {
      existing = {};
    }
    const log = appendUsageRun(
      existing,
      { at: new Date().toISOString(), records: provider.usage, provider: providerName },
      cfg.pricing,
    );
    await writeFile(logPath, JSON.stringify(log, null, 2));
    // …and stamp it onto the artefact it explains, so `production.json` says
    // who planned it without a second file to cross-reference.
    const last = log.runs[log.runs.length - 1]!;
    producerStamp = {
      provider: last.provider ?? providerName,
      models: last.models,
      cached: last.cached,
      at: last.at,
    };
  }

  // The overlay and the caption under it must spell the same word (§21).
  // The repair pass runs before the producer, so they normally already agree;
  // this catches the residue where the producer read through a mishearing the
  // repair pass missed ("Orchestration Tax" over a caption reading "text").
  // Word count and timings are untouched, so scene anchors stay valid.
  if (scenes.length > 0) {
    const reconciled = reconcileCopy(transcript, scenes);
    transcript = reconciled.transcript;
    repairs = [...repairs, ...reconciled.applied];
    for (const r of reconciled.applied) {
      console.log(`  ▸ caption "${r.heard}" → "${r.correction}" (matches the on-screen copy)`);
    }
  }

  // Landscape keeps the frame whole (R15): the split-screen layouts are
  // vertical-format answers, and applying them to 16:9 crops the picture into
  // a letterbox for no gain. Remapped here — before assembly — so cues,
  // captions, the framing report and the editor all see one set of layouts.
  if (landscape) {
    const remapped = scenes.filter((sc) => landscapeLayout(sc.layout) !== sc.layout);
    for (const sc of remapped) {
      console.log(`  ▸ ${sc.id}: ${sc.layout} → ${landscapeLayout(sc.layout)} (landscape)`);
      sc.layout = landscapeLayout(sc.layout);
    }
    if (remapped.length > 0) {
      console.log(`▸ ${remapped.length} scene(s) re-laid out for the 16:9 frame`);
    }

    // Layout VARIETY (R21 §101): the first real landscape run put nearly
    // every graphic in a lower third — legal, monotonous, and for stack
    // components actively broken (a BulletList's legibility floor cannot fit
    // 0.18 of frame height; it rendered cropped). Two deterministic rules in
    // time order: stack components never take the shallow band, and no two
    // consecutive graphics share a layout. The prompt asks the producer for
    // the same variety (see the aspect hint); this pass is the guarantee.
    // The editor's per-scene layout override still wins over all of it.
    const STACK_COMPONENTS = new Set<string>(["BulletList", "ChatMock", "TerminalMock"]);
    const VARIETY_CYCLE: Array<Scene["layout"]> = [
      "lower-third",
      "split-right",
      "blurred-behind",
      "split-left",
    ];
    let prevLayout: Scene["layout"] | null = null;
    let varied = 0;
    for (const sc of scenes) {
      let want = sc.layout;
      if (STACK_COMPONENTS.has(sc.component) && want === "lower-third") want = "split-right";
      if (want === prevLayout) {
        const alternatives = VARIETY_CYCLE.filter(
          (l) => l !== prevLayout && !(STACK_COMPONENTS.has(sc.component) && l === "lower-third"),
        );
        want = alternatives[Math.max(0, VARIETY_CYCLE.indexOf(want)) % alternatives.length]!;
      }
      if (want !== sc.layout) {
        console.log(`  ▸ ${sc.id}: ${sc.layout} → ${want} (landscape variety)`);
        sc.layout = want;
        varied++;
      }
      prevLayout = want;
    }
    if (varied > 0) console.log(`▸ ${varied} scene(s) re-laid out for variety`);
  }

  // ---- The user's edit layer: loaded here for `cuts` (PLAN 2026-08-04
  // Task 4) -------------------------------------------------------------
  // Everything ELSE the doc carries (scene props, splits, retyped captions)
  // still applies further down, AFTER assembly and routing, exactly as
  // before this feature existed — see the comment there. `cuts` is the one
  // exception: it changes `map` itself, and every downstream consumer of
  // `map` below this point (assembly, captions, the zoom plan, render-props)
  // must see the POST-cut timeline, so the file has to be read and the cut
  // applied before any of that runs.
  const overridesPath = join(work, "overrides.json");
  let overrideDoc = emptyOverrideDoc();
  if (existsSync(overridesPath)) {
    const parsed = OverrideDocSchema.safeParse(
      JSON.parse(await readFile(overridesPath, "utf8")),
    );
    if (!parsed.success) {
      // Hand-editable user data: refuse rather than silently resetting it.
      throw new Error(`${overridesPath} is not valid: ${parsed.error.message}`);
    }
    overrideDoc = parsed.data;
  }
  // `applyUserCuts`'s `priorMap`: a cut's `startSec`/`endSec` (when it has
  // no `src` yet) and any already-re-anchored splits/pins are expressed
  // relative to whatever render-props the user was LAST looking at, not the
  // fresh automatic `map` this run just rebuilt — reusing `map` as "the
  // frame the doc is in" gets it wrong the moment ANYTHING drifts (review
  // fix wave finding 1 — confirmed for real on the dogfood workdir, where an
  // unrelated blooper-matching change put "output 31s" 5.8s away from where
  // the user actually pointed when they drew the cut). The PREVIOUS run's
  // `render-props.json` is exactly that frame; `null` (no readable
  // render-props.json — first-ever produce, or a corrupt workdir) is passed
  // through as-is rather than defaulting to `map` — `applyUserCuts` needs to
  // tell "no prior frame to compare against" apart from "available and
  // happens to equal `map`" (finding 3's re-anchor gate depends on it).
  const priorRenderProps = join(work, "render-props.json");
  let priorMap: TimeMap | null = null;
  if (existsSync(priorRenderProps)) {
    try {
      const prev = JSON.parse(await readFile(priorRenderProps, "utf8")) as { spans?: KeptSpan[] };
      if (prev.spans) priorMap = mapFromKeptSpans(prev.spans);
    } catch {
      // Unreadable/corrupt — treated the same as no prior run.
    }
  }
  const cutResult = applyUserCuts(overrideDoc, cutlist, map, priorMap);
  cutlist = cutResult.cutlist;
  map = cutResult.map;
  overrideDoc = cutResult.doc;
  if (overrideDoc.cuts.length > 0) {
    console.log(
      `▸ ${overrideDoc.cuts.length} user cut(s) removed ${cutResult.removedSec.toFixed(1)}s ` +
        `of output (${map.outputDuration.toFixed(1)}s remaining)`,
    );
  }
  // Printed regardless of `cutResult.changed`: a missing-render-props
  // fallback (see `resolveCutSourceRanges`) is a decision worth saying out
  // loud even on a run that ends up writing nothing. The actual
  // `overrides.json` write — gated on `changed` — happens further down,
  // beside `render-props.json`'s own write (see the comment there for why).
  for (const r of cutResult.reports) console.log(`  ⚠ ${r}`);

  const { cues: assembled, dropped } = assembleScenes(scenes, transcript, map);
  for (const d of dropped) console.log(`  ⚠ scene ${d.id} dropped: ${d.reason}`);

  // ---- Framing bake (plan step C / option (a)) ----------------------------
  // The MEASUREMENT ran before the producer (Tasks A+B need it in the beat-
  // sheet prompt); the BAKE stays here, after the scenes exist, so a future
  // scene-aware bake has the cues in scope. Moving measurement up changes no
  // edit decision — the cut is still computed on raw ASR above.
  let analysisInput = input;
  let analysisProbe = sourceProbe;
  let analysisCropVf = cropVf;
  let cacheTag = "";
  let fitFallback = false;
  if (framingPlan) {
    const plan = framingPlan;
    if (plan.ok) {
      const planHash = createHash("sha1").update(JSON.stringify(plan)).digest("hex").slice(0, 8);
      const baked = join(work, `content-${planHash}.mp4`);
      if (!existsSync(baked)) {
        console.log(
          `▸ normalizing framing: one ${plan.canvas.width}×${plan.canvas.height} field of view ` +
            `across ${plan.segments.length} segments (upscale ×${plan.coverUpscale.toFixed(2)})…`,
        );
        await bakeNormalizedSource(tools, input, plan, baked);
      } else {
        console.log(`▸ normalized framing cached (${basename(baked)})`);
      }
      analysisInput = baked;
      analysisProbe = await probe(tools, baked);
      analysisCropVf = "";
      cacheTag = basename(baked);
    } else {
      fitFallback = true;
      console.log(
        `  ⚠ strip too small to unify (would upscale ×${plan.coverUpscale.toFixed(2)} > ` +
          `${MAX_NORMALIZE_UPSCALE}) — letterboxed stretches render FITTED at natural size; ` +
          `framing will visibly change at ${contentTimeline.length - 1} boundaries`,
      );
    }
  }
  const contentRect: ContentRect = detection.uniform ?? {
    x: 0, y: 0, w: analysisProbe.width, h: analysisProbe.height, full: true,
  };
  /** The picture's dimensions — what every geometric consumer reasons about. */
  const content = { width: contentRect.w, height: contentRect.h };
  // Computed ONCE and reused by both the accepted-side-image public-dir
  // check below and the real mezzanine build further down — one boolean,
  // not two independent copies of the same condition that could silently
  // drift apart (Finding 3, final-review fix wave: that drift is exactly
  // what let an accepted image 404 inside Remotion's staticFile()).
  const mezzanineWillBuild = analysisInput === input && (opts.mezzanine || !contentRect.full);

  // Face measurement (FINDINGS §13): one static crop offset per source,
  // measured rather than guessed; cached in the workdir like the transcript.
  const faceSamples = 9;
  const faceBox = await measureFace(tools, analysisInput, analysisProbe.duration, {
    cacheDir: work,
    cropVf: analysisCropVf,
    cacheTag,
    samples: faceSamples,
  });
  console.log(
    faceBox
      ? `▸ face at ${(faceBox.centerYFrac * 100).toFixed(0)}% down the frame, ` +
          `${(faceBox.sizeFrac * 100).toFixed(0)}% tall ` +
          `(${faceBox.framesDetected}/${faceBox.framesSampled} frames` +
          `${faceBox.framesRotated ? `, ${faceBox.framesRotated} recovered by tilt sweep` : ""})`
      : // A miss must be LOUD (PLAN Task 8): the silent fallback to the
        // assumed selfie framing is how a wrong crop shipped unnoticed.
        `▸ no face detected in ${faceSamples} sampled frames — using the ASSUMED framing; ` +
          "the crop may be wrong, check the output",
  );

  // A landscape source loses most of its width to the vertical frame, and how
  // much is arithmetic, not opinion: cover-cropping displays the picture at
  // `height × aspect` and keeps only the frame's width of it. Said out loud
  // because the result LOOKS deliberate — a tight talking head — and nothing
  // else in the run would mention that the desk, the screen and the second
  // person are simply gone.
  if (!landscape && opts.sourceFit !== "contain" && content.height > 0) {
    const displayedW = frame.height * (content.width / content.height);
    if (displayedW > frame.width * 1.05) {
      console.log(
        `▸ source is ${(content.width / content.height).toFixed(2)}:1 — a full-frame crop keeps ` +
          `${((frame.width / displayedW) * 100).toFixed(0)}% of its width. ` +
          "Use --source-fit contain to show the whole frame instead.",
      );
    }
  }

  // ---- Route around the source's own burned-in text (FINDINGS §26) --------
  // Fed a finished reel, ossclip would otherwise stack its layer on an
  // existing one — cropping through the source's title and then restating it
  // underneath. Graphics move to a clear slot or are skipped; captions never
  // are, they just relocate.
  //
  // Behind --source-is-edited since R27 §120. The detector cannot tell burned-in
  // GRAPHICS from text that is simply in the room, and on a raw take at a desk
  // it read the background monitors as 45 bands of "source text". The cost is
  // not cosmetic: every graphic was then moved and SHRUNK to a free band —
  // a BulletList pinned to its 36px font floor, a FlowDiagram's slot halved
  // (0.54 → 0.27, type 71 → 35), and a ScreenshotFrame slid onto the speaker's
  // face. Routing around a hazard only pays when there is a hazard, and only
  // the user knows whether their source is already edited.
  const sourceText = opts.sourceIsEdited
    ? await scanSourceText(tools, analysisInput, analysisProbe.duration, {
        cacheDir: work,
        assumeEdited: true,
        cropVf: analysisCropVf,
        cacheTag,
      })
    : { regions: [], assumed: false, framesSampled: 0 };
  if (sourceText.regions.length > 0) {
    console.log(
      sourceText.assumed
        ? "▸ --source-is-edited: assuming burned-in text in the title and caption bands"
        : `▸ source already has on-screen text in ${sourceText.regions.length} band(s) ` +
            `(${sourceText.framesSampled} frames sampled)`,
    );
  }
  // Detection reports SOURCE time; everything downstream — cues, captions, the
  // crop — is output time. Identical only while nothing is cut, so convert
  // rather than let a cut silently slide every region out of place. Regions
  // whose window is entirely removed drop out with it.
  const textRegions = sourceText.regions.flatMap((r) => {
    if (!Number.isFinite(r.endSec)) return [{ ...r, startSec: 0, endSec: map.outputDuration }];
    const startSec = map.toOutputClamped(r.startSec);
    const endSec = map.toOutputClamped(r.endSec);
    return endSec > startSec ? [{ ...r, startSec, endSec }] : [];
  });
  // The frame matters here: the splits separate by X in 16:9, so routing that
  // assumed portrait decided against geometry that is not what renders (§120).
  const routed = routeAroundSourceText(assembled, textRegions, frame);
  for (const r of routed.relayouts) {
    console.log(`  ▸ scene ${r.id}: ${r.from} → ${r.to} (source text in the way)`);
  }
  for (const m of routed.moved) {
    console.log(
      `  ▸ scene ${m.id}: graphic moved into the free band at ` +
        `${(m.y * 100).toFixed(0)}-${((m.y + m.h) * 100).toFixed(0)}%`,
    );
  }
  // Name the destination layout and stop there. The target is whichever
  // alternate the component declares that videoObstacleFor clears, and the
  // two answers do not look alike: `blurred-behind` blurs and dims the
  // picture (clause 3), while `graphic-only` hides it outright at opacity 0
  // (clause 1). Three components declare each, so promising a blurred
  // backdrop would have been a lie half the time (§120).
  for (const o of routed.overlaid) {
    console.log(
      `  ▸ scene ${o.id}: ${o.from} → ${o.to} (no room clear of the video — ` +
        `moved to ${o.to})`,
    );
  }
  for (const s of routed.skipped) console.log(`  ⚠ scene ${s.id} skipped: ${s.reason}`);

  // Source-text routing picks from a component's `altLayouts`, which include
  // the vertical split layouts — so in landscape it can hand back exactly what
  // the remap above removed. Re-assert the constraint on its OUTPUT, and say
  // when that costs a text dodge: the graphic keeps whatever free-band rect
  // routing gave it, but the frame stays whole (R15).
  if (landscape) {
    for (const c of routed.cues) {
      const want = landscapeLayout(c.layout);
      if (want === c.layout) continue;
      console.log(
        `  ▸ ${c.id}: ${c.layout} → ${want} (landscape; source-text routing had moved it)`,
      );
      c.layout = want;
    }
  }

  // ---- The user's edit layer (SPEC: direct manipulation) -------------------
  // `overrideDoc` was already loaded above (before assembly, so `cuts` could
  // reshape `map` in time) — applied here, AFTER assembly and routing, so
  // hand edits sit on top of whatever the producer just planned. Never
  // written to production.json — that file is ours to overwrite.
  const { cues: editedCues } = applyOverrides(routed.cues, overrideDoc);
  // Scenes the user deleted in the editor drop here — their windows become
  // plain takes in the fill below, which is Task C's payoff for Task A.
  // `splitThenDropHidden`, not a bare `dropHiddenCues`: this runs before
  // `splitCues` below, so a hidden ROOT id (`scene-6`) used to erase its
  // whole pre-split window — both the half it names and the half a stored
  // split (R16 §61) had already carved off — before that split ever got a
  // chance to separate them (PLAN 2026-08-04 Task 1, bug 3).
  const { cues: visibleCues, hidden: hiddenIds } = splitThenDropHidden(editedCues, overrideDoc);
  if (hiddenIds.length > 0) {
    console.log(`▸ ${hiddenIds.length} scene(s) hidden by the edit layer: ${hiddenIds.join(", ")}`);
  }
  const theme = resolveTheme(defaultTheme, overrideDoc);

  // A pin freezes a scene's ABSOLUTE time against whatever its neighbours'
  // timing was when it was set. This same plan may since have re-anchored
  // those neighbours (a `--cleanup` level change, new source material), so
  // the pin can now overlap one of them or leave the array out of time
  // order — re-clamp it here, the same way the editor clamps a pinned nudge
  // at drag time, rather than letting an overlap reach `SceneLayer`/
  // `buildCaptionLines`.
  const { cues: reclamped, adjusted } = reclampPinnedTiming(visibleCues);
  for (const id of adjusted) {
    console.log(`  ⚠ pinned timing for ${id} overlapped a re-planned neighbour — clamped back in bounds`);
  }

  // Fill the timeline (PLAN 2026-07-30 Task A): every gap between graphic
  // cues becomes a plain take, split at the cuts so a block never straddles
  // one. Then a SECOND override pass, because the user's framing edits on
  // `take-*` ids target cues that only exist after the fill. That pass is a
  // no-op on the graphic cues it already touched — same component ⇒ no swap
  // ⇒ the prop merge is idempotent — so do not "simplify" it away. Orphans
  // are reported from THIS pass: only now does the id universe include the
  // takes, so a `take-2-1` edit whose take merged away reports here instead
  // of every take id reporting on the first pass.
  const filled = fillPlainCues(reclamped, {
    outputDurationSec: map.outputDuration,
    clipStarts: map.spans.map((s) => s.outIn),
  });
  // User splits (R16 §61) — after the fill so takes split like scenes, and
  // before the final override pass so edits on the `id@ms` halves land. A
  // split whose ROOT was a graphic scene already happened once inside
  // `splitThenDropHidden` above (PLAN 2026-08-04 Task 1) — re-running it here
  // is a no-op for that scene (the split point sits exactly on the joint
  // between the two halves, matching neither), so this call stays the one
  // that actually cuts TAKE ids, which don't exist until the fill just ran.
  const split = splitCues(filled, overrideDoc.splits);
  if (overrideDoc.splits.length > 0) {
    console.log(`▸ ${overrideDoc.splits.length} scene split(s) from the edit layer`);
  }
  const { cues: mergedCues, orphans: rawOrphans } = applyOverrides(split, overrideDoc);
  // Halves of a TAKE the user deleted after splitting: a take id only exists
  // once the fill above runs, so its `id@ms` half couldn't have been seen by
  // `splitThenDropHidden` earlier (that pass only ever saw graphic scenes).
  // Scene halves were already caught above; this is a no-op for them. Same
  // order as the editor's live memo.
  const { cues: sceneCues, hidden: hiddenHalves } = dropHiddenCues(mergedCues, overrideDoc);
  if (hiddenHalves.length > 0) {
    console.log(`▸ ${hiddenHalves.length} split half(s) hidden by the edit layer`);
  }
  // A hidden scene's id is absent from the filled list by construction —
  // that's a deletion doing its job, not a lost edit.
  const orphans = rawOrphans.filter((id) => !hiddenIds.includes(id));
  const editedCount = Object.keys(overrideDoc.scenes).length;
  if (editedCount > 0) {
    console.log(`▸ applied your edits to ${editedCount - orphans.length - hiddenIds.length} scene(s)`);
  }
  for (const id of orphans) {
    console.log(`  ⚠ edit for ${id} dropped — the plan no longer has that scene`);
  }

  const graphicCues = sceneCues.filter((c) => c.kind !== "plain");
  if (graphicCues.length > 0) {
    console.log(
      `▸ ${graphicCues.length} scene(s) on stage, ` +
        `${sceneCues.length - graphicCues.length} plain take(s) filling the gaps: ` +
        graphicCues.map((c) => `${c.component ?? c.id}@${c.startSec.toFixed(1)}s`).join(", "),
    );
  }

  // Grounding post-check (FINDINGS §14a): flags label tokens the take never
  // says — a hallucinated hook label is visible here without watching the video.
  //
  // Checked against the copy that will actually RENDER, overrides included
  // (R27 §124). It used to read the producer's raw scenes, so it was wrong in
  // both directions: it kept reporting invented copy the user had already
  // fixed by hand — the warning outlived the defect, which teaches people to
  // ignore warnings — and it never looked at copy the user typed themselves.
  // `checkGrounding` already merges a scene's `overrides` slot; nothing was
  // filling it from `overrides.json`.
  const scenesAsRendered = scenes.map((s) => {
    const edit = overrideDoc.scenes[s.id]?.props;
    return edit && Object.keys(edit).length > 0
      ? { ...s, overrides: { ...s.overrides, ...edit } }
      : s;
  });
  const groundingIssues = checkGrounding(scenesAsRendered, transcript, opts.speaker ?? cfg.speaker);
  for (const g of groundingIssues) {
    console.log(`  ⚠ grounding: ${g.component} ${g.sceneId} ${g.field} "${g.token}" — not in the take`);
  }

  // CTA-keyword post-check: the keyword mechanic renders ONE shape of ask, and
  // a "reply with a number" prompt is not it. Dropping the prop here — before
  // the cue, the scene file and the caption track ever read it — is what makes
  // ChatMock fall back to rendering the exchange the producer actually planned
  // (`chatBubbles` collapses to a single bubble only while a keyword is set).
  const ctaRejections: Array<{ sceneId: string; keyword: string; reason: string }> = [];
  for (const holder of [...scenes, ...graphicCues]) {
    const kw = holder.props?.keyword;
    if (typeof kw !== "string" || kw.length === 0) continue;
    const reason = rejectCtaKeyword(kw);
    if (!reason) continue;
    delete (holder.props as Record<string, unknown>).keyword;
    ctaRejections.push({ sceneId: holder.id, keyword: kw, reason });
  }
  // Scenes and cues carry the same resolved props, so each rejection is seen
  // twice; report the word once.
  for (const r of [...new Map(ctaRejections.map((r) => [r.keyword, r])).values()]) {
    console.log(`  ⚠ CTA keyword dropped — ${r.reason}`);
  }

  // ScreenshotFrame `src` must name a file that EXISTS (R22 §112). The
  // producer reads the transcript and will happily invent a plausible
  // filename from it — a take that says "CLAUDE.md" produced
  // `src: "claude.md"` — and Remotion treats an unloadable image as a fatal
  // render error, so the whole run died at 40% after four minutes of work.
  // The prop is optional and the component already draws a styled
  // placeholder without it, so dropping the bad reference degrades exactly
  // the way the schema intended. Checked against the directories that can
  // become the render's public dir: the workdir (mezzanine path) and the
  // source's own folder (--no-mezzanine) — which for a FOLDER run is
  // `dirname(input)` no longer, review fix: `input` was already reassigned
  // to `source-concat.mp4` inside `work` by this point, so `dirname(input)`
  // IS `work` and that branch was silently checking the same directory
  // twice. `originalInput` (the folder itself) is the natural place someone
  // would actually drop an image for a folder run.
  //
  // Finding 3 (final-review fix wave): accepting an image from a sideDir is
  // NOT the same as the render being able to load it — Remotion's
  // `staticFile()` only ever looks in ONE directory, `dirname(renderVideo)`.
  // `planRenderPublicDir` computes that same directory from the
  // `mezzanineWillBuild` boolean set above (shared with the real
  // `renderVideo` assignment further down, so the two can't disagree about
  // which directory wins). An image accepted from a sideDir that isn't THAT
  // directory used to pass this check and then 404 mid-render — a failure
  // that surfaced only after the whole pipeline had already spent its budget
  // getting there. The fix is to make the two agree by construction: copy
  // the file into the render's public dir the moment it's accepted from
  // anywhere else. This also retires the "latent" file-input+mezzanine case
  // the reviewer found pre-existing: an image beside a source video that
  // then gets mezzanine'd (the default) was accepted from `dirname(input)`
  // but the mezzanine's public dir is `work` — same failure shape, one
  // branch earlier.
  //
  // Second pass (Important, unsanitized copy destination): `src` drove a
  // read-only `existsSync` before this fix, which was an acceptable risk;
  // once it also drove `mkdirSync(recursive) + copyFileSync` destinations,
  // an unconstrained LLM-authored string became a write primitive. Every
  // `src` is checked with `isSafeScreenshotSrc` BEFORE the lookup (not just
  // before the copy), and every copy lands under `SIDE_IMAGE_SUBDIR` via
  // `planScreenshotSrcCopy` — see those two functions for why.
  const srcRejections: Array<{
    sceneId: string;
    src: string;
    reason: "unsafe" | "not-found" | "conflict";
  }> = [];
  const srcCopies: Array<{ src: string; from: string; destRel: string }> = [];
  const sideDirs = isFolder ? [work, originalInput] : [work, dirname(input)];
  const renderPublicDirPath = planRenderPublicDir({
    input,
    inputIsAnalysisInput: analysisInput === input,
    mezzanineWillBuild,
    work,
  });
  for (const holder of [...scenes, ...graphicCues]) {
    const src = holder.props?.src;
    if (typeof src !== "string" || src.length === 0) continue;
    // A remote URL is the renderer's job, not a file to look up or copy —
    // see `isRemoteScreenshotSrc` for why this must come before the safe-src
    // check (which would otherwise reject it with a misleading message).
    if (isRemoteScreenshotSrc(src)) continue;
    if (!isSafeScreenshotSrc(src)) {
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "unsafe" });
      continue;
    }
    const foundDir = sideDirs.find((dir) => existsSync(join(dir, src)));
    if (!foundDir) {
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "not-found" });
      continue;
    }
    if (foundDir === renderPublicDirPath) continue; // already where the render will look
    // `sideImageDestRel` is POSIX-literal (see its own comment for why);
    // `destAbs` below is a normal `join()` since it IS a filesystem path,
    // not a served URL.
    const destRel = sideImageDestRel(src);
    const destAbs = join(renderPublicDirPath, destRel);
    const sourceAbs = join(foundDir, src);
    const destExists = existsSync(destAbs);
    const plan = planScreenshotSrcCopy({
      exists: destExists,
      identical: destExists && filesIdentical(sourceAbs, destAbs),
    });
    if (plan === "conflict") {
      // A DIFFERENT file already answers to this basename in side-images/ —
      // refuse rather than let one scene's image silently clobber another's
      // (same "warn + drop" treatment as not-found, not an overwrite).
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "conflict" });
      continue;
    }
    if (plan === "copy") {
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(sourceAbs, destAbs);
      srcCopies.push({ src, from: foundDir, destRel });
    }
    // `skip-identical` and `copy` both end with the file at `destAbs` —
    // rewrite the prop so `staticFile()` resolves the NEW location, not the
    // original bare name (which no longer lives at the public dir's root).
    (holder.props as Record<string, unknown>).src = destRel;
  }
  for (const r of [...new Map(srcRejections.map((r) => [r.src, r])).values()]) {
    const why =
      r.reason === "unsafe"
        ? "names a path, not a bare filename — refusing to let it drive a file lookup"
        : r.reason === "conflict"
          ? `a DIFFERENT file already answers to "${basename(r.src)}" in ${SIDE_IMAGE_SUBDIR}/`
          : `not found in the workdir or ${isFolder ? "the source folder" : "beside the source video"}`;
    console.log(`  ⚠ image "${r.src}" ${why} — rendering the frame as a placeholder instead`);
  }
  for (const c of [...new Map(srcCopies.map((c) => [c.src, c])).values()]) {
    console.log(`  ▸ image "${c.src}" copied into ${c.destRel} (found in ${c.from})`);
  }
  // Audit fix: on a --no-mezzanine file run the render's public dir is the
  // source video's OWN folder, so the copies above just wrote a
  // `side-images/` subfolder into a directory the user owns — say so rather
  // than leaving them to discover an unexplained folder beside their input.
  if (srcCopies.length > 0 && renderPublicDirPath !== work) {
    console.log(
      `  ▸ note: rendering without a mezzanine serves images from the source's folder — ` +
        `created ${SIDE_IMAGE_SUBDIR}/ in ${renderPublicDirPath}`,
    );
  }

  const production: Production = {
    version: 1,
    // `originalInput`, not `input`: for a folder run `input` is by now
    // `<workdir>/source-concat.mp4`, and `source.path` only feeds
    // `report.txt`'s printed "source:" line (checked — nothing resolves a
    // file against it) — so it should say what the user actually pointed
    // produce at (final-review fix wave, cheap minor a), same fix shape as
    // `defaultOutPath` above.
    source: { path: originalInput, probe: sourceProbe, audioPath, face: faceBox },
    cleanup: opts.cleanup,
    intent: opts.intent,
    // The RAW transcript, because `analysis` and `cutlist` index into it —
    // storing the repaired one here would leave those pointing at words that
    // no longer exist. Repairs are kept alongside so the repaired transcript
    // stays derivable (`applyRepairs`) rather than being a second truth.
    transcript: rawTranscript,
    repairs: repairs.length > 0 ? repairs : undefined,
    analysis,
    cutlist,
    ...(clipWindow && clipTargetSec !== undefined
      ? { clip: { targetSec: clipTargetSec, ...clipWindow } }
      : {}),
    scenes: scenes.length > 0 ? scenes : undefined,
    producer: producerStamp,
    theme,
    render: { ...frame, fps: 30 },
  };
  await writeFile(join(work, "production.json"), JSON.stringify(production, null, 2));

  let report = formatCutReport(production);
  // §93h: a tool that discards 19 of 20 minutes owes the user an account of
  // why those 19 — the window, its share of the take, and the model's reason.
  if (clipWindow && clipTargetSec !== undefined) {
    const dur = clipWindow.endSec - clipWindow.startSec;
    report +=
      `\nclip window (--clip ${clipTargetSec}):\n` +
      `  ${formatClipTime(clipWindow.startSec)}–${formatClipTime(clipWindow.endSec)} of ` +
      `${formatClipTime(sourceProbe.duration)} (${dur.toFixed(1)}s selected, ` +
      `${((dur / sourceProbe.duration) * 100).toFixed(0)}% of the take)\n` +
      `  reason: ${clipWindow.reason}\n`;
  }
  // §122: a cut that takes whole sentences owes the user the words it took —
  // the timestamps above say WHERE, not what was lost.
  if (bloops.length > 0) {
    report +=
      `\nbloopers cut (you said "${opts.blooperMarker}" — FINDINGS §122):\n` +
      bloops.map((b) => `  ${formatBloopSpan(rawTranscript, b)}`).join("\n") +
      "\n";
  }
  // §128: same reasoning as §122's block above, for the flub the speaker did
  // NOT say a marker over — kept / cut (with similarity) / ignored as a
  // hallucination (with its silence fraction), in the words `report.txt`
  // already trusts. Also the record `--collapse-retakes`'s opt-in default
  // is promoted from: a clean run here is the evidence.
  if (retakeGroups.length > 0) {
    report +=
      "\nretakes collapsed (--collapse-retakes — FINDINGS §128):\n" +
      retakeGroups.map((g) => formatRetakeGroup(rawTranscript, g)).join("\n") +
      "\n";
  }
  // PLAN 2026-08-04 Task 4: the removed ranges themselves are already in the
  // report above (`formatCutReport` walks `production.cutlist`, and the
  // subtracted spans carry `reason: "user"`) — this section is specifically
  // for what a cut MOVED: a decision that landed on a cut edge must be
  // visible here, never silently repositioned.
  if (cutResult.changed && cutResult.reports.length > 0) {
    report +=
      "\noverrides re-anchored by your cut (nothing moved silently):\n" +
      cutResult.reports.map((r) => `  ${r}`).join("\n") +
      "\n";
  }
  const landed = repairs.filter((r) => r.applied);
  if (landed.length > 0) {
    report +=
      "\ntranscript repairs (mishearings corrected before captions — FINDINGS §17/§21):\n" +
      landed.map((r) => `  "${r.heard}" → "${r.correction}"`).join("\n") +
      "\n";
  }
  const refused = repairs.filter((r) => !r.applied);
  if (refused.length > 0) {
    report +=
      "\nrepairs refused (proposed but not a mishearing):\n" +
      refused.map((r) => `  "${r.heard}" → "${r.correction}": ${r.rejected}`).join("\n") +
      "\n";
  }
  if (groundingIssues.length > 0) {
    report +=
      "\ngrounding warnings (labels the take never says — FINDINGS §14):\n" +
      groundingIssues
        .map((g) => `  ${g.component} ${g.sceneId} ${g.field}: "${g.token}"`)
        .join("\n") +
      "\n";
  }
  // §118b: the graphics count justified in the artefact, like every cut is —
  // delivered vs asked and why, then the scheduler's own account of what it
  // demoted. The shortfall issue repeats the accounting line, so it is the
  // one issue not reprinted here.
  if (graphicsLine) {
    report +=
      `\n${graphicsLine} (FINDINGS §118)\n` +
      beatIssues
        .filter((i) => !i.issue.startsWith("graphics:"))
        .map((i) => `  ⚠ moment ${i.moment}: ${i.issue}\n`)
        .join("");
  }
  if (provider) {
    report += formatUsageReport(provider.usage, cfg.pricing);
    // A cached run has no usage block to print, and used to leave the report
    // silent about who planned the video (R16 §78) — the same erasure the
    // usage log had. Name the provider it is reusing.
    if (provider.usage.length === 0 && producerStamp) {
      report +=
        `\nllm: no calls this run — planned by ${producerStamp.provider}` +
        (producerStamp.models.length > 0 ? ` (${producerStamp.models.join(", ")})` : "") +
        `, reused from the workdir cache\n`;
    }
  }
  // R21 §105 — the standard honesty line, in the artefact people forward.
  report +=
    "\nnote: the cut, captions and graphics are AI-generated — review the output before publishing.\n";
  await writeFile(join(work, "report.txt"), report);
  console.log("");
  console.log(report);
  console.log("");

  const baseCaptionLines = buildCaptionLines(transcript, map, {
    // GRAPHIC cues only: a plain take is presentationally a gap, and letting
    // the fill's derived boundaries re-split caption lines would change
    // caption output for zero visual reason (PLAN Task A4.4).
    breakpoints: graphicCues.flatMap((c) => [c.startSec, c.endSec]),
  });
  // The user's retyped caption words (editor, PLAN 2026-07-29 Task 7 scope
  // (a)). Guarded per word: a stale edit — the pipeline re-derived a
  // different word at that position — is dropped LOUDLY, never applied to
  // the wrong word and never silently forgotten.
  const { lines: captionLines, dropped: staleCaptionEdits } = applyCaptionEdits(
    baseCaptionLines,
    overrideDoc.captions,
  );
  const liveCaptionEdits = Object.keys(overrideDoc.captions).length - staleCaptionEdits.length;
  if (liveCaptionEdits > 0) console.log(`▸ ${liveCaptionEdits} caption word(s) retyped by the editor`);
  for (const d of staleCaptionEdits) {
    console.log(
      `  ⚠ caption edit at word ${d.index} dropped: expected "${d.expected}" there, ` +
        `the transcript now has "${d.found}"`,
    );
  }

  // Micro zoom punches (FINDINGS §15) reversing at real phrase breaks (§18).
  // Breaths are source-time; TimeMap has no span mapper, so both ends go
  // through toOutputClamped — a pause that was cut collapses to one instant,
  // which is still a boundary (a jump cut is a phrase break too).
  // One move per cut-free clip: ramp in, then hold. The clip starts ARE the
  // cuts — every point the source jumps — so a take that removed nothing is
  // one clip and gets exactly one slow push.
  const zoom = buildZoomPlan(map.outputDuration, {
    clipStarts: map.spans.map((s) => s.outIn),
  });
  console.log(
    `▸ zoom: ${zoom.clips} clip(s), ${zoom.rampSec}s push then hold ` +
      `(${zoom.segments.length} segments)`,
  );

  // ---- Per-scene framing (plan step D) ------------------------------------
  // A slot wider than the source canvas is cover-cropped VERTICALLY, so it
  // shows only a fraction of the canvas height and the face grows by the
  // inverse. `video-top` is a wide band against a portrait canvas, which is
  // why a close-up moment placed there loses its crown. Not fixable by
  // cropping — the pixels a wide band wants do not exist in a portrait
  // close-up — so it is REPORTED here, and the producer is what has to stop
  // choosing that layout for those moments (steps A and B).
  if (framingPlan) {
    const toSource = (outSec: number): number => {
      for (const sp of map.spans) {
        if (outSec >= sp.outIn && outSec < sp.outOut) return sp.srcIn + (outSec - sp.outIn);
      }
      return map.spans[map.spans.length - 1]?.srcOut ?? outSec;
    };
    // Only layouts where the video IS the subject. A `pip-bubble` is a small
    // circular inset and a `graphic-only` slot is not even drawn (opacity 0):
    // a tight head-shot is what a bubble is FOR, so judging it against the
    // same head-fits rule would report a defect for working as designed.
    const issues = assessCueFraming(
      graphicCues.flatMap((c) => {
        const v = layoutSlots(c.layout).video;
        if (v.opacity <= 0 || v.rect.w * v.rect.h < PRIMARY_VIDEO_SLOT_AREA) return [];
        return [{
          id: c.id,
          layout: c.layout,
          startSec: toSource(c.startSec),
          endSec: toSource(c.endSec),
          slot: { width: v.rect.w * frame.width, height: v.rect.h * frame.height },
        }];
      }),
      framingPlan.segments,
      framingPlan.faceFracOfCanvas,
      framingPlan.canvas,
      ZOOM_MAX_SCALE,
    );
    const tight = issues.filter((f) => f.headFracOfSlot > 1);
    for (const f of tight) {
      console.log(
        `  ⚠ ${f.cueId} (${f.layout}): head is ${(f.headFracOfSlot * 100).toFixed(0)}% of its ` +
          `video slot — the crop will trim it. This layout is too wide for how close ` +
          `the speaker is here.`,
      );
    }
    if (issues.length > 0 && tight.length === 0) {
      const worst = issues.reduce((a, b) => (b.headFracOfSlot > a.headFracOfSlot ? b : a));
      console.log(
        `▸ framing: every scene fits its slot (tightest ${worst.cueId} at ` +
          `${(worst.headFracOfSlot * 100).toFixed(0)}% of its band)`,
      );
    }
  }

  let renderVideo = analysisInput;
  // A letterboxed source MUST go through the re-encode even under
  // --no-mezzanine: the bars are pixels in the file, and cropping them here is
  // what lets every layout and zoom downstream treat the picture as the frame.
  // The cropped file gets its own name so a pre-crop cache is never reused.
  // A NORMALIZED source skips this outright: the bake already carries the
  // mezzanine's encode settings, and re-encoding it would be a second
  // generation of loss for nothing.
  // `mezzanineWillBuild` (computed once, above, with `contentRect`) — not a
  // second copy of this condition — so this can't drift from what
  // `planRenderPublicDir` already decided the accepted-image check against
  // (Finding 3, final-review fix wave).
  if (mezzanineWillBuild) {
    const mezz = join(work, contentRect.full ? "mezzanine.mp4" : "mezzanine-content.mp4");
    if (!existsSync(mezz)) {
      console.log(
        contentRect.full
          ? "▸ building mezzanine (dense keyframes)…"
          : "▸ building mezzanine (dense keyframes, letterbox bars trimmed)…",
      );
      await makeMezzanine(tools, input, mezz, { cropVf: cropVf || undefined });
    }
    renderVideo = mezz;
  }

  // Comment-CTA keyword (FINDINGS §16), scoped to the ask (FINDINGS §22).
  // Read off the timed CUE, not the untimed scene: the cue carries the same
  // resolved props AND the window, so the keyword can never come from a scene
  // that assembleScenes dropped, and the caption track knows exactly when the
  // ask is on screen. Quoting marks the word you type in the comments — every
  // other time the speaker merely says it, it must render plainly.
  const ctaCue = [...graphicCues]
    .reverse()
    .find((c) => typeof c.props?.keyword === "string" && (c.props.keyword as string).length > 0);
  const ctaKeyword = ctaCue ? (ctaCue.props!.keyword as string) : undefined;
  const ctaWindow = ctaCue
    ? { startSec: ctaCue.startSec, endSec: ctaCue.endSec }
    : undefined;
  if (ctaKeyword) {
    console.log(
      `▸ CTA keyword "${ctaKeyword}" styled only at ` +
        `${ctaWindow!.startSec.toFixed(1)}–${ctaWindow!.endSec.toFixed(1)}s`,
    );
  }

  // Resolved HERE, next to the props it feeds, and announced when on — the
  // one ▸ line is how a config-sourced credit stays visible per run instead
  // of surprising the author on upload.
  const watermark = resolveWatermark(opts.watermark, cfg.watermark);
  if (watermark) {
    console.log(
      `▸ watermark: "made with ossclip" in the top-left safe area` +
        `${opts.watermark === undefined ? " (from config; --no-watermark overrides)" : ""}`,
    );
  }

  const props = {
    videoFileName: basename(renderVideo),
    spans: [...map.spans],
    captionLines,
    sceneCues,
    theme,
    // The PRISTINE, pre-override cues/theme — everything above this line
    // already has the CURRENT `overrides.json` baked in (so `sceneCues`/
    // `theme` are exactly what got rendered). The editor needs an unmerged
    // base to re-apply overrides onto instead: merging the live doc onto an
    // already-merged base is add-only, so a reset/un-pin/undo in a second
    // editing session would have nothing to fall back to and render as if
    // it never happened, even though `overrides.json` on disk is correct.
    baseSceneCues: routed.cues,
    baseTheme: defaultTheme,
    baseCaptionLines,
    settings: production.render,
    outputDurationSec: map.outputDuration,
    // The aspect travels with the measurement because the crop math needs it:
    // `object-fit: cover` spills vertically for a portrait source and
    // HORIZONTALLY for a landscape one, and the stage cannot tell which
    // without being told what shape the source is.
    face: faceBox
      ? {
          centerYFrac: faceBox.centerYFrac,
          centerXFrac: faceBox.centerXFrac,
          sizeFrac: faceBox.sizeFrac,
          // The CONTENT's shape, not the container's — with bars trimmed the
          // rendered video IS the content rect (PLAN Task 7).
          sourceAspect: content.height > 0 ? content.width / content.height : undefined,
        }
      : null,
    zoomPlan: zoom.segments,
    ctaKeyword,
    ctaWindow,
    sourceTextRegions: textRegions,
    // Sent ONLY on the fit fallback (option (b)): a normalized mixed source is
    // already one uniform file, and a uniform source had its bars cropped into
    // the mezzanine — cropping either again at render time would eat the
    // picture twice.
    ...(fitFallback
      ? {
          contentTimeline,
          sourceSize: { width: sourceProbe.width, height: sourceProbe.height },
          contentCropMode: "fit" as const,
        }
      : {}),
    // `--source-fit contain`: show the whole frame instead of cropping it.
    // The size sent is the PICTURE's, not the container's — with bars trimmed
    // into the mezzanine the rendered video IS the content rect, and fitting
    // against the container's shape would inset a frame that no longer exists.
    // Listed after the fit fallback so it wins on a source that is both mixed
    // and asked to be shown whole.
    ...(opts.sourceFit === "contain"
      ? { sourceFit: "contain" as const, sourceSize: content }
      : {}),
    // Written only when ON, matching the field's absent-means-off contract:
    // an off run's render-props.json stays byte-identical to a pre-watermark
    // one, so nothing downstream can tell the feature ever shipped.
    ...(watermark ? { watermark: true } : {}),
  };
  await writeFile(join(work, "render-props.json"), JSON.stringify(props, null, 2));

  // The one sanctioned overrides.json write (PLAN 2026-08-04 Task 4; see
  // `applyUserCuts`'s doc comment for why it's allowed at all) — computed
  // way back when `cutResult` was built, but the actual write waits until
  // HERE, immediately after `render-props.json`'s own write, deliberately
  // adjacent (review fix wave finding 2). A crash or Ctrl-C anywhere in
  // between (assembly, LLM captions, ffmpeg, face measurement — several
  // hundred lines of I/O that can throw) used to be able to land between the
  // OLD ordering's early overrides.json write and this one: overrides.json
  // would already describe the NEW (post-cut) frame while render-props.json
  // on disk still described the OLD one, so the NEXT run's `priorMap` —
  // reconstructed from that stale render-props.json — would be off by
  // exactly the cut's duration and silently double-shift every split and
  // pin. Writing render-props.json FIRST means the worst a crash between the
  // two can do is leave overrides.json one run stale relative to it — the
  // next run's `priorMap` then sees drift and re-anchors again, the same
  // recovery path finding 3 already has to support — never a false "nothing
  // changed" that quietly corrupts positions.
  if (cutResult.changed) {
    // Keep a `.bak` of whatever was on disk first — the same safety net
    // `saveConfigPatch` keeps for a config file it's about to replace —
    // before overwriting the user's own data. Atomic write via tmp+rename,
    // matching the edit server's own `PUT /overrides` handler: the producer
    // or a live editor session may read this file at any moment, and a
    // half-written document would be worse than a stale one.
    try {
      const raw = await readFile(overridesPath, "utf8");
      await writeFile(`${overridesPath}.bak`, raw);
    } catch {
      // Nothing on disk to back up (first cut ever applied here) — fine.
    }
    const tmp = `${overridesPath}.tmp`;
    await writeFile(tmp, JSON.stringify(overrideDoc, null, 2));
    await rename(tmp, overridesPath);
    console.log("▸ overrides.json re-anchored to the new cut and saved (previous copy kept as .bak)");
  }

  if (!opts.render) {
    console.log(`▸ skipping render (--no-render). Props at ${join(work, "render-props.json")}`);
    console.log(editHint(work));
    return { workdir: work, rendered: false };
  }

  const outPath = resolve(opts.out ?? defaultOutPath(originalInput));
  const rawPath = join(work, "render-raw.mp4");
  console.log("▸ rendering…");
  let lastPct = -10;
  await renderProduction(props, {
    publicDir: dirname(renderVideo),
    outPath: rawPath,
    browserExecutable: cfg.browserExecutable,
    onProgress: (p) => {
      const pct = Math.floor(p * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}%\n`);
      }
    },
  });
  console.log("▸ normalizing loudness…");
  const normPath = join(work, "render-norm.mp4");
  await loudnorm(tools, rawPath, normPath);
  await rename(normPath, outPath);

  // ---- Cover image (FINDINGS §31) -----------------------------------------
  // A separate file, not a burned-in intro: both platforms accept a custom
  // cover, so nothing has to be pickable from the video — and spending the
  // opening seconds on a title card fights the hook-in-2s policy directly.
  if (opts.cover !== false) {
    // §35's cap applies here too: a cached beat sheet from before the fix, or
    // the hook fallback, must not slip a 13-word paragraph onto a thumbnail.
    const coverText = coverHeadline(beatSheet?.coverText ?? beatSheet?.hook ?? "");
    if (!coverText) {
      console.log("▸ no cover text (run --produce for one) — skipping cover");
    } else {
      const detector = await createFaceDetector();
      const pick = await pickCoverFrame(tools, analysisInput, analysisProbe.duration, {
        cacheDir: work,
        cropVf: analysisCropVf,
        detectFace: (pixels, w, h) => {
          const d = detector(pixels, w, h);
          // pico returns [row, col, size, score] in detection-frame pixels,
          // and that frame is cropped exactly like the cover — so these
          // fractions are the cover's own geometry, not the source's.
          return d ? { centerXFrac: d[1] / w, centerYFrac: d[0] / h, sizeFrac: d[2] / h } : null;
        },
      });
      if (!pick) {
        console.log("▸ no usable cover frame found — skipping cover");
      } else {
        const frameName = "cover-frame.png";
        await run(cfg.ffmpegPath, [
          "-v", "error",
          "-ss", pick.timeSec.toFixed(3),
          "-i", analysisInput,
          "-frames:v", "1",
          "-vf", `${analysisCropVf ? `${analysisCropVf},` : ""}scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase,crop=${frame.width}:${frame.height}`,
          "-y", join(work, frameName),
        ]);
        const coverPath = resolve(
          opts.coverPath ?? outPath.replace(/(\.[^.]+)?$/, ".cover.jpg"),
        );
        // §34: if the source's own title is up at this instant, the frame
        // already has a headline. Adding ours states the same claim twice in
        // one image — a cover with one title beats a cover with two.
        const sourceTitled = regionsDuring(
          sourceText.regions,
          pick.timeSec - 0.5,
          pick.timeSec + 0.5,
        ).length > 0;
        console.log(
          `▸ cover from ${pick.timeSec.toFixed(1)}s ` +
            `(${pick.hasFace ? "face" : "no face"}, sharpness ${pick.sharpness.toFixed(0)})…`,
        );
        if (sourceTitled) {
          console.log("  ▸ source already has a title in this frame — shipping it without a banner");
        } else if (pick.face) {
          const band = coverTextRect(pick.face, frame);
          console.log(
            `  ▸ banner in the ${band.y + band.h / 2 < pick.face.centerYFrac ? "band above" : "band below"} ` +
              `the face (${(band.y * 100).toFixed(0)}-${((band.y + band.h) * 100).toFixed(0)}%)`,
          );
        }
        await renderCover(
          {
            frameFileName: frameName,
            text: sourceTitled ? "" : coverText,
            theme,
            face: pick.face,
            // The cover is the OUTPUT's thumbnail — a landscape render gets a
            // landscape cover (R16 §76). The still was already extracted at
            // this size; only the composition disagreed.
            frame: { width: frame.width, height: frame.height },
          },
          { publicDir: work, outPath: coverPath, browserExecutable: cfg.browserExecutable },
        );
        console.log(`✓ cover → ${coverPath}`);
      }
    }
  }
  // Record THIS invocation so the editor's Render button can replay it (R11
  // Task 4). Nothing else can reconstruct it — production.json has the
  // source path, cleanup and intent, but not --produce, --out or the LLM
  // flags — and guessing would silently render a different video than the
  // one on screen. execArgv carries the module loader (tsx in dev), so the
  // replay works from source and from a compiled build alike.
  // The provider may have been AUTO-DETECTED from this shell's environment
  // (a GEMINI_/ANTHROPIC_ key exported here). The editor's Render replays
  // this argv from the EDIT SERVER's environment, which may not have that
  // key — and the auto-detection would then silently pick a DIFFERENT
  // provider (R16 §75). Pin the RESOLVED choice into the recorded args —
  // never the key itself; secrets stay out of the workdir — so a replay
  // uses the same configuration or fails loudly asking for it.
  // §93g: pin the RESOLVED window, exactly as §75 pinned the provider. The
  // editor's Render replays this argv; if replay re-asked the model and got a
  // slightly different window, every saved override — anchored to scene ids
  // and word indices — would land on the wrong words. The word range, not
  // just `--clip 60`, is what makes replay deterministic with zero LLM calls.
  //
  // §129: NOT process.argv. A wizard or bare-path run re-enters commander
  // with a BUILT argv while process.argv still holds the original invocation
  // (`ossclip <path>`, no `produce` literal, none of the wizard's answers) —
  // recording process.argv shipped a command that replays as
  // `ossclip <path> --llm …` and dies on "unknown option '--llm'".
  // recordedProduceArgs prefers the argv the re-entry stashed and falls back
  // to process.argv for a directly typed `ossclip produce …`, which stays
  // byte-identical to what was always recorded.
  // Watermark pin, same §75 shape: a config-sourced ON (flag untyped) exists
  // only in THIS machine's ~/.ossclip/config.json — a replay elsewhere would
  // silently drop the credit. Pinned as the RESOLVED value; a typed flag is
  // already in the argv and the includes-guard leaves it alone. Off needs no
  // pin: off is the universal default, so an argv without the flag replays
  // identically everywhere.
  const recordedArgs = recordedProduceArgs({
    llm: provider ? providerName : undefined,
    clipWindow: clipWindow ? `${clipWindow.startWord}:${clipWindow.endWord}` : undefined,
    watermark: watermark || undefined,
  });
  await writeFile(
    join(work, "command.json"),
    JSON.stringify(
      {
        execPath: process.execPath,
        execArgv: process.execArgv,
        script: process.argv[1],
        args: recordedArgs,
        cwd: process.cwd(),
        out: outPath,
      },
      null,
      2,
    ),
  );
  // Every produce run is a project the picker should offer (R17 §83) —
  // best-effort, so a read-only home dir never fails the render.
  await recordRecentProject(work);
  console.log(`✓ done → ${outPath}`);
  console.log(editHint(work));
  return { workdir: work, out: outPath, rendered: true };
}
