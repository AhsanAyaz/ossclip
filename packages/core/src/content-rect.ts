import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";

/**
 * Letterbox detection (PLAN 2026-07-28 Task 7).
 *
 * A source file's frame is not always its picture. A screen-recorded or
 * re-exported clip can carry black bars baked into the pixels — one real case
 * probed as 1440×2560 portrait while the actual shot was a landscape strip
 * with bars above and below. Every geometric consumer then reasoned about the
 * wrong frame: `video-top` showed mostly bar, `blurred-behind` blurred black
 * into more black, the face detector searched an area two-thirds empty, and
 * `sourceAspect` described the container instead of the picture.
 *
 * The fix is one measurement, made early and consumed everywhere: the CONTENT
 * RECT — the largest area that is ever non-black across sampled frames. It is
 * a property of the source, cached beside `face.json`, and each downstream
 * ffmpeg pass prepends a `crop` to it so the rest of the pipeline never sees
 * the bars at all.
 *
 * Detection is ffmpeg's own `cropdetect` (parsed from stderr exactly the way
 * `detectSilences` reads `silencedetect`), not hand-rolled pixel scanning.
 * The union across samples is what keeps a dark shot honest: a bar has to be
 * black in EVERY sampled frame, so a night scene that ever shows anything at
 * its edges keeps its full frame.
 */

/** Pixel rect inside the source frame. */
export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the rect IS the frame — nothing to trim, no crop pass runs. */
  full: boolean;
}

/** Per-frame `crop=W:H:X:Y` lines from cropdetect's stderr. */
export function parseCropdetect(stderr: string): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    if (m) out.push({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) });
  }
  return out;
}

/**
 * A bar thinner than this fraction of its dimension is treated as not there.
 * Encoder padding and edge vignetting produce a few dark rows on perfectly
 * ordinary footage; trimming them would change every geometry downstream to
 * chase two invisible pixels.
 */
const SNAP_FRAC = 0.02;

/**
 * Below this share of the frame the measurement is refused. A clip dark
 * enough to "detect" a content rect this small is a clip cropdetect cannot be
 * trusted on — a fade-from-black or a genuinely dim shot — and cropping a
 * video to a sliver on bad evidence is far worse than leaving bars alone.
 */
const MIN_CONTENT_FRAC = 0.25;

/**
 * The stable rect from per-frame measurements: the UNION of everything any
 * sample considered content, snapped per side so hairline bars don't trigger
 * a crop, and refused outright when the result is implausibly small.
 */
export function stableContentRect(
  rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  width: number,
  height: number,
): ContentRect {
  const whole: ContentRect = { x: 0, y: 0, w: width, h: height, full: true };
  if (rects.length === 0 || width <= 0 || height <= 0) return whole;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }

  // Snap each side independently: a real top bar must survive even when the
  // left and right edges are content to the pixel.
  if (left / width < SNAP_FRAC) left = 0;
  if (top / height < SNAP_FRAC) top = 0;
  if ((width - right) / width < SNAP_FRAC) right = width;
  if ((height - bottom) / height < SNAP_FRAC) bottom = height;

  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return whole;
  if ((w * h) / (width * height) < MIN_CONTENT_FRAC) return whole;
  if (left === 0 && top === 0 && w === width && h === height) return whole;
  // Even offsets/sizes keep yuv420 encoders happy; expand outward so the
  // rounding never shaves a row of picture (a black hairline would).
  const x = left - (left % 2);
  const y = top - (top % 2);
  return {
    x,
    y,
    w: Math.min(width - x, w + (w % 2)),
    h: Math.min(height - y, h + (h % 2)),
    full: false,
  };
}

/** The ffmpeg `crop=` filter string for a rect (no-op rects return ""). */
export function cropFilter(rect: ContentRect | null | undefined): string {
  if (!rect || rect.full) return "";
  return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
}

export interface DetectContentRectOptions {
  samples?: number;
  cacheDir?: string;
}

const CACHE_VERSION = 1;

/**
 * Measure the source's content rect, cached in the workdir like `face.json`.
 * One decode pass at a low sample rate; cropdetect logs at info level, so this
 * runs without `-v error` and reads the filter's stderr lines.
 */
export async function detectContentRect(
  tools: { ffmpegPath: string },
  videoPath: string,
  probe: { width: number; height: number; duration: number },
  opts: DetectContentRectOptions = {},
): Promise<ContentRect> {
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "content-rect.json") : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as ContentRect & {
      version?: number;
    };
    if (cached.version === CACHE_VERSION) {
      return { x: cached.x, y: cached.y, w: cached.w, h: cached.h, full: cached.full };
    }
  }

  const samples = opts.samples ?? 12;
  const rate = Math.max(0.05, samples / Math.max(1, probe.duration));
  const { stderr } = await run(
    tools.ffmpegPath,
    [
      "-i", videoPath,
      "-vf", `fps=${rate.toFixed(4)},cropdetect=limit=24:round=2:reset=1`,
      "-f", "null", "-",
    ],
    { allowNonZero: true },
  );
  const rect = stableContentRect(parseCropdetect(stderr), probe.width, probe.height);
  if (cachePath) {
    await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, ...rect }, null, 2));
  }
  return rect;
}
