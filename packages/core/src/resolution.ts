import { z } from "zod/v4";

/**
 * How big the output actually renders (2026-08-27).
 *
 * ossclip rendered 1080×1920 unconditionally, and three separate stages
 * enforced it: the folder-concat target, the mezzanine's scale filter, and
 * the render. A 4K take therefore lost three quarters of its pixels before
 * anything looked at it — invisible on LinkedIn/Instagram/TikTok, which cap
 * at 1080p anyway, but real on YouTube, which keeps 4K and gives it a better
 * codec tier.
 *
 * This is the ONE place that decides the size, so those three stages cannot
 * disagree. It returns a SCALE FACTOR, not a stage to build from: the
 * composition must stay 1080-wide because `captionFontSizeFor` (scenes/
 * stage.ts) answers in ABSOLUTE px — 64 portrait, 44 landscape — so a
 * composition built at 2160 would draw captions a quarter of their intended
 * size. Remotion's own `scale` renders that same composition larger, fonts
 * and strokes included.
 */

/** `--resolution`: an explicit short-edge height, or `auto` from the source. */
export const RESOLUTION_CHOICES = ["auto", "1080", "1440", "2160"] as const;

export type ResolutionChoice = (typeof RESOLUTION_CHOICES)[number];

/** The gate every user-supplied resolution passes through — flag AND config,
 * so a hand-edited `"resolution": "4k"` earns the same refusal as a typo'd
 * flag rather than a silent fallback (CLAUDE.md: parse, never coerce). */
export const ResolutionChoiceSchema = z.enum(RESOLUTION_CHOICES);

/**
 * The ceiling `auto` will not cross, as a short-edge height. An 8K source
 * answers 2160 rather than 4320: h264 at 8K is not universally playable, and
 * the render cost grows with the pixel count.
 */
export const MAX_AUTO_HEIGHT = 2160;

/** The base short edge both frames share — the unit every choice divides by. */
const BASE_SHORT_EDGE = 1080;

/**
 * `auto` snaps DOWN to a half step (1, 1.5, 2). Two reasons, both hard:
 * h264 needs EVEN dimensions, and 1080/1920 times a half step is always even
 * while an arbitrary factor is not (1.125 → 1215, odd); and rounding odd
 * dimensions to even would drift the frame off 9:16, which the platforms
 * letterbox. Snapping down rather than up keeps the promise that auto never
 * invents detail the source does not have.
 */
const AUTO_STEP = 0.5;

export interface OutputFrame {
  /** What Remotion renders the 1080-wide composition at. */
  scale: number;
  /** The resulting file's dimensions — what `production.json` records. */
  width: number;
  height: number;
}

/**
 * The clip a FOLDER input can honestly be sized by: the smallest.
 *
 * A folder concat letterboxes every take into one frame (`buildConcatFilter`),
 * so the frame carries only what the weakest clip has — sizing by the largest
 * would upscale every other take and charge render time for invented pixels.
 * Clips that failed to probe are ignored rather than counted as zero, and a
 * listing with nothing usable answers `null` so the caller falls back to its
 * default instead of sizing a render off a guess.
 */
export function smallestSource(
  sizes: ReadonlyArray<{ width: number; height: number }>,
): { width: number; height: number } | null {
  const usable = sizes.filter((s) => s.width > 0 && s.height > 0);
  if (usable.length === 0) return null;
  return usable.reduce((min, s) => (s.width * s.height < min.width * min.height ? s : min));
}

export function resolveOutputFrame(args: {
  frame: { width: number; height: number };
  /** The source's DISPLAY dimensions (rotation already applied by the probe). */
  source: { width: number; height: number };
  resolution: ResolutionChoice;
}): OutputFrame {
  const { frame, source, resolution } = args;
  const at = (scale: number): OutputFrame => ({
    scale,
    width: Math.round(frame.width * scale),
    height: Math.round(frame.height * scale),
  });
  if (resolution !== "auto") {
    return at(Number(resolution) / BASE_SHORT_EDGE);
  }
  // A probe that answered nothing cannot size anything: today's 1080p is the
  // honest fallback, never a throw in the middle of a render.
  if (!(source.width > 0) || !(source.height > 0)) return at(1);

  // The pixels that SURVIVE the crop, not the ones the file advertises. The
  // source is fitted to the output's aspect and the overflow is cropped
  // (produce's own `force_original_aspect_ratio=increase,crop=`), so the
  // usable width is whichever edge binds.
  const frameAspect = frame.width / frame.height;
  const sourceAspect = source.width / source.height;
  const usableWidth =
    sourceAspect > frameAspect
      ? source.height * frameAspect // wider than the frame: sides are cropped
      : source.width; //               taller than the frame: top/bottom cropped

  const raw = usableWidth / frame.width;
  const snapped = Math.floor(raw / AUTO_STEP) * AUTO_STEP;
  const capped = Math.min(snapped, MAX_AUTO_HEIGHT / BASE_SHORT_EDGE);
  // Never below today's output: a 720p source still renders 1080p, which is
  // what every caller already depends on.
  return at(Math.max(capped, 1));
}
