/**
 * Importing a transparent clip named by a script's `clip:` cue (explainer
 * spec 1.4): the source is transcoded once into a VP9-alpha WebM inside the
 * render's public dir, and the scene plays that file.
 *
 * Why transcode at all: the clips are ProRes 4444 `.mov` (the EGM shots were
 * rendered that way), and browsers do not decode ProRes. The editor preview
 * plays the scene through a `<video>` element, so the one file both the
 * preview and the render can play with its alpha intact is VP9 in WebM.
 *
 * Its own path, not the overlay library's: that one sniffs images and caps
 * them at 20 MB, and a 10-second ProRes 4444 clip is ~50 MB (spec 1.4).
 *
 * A source that is ALREADY VP8/VP9 in WebM is copied, not transcoded:
 * ffmpeg's built-in VP9 decoder ignores the alpha side data, so re-encoding a
 * VP9-alpha WebM silently produced an opaque file (found in Task 6's real
 * check). The copy is also the cheapest import there is.
 *
 * The argument builders, the output name and the probe parser are pure; the
 * filesystem and ffmpeg come in through `ImportClipDeps` so the import is
 * tested without either.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { run } from "@ossclip/core";

/** Largest source accepted (spec 1.4). A 4-minute video's longest shot is ~15 s; 500 MB of ProRes 4444 is well past that. */
export const MAX_CLIP_BYTES = 500_000_000;

/** A clip that cannot be imported; `message` names the path and is shown as-is. */
export class ClipImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipImportError";
  }
}

/**
 * The absolute path a `clip:` cue names, or a `ClipImportError` naming it.
 *
 * Relative to the script's folder and confined to it (spec 1.1): the script
 * is a file someone may hand you, and the import reads whatever it names
 * into the project — a `../../` path or an absolute one would let a script
 * pull any file on the machine into a render. Absolute paths are refused even
 * when they point inside the folder, because the format says relative and a
 * script that only works on its author's machine is the failure that rule
 * prevents. Symlinks are not followed here (this is pure); the folder is the
 * author's own.
 */
export function resolveClipPath(scriptPath: string, clipPath: string): string {
  const dir = dirname(resolve(scriptPath));
  if (isAbsolute(clipPath)) {
    throw new ClipImportError(`clip path must be relative to the script's folder: ${clipPath}`);
  }
  const abs = resolve(dir, clipPath);
  const rel = relative(dir, abs);
  // `rel === ""` is the folder itself (an empty or "." path), which is no clip.
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ClipImportError(`clip path leaves the script's folder: ${clipPath}`);
  }
  return abs;
}

/**
 * ffmpeg arguments for the VP9-alpha transcode.
 *
 * `yuva420p` is the only alpha-bearing pixel format libvpx-vp9 encodes.
 * `-auto-alt-ref 0` is required with it: libvpx's alt-ref frames do not carry
 * the alpha plane, and with them on the encode either fails or silently comes
 * out opaque. `-b:v 0 -crf 30` is constant quality (the clips are short and
 * graphic, so a bitrate target would only starve the busy ones), and
 * `-row-mt 1` lets a VP9 encode use more than one core. Opus is the audio
 * codec WebM carries; a source with no audio simply has none to encode.
 *
 * `-deadline good -cpu-used 4` trades encoder search effort for speed: a
 * script of 24 clips pays the encode 24 times. Measured on the 4.6 s EGM
 * ProRes 4444 shot (§158): 9.7-11.0 s down to 7.7-9.2 s, colour SSIM
 * 0.9985 against 0.9986 and alpha SSIM 0.9985 against 0.9984, with the
 * alpha plane (decoded through libvpx) still ranging 0-255 per frame.
 */
export function clipTranscodeArgs(src: string, out: string): string[] {
  return [
    "-y",
    "-i", src,
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-b:v", "0",
    "-crf", "30",
    "-deadline", "good",
    "-cpu-used", "4",
    "-row-mt", "1",
    "-auto-alt-ref", "0",
    "-c:a", "libopus",
    "-b:a", "128k",
    out,
  ];
}

/**
 * Where the transcode lands, relative to the public dir (`staticFile()`'s
 * form, so always `/`-separated). The name hashes the source's path, size and
 * mtime: an unchanged clip is never encoded twice, and an edited one —
 * same path, new bytes — gets a new file instead of replaying the stale one.
 */
export function clipOutputName(srcAbs: string, sizeBytes: number, mtimeMs: number): string {
  const hash = createHash("sha1").update(`${srcAbs}\0${sizeBytes}\0${mtimeMs}`).digest("hex").slice(0, 12);
  return `clips/${hash}.webm`;
}

export interface ClipProbe {
  durationSec: number;
  hasAudio: boolean;
}

/** ffprobe's JSON, only the fields read here. Parsed, never cast: a probe of a broken file returns anything. */
const ProbeOutputSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string().optional() })).default([]),
  format: z.object({ duration: z.string().optional() }).default({}),
});

/**
 * Read `ffprobe -show_entries format=duration:stream=codec_type -of json`.
 * The duration is ffprobe's container duration, which ffmpeg writes into a
 * WebM it finalizes. No positive duration is an error rather than a guess: the
 * scene lasts exactly this long (`fixedDurationSec`), so a wrong number would
 * cut the clip off or hold a frozen frame.
 */
export function parseClipProbe(stdout: string, path: string): ClipProbe {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ClipImportError(`could not read the clip's length: ${path}`);
  }
  const parsed = ProbeOutputSchema.safeParse(json);
  const durationSec = parsed.success ? Number(parsed.data.format.duration) : NaN;
  if (!parsed.success || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ClipImportError(`could not read the clip's length: ${path}`);
  }
  return { durationSec, hasAudio: parsed.data.streams.some((s) => s.codec_type === "audio") };
}

/** ffprobe's JSON for the SOURCE, only the fields the copy decision reads. */
const SourceProbeSchema = z.object({
  streams: z
    .array(z.object({ codec_type: z.string().optional(), codec_name: z.string().optional() }))
    .default([]),
  format: z.object({ format_name: z.string().optional() }).default({}),
});

/** ffprobe arguments for the source: its container and its streams' codecs. */
export function clipSourceProbeArgs(src: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=format_name:stream=codec_type,codec_name",
    "-of", "json",
    src,
  ];
}

/**
 * Whether a source can be copied into `clips/` byte for byte instead of
 * transcoded: VP8 or VP9 video in a WebM container. Pure.
 *
 * Copy is not an optimisation here, it is the only way to keep the alpha: the
 * transcode decodes with ffmpeg's built-in VP9 decoder, which drops the alpha
 * side data, so re-encoding a VP9-alpha WebM came out opaque. ffprobe names
 * the demuxer `matroska,webm` for both .webm and .mkv, so a VP9 .mkv is
 * copied too; browsers play Matroska with VP9 the same way. Anything
 * unreadable is "not copyable" and goes through the transcode, whose own
 * failure then names the file.
 */
export function canCopyClip(sourceProbeStdout: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(sourceProbeStdout);
  } catch {
    return false;
  }
  const parsed = SourceProbeSchema.safeParse(json);
  if (!parsed.success) return false;
  const formats = (parsed.data.format.format_name ?? "").split(",");
  const video = parsed.data.streams.find((s) => s.codec_type === "video");
  return formats.includes("webm") && (video?.codec_name === "vp9" || video?.codec_name === "vp8");
}

/** What an import is about to do, announced before it does it (a transcode takes seconds). */
export type ClipImportStep = "transcode" | "copy" | "reuse";

/**
 * The progress line for one clip. Pure. One line per clip because a script
 * with 24 clips otherwise sits silent for minutes between transcription and
 * planning; `reusing` says why a re-run was instant.
 */
export function clipImportLine(index: number, total: number, name: string, step: ClipImportStep): string {
  const verb = step === "reuse" ? "reusing" : "importing";
  return `▸ ${verb} clip ${index + 1} of ${total}: ${name}`;
}

/**
 * The seams. All optional: production passes only the configured tool paths
 * (`cfg.ffmpegPath`/`cfg.ffprobePath` — the binaries `ossclip setup` and
 * `OSSCLIP_FFMPEG` point at, which need not be the ones on PATH), and tests
 * replace the filesystem.
 */
export interface ImportClipDeps {
  run?: typeof run;
  stat?: (p: string) => Promise<{ size: number; mtimeMs: number }>;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => Promise<unknown>;
  rename?: (from: string, to: string) => Promise<void>;
  copyFile?: (from: string, to: string) => Promise<void>;
  /** Called once per import, before the work, with what it is about to do. */
  onStep?: (step: ClipImportStep) => void;
  ffmpegPath?: string;
  ffprobePath?: string;
}

/**
 * Transcode `srcAbs` into `publicDir` (once) and return the project-relative
 * WebM and its length.
 *
 * A VP8/VP9 WebM source is copied rather than encoded (`canCopyClip`).
 * Either way the bytes go to a `.partial.webm` beside the final name and are
 * renamed into place only when the step finishes. The reuse rule makes this
 * necessary: the output name never changes for an unchanged source, so a
 * file truncated by an interrupted encode would otherwise be "reused" by
 * every later run.
 */
export async function importClip(
  srcAbs: string,
  publicDir: string,
  deps: ImportClipDeps = {},
): Promise<{ src: string; durationSec: number }> {
  const exec = deps.run ?? run;
  const exists = deps.exists ?? existsSync;
  const statFile = deps.stat ?? stat;
  const ffmpeg = deps.ffmpegPath ?? "ffmpeg";
  const ffprobe = deps.ffprobePath ?? "ffprobe";

  if (!exists(srcAbs)) throw new ClipImportError(`clip file not found: ${srcAbs}`);
  const { size, mtimeMs } = await statFile(srcAbs);
  if (size > MAX_CLIP_BYTES) {
    throw new ClipImportError(
      `clip is ${(size / 1e6).toFixed(0)} MB, over the ${MAX_CLIP_BYTES / 1e6} MB limit: ${srcAbs}`,
    );
  }

  const name = clipOutputName(srcAbs, size, mtimeMs);
  const outAbs = join(publicDir, ...name.split("/"));
  if (exists(outAbs)) {
    deps.onStep?.("reuse");
  } else {
    const partial = outAbs.replace(/\.webm$/, ".partial.webm");
    // A probe that fails (unreadable source) reads as "not copyable", and the
    // transcode below then fails with ffmpeg's own words about the file.
    const sourceProbe = await exec(ffprobe, clipSourceProbeArgs(srcAbs)).catch(() => ({ stdout: "" }));
    const copy = canCopyClip(sourceProbe.stdout);
    deps.onStep?.(copy ? "copy" : "transcode");
    await (deps.mkdir ?? ((p: string) => mkdir(p, { recursive: true })))(dirname(outAbs));
    try {
      if (copy) await (deps.copyFile ?? copyFile)(srcAbs, partial);
      else await exec(ffmpeg, clipTranscodeArgs(srcAbs, partial));
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n").slice(-3).join(" ") : String(err);
      throw new ClipImportError(`could not ${copy ? "copy" : "transcode"} the clip ${srcAbs}: ${detail}`);
    }
    await (deps.rename ?? rename)(partial, outAbs);
  }

  const probe = await exec(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    outAbs,
  ]);
  const { durationSec } = parseClipProbe(probe.stdout, outAbs);
  return { src: name, durationSec };
}
