import { run } from "./exec";
import type { ContentRectSegment } from "./content-rect";
import type { WindowFace } from "./face";

/**
 * Framing normalization for a mixed-framing source (option (a), chosen with
 * the author 2026-07-28).
 *
 * A source that alternates a letterboxed landscape strip with full-bleed
 * portrait has no single framing — and rendering each segment's own framing
 * cover-filled produced a ~3× apparent zoom jump at every boundary, nine
 * times a minute on the motivating clip ("weird zoom-outs and zoom-ins").
 * Smoothing the boundaries cannot fix that; the output would still alternate
 * between two shots.
 *
 * The fix is editorial, applied at bake time: pick ONE field of view — the
 * tightest the source ever shows, i.e. the strip, since the strip's pixels
 * are all those stretches have — and crop every other segment down to a
 * window of that same shape, placed on the measured face. The result is a
 * single, uniform landscape source with constant apparent framing, and the
 * ENTIRE downstream pipeline (face bias, source-text, cover, layouts, zoom)
 * runs its ordinary uniform-source path on it. Tight but stable, by choice.
 *
 * When even the strip cannot cover the output frame without excessive
 * upscaling, normalization refuses (`ok: false`) and the caller falls back to
 * render-time FIT — the strip shown at its natural size rather than
 * fake-zoomed (option (b)).
 */

/** One baked stretch: this window of the source, scaled to the canvas. */
export interface NormalizeSegment {
  startSec: number;
  endSec: number;
  /** Crop window in SOURCE pixels — always the canvas's aspect. */
  window: { x: number; y: number; w: number; h: number };
}

export interface NormalizePlan {
  /** The common frame every segment is cropped+scaled to. */
  canvas: { width: number; height: number };
  segments: NormalizeSegment[];
  /**
   * The upscale a full-bleed cover of the OUTPUT implies. The quality gate:
   * past `MAX_NORMALIZE_UPSCALE` the picture would be visibly soft, and a
   * soft fake is worse than an honest fit.
   */
  coverUpscale: number;
  ok: boolean;
}

/**
 * Ceiling on how far the canvas may be upscaled when a full-bleed layout
 * covers the output with it. The motivating clip sits at 1920/808 ≈ 2.38 —
 * soft but within reel norms; a strip much shorter than that is not worth
 * faking a full-frame shot from.
 */
export const MAX_NORMALIZE_UPSCALE = 2.6;

const even = (v: number): number => 2 * Math.floor(v / 2);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Decide the canvas and each segment's crop window.
 *
 * `faces` is parallel to `timeline` — each face in ITS segment rect's own
 * fractions (`measureFaceInWindows`).
 *
 * The window is sized by the FACE, not by a constant rect. Equalizing the
 * canvas alone is not enough, and the author's clip proved it: its two
 * framings are the same camera shot presented differently — the letterboxed
 * strip is the whole landscape frame, the full-bleed stretches are a zoomed
 * crop of it. So the face measures 0.28-0.44 of the frame in one state and
 * 0.48-0.57 in the other, and cropping both to a constant-height window put
 * the face at 108% of output height in the full-bleed stretches (head taller
 * than the frame) against 57% in the strips. Same subject, wildly different
 * size, at every boundary.
 *
 * Sizing each window as `faceHeight / targetFraction` makes the SUBJECT the
 * constant instead, which is what "one consistent framing" has to mean. The
 * target is the MEDIAN measured fraction: a segment whose face is smaller
 * than the target crops in to match, and one whose face is larger can only
 * zoom out as far as its own rect — clamping there rather than inventing
 * pixels. The median (not the max) is what keeps that clamping rare and the
 * upscale inside the quality gate.
 */
export function planNormalization(
  timeline: readonly ContentRectSegment[],
  faces: ReadonlyArray<WindowFace | null>,
  output: { width: number; height: number },
): NormalizePlan {
  const boxed = timeline.filter((s) => !s.rect.full);
  // Callers only reach here for a mixed source, but refuse rather than crash.
  if (boxed.length === 0 || timeline.length < 2) {
    return { canvas: { width: 0, height: 0 }, segments: [], coverUpscale: Infinity, ok: false };
  }

  /** Face height as a fraction of its own segment's rect, where measured. */
  const measured = timeline.map((_, i) => faces[i]?.sizeFrac ?? null);
  const known = measured.filter((v): v is number => v !== null);

  // ---- Window heights ------------------------------------------------------
  // Without a single measurement there is no subject to hold constant, so the
  // rect-shaped fallback stands: the tightest field of view, uniformly.
  const target = known.length > 0 ? median(known) : null;
  const rectShapedHeights = (): number[] => {
    const canvasRect = boxed.reduce((a, b) => (b.rect.h < a.rect.h ? b : a)).rect;
    const a = canvasRect.w / canvasRect.h;
    return timeline.map((s) => even(Math.min(s.rect.w, s.rect.h * a) / a));
  };
  const windowHeights =
    target === null
      ? rectShapedHeights()
      : timeline.map((s, i) => {
          // An unmeasured segment inherits the median fraction of the segments
          // framed like it (same rect height), so it is sized in ITS OWN class
          // rather than averaged across two different shots.
          const sameClass = timeline.flatMap((o, j) =>
            measured[j] !== null && Math.abs(o.rect.h - s.rect.h) <= 2 ? [measured[j]!] : [],
          );
          const frac = measured[i] ?? (sameClass.length > 0 ? median(sameClass) : median(known));
          return even(clamp((frac * s.rect.h) / target, 16, s.rect.h));
        });

  // ---- Canvas --------------------------------------------------------------
  // The widest aspect every window can actually hold. Wider than the output's
  // own aspect leaves the stage some horizontal freedom for the face bias;
  // narrower simply means the output crops height, which cover already does.
  const aspect = timeline.reduce(
    (a, s, i) => Math.min(a, s.rect.w / windowHeights[i]!),
    Number.POSITIVE_INFINITY,
  );
  // The smallest window, so baking never upscales — the tightest segment sets
  // the resolution and every other one is downscaled into it.
  const canvasHeight = even(Math.min(...windowHeights));
  const canvas = { width: even(canvasHeight * aspect), height: canvasHeight };

  // ---- Face placement inside the window ------------------------------------
  // Taken from the segments whose window IS their rect: their framing is the
  // author's own and survives untouched, so it is the one to reproduce.
  let wx = 0;
  let wy = 0;
  let weight = 0;
  timeline.forEach((seg, i) => {
    const f = faces[i];
    if (!f || windowHeights[i]! < seg.rect.h - 2) return;
    const dur = Math.max(1e-6, seg.endSec - seg.startSec);
    wx += f.centerXFrac * dur;
    wy += f.centerYFrac * dur;
    weight += dur;
  });
  const targetX = weight > 0 ? wx / weight : 0.5;
  const targetY = weight > 0 ? wy / weight : 0.45;

  const segments: NormalizeSegment[] = timeline.map((seg, i) => {
    const r = seg.rect;
    const wH = windowHeights[i]!;
    const wW = even(Math.min(r.w, wH * aspect));
    const f = faces[i];
    // Face position in source px; the rect centre when nothing was measured.
    const faceX = r.x + (f ? f.centerXFrac : 0.5) * r.w;
    const faceY = r.y + (f ? f.centerYFrac : 0.5) * r.h;
    const x = even(clamp(faceX - targetX * wW, r.x, r.x + r.w - wW));
    const y = even(clamp(faceY - targetY * wH, r.y, r.y + r.h - wH));
    return { startSec: seg.startSec, endSec: seg.endSec, window: { x, y, w: wW, h: wH } };
  });

  // Cover the output with the canvas: for a canvas wider than the output's
  // aspect the height binds, otherwise the width does.
  const coverUpscale =
    canvas.width / canvas.height > output.width / output.height
      ? output.height / canvas.height
      : output.width / canvas.width;

  return { canvas, segments, coverUpscale, ok: coverUpscale <= MAX_NORMALIZE_UPSCALE };
}

/**
 * The ffmpeg filter graph baking the plan: each segment trimmed, cropped to
 * its window, scaled to the canvas, and the pieces concatenated back into one
 * continuous stream. The segment boundaries partition the source exactly, so
 * the output timeline equals the input's and the untouched audio stays in
 * sync.
 */
export function normalizationFilterGraph(plan: NormalizePlan): string {
  const parts = plan.segments.map((s, i) => {
    const w = s.window;
    return (
      `[0:v]trim=start=${s.startSec.toFixed(3)}:end=${s.endSec.toFixed(3)},` +
      `setpts=PTS-STARTPTS,crop=${w.w}:${w.h}:${w.x}:${w.y},` +
      `scale=${plan.canvas.width}:${plan.canvas.height}[v${i}]`
    );
  });
  const inputs = plan.segments.map((_, i) => `[v${i}]`).join("");
  return `${parts.join(";")};${inputs}concat=n=${plan.segments.length}:v=1:a=0[v]`;
}

/**
 * Bake the normalized source. Encoded with the mezzanine's own settings
 * (dense keyframes) because it REPLACES the mezzanine — normalizing and then
 * re-encoding for seekability would be two generations of loss for nothing.
 */
export async function bakeNormalizedSource(
  tools: { ffmpegPath: string },
  input: string,
  plan: NormalizePlan,
  outPath: string,
): Promise<void> {
  await run(tools.ffmpegPath, [
    "-y", "-i", input,
    "-filter_complex", normalizationFilterGraph(plan),
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    outPath,
  ]);
}
