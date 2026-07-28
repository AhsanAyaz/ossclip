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

/**
 * Decide the canvas and each segment's crop window.
 *
 * `faces` is parallel to `timeline` — each face in ITS segment rect's own
 * fractions (`measureFaceInWindows`), which is what makes cross-segment
 * placement meaningful: the windows are positioned so the face sits at the
 * same relative height everywhere, so a framing boundary in the bake is a
 * non-event on screen.
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

  // The canvas is the TIGHTEST field of view in the take — those stretches
  // have nothing more to give, so everything else meets them there.
  const canvasRect = boxed.reduce((a, b) => (b.rect.h < a.rect.h ? b : a)).rect;
  const canvas = { width: even(canvasRect.w), height: even(canvasRect.h) };
  const aspect = canvas.width / canvas.height;

  // Where the face sits WITHIN the canvas-framed stretches — the target every
  // other segment's window reproduces. Duration-weighted so a 2s stretch
  // cannot outvote a 20s one; 0.5/0.45 (centre, face slightly high) when the
  // detector found nothing to measure.
  let wx = 0;
  let wy = 0;
  let weight = 0;
  timeline.forEach((seg, i) => {
    const f = faces[i];
    if (!f || seg.rect.h > canvasRect.h + 2) return;
    const dur = seg.endSec - seg.startSec;
    wx += f.centerXFrac * dur;
    wy += f.centerYFrac * dur;
    weight += dur;
  });
  const targetX = weight > 0 ? wx / weight : 0.5;
  const targetY = weight > 0 ? wy / weight : 0.45;

  const segments: NormalizeSegment[] = timeline.map((seg, i) => {
    const r = seg.rect;
    // The largest canvas-shaped window that fits inside this segment's rect.
    const wW = even(Math.min(r.w, r.h * aspect));
    const wH = even(wW / aspect);
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
    aspect > output.width / output.height
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
