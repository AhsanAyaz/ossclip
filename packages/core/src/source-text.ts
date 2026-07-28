import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";

/**
 * Burned-in text detection (FINDINGS §26, rebuilt for §32).
 *
 * ossclip assumes raw footage. Fed a finished reel it has no idea anything is
 * already on screen, so it crops through the source's own title and then says
 * much the same thing in different words directly beneath — two competing
 * titles, one of them clipped.
 *
 * The product rule is asymmetric, and deliberately so:
 *   - CAPTIONS ALWAYS GO IN. They are the accessibility layer, so they move
 *     rather than disappear.
 *   - ossclip's own graphics must not overlap existing elements at all. If no
 *     free region can hold a scene, that scene is skipped.
 *
 * The first version reported zero regions on the exact footage it was built
 * for. Measuring a reproduction of that clip showed why, and neither cause was
 * the discriminator everyone suspected:
 *
 *   1. A burned-in title is TRANSIENT — it ran 6s of a 12s clip. The detector
 *      demanded a band be busy in half of ALL sampled frames, so a title that
 *      occupies a third of the runtime was voted out by the frames it was
 *      never in. Regions are now time-scoped, which is both the fix and the
 *      more honest model: a title only conflicts with scenes that share its
 *      window.
 *   2. The edge threshold sat INSIDE the background noise. Measured on the
 *      reproduction: the title band scores 0.345 while every other band scores
 *      0.021-0.069. The old 0.055 cut through that noise band, which is what
 *      made the golden fixture false-positive — and then the bimodality gate
 *      added to suppress it was blamed for suppressing real text too.
 *
 * Three signals now have to agree, each rejecting a different impostor:
 * density (is anything drawn), bimodality (glyphs sit at the luminance
 * extremes; scenery spreads across the midtones), and stroke structure (text
 * is many SHORT runs per row; colour bars are a handful of very wide ones).
 * Per-band scores are written to the cache so thresholds stay settable from
 * measurements rather than guesses.
 */

/** Occupancy rect in frame fractions, scoped to when it is on screen. */
export interface TextRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** SOURCE time this region is visible. */
  startSec: number;
  endSec: number;
  /** Share of the samples inside its own window that saw it. */
  confidence: number;
}

export interface BandScore {
  edge: number;
  bimodal: number;
  stroke: number;
}

export interface SourceTextScan {
  regions: TextRegion[];
  framesSampled: number;
  /** True when the user asserted the source is edited, skipping detection. */
  assumed: boolean;
  /** Per-sample, per-band measurements — kept so thresholds stay evidence-based. */
  debug?: Array<{ timeSec: number; bands: BandScore[] }>;
}

/**
 * Analysis width. The HEIGHT is whatever the source's aspect gives, rather
 * than a fixed 9:16 — all three signals below are geometric, and squeezing a
 * 16:9 frame into a portrait box turns every glyph stroke into a sliver and
 * every horizontal run into a short one. That is the shape of text, so a
 * stretched landscape source would score as text everywhere.
 */
const DET_W = 240;
/** Rows of the analysis grid — bands are the unit, since text runs across. */
export const BANDS = 24;
/** Luminance step that counts as a glyph edge. */
const EDGE_THRESHOLD = 42;

/**
 * Thresholds, set from measurements on a reproduction of the §32 clip
 * (white-on-black title over a colour-bar background):
 *
 *   band            edge    bimodal  stroke
 *   title           0.345   0.76     high
 *   colour bars     0.042   0.33     low   (few, very wide runs)
 *   checkerboard    0.069   0.30     high  (dense, but low contrast)
 *
 * Each threshold sits in the gap, not at the edge of the noise.
 */
const BAND_EDGE_RATIO = 0.12;
const BAND_BIMODALITY = 0.5;
const BAND_STROKE = 0.25;

/** A row needs at least this many transitions to look like a line of glyphs. */
const MIN_ROW_TRANSITIONS = 6;
/** …and its runs must be short relative to the frame: glyphs, not bars. */
const MAX_STROKE_FRACTION = 1 / 12;

/**
 * Three scores per band.
 *
 * - `edge`: share of pixels sitting on a horizontal luminance step.
 * - `bimodal`: share of pixels at the luminance extremes.
 * - `stroke`: share of ROWS whose transitions are many and closely spaced.
 *
 * The third is what separates text from a colour-bar test pattern, which is
 * every bit as bimodal as white-on-black type but is a handful of enormous
 * runs rather than dozens of narrow ones.
 */
export function bandScores(pixels: Uint8Array, w: number, h: number): BandScore[] {
  const bandHeight = Math.max(1, Math.floor(h / BANDS));
  const maxRun = w * MAX_STROKE_FRACTION;
  const out: BandScore[] = [];
  for (let b = 0; b < BANDS; b++) {
    const y0 = b * bandHeight;
    const y1 = Math.min(h, y0 + bandHeight);
    let edges = 0;
    let extreme = 0;
    let count = 0;
    let strokeRows = 0;
    let rows = 0;
    for (let y = y0; y < y1; y++) {
      let transitions = 0;
      let lastTransition = 0;
      let shortRuns = 0;
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = pixels[i]!;
        if (v <= 48 || v >= 207) extreme++;
        count++;
        if (Math.abs(pixels[i + 1]! - pixels[i - 1]!) >= EDGE_THRESHOLD) {
          edges++;
          if (x - lastTransition > 1) {
            transitions++;
            if (x - lastTransition <= maxRun) shortRuns++;
            lastTransition = x;
          }
        }
      }
      rows++;
      if (transitions >= MIN_ROW_TRANSITIONS && shortRuns >= transitions * 0.6) strokeRows++;
    }
    out.push({
      edge: count > 0 ? edges / count : 0,
      bimodal: count > 0 ? extreme / count : 0,
      stroke: rows > 0 ? strokeRows / rows : 0,
    });
  }
  return out;
}

/** Does this band look like burned-in text? All three signals must agree. */
export function bandIsText(s: BandScore): boolean {
  return s.edge >= BAND_EDGE_RATIO && s.bimodal >= BAND_BIMODALITY && s.stroke >= BAND_STROKE;
}

/**
 * Turn per-sample band occupancy into time-scoped regions.
 *
 * Consecutive busy samples in a band become one region spanning their window;
 * vertically adjacent bands sharing a window merge into a block. No global
 * persistence vote — a title that runs a third of the clip is still a title,
 * it just conflicts with a third of the scenes.
 */
export function regionsFromSamples(
  samples: Array<{ timeSec: number; busy: boolean[] }>,
  halfStepSec: number,
): TextRegion[] {
  const perBand: TextRegion[] = [];
  for (let b = 0; b < BANDS; b++) {
    let runStart: number | null = null;
    let seen = 0;
    const flush = (endIdx: number) => {
      if (runStart === null) return;
      perBand.push({
        x: 0,
        y: b / BANDS,
        w: 1,
        h: 1 / BANDS,
        startSec: Math.max(0, samples[runStart]!.timeSec - halfStepSec),
        endSec: samples[endIdx]!.timeSec + halfStepSec,
        confidence: seen / (endIdx - runStart + 1),
      });
      runStart = null;
      seen = 0;
    };
    for (let i = 0; i < samples.length; i++) {
      if (samples[i]!.busy[b]) {
        if (runStart === null) runStart = i;
        seen++;
      } else if (runStart !== null) {
        flush(i - 1);
      }
    }
    if (runStart !== null) flush(samples.length - 1);
  }

  // Merge vertically adjacent bands whose windows overlap.
  perBand.sort((a, b) => a.y - b.y || a.startSec - b.startSec);
  const merged: TextRegion[] = [];
  for (const r of perBand) {
    const prev = merged[merged.length - 1];
    const adjacent = prev && Math.abs(prev.y + prev.h - r.y) < 1e-9;
    const overlaps = prev && r.startSec < prev.endSec && prev.startSec < r.endSec;
    if (prev && adjacent && overlaps) {
      prev.h += r.h;
      prev.startSec = Math.min(prev.startSec, r.startSec);
      prev.endSec = Math.max(prev.endSec, r.endSec);
      prev.confidence = Math.min(prev.confidence, r.confidence);
    } else {
      merged.push({ ...r });
    }
  }

  // Pad each merged region by one band. Detection localizes GLYPHS, but the
  // graphic behind them — the rounded plate a title sits on — reaches past the
  // last row of type, and it is the PLATE a crop visibly slices. Measured on
  // the real reel: glyphs at 17-25% of the source, the black box from ~12.5%,
  // and the rendered crop cut the box while clearing the text. One band is the
  // detector's own resolution, so this claims no more precision than the
  // measurement has. Padding happens after merging so it cannot fuse regions
  // that the evidence kept apart.
  const pad = 1 / BANDS;
  for (const r of merged) {
    const top = Math.max(0, r.y - pad);
    r.h = Math.min(1, r.y + r.h + pad) - top;
    r.y = top;
  }
  return merged;
}

/**
 * Bands a conservative run assumes are occupied when detection is skipped
 * (`--source-is-edited`). Burned-in titles sit in the upper third and burned-in
 * captions in the lower-middle — the two places an editor puts them, and the
 * two places ossclip most wants to draw. Assumed regions span the whole clip,
 * because without detection there is no way to know when they are up.
 */
export const ASSUMED_EDITED_REGIONS: TextRegion[] = [
  { x: 0, y: 0.12, w: 1, h: 0.2, startSec: 0, endSec: Number.POSITIVE_INFINITY, confidence: 1 },
  { x: 0, y: 0.66, w: 1, h: 0.12, startSec: 0, endSec: Number.POSITIVE_INFINITY, confidence: 1 },
];

export interface ScanSourceTextOptions {
  samples?: number;
  cacheDir?: string;
  /** Skip detection and assume the conservative regions above. */
  assumeEdited?: boolean;
  /**
   * ffmpeg filter trimming the source to its content rect (PLAN Task 7).
   * Letterbox bars are hard black edges — exactly what the density signal
   * fires on — and regions must be fractions of the frame that RENDERS, which
   * is the cropped one.
   */
  cropVf?: string;
  /** Extra cache key for when the scanned file is the normalized bake. */
  cacheTag?: string;
}

/** Cache format version — bump to invalidate stale scans after a rebuild. */
const SCAN_VERSION = 3;

/**
 * Sample the take and report where — and WHEN — it already has text burned in.
 * Cached in the workdir beside `face.json`: like the face box, this is a
 * property of the source, not of a render.
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
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as SourceTextScan & {
      version?: number;
      cropVf?: string;
      cacheTag?: string;
    };
    // Regions are fractions of the analyzed frame, so a scan made against a
    // different crop (or a different baked file) describes geometry that no
    // longer renders.
    if (
      cached.version === SCAN_VERSION &&
      (cached.cropVf ?? "") === (opts.cropVf ?? "") &&
      (cached.cacheTag ?? "") === (opts.cacheTag ?? "")
    ) {
      return cached;
    }
  }

  // A title can be short; sample densely enough to catch a ~2s one.
  const samples = opts.samples ?? Math.min(40, Math.max(12, Math.round(durationSec / 1.5)));
  const step = durationSec / samples;
  const collected: Array<{ timeSec: number; busy: boolean[] }> = [];
  const debug: SourceTextScan["debug"] = [];

  for (let i = 0; i < samples; i++) {
    const t = step * (i + 0.5);
    const framePath = join(opts.cacheDir ?? ".", `text-frame-${i}.gray`);
    await run(tools.ffmpegPath, [
      "-v", "error",
      "-ss", t.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      // -2: height follows the source aspect, rounded to an even number.
      "-vf", `${opts.cropVf ? `${opts.cropVf},` : ""}scale=${DET_W}:-2`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-y", framePath,
    ]);
    const pixels = new Uint8Array(await readFile(framePath));
    await unlink(framePath).catch(() => {});
    const detH = Math.floor(pixels.length / DET_W);
    if (detH < BANDS) continue;
    const scores = bandScores(pixels, DET_W, detH);
    collected.push({ timeSec: t, busy: scores.map(bandIsText) });
    debug.push({ timeSec: t, bands: scores });
  }

  const scan: SourceTextScan = {
    regions: regionsFromSamples(collected, step / 2),
    framesSampled: collected.length,
    assumed: false,
    debug,
  };
  if (cachePath) {
    await writeFile(
      cachePath,
      JSON.stringify(
        { version: SCAN_VERSION, cropVf: opts.cropVf ?? "", cacheTag: opts.cacheTag ?? "", ...scan },
        null,
        2,
      ),
    );
  }
  return scan;
}
