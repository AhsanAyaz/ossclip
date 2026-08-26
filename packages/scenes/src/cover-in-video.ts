import { frameWindow } from "./frames";

/**
 * The `--cover-in-video` overlay (core's cover-in-video.ts owns the WHY and
 * the window derivation): the cover image painted over the opening frames,
 * for the platforms that use frame 1 instead of an uploaded cover.
 *
 * Pure and JSX-free (house rule, `punch-plan.ts`'s posture): the gate, the
 * frame math and the fade are the whole behavior, and this package carries no
 * jsdom — none of it would be assertable if it lived inside the component.
 */

export interface CoverInVideoProps {
  /** Image file name inside the render's public dir (or an absolute http(s) URL). */
  fileName: string;
  /** How long the overlay lasts, in OUTPUT seconds from frame 0. */
  durationSec: number;
}

/**
 * How many frames the overlay spends fading out. Long enough that the cut to
 * video is a transition rather than a pop, short enough that it does not eat
 * a meaningful slice of a window whose cap is half a second.
 */
export const COVER_IN_VIDEO_FADE_FRAMES = 4;

/**
 * Whether a render-props `coverInVideo` field is an overlay this renderer
 * will mount — `punchPropsFor`'s posture (parse, never coerce, CLAUDE.md):
 * render-props.json is user-visible and hand-editable, every pre-feature file
 * has no key at all, and a mangled one must fall back to NO overlay rather
 * than mount an `undefined` src or a NaN-frame Sequence over the hook.
 */
export function coverInVideoPropsFor(value: unknown): CoverInVideoProps | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { fileName?: unknown; durationSec?: unknown };
  if (typeof v.fileName !== "string" || v.fileName.length === 0) return null;
  if (typeof v.durationSec !== "number" || !Number.isFinite(v.durationSec) || v.durationSec <= 0) {
    return null;
  }
  return { fileName: v.fileName, durationSec: v.durationSec };
}

/**
 * The overlay's `<Sequence>` window. Always from frame 0 — the whole point is
 * frame 1 — and the end comes from the end TIME through `frameWindow`
 * (FINDINGS §115), not from a rounded duration, so the overlay's last frame
 * and the first uncovered frame can never be the same one.
 */
export function coverInVideoFrames(
  durationSec: number,
  fps: number,
): { from: number; durationInFrames: number } {
  return frameWindow(0, durationSec, fps);
}

/**
 * Opacity at `frame` (SEQUENCE-relative, so 0 is the first covered frame) for
 * a window `durationInFrames` long: solid, then a linear ramp over the last
 * `COVER_IN_VIDEO_FADE_FRAMES`.
 *
 * The ramp is capped at the window's own length, so a sub-fade window (a 0.2s
 * floor at a low fps) fades across what it has instead of starting below 1 —
 * a cover that is never fully opaque looks like a rendering fault, not a
 * transition.
 */
export function coverInVideoOpacity(frame: number, durationInFrames: number): number {
  const fade = Math.min(COVER_IN_VIDEO_FADE_FRAMES, durationInFrames);
  const remaining = durationInFrames - frame;
  if (remaining >= fade) return 1;
  return Math.min(1, Math.max(0, remaining / fade));
}
