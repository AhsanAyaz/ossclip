import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec";

/**
 * Cover image selection (FINDINGS §31).
 *
 * Instagram and Facebook both accept a custom uploaded cover, so nothing has
 * to be pickable from the video's own frames — which is why ossclip writes a
 * separate `<out>.cover.jpg` rather than burning a title card into the head of
 * the reel. Spending the first 2-3 seconds on a static card would fight the
 * "hook in the first ~2s" policy directly, and a separate file can be
 * restyled without re-rendering a minute of video.
 *
 * This module picks WHICH frame. The banner is drawn by the renderer.
 */

export interface CoverCandidate {
  timeSec: number;
  /** Variance of the Laplacian — higher is sharper, lower is motion-blurred. */
  sharpness: number;
  hasFace: boolean;
  score: number;
}

/** Detection frame size, matching face.ts so the two agree on geometry. */
const DET_W = 360;
const DET_H = 640;

/**
 * Variance of the Laplacian over a grayscale frame — the standard cheap
 * sharpness measure. A frame caught mid-motion has most of its energy smeared
 * away and scores low, which is exactly what a cover must not be.
 */
export function laplacianVariance(pixels: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * pixels[i]! - pixels[i - 1]! - pixels[i + 1]! - pixels[i - w]! - pixels[i + w]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Score a candidate. A face is close to mandatory — a cover without the
 * speaker is a cover for a different video — and among frames that have one,
 * sharpness decides. Earlier frames win ties so the cover matches the opening.
 */
export function scoreCandidate(c: {
  timeSec: number;
  durationSec: number;
  sharpness: number;
  hasFace: boolean;
  maxSharpness: number;
}): number {
  const face = c.hasFace ? 1 : 0;
  const sharp = c.maxSharpness > 0 ? c.sharpness / c.maxSharpness : 0;
  const earliness = 1 - Math.min(1, c.timeSec / Math.max(1e-6, c.durationSec));
  return face * 2 + sharp + earliness * 0.3;
}

export interface PickCoverOptions {
  /** Frames to sample across the searched window. */
  samples?: number;
  /** Fraction of the take to search — the cover should match the opening. */
  searchFraction?: number;
  cacheDir?: string;
  /** Reports whether a face is present in a sampled frame. */
  hasFace?: (pixels: Uint8Array, w: number, h: number) => boolean;
}

/**
 * Pick the best cover frame from the take: sharp, face present, early.
 *
 * Note on "eyes open" (§31): pico's cascade locates a face box but carries no
 * eye state, and adding a landmark model for one thumbnail is not worth the
 * dependency — sharpness plus a face is what this measures. A blink is a real
 * residual risk; `--cover <path>` is the escape hatch.
 */
export async function pickCoverFrame(
  tools: { ffmpegPath: string },
  videoPath: string,
  durationSec: number,
  opts: PickCoverOptions = {},
): Promise<CoverCandidate | null> {
  const samples = opts.samples ?? 12;
  const searchFraction = opts.searchFraction ?? 0.2;
  const window = Math.max(1, durationSec * searchFraction);
  const candidates: CoverCandidate[] = [];
  const raw: Array<{ timeSec: number; sharpness: number; hasFace: boolean }> = [];

  for (let i = 0; i < samples; i++) {
    const t = (window * (i + 0.5)) / samples;
    const framePath = join(opts.cacheDir ?? ".", `cover-frame-${i}.gray`);
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
    raw.push({
      timeSec: t,
      sharpness: laplacianVariance(pixels, DET_W, DET_H),
      hasFace: opts.hasFace ? opts.hasFace(pixels, DET_W, DET_H) : false,
    });
  }
  if (raw.length === 0) return null;

  const maxSharpness = Math.max(...raw.map((r) => r.sharpness));
  for (const r of raw) {
    candidates.push({
      ...r,
      score: scoreCandidate({ ...r, durationSec: window, maxSharpness }),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}
