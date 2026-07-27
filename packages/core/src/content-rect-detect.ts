import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";
import {
  contentRectTimeline,
  parseCropdetect,
  type ContentRect,
  type ContentRectSegment,
} from "./content-rect";

/**
 * The ffmpeg + cache half of letterbox detection. Split from `content-rect.ts`
 * so the pure geometry (timeline, lookup, crop filter) can be imported by the
 * Remotion bundle, which must never pull in node built-ins — the render-time
 * crop of a mixed-framing source needs exactly that geometry (PLAN Task C).
 */

export interface DetectContentRectOptions {
  /** Samples per second. Must be dense enough to see the SHORTEST segment. */
  rate?: number;
  /** Hard ceiling on samples so a feature-length source stays cheap. */
  maxSamples?: number;
  cacheDir?: string;
}

/**
 * v2 stores a TIMELINE rather than one rect (PLAN Task C). A v1 file is not
 * upgradable — it recorded the union's verdict, not the per-sample evidence —
 * so a stale cache is re-measured rather than misread.
 */
const CACHE_VERSION = 2;

/**
 * Sampling rate. Task 7 took 12 samples spread over the whole source, which is
 * one every ~5s on a 64s clip and cannot see a 3.5s framing change. cropdetect
 * decodes every frame regardless of the `fps` filter, so a denser rate costs
 * almost nothing beyond parsing.
 */
const DEFAULT_RATE = 2;
const DEFAULT_MAX_SAMPLES = 900;

export interface ContentRectDetection {
  /** Framing over source time. Always non-empty; one entry when uniform. */
  timeline: ContentRectSegment[];
  /**
   * The single rect when — and only when — the source has uniform framing.
   * `null` for a mixed source, so a caller that needs one constant has to
   * decide what to do rather than silently getting the first segment's.
   */
  uniform: ContentRect | null;
}

/**
 * Measure the source's framing, cached in the workdir like `face.json`.
 * One decode pass; cropdetect logs at info level, so this runs without
 * `-v error` and reads the filter's stderr lines.
 */
export async function detectContentRect(
  tools: { ffmpegPath: string },
  videoPath: string,
  probe: { width: number; height: number; duration: number },
  opts: DetectContentRectOptions = {},
): Promise<ContentRectDetection> {
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "content-rect.json") : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      version?: number;
      timeline?: ContentRectSegment[];
    };
    if (cached.version === CACHE_VERSION && cached.timeline?.length) {
      return withUniform(cached.timeline);
    }
  }

  const duration = Math.max(1, probe.duration);
  const rate = Math.min(opts.rate ?? DEFAULT_RATE, (opts.maxSamples ?? DEFAULT_MAX_SAMPLES) / duration);
  const { stderr } = await run(
    tools.ffmpegPath,
    [
      "-i", videoPath,
      "-vf", `fps=${Math.max(0.05, rate).toFixed(4)},cropdetect=limit=24:round=2:reset=1`,
      "-f", "null", "-",
    ],
    { allowNonZero: true },
  );
  const timeline = contentRectTimeline(
    parseCropdetect(stderr),
    probe.width,
    probe.height,
    probe.duration,
  );
  if (cachePath) {
    await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, timeline }, null, 2));
  }
  return withUniform(timeline);
}

function withUniform(timeline: ContentRectSegment[]): ContentRectDetection {
  return { timeline, uniform: timeline.length === 1 ? timeline[0]!.rect : null };
}

/** Total source seconds the framing is NOT the full frame — for reporting. */
export function letterboxedSeconds(timeline: readonly ContentRectSegment[]): number {
  return timeline.reduce((s, seg) => (seg.rect.full ? s : s + (seg.endSec - seg.startSec)), 0);
}
