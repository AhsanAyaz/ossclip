import { PORTRAIT_FRAME, safeAreaFor, type FrameSize } from "./stage";

/**
 * The opt-in "made with ossclip" wordmark. OPT-IN is the whole design: the
 * default stays off for everyone, because a forced watermark on an
 * open-source tool reads as a free-tier limitation — this exists so the
 * author (or anyone who wants to) can voluntarily credit the tool on videos
 * they post, nothing more.
 *
 * Pure placement math, separated from the component so both frames can be
 * asserted without React or Remotion in the loop (house rule: pure logic
 * apart from rendering).
 */

export const WATERMARK_TEXT = "made with ossclip";

/**
 * Low enough to read as a credit, not a caption — it must never compete with
 * the captions or the scene graphics for attention.
 */
export const WATERMARK_OPACITY = 0.45;

/**
 * Font size as a fraction of the frame's SHORT edge. Both output shapes share
 * a 1080px short edge, so the wordmark renders at the same physical size in
 * 9:16 and 16:9 instead of ballooning with the long edge.
 */
const WATERMARK_FONT_FRAC = 0.024;

export interface WatermarkLayout {
  xPx: number;
  yPx: number;
  fontPx: number;
  opacity: number;
  text: string;
}

/**
 * TOP-LEFT of the textual safe area, per shape: 9:16 platforms overlay their
 * own UI on the right edge (action rail) and the bottom (username/ticker),
 * and the caption track owns the lower third — top-left is the one corner
 * nothing else claims. `safeAreaFor` picks the portrait chrome insets or the
 * landscape title-safe margins by frame shape, the same decision rule the
 * stage itself uses, so the wordmark can never disagree with the layouts
 * about where "safe" is.
 */
export function watermarkLayout(frame: FrameSize = PORTRAIT_FRAME): WatermarkLayout {
  const a = safeAreaFor(frame);
  return {
    xPx: Math.round(a.left * frame.width),
    yPx: Math.round(a.top * frame.height),
    fontPx: Math.round(Math.min(frame.width, frame.height) * WATERMARK_FONT_FRAC),
    opacity: WATERMARK_OPACITY,
    text: WATERMARK_TEXT,
  };
}

/**
 * Whether a render-props `watermark` field turns the wordmark on. Strict
 * `=== true`, not truthiness: every pre-watermark `render-props.json` has no
 * field at all (undefined → off, so old workdirs render unchanged), and a
 * hand-edited `"watermark": "yes"` must not coerce a credit on — values from
 * outside are parsed, never coerced (CLAUDE.md).
 */
export function showWatermark(flag: unknown): flag is true {
  return flag === true;
}
