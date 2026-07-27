import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";

/**
 * Burned-in text detection (FINDINGS §26).
 *
 * ossclip assumes raw footage. Fed a finished reel it has no idea anything is
 * already on screen, so it crops through the source's own title and then says
 * much the same thing in different words directly beneath — two competing
 * titles, one of them clipped.
 *
 * The product rule is asymmetric, and deliberately so:
 *   - CAPTIONS ALWAYS GO IN. They are the accessibility layer; a caption
 *     landing near existing text is worse than nothing only if it is
 *     unreadable, so captions move but never disappear.
 *   - ossclip's own graphics must not overlap existing elements at all. If no
 *     free region can hold a scene, that scene is skipped.
 *
 * Detection is a gradient-density heuristic rather than OCR: burned-in
 * captions and titles are high-contrast glyph clusters with strong local edge
 * energy and a horizontal run structure, which separates them from faces and
 * flat backgrounds without a model or a native dependency. It is a
 * conservative signal — it answers "is something drawn here", not "what does
 * it say", which is all the layout needs.
 */

/** Occupancy rect in frame fractions, with the window it was seen in. */
export interface TextRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fraction of sampled frames this band was busy in. */
  confidence: number;
}

export interface SourceTextScan {
  regions: TextRegion[];
  framesSampled: number;
  /** True when the user asserted the source is edited, skipping detection. */
  assumed: boolean;
}

const DET_W = 240;
const DET_H = 426;
/** Rows of the analysis grid — bands are the unit, since text runs across. */
const BANDS = 24;
/** A cell counts as "busy" above this gradient magnitude. */
const EDGE_THRESHOLD = 42;
/** Fraction of a band's pixels that must be edges for it to read as text. */
const BAND_EDGE_RATIO = 0.055;
/** A band must be busy in this fraction of frames to count as burned in. */
const PERSISTENCE = 0.5;
/** Share of a band's pixels at the luminance extremes for it to read as text. */
const BAND_BIMODALITY = 0.5;

/**
 * Per-band horizontal edge density.
 *
 * Text is characterised by many short, high-contrast vertical strokes packed
 * into a band: measuring the horizontal gradient picks up glyph edges while
 * largely ignoring the soft luminance ramps of a face or a background.
 */
export function bandEdgeDensity(pixels: Uint8Array, w: number, h: number): number[] {
  const bandHeight = Math.max(1, Math.floor(h / BANDS));
  const density: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const y0 = b * bandHeight;
    const y1 = Math.min(h, y0 + bandHeight);
    let edges = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (Math.abs(pixels[i + 1]! - pixels[i - 1]!) >= EDGE_THRESHOLD) edges++;
        count++;
      }
    }
    density.push(count > 0 ? edges / count : 0);
  }
  return density;
}

/**
 * Per-band bimodality: the share of pixels sitting near black or near white.
 *
 * Edge density alone is not enough to call something text — any high-frequency
 * content trips it. A colour-bar test pattern scored two "text" bands on the
 * golden fixture, and real footage has plenty of equivalents: window blinds,
 * bookshelves, a striped shirt. Burned-in text is nearly always light glyphs
 * on a dark scrim or the reverse, so its luminance piles up at the extremes,
 * while textured scenery spreads across the midtones.
 *
 * Requiring BOTH signals biases toward missing text rather than inventing it —
 * the right way round, since a false positive silently skips a scene on clean
 * footage while a false negative merely restores the old behaviour.
 */
export function bandBimodality(pixels: Uint8Array, w: number, h: number): number[] {
  const bandHeight = Math.max(1, Math.floor(h / BANDS));
  const out: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const y0 = b * bandHeight;
    const y1 = Math.min(h, y0 + bandHeight);
    let extreme = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const v = pixels[y * w + x]!;
        if (v <= 48 || v >= 207) extreme++;
        count++;
      }
    }
    out.push(count > 0 ? extreme / count : 0);
  }
  return out;
}

/** Merge adjacent busy bands into regions, with their persistence. */
export function regionsFromBands(busyCounts: number[], frames: number): TextRegion[] {
  const regions: TextRegion[] = [];
  let start: number | null = null;
  let peak = 0;
  const flush = (end: number) => {
    if (start === null) return;
    regions.push({
      x: 0,
      y: start / BANDS,
      w: 1,
      h: (end - start) / BANDS,
      confidence: peak / Math.max(1, frames),
    });
    start = null;
    peak = 0;
  };
  for (let b = 0; b < BANDS; b++) {
    const persistent = busyCounts[b]! / Math.max(1, frames) >= PERSISTENCE;
    if (persistent) {
      if (start === null) start = b;
      peak = Math.max(peak, busyCounts[b]!);
    } else {
      flush(b);
    }
  }
  flush(BANDS);
  return regions;
}

/**
 * Bands a conservative run assumes are occupied when detection is skipped
 * (`--source-is-edited`). Burned-in titles sit in the upper third and burned-in
 * captions in the lower-middle — the two places an editor puts them, and the
 * two places ossclip most wants to draw.
 */
export const ASSUMED_EDITED_REGIONS: TextRegion[] = [
  { x: 0, y: 0.12, w: 1, h: 0.2, confidence: 1 },
  { x: 0, y: 0.66, w: 1, h: 0.12, confidence: 1 },
];

export interface ScanSourceTextOptions {
  samples?: number;
  cacheDir?: string;
  /** Skip detection and assume the conservative regions above. */
  assumeEdited?: boolean;
}

/**
 * Sample the take and report where it already has text burned in. Cached in
 * the workdir beside `face.json` — like the face box, this is a property of
 * the source, not of a render.
 */
export async function scanSourceText(
  tools: { ffmpegPath: string },
  videoPath: string,
  durationSec: number,
  opts: ScanSourceTextOptions = {},
): Promise<SourceTextScan> {
  if (opts.assumeEdited) {
    return { regions: ASSUMED_EDITED_REGIONS, framesSampled: 0, assumed: true };
  }
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "source-text.json") : null;
  if (cachePath && existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8")) as SourceTextScan;
  }

  const samples = opts.samples ?? 12;
  const busy = new Array<number>(BANDS).fill(0);
  let seen = 0;
  for (let i = 0; i < samples; i++) {
    const t = (durationSec * (i + 0.5)) / samples;
    const framePath = join(opts.cacheDir ?? ".", `text-frame-${i}.gray`);
    await run(tools.ffmpegPath, [
      "-v", "error",
      "-ss", t.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale=${DET_W}:${DET_H}`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-y", framePath,
    ]);
    const pixels = new Uint8Array(await readFile(framePath));
    await unlink(framePath).catch(() => {});
    if (pixels.length < DET_W * DET_H) continue;
    seen++;
    const density = bandEdgeDensity(pixels, DET_W, DET_H);
    const bimodality = bandBimodality(pixels, DET_W, DET_H);
    density.forEach((d, b) => {
      if (d >= BAND_EDGE_RATIO && bimodality[b]! >= BAND_BIMODALITY) busy[b]!++;
    });
  }

  const scan: SourceTextScan = {
    regions: seen > 0 ? regionsFromBands(busy, seen) : [],
    framesSampled: seen,
    assumed: false,
  };
  if (cachePath) await writeFile(cachePath, JSON.stringify(scan, null, 2));
  return scan;
}
