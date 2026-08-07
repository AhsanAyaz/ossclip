/**
 * Whether a render-props `captionsHidden` field unmounts the caption track.
 * The mirror of `showWatermark` (watermark-layout.ts) with the polarity
 * flipped by the feature's default: captions are ON unless something said
 * off, so only a literal `true` hides — every pre-feature render-props.json
 * has no field at all (undefined → visible, old workdirs render unchanged),
 * and a hand-edited `"captionsHidden": "yes"` must fall back to VISIBLE,
 * the default, rather than coerce the track away — values from outside are
 * parsed, never coerced (CLAUDE.md).
 *
 * Pure and separate from ProductionComposition so the mount decision is
 * testable without React or Remotion in the loop (house rule), exactly how
 * the watermark's own gate is tested.
 */
export function showCaptions(captionsHidden: unknown): boolean {
  return captionsHidden !== true;
}
