import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";

/**
 * Static face measurement (FINDINGS §13) — the v0 shortcut of BRAINSTORM
 * §4.3's reframing note. A constant crop bias trades cutting the forehead
 * for cutting the mouth depending on how the speaker framed themselves, so
 * the system measures where the face IS: sample frames, detect, take the
 * median box, cache it in the workdir (it is a property of the source, not
 * of a render). Full per-frame tracking stays Phase 4.
 *
 * Detection is the pico cascade (Nenad Markus), ported from picojs — a pure
 * JS decision-tree detector, MIT licensed, no native deps:
 * https://github.com/nenadmarkus/picojs. The pretrained `facefinder`
 * cascade is vendored in assets/ (also MIT, from github.com/nenadmarkus/pico).
 */

/** Median face box, as fractions of the SOURCE frame. */
export interface FaceBox {
  /** Horizontal center, 0..1 of source width. */
  centerXFrac: number;
  /** Vertical center, 0..1 of source height. */
  centerYFrac: number;
  /** Face size (pico's square detection edge), as a fraction of source height. */
  sizeFrac: number;
  framesSampled: number;
  framesDetected: number;
}

// ---- pico runtime (ported from picojs, MIT) --------------------------------

type ClassifyFn = (r: number, c: number, s: number, pixels: Uint8Array, ldim: number) => number;

function unpackCascade(bytes: Uint8Array): ClassifyFn {
  const dview = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Skip version + training metadata (8 bytes).
  let p = 8;
  const tdepth = dview.getInt32(p, true);
  p += 4;
  const ntrees = dview.getInt32(p, true);
  p += 4;
  const pow2tdepth = 2 ** tdepth;
  const tcodesLs: number[] = [];
  const tpredsLs: number[] = [];
  const threshLs: number[] = [];
  for (let t = 0; t < ntrees; t++) {
    tcodesLs.push(0, 0, 0, 0);
    for (let i = 0; i < 4 * pow2tdepth - 4; i++) tcodesLs.push(dview.getInt8(p + i));
    p += 4 * pow2tdepth - 4;
    for (let i = 0; i < pow2tdepth; i++) {
      tpredsLs.push(dview.getFloat32(p, true));
      p += 4;
    }
    threshLs.push(dview.getFloat32(p, true));
    p += 4;
  }
  const tcodes = new Int8Array(tcodesLs);
  const tpreds = new Float32Array(tpredsLs);
  const thresh = new Float32Array(threshLs);

  return (r, c, s, pixels, ldim) => {
    r *= 256;
    c *= 256;
    let root = 0;
    let o = 0;
    for (let i = 0; i < ntrees; i++) {
      let idx = 1;
      for (let j = 0; j < tdepth; j++) {
        // '>> 8' is the fixed-point division pico uses for speed.
        const p1 =
          pixels[((r + tcodes[root + 4 * idx + 0]! * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1]! * s) >> 8)]!;
        const p2 =
          pixels[((r + tcodes[root + 4 * idx + 2]! * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3]! * s) >> 8)]!;
        idx = 2 * idx + (p1 <= p2 ? 1 : 0);
      }
      o += tpreds[pow2tdepth * i + idx - pow2tdepth]!;
      if (o <= thresh[i]!) return -1;
      root += 4 * pow2tdepth;
    }
    return o - thresh[ntrees - 1]!;
  };
}

/** [row, col, scale, score] */
type Detection = [number, number, number, number];

function runCascade(
  pixels: Uint8Array,
  nrows: number,
  ncols: number,
  classify: ClassifyFn,
  params: { shiftfactor: number; minsize: number; maxsize: number; scalefactor: number },
): Detection[] {
  const detections: Detection[] = [];
  let scale = params.minsize;
  while (scale <= params.maxsize) {
    const step = Math.max(params.shiftfactor * scale, 1) | 0;
    const offset = (scale / 2 + 1) | 0;
    for (let r = offset; r <= nrows - offset; r += step) {
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classify(r, c, scale, pixels, ncols);
        if (q > 0) detections.push([r, c, scale, q]);
      }
    }
    scale *= params.scalefactor;
  }
  return detections;
}

function clusterDetections(dets: Detection[], iouThreshold: number): Detection[] {
  dets = [...dets].sort((a, b) => b[3] - a[3]);
  const iou = (d1: Detection, d2: Detection): number => {
    const [r1, c1, s1] = d1;
    const [r2, c2, s2] = d2;
    const overR = Math.max(0, Math.min(r1 + s1 / 2, r2 + s2 / 2) - Math.max(r1 - s1 / 2, r2 - s2 / 2));
    const overC = Math.max(0, Math.min(c1 + s1 / 2, c2 + s2 / 2) - Math.max(c1 - s1 / 2, c2 - s2 / 2));
    return (overR * overC) / (s1 * s1 + s2 * s2 - overR * overC);
  };
  const assigned = new Array<boolean>(dets.length).fill(false);
  const clusters: Detection[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (assigned[i]) continue;
    let r = 0,
      c = 0,
      s = 0,
      q = 0,
      n = 0;
    for (let j = i; j < dets.length; j++) {
      if (iou(dets[i]!, dets[j]!) > iouThreshold) {
        assigned[j] = true;
        r += dets[j]![0];
        c += dets[j]![1];
        s += dets[j]![2];
        q += dets[j]![3];
        n++;
      }
    }
    clusters.push([r / n, c / n, s / n, q]);
  }
  return clusters;
}

// ---- frame sampling + measurement ------------------------------------------

/** Detection frame size: exact 9:16 like the target output; the vertical
 * fraction is what matters and survives any horizontal squeeze. */
const DET_W = 360;
const DET_H = 640;
/** Clustered-score floor for a believable face. picojs demos use ~50, but
 * that is summed over a 5-frame memory; a SINGLE frame at this resolution
 * clears ~5-10 on a real face. Robustness against a lucky wall-poster hit
 * comes from requiring detections in a majority of sampled frames, not from
 * this per-frame floor. */
const MIN_CLUSTER_SCORE = 5;

export interface MeasureFaceOptions {
  /** Frames to sample, spread across the middle of the take. */
  samples?: number;
  /** Directory for the cached measurement + temp frames (the workdir). */
  cacheDir?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Sample frames across the take, detect the face in each, return the median
 * box — or null when the take genuinely has no findable face (screen
 * recording, slides), in which case callers fall back to the default bias.
 */
export async function measureFace(
  tools: { ffmpegPath: string },
  videoPath: string,
  durationSec: number,
  opts: MeasureFaceOptions = {},
): Promise<FaceBox | null> {
  const samples = opts.samples ?? 9;
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "face.json") : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { face: FaceBox | null };
    return cached.face;
  }

  const cascadeBytes = new Uint8Array(
    await readFile(new URL("../assets/facefinder", import.meta.url)),
  );
  const classify = unpackCascade(cascadeBytes);

  const centersX: number[] = [];
  const centersY: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < samples; i++) {
    // Middle 80% — intros/outros are where people lean off-frame.
    const t = durationSec * (0.1 + (0.8 * i) / Math.max(1, samples - 1));
    const framePath = join(opts.cacheDir ?? ".", `face-frame-${i}.gray`);
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
    const dets = clusterDetections(
      runCascade(pixels, DET_H, DET_W, classify, {
        shiftfactor: 0.1,
        minsize: 60,
        maxsize: DET_H,
        scalefactor: 1.1,
      }),
      0.2,
    ).filter((d) => d[3] >= MIN_CLUSTER_SCORE);
    if (dets.length === 0) continue;
    const best = dets.reduce((a, b) => (b[3] > a[3] ? b : a));
    centersY.push(best[0] / DET_H);
    centersX.push(best[1] / DET_W);
    sizes.push(best[2] / DET_H);
  }

  // One lucky hit could be a poster in the background; demand a majority-ish.
  const face: FaceBox | null =
    centersY.length >= Math.min(3, samples)
      ? {
          centerXFrac: median(centersX),
          centerYFrac: median(centersY),
          sizeFrac: median(sizes),
          framesSampled: samples,
          framesDetected: centersY.length,
        }
      : null;

  if (cachePath) await writeFile(cachePath, JSON.stringify({ face }, null, 2));
  return face;
}
