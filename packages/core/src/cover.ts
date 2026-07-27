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

/**
 * A cover banner is a headline, not a sentence (FINDINGS §35). The producer
 * shipped 13 words across five lines by reusing the video's hook verbatim; at
 * grid-tile size that is unreadable. The reference covers run 4-9 words.
 *
 * Stated in the schema AND enforced here, because a `.describe()` is a request
 * and this is a constraint — the same reason `normalizeBeatSheet` exists.
 */
export const COVER_MAX_WORDS = 9;

/** Trailing words that cannot end a headline — the truncation reads as broken. */
const DANGLING = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "the", "to", "with", "that", "this", "my", "your", "so",
]);

/**
 * Cut a headline down to `maxWords`, preferring a natural break.
 *
 * A dash or colon usually separates a complete claim from its elaboration, so
 * the first clause is a real headline rather than a sentence with its end
 * lopped off. Only when that is still too long does this truncate — and then
 * it refuses to stop on a preposition or article, which is what makes a
 * truncation look like a bug instead of an edit.
 */
export function coverHeadline(text: string, maxWords = COVER_MAX_WORDS): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return clean;
  const words = (s: string): string[] => s.split(" ").filter(Boolean);
  if (words(clean).length <= maxWords) return clean;

  // First clause, if it stands on its own — never a two-word fragment. Even
  // when the clause is itself too long it is the better thing to cut down,
  // since truncating it can never wander past the dash into the elaboration.
  const clause = clean.split(/\s*[—–:]\s*|\s+-\s+/)[0]!.trim();
  const base = words(clause).length >= 3 ? clause : clean;
  const out = words(base).slice(0, maxWords);
  while (out.length > 3 && DANGLING.has(out[out.length - 1]!.toLowerCase().replace(/\W/g, ""))) {
    out.pop();
  }
  // A clause that ended on its own punctuation keeps it; a cut does not.
  return out.join(" ").replace(/[,;:—–-]+$/, "");
}

/** Where the face sits in the COVER frame, as fractions of it. */
export interface CoverFace {
  centerXFrac: number;
  centerYFrac: number;
  sizeFrac: number;
}

export interface CoverCandidate {
  timeSec: number;
  /** Variance of the Laplacian — higher is sharper, lower is motion-blurred. */
  sharpness: number;
  hasFace: boolean;
  /** The box, when one was found — the banner routes around it (FINDINGS §33). */
  face?: CoverFace;
  score: number;
}

/**
 * Detection frame: the 9:16 cover frame at analysis size.
 *
 * Deliberately NOT face.ts's plain `scale`. That one measures the SOURCE, and
 * its fractions feed the video crop math. This one measures the COVER, which
 * is a centre crop to 1080×1920 — so it applies the identical crop first.
 * Without that, a face box measured on a stretched 16:9 source would place the
 * cover banner against geometry the cover does not have.
 */
const DET_W = 360;
const DET_H = 640;
export const COVER_CROP_VF =
  `scale=${DET_W}:${DET_H}:force_original_aspect_ratio=increase,crop=${DET_W}:${DET_H}`;

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
  /**
   * Locates the face in a sampled frame, in that frame's own fractions.
   * Returns the box rather than a boolean because the banner has to route
   * around it (FINDINGS §33), and the frame it was measured on is the only
   * frame whose geometry is certainly the cover's.
   */
  detectFace?: (pixels: Uint8Array, w: number, h: number) => CoverFace | null;
  /**
   * ffmpeg filter trimming the source to its content rect (PLAN Task 7),
   * applied BEFORE the cover's own centre crop — otherwise the cover frames a
   * canvas that is two-thirds baked-in black bar.
   */
  cropVf?: string;
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
  const raw: Array<{
    timeSec: number;
    sharpness: number;
    hasFace: boolean;
    face?: CoverFace;
  }> = [];

  for (let i = 0; i < samples; i++) {
    const t = (window * (i + 0.5)) / samples;
    const framePath = join(opts.cacheDir ?? ".", `cover-frame-${i}.gray`);
    await run(tools.ffmpegPath, [
      "-v", "error",
      "-ss", t.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `${opts.cropVf ? `${opts.cropVf},` : ""}${COVER_CROP_VF}`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-y", framePath,
    ]);
    const pixels = new Uint8Array(await readFile(framePath));
    await unlink(framePath).catch(() => {});
    if (pixels.length < DET_W * DET_H) continue;
    const face = opts.detectFace?.(pixels, DET_W, DET_H) ?? undefined;
    raw.push({
      timeSec: t,
      sharpness: laplacianVariance(pixels, DET_W, DET_H),
      hasFace: face !== undefined,
      face,
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
