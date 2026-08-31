import { run } from "./exec";
import type { Probe } from "./schema";

export interface IngestTools {
  ffmpegPath: string;
  ffprobePath: string;
}

/**
 * The stream's rotation, normalized to 0/90/180/270 (R27 §119).
 *
 * Two spellings, because containers disagree: a Display Matrix side-datum
 * (modern ffprobe, and the only one a concatenated MP4 keeps) or the legacy
 * `rotate` tag. ffprobe reports the matrix angle signed — -90 and 270 are the
 * same quarter turn — so everything is folded into [0, 360).
 */
export function normalizeRotation(raw: number | string | undefined): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (n === undefined || !Number.isFinite(n)) return 0;
  const deg = ((Math.round(n) % 360) + 360) % 360;
  // Anything that is not a quarter turn cannot swap an axis; treat as upright.
  return deg % 90 === 0 ? deg : 0;
}

/** A quarter turn exchanges the axes, so the DISPLAYED frame is w/h swapped. */
export function rotationSwapsAxes(rotation: number): boolean {
  return rotation === 90 || rotation === 270;
}

export async function probe(tools: IngestTools, path: string): Promise<Probe> {
  const { stdout } = await run(tools.ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    path,
  ]);
  const info = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      side_data_list?: Array<{ rotation?: number }>;
      tags?: { rotate?: string };
    }>;
    format?: { duration?: string };
  };
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new Error(`no video stream in ${path}`);
  const rate = video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate;
  const [num, den] = (rate ?? "30/1").split("/").map(Number);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`could not determine duration of ${path}`);
  // `side_data_list` carries several kinds of datum (ambient viewing
  // environment, content light level); only one of them has a rotation.
  const matrix = video.side_data_list?.find((s) => typeof s.rotation === "number");
  const rotation = normalizeRotation(matrix?.rotation ?? video.tags?.rotate);
  const rawW = video.width ?? 0;
  const rawH = video.height ?? 0;
  // Report what is DISPLAYED. ffmpeg auto-rotates in the filter chain, so every
  // measurement taken through it (cropdetect, face, the mezzanine) is already
  // in this space; returning the raw stream size made the pipeline reconcile
  // two orientations into a bogus square and "detect" a letterbox on a
  // full-frame portrait take (R27 §119).
  const swap = rotationSwapsAxes(rotation);
  return {
    duration,
    width: swap ? rawH : rawW,
    height: swap ? rawW : rawH,
    fps: den ? (num ?? 30) / den : 30,
    hasAudio: Boolean(audio),
    ...(rotation !== 0 ? { rotation } : {}),
  };
}

/** Extract 16 kHz mono PCM audio for ASR + silence analysis. */
export async function extractAudio(tools: IngestTools, src: string, outWav: string): Promise<void> {
  await run(tools.ffmpegPath, [
    "-y", "-i", src,
    "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    outWav,
  ]);
}

/**
 * Extract ONE span of an existing wav, same 16 kHz mono PCM shape
 * (2026-08-26, the caption re-alignment pass).
 *
 * Fed the workdir's `audio.wav`, which `extractAudio` above already wrote at
 * 16k/mono/pcm_s16le — so this is a sample-exact cut, not a re-encode, and it
 * costs milliseconds even on a long source. Re-slicing from the ORIGINAL video
 * would decode video frames for nothing and hand whisper an audio stream
 * conditioned differently from the one the first pass decoded, which is
 * exactly the variable a re-transcription is trying to hold still.
 *
 * `-ss` goes BEFORE `-i`: as an input option ffmpeg seeks the demuxer and
 * starts decoding at the span, instead of decoding the whole file and
 * discarding everything ahead of it. On PCM that seek is exact, so the clip's
 * stamps are `spanStart`-relative with no drift to compensate for
 * (`alignRestamp` adds the offset back).
 */
export async function extractAudioSpan(
  tools: IngestTools,
  wav: string,
  outWav: string,
  fromSec: number,
  durSec: number,
): Promise<void> {
  await run(tools.ffmpegPath, [
    "-y",
    "-ss", fromSec.toFixed(3),
    "-i", wav,
    "-t", durSec.toFixed(3),
    "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    outWav,
  ]);
}

/**
 * Headroom over the exact displayed size so a zoomed span never renders from
 * below-native pixels (2026-08-17 render-speed pass). The two motion drivers
 * stack to at most ZOOM_MAX_SCALE (1.05) × FACE_PUNCH_SCALE (1.015) ≈ 1.066
 * on any frame a new run emits, so 1.1 covers the worst momentary
 * magnification with margin. (The legacy punch-less contract renders 1.07 —
 * still under 1.1 — and pre-existing render-props keep their own full-res
 * mezzanine anyway; see `mezzanineFileName`.)
 */
export const MEZZANINE_SCALE_MARGIN = 1.1;

export interface MezzanineScale {
  width: number;
  height: number;
  fps: number;
}

/** Nearest even dimension — yuv420 chroma subsampling needs both axes even. */
export function evenDim(v: number): number {
  return Math.max(2, 2 * Math.round(v / 2));
}

/**
 * The size and rate the mezzanine should be encoded at, or null when the
 * source is already no larger than the render needs (2026-08-17 render-speed
 * pass). Remotion's OffthreadVideo extracts EVERY sampled frame via ffmpeg
 * on the CPU, so decode cost scales with pixels × fps — a 3456x2234@60
 * source feeding a 1920x1080@30 render pays ~4.6× the pixels and 2× the
 * frames the render ever shows.
 *
 * The target is the size at which the source is DISPLAYED: for `cover` the
 * larger frame/source axis ratio (overflow is cropped, not shown), for
 * `contain` the smaller (the whole frame fits inside). That target gets
 * MEZZANINE_SCALE_MARGIN of headroom for the motion drivers, is rounded
 * even for yuv420, and is capped at native — scaling UP would soften every
 * frame for zero decode saved.
 *
 * fps: min(source, output) — frames the render never samples are pure decode
 * waste. Safe because EDL `srcIn`/`srcOut` are SECONDS, not frame indexes:
 * a 60→30 resample moves a cut boundary by at most 1/60s, the same
 * magnitude whisper's word stamps already jitter by.
 */
export function mezzanineScale(
  source: { width: number; height: number; fps: number },
  frame: { width: number; height: number; fps: number },
  sourceFit: "cover" | "contain",
): MezzanineScale | null {
  if (source.width <= 0 || source.height <= 0) return null;
  const displayed =
    sourceFit === "contain"
      ? Math.min(frame.width / source.width, frame.height / source.height)
      : Math.max(frame.width / source.width, frame.height / source.height);
  const k = Math.min(1, displayed * MEZZANINE_SCALE_MARGIN);
  // At the cap, keep the source's exact dims — even-rounding a size that is
  // not being resampled would manufacture a 1px no-op rescale.
  const width = k < 1 ? evenDim(source.width * k) : source.width;
  const height = k < 1 ? evenDim(source.height * k) : source.height;
  const fps = Math.min(source.fps, frame.fps);
  if (width === source.width && height === source.height && fps >= source.fps) return null;
  return { width, height, fps };
}

/**
 * The mezzanine's filename, which IS its cache key: mezzanines are
 * existence-keyed in the workdir, so the scale decision must live in the
 * name — a pre-pass full-res `mezzanine.mp4` must never satisfy a run that
 * will emit mezzanine-sized framing windows (they would land on a file with
 * ~1.6× their pixel space and crop the wrong picture). Unscaled runs keep
 * the legacy names so existing workdir caches stay valid; a scaled run
 * rebuilds once under its own name and old workdirs' render-props keep
 * referencing (and rendering from) the file they were emitted against.
 *
 * The LUT hash is in the name for the same reason: grading is baked into the
 * mezzanine at build time, so a warm workdir keyed only on crop/scale would
 * satisfy a graded run with UNGRADED frames (or a re-graded run with the old
 * look). No LUT keeps today's names byte-for-byte, so existing warm workdirs
 * stay valid.
 */
export function mezzanineFileName(cropped: boolean, scale: MezzanineScale | null, lutHash?: string): string {
  const base = cropped ? "mezzanine-content" : "mezzanine";
  const scaleSeg = scale ? `-${scale.width}x${scale.height}@${Math.round(scale.fps)}` : "";
  const lutSeg = lutHash ? `-lut${lutHash}` : "";
  return `${base}${scaleSeg}${lutSeg}.mp4`;
}

/** A 3D LUT to bake into the mezzanine; `hash` keys the cache (see `mezzanineFileName`). */
export interface MezzanineLut {
  path: string;
  hash: string;
}

/**
 * Escape a filesystem path for use as an ffmpeg filter option value.
 *
 * A `-vf` string is parsed twice: once as a filtergraph (where `\` `'` `[`
 * `]` `,` `;` are special) and once as the filter's option value (where `:`
 * `\` `'` are special — `:` is the option separator, so an unescaped drive
 * letter like `C:` truncates the path there). Each level strips one layer of
 * backslashes, so the option-level escapes must themselves be escaped for
 * the graph level: `:` → `\\:`, `'` → `\\\'`, `\` → `\\\\`. Spaces need
 * nothing — the argv goes straight to ffmpeg, no shell in between.
 */
export function escapeFilterPath(p: string): string {
  // Level 1: filter option value — `:` `\` `'` are special.
  const option = p.replace(/[\\':]/g, (c) => `\\${c}`);
  // Level 2: filtergraph — escape again so level-1 backslashes survive.
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/**
 * The mezzanine's `-vf` chain, pure so the ordering contract is testable:
 * LUT strictly AFTER crop/scale — grading the letterbox bars would be
 * wasted math, and grading pre-scale pixels the render never sees changes
 * nothing but costs full-res per-pixel lookups.
 */
export function mezzanineVf(opts: { cropVf?: string; scale?: MezzanineScale; lut?: MezzanineLut }): string {
  return [
    ...(opts.cropVf ? [opts.cropVf] : []),
    ...(opts.scale ? [`scale=${opts.scale.width}:${opts.scale.height}`] : []),
    ...(opts.lut ? [`lut3d=file=${escapeFilterPath(opts.lut.path)}:interp=tetrahedral`] : []),
  ].join(",");
}

/**
 * Re-encode with dense keyframes so EDL playback (<OffthreadVideo> with many
 * small trims) seeks fast. Optional — most sources play fine untouched —
 * EXCEPT when the source is letterboxed: then this pass also trims the baked
 * bars (`crop`), so everything downstream sees the picture, not picture+bars
 * (PLAN Task 7), and the pass stops being optional.
 *
 * `scale` (from `mezzanineScale`) downsizes to display size in the SAME
 * pass, crop first — the scale dims are computed on the post-crop picture.
 * `lut` bakes a 3D grade in last, on exactly the pixels the render will see.
 */
export async function makeMezzanine(
  tools: IngestTools,
  src: string,
  out: string,
  opts: { cropVf?: string; scale?: MezzanineScale; lut?: MezzanineLut } = {},
): Promise<void> {
  const vf = mezzanineVf(opts);
  await run(tools.ffmpegPath, [
    "-y", "-i", src,
    ...(vf ? ["-vf", vf] : []),
    ...(opts.scale ? ["-r", String(opts.scale.fps)] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    out,
  ]);
}

/** EBU R128 loudness normalization post-pass; video stream is copied untouched. */
export async function loudnorm(tools: IngestTools, src: string, out: string): Promise<void> {
  await run(tools.ffmpegPath, [
    "-y", "-i", src,
    "-c:v", "copy",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "aac", "-b:a", "192k",
    out,
  ]);
}
