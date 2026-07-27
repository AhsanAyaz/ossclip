import { run } from "./exec";
import type { Probe } from "./schema";

export interface IngestTools {
  ffmpegPath: string;
  ffprobePath: string;
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
  return {
    duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: den ? (num ?? 30) / den : 30,
    hasAudio: Boolean(audio),
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
