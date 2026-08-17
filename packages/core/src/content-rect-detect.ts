import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";
import {
  contentRectTimeline,
  materializeTimeline,
  parseCropdetect,
  pickTransition,
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
 * v2 stored the coarse timeline (PLAN Task C); v3 stores boundaries REFINED
 * to the frame (NORMALIZE plan) — a v2 cache carries ±0.25s boundaries that
 * would be baked into the normalized source, so it is re-measured.
 */
const CACHE_VERSION = 3;

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
      return withUniform(cached.timeline, probe);
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
  await refineBoundaries(tools, videoPath, timeline, probe);
  if (cachePath) {
    await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, timeline }, null, 2));
  }
  return withUniform(timeline, probe);
}

/** How far around a coarse boundary the refinement pass looks. Must exceed the
 * coarse sampling half-step (0.25s at 2 Hz) with room for run-absorption
 * slop, and stay small enough that nine boundaries cost under a second of
 * decode each. */
const REFINE_HALF_WINDOW_SEC = 0.8;

/**
 * Sharpen each boundary of a mixed timeline to the frame, in place.
 *
 * The coarse pass samples at 2 Hz and places boundaries midway between
 * disagreeing samples — good enough to steer a render-time crop, not good
 * enough to BAKE: every frame on the wrong side of a baked boundary gets the
 * wrong window. This decodes ~1.6s around each boundary at native fps
 * (`-ss` before `-i`, so it is a seek, not a scan; cropdetect's `t:` restarts
 * at the seek point) and moves the boundary to the midpoint of the two frames
 * that actually disagree. A window that never straddles the change keeps the
 * coarse estimate — wrong by less than the window, and said so by the caller's
 * log rather than silently.
 */
async function refineBoundaries(
  tools: { ffmpegPath: string },
  videoPath: string,
  timeline: ContentRectSegment[],
  probe: { width: number; height: number; duration: number },
): Promise<void> {
  for (let i = 1; i < timeline.length; i++) {
    const coarse = timeline[i]!.startSec;
    const from = Math.max(0, coarse - REFINE_HALF_WINDOW_SEC);
    const { stderr } = await run(
      tools.ffmpegPath,
      [
        "-ss", from.toFixed(3),
        "-t", (REFINE_HALF_WINDOW_SEC * 2).toFixed(3),
        "-i", videoPath,
        "-vf", "cropdetect=limit=24:round=2:reset=1",
        "-f", "null", "-",
      ],
      { allowNonZero: true },
    );
    const samples = parseCropdetect(stderr).map((s) => ({ ...s, tSec: from + s.tSec }));
    const exact = pickTransition(
      samples,
      timeline[i - 1]!.rect,
      timeline[i]!.rect,
      probe.width,
      probe.height,
    );
    if (exact !== null) {
      timeline[i - 1]!.endSec = exact;
      timeline[i]!.startSec = exact;
    }
  }
}

function withUniform(
  timeline: ContentRectSegment[],
  probe: { width: number; height: number; duration: number },
): ContentRectDetection {
  // Materialize BEFORE the single-segment uniform test, and on the cache-hit
  // path too: the cache stores the RAW measurement, so re-judging it here is
  // what lets the 2026-08-16 incident's cached content-rect.json re-classify
  // as uniform on replay without a CACHE_VERSION bump (no re-measure).
  const materialized = materializeTimeline(timeline, probe.width, probe.height, probe.duration);
  return {
    timeline: materialized,
    uniform: materialized.length === 1 ? materialized[0]!.rect : null,
  };
}

/** Total source seconds the framing is NOT the full frame — for reporting. */
export function letterboxedSeconds(timeline: readonly ContentRectSegment[]): number {
  return timeline.reduce((s, seg) => (seg.rect.full ? s : s + (seg.endSec - seg.startSec)), 0);
}
