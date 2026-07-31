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
 * Re-encode with dense keyframes so EDL playback (<OffthreadVideo> with many
 * small trims) seeks fast. Optional — most sources play fine untouched —
 * EXCEPT when the source is letterboxed: then this pass also trims the baked
 * bars (`crop`), so everything downstream sees the picture, not picture+bars
 * (PLAN Task 7), and the pass stops being optional.
 */
export async function makeMezzanine(
  tools: IngestTools,
  src: string,
  out: string,
  opts: { cropVf?: string } = {},
): Promise<void> {
  await run(tools.ffmpegPath, [
    "-y", "-i", src,
    ...(opts.cropVf ? ["-vf", opts.cropVf] : []),
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
