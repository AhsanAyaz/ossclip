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
  /** Frames only the tilt sweep found (PLAN Task 8) — absent when none. */
  framesRotated?: number;
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

// ---- rotation sweep (PLAN Task 8) ------------------------------------------

/**
 * Angles tried, in order, when the upright pass finds nothing. The cascade is
 * frontal AND upright: a head tilted past ~±20° falls outside what it was
 * trained on, and one real clip lost all nine samples that way. Rotating the
 * FRAME back to upright (cheap nearest-neighbour remap at detection size)
 * recovers in-plane tilt without any new model asset.
 *
 * What this does NOT recover, stated plainly: a true profile — the head
 * TURNED sideways rather than tilted — is out-of-plane and no image rotation
 * makes it frontal. If the loud-miss log still fires on such footage, the
 * next step is a profile cascade, not more angles here.
 */
export const ROTATION_SWEEP_DEG = [-20, 20, -40, 40];

/**
 * The frame rotated by `deg` about its centre; out-of-frame samples are 0.
 * Nearest-neighbour is plenty — the cascade reads coarse luminance relations,
 * not edges — and keeps this allocation-cheap at detection size.
 */
export function rotateGray(pixels: Uint8Array, w: number, h: number, deg: number): Uint8Array {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sample the source at the inverse rotation of this output position.
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cx + cos * dx + sin * dy);
      const sy = Math.round(cy - sin * dx + cos * dy);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = pixels[sy * w + sx]!;
    }
  }
  return out;
}

/**
 * Map a detection centre found in the ROTATED frame back to the original.
 * Exactly the sampling transform `rotateGray` applies — a rotated-frame
 * position corresponds to the source pixel that was sampled into it.
 */
export function rotatePointBack(
  r: number,
  c: number,
  w: number,
  h: number,
  deg: number,
): { r: number; c: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const dx = c - cx;
  const dy = r - cy;
  return { c: cx + cos * dx + sin * dy, r: cy - sin * dx + cos * dy };
}

interface CascadeParams {
  shiftfactor: number;
  minsize: number;
  maxsize: number;
  scalefactor: number;
}

/** Best clustered detection above the score floor, or null. */
function bestDetection(
  pixels: Uint8Array,
  h: number,
  w: number,
  classify: ClassifyFn,
  params: CascadeParams,
): Detection | null {
  const dets = clusterDetections(runCascade(pixels, h, w, classify, params), 0.2).filter(
    (d) => d[3] >= MIN_CLUSTER_SCORE,
  );
  if (dets.length === 0) return null;
  return dets.reduce((a, b) => (b[3] > a[3] ? b : a));
}

/**
 * Upright pass first; on a miss, the rotation sweep. The returned detection is
 * in ORIGINAL frame coordinates whichever pass found it (size is preserved —
 * in-plane rotation does not change scale).
 */
export function bestDetectionWithSweep(
  pixels: Uint8Array,
  h: number,
  w: number,
  classify: ClassifyFn,
  params: CascadeParams,
  sweepDeg: readonly number[] = ROTATION_SWEEP_DEG,
): { det: Detection; angleDeg: number } | null {
  const upright = bestDetection(pixels, h, w, classify, params);
  if (upright) return { det: upright, angleDeg: 0 };
  for (const deg of sweepDeg) {
    const hit = bestDetection(rotateGray(pixels, w, h, deg), h, w, classify, params);
    if (!hit) continue;
    const { r, c } = rotatePointBack(hit[0], hit[1], w, h, deg);
    return { det: [r, c, hit[2], hit[3]], angleDeg: deg };
  }
  return null;
}

// ---- frame sampling + measurement ------------------------------------------

/** Detection frame width; the HEIGHT follows the (cropped) source's aspect —
 * the cascade is trained on undistorted faces, so no squeeze into a fixed
 * box. Fractions are of the analyzed frame either way. */
const DET_W = 360;
/** Clustered-score floor for a believable face. picojs demos use ~50, but
 * that is summed over a 5-frame memory; a SINGLE frame at this resolution
 * clears ~5-10 on a real face. Robustness against a lucky wall-poster hit
 * comes from requiring detections in a majority of sampled frames, not from
 * this per-frame floor. */
const MIN_CLUSTER_SCORE = 5;

/**
 * A reusable detector over raw grayscale frames — the cascade is unpacked
 * once and the closure reused, so callers that score many frames (cover
 * selection, source-text scanning) don't pay for it per frame.
 */
export async function createFaceDetector(): Promise<
  (pixels: Uint8Array, width: number, height: number) => Detection | null
> {
  const cascadeBytes = new Uint8Array(
    await readFile(new URL("../assets/facefinder", import.meta.url)),
  );
  const classify = unpackCascade(cascadeBytes);
  return (pixels, width, height) => {
    if (pixels.length < width * height) return null;
    const hit = bestDetectionWithSweep(pixels, height, width, classify, {
      shiftfactor: 0.1,
      minsize: 60,
      maxsize: height,
      scalefactor: 1.1,
    });
    return hit ? hit.det : null;
  };
}

/** A face measured inside one time-and-crop window, in the WINDOW's fractions. */
export interface WindowFace {
  centerXFrac: number;
  centerYFrac: number;
  sizeFrac: number;
  framesDetected: number;
  framesSampled: number;
}

/**
 * The face per WINDOW — one measurement per (time range, crop) pair, each in
 * that crop's own fractions (NORMALIZE plan, the old Task C5 gap).
 *
 * A mixed-framing source cannot use `measureFace`'s single median: some of its
 * samples are fractions of a letterboxed strip and some of the full frame, and
 * a median across two coordinate systems describes neither — that mispointed
 * crop is exactly what put the eyes at the top of the frame on the author's
 * clip. Normalization instead measures each segment inside its own rect and
 * uses the result to place that segment's crop window.
 *
 * No cache: a handful of frames per window, and the caller's bake output is
 * itself cached by a hash of the plan this feeds.
 */
export async function measureFaceInWindows(
  tools: { ffmpegPath: string },
  videoPath: string,
  windows: ReadonlyArray<{ startSec: number; endSec: number; cropVf: string }>,
  opts: { samplesPerWindow?: number; workDir?: string } = {},
): Promise<Array<WindowFace | null>> {
  const cascadeBytes = new Uint8Array(
    await readFile(new URL("../assets/facefinder", import.meta.url)),
  );
  const classify = unpackCascade(cascadeBytes);
  const out: Array<WindowFace | null> = [];

  for (const [wi, w] of windows.entries()) {
    const dur = Math.max(0, w.endSec - w.startSec);
    // Short segments still get two looks; long ones don't need more than four.
    const samples = Math.min(opts.samplesPerWindow ?? 4, Math.max(2, Math.floor(dur)));
    const centersX: number[] = [];
    const centersY: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < samples; i++) {
      // Interior points only — a frame ON the boundary may already be the
      // other framing, which is the confusion this function exists to avoid.
      const t = w.startSec + (dur * (i + 1)) / (samples + 1);
      const framePath = join(opts.workDir ?? ".", `segface-${wi}-${i}.gray`);
      await run(tools.ffmpegPath, [
        "-v", "error",
        "-ss", t.toFixed(3),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", `${w.cropVf ? `${w.cropVf},` : ""}scale=${DET_W}:-2`,
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-y", framePath,
      ]);
      const pixels = new Uint8Array(await readFile(framePath));
      await unlink(framePath).catch(() => {});
      const detH = Math.floor(pixels.length / DET_W);
      if (detH < 32) continue;
      const hit = bestDetectionWithSweep(pixels, detH, DET_W, classify, {
        shiftfactor: 0.1,
        minsize: Math.max(24, Math.round(detH * 0.094)),
        maxsize: detH,
        scalefactor: 1.1,
      });
      if (!hit) continue;
      centersY.push(hit.det[0] / detH);
      centersX.push(hit.det[1] / DET_W);
      sizes.push(hit.det[2] / detH);
    }
    out.push(
      centersY.length >= 2
        ? {
            centerXFrac: median(centersX),
            centerYFrac: median(centersY),
            sizeFrac: median(sizes),
            framesDetected: centersY.length,
            framesSampled: samples,
          }
        : null,
    );
  }
  return out;
}

export interface MeasureFaceOptions {
  /** Frames to sample, spread across the middle of the take. */
  samples?: number;
  /** Directory for the cached measurement + temp frames (the workdir). */
  cacheDir?: string;
  /**
   * ffmpeg filter trimming the source to its content rect (PLAN Task 7),
   * prepended before the detection scale. Measuring inside the picture rather
   * than the letterboxed canvas matters twice over: the returned fractions
   * then describe the frame that actually renders, and the face is a large
   * enough share of the searched area for the cascade's scale sweep to find.
   */
  cropVf?: string;
  /**
   * Extra cache-validity key beyond `cropVf` — set to the measured FILE's
   * identity when it is not the workdir's original source (the normalized
   * bake), so a cache from one geometry is never served for another.
   */
  cacheTag?: string;
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
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      face: FaceBox | null;
      cropVf?: string;
      cacheTag?: string;
    };
    // A measurement made against a different geometry (pre-Task-7 cache, a
    // changed content rect, or a different baked file) describes a frame that
    // no longer renders.
    if (
      (cached.cropVf ?? "") === (opts.cropVf ?? "") &&
      (cached.cacheTag ?? "") === (opts.cacheTag ?? "")
    ) {
      return cached.face;
    }
  }

  const cascadeBytes = new Uint8Array(
    await readFile(new URL("../assets/facefinder", import.meta.url)),
  );
  const classify = unpackCascade(cascadeBytes);

  const centersX: number[] = [];
  const centersY: number[] = [];
  const sizes: number[] = [];
  let rotated = 0;
  for (let i = 0; i < samples; i++) {
    // Middle 80% — intros/outros are where people lean off-frame.
    const t = durationSec * (0.1 + (0.8 * i) / Math.max(1, samples - 1));
    const framePath = join(opts.cacheDir ?? ".", `face-frame-${i}.gray`);
    await run(tools.ffmpegPath, [
      "-v", "error",
      "-ss", t.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      // Aspect follows the (cropped) source rather than a fixed 9:16 box: the
      // cascade is trained on undistorted faces, and squeezing a landscape
      // content rect into a portrait frame stretches every face past what it
      // can match. -2 keeps the height even.
      "-vf", `${opts.cropVf ? `${opts.cropVf},` : ""}scale=${DET_W}:-2`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-y", framePath,
    ]);
    const pixels = new Uint8Array(await readFile(framePath));
    await unlink(framePath).catch(() => {});
    const detH = Math.floor(pixels.length / DET_W);
    if (detH < 32) continue;
    const hit = bestDetectionWithSweep(pixels, detH, DET_W, classify, {
      shiftfactor: 0.1,
      // The old fixed floor (60px of a 640-tall frame, ~9%) expressed as a
      // ratio, so a shorter landscape frame still sweeps small enough.
      minsize: Math.max(24, Math.round(detH * 0.094)),
      maxsize: detH,
      scalefactor: 1.1,
    });
    if (!hit) continue;
    if (hit.angleDeg !== 0) rotated++;
    centersY.push(hit.det[0] / detH);
    centersX.push(hit.det[1] / DET_W);
    sizes.push(hit.det[2] / detH);
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
          framesRotated: rotated > 0 ? rotated : undefined,
        }
      : null;

  if (cachePath) {
    await writeFile(
      cachePath,
      JSON.stringify({ face, cropVf: opts.cropVf ?? "", cacheTag: opts.cacheTag ?? "" }, null, 2),
    );
  }
  return face;
}
