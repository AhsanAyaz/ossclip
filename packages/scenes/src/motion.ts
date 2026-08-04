/**
 * The layer's motion constants and the one curve every animated thing in the
 * render shares. One module rather than per-file literals so the entrance,
 * the exit, and the caption pop cannot drift onto different curves — the
 * design's "reads as designed" claim (R16 §69) depends on them agreeing.
 */

/** Seconds a graphic spends arriving. Mirrors EXIT_SEC — one number, both ends. */
export const ENTER_SEC = 0.3;

/** Seconds a graphic spends leaving. Matches LAYOUT_TRANSITION_SEC's order of
 * magnitude so the graphic departs WITH the video slot's morph — the reported
 * failure was the split view closing first and the card then blinking out. */
export const EXIT_SEC = 0.3;

/**
 * Seconds the caption's active word takes to reach its 1.08 emphasis. Four
 * frames at 30fps: the original CSS transition said 60ms, which is 1.8
 * frames — honouring it exactly would still read as a step.
 */
export const CAPTION_POP_SEC = 0.133;

/** The exit's existing ease — fast start, soft landing. */
export const easeOutQuad = (p: number): number => p * (2 - p);

/**
 * The entrance and exit seconds for a cue, shrunk proportionally when the cue
 * is too short to hold both. Resolved together rather than clamped
 * independently: two independent clamps can still sum past the duration, and
 * the failure that produces — entrance and exit overlapping, their opacities
 * multiplying into a dip halfway through a graphic's life — is invisible in
 * a still and obvious in motion.
 */
export function entranceExitSec(
  durationSec: number,
  enterSec: number = ENTER_SEC,
  exitSec: number = EXIT_SEC,
): { enterSec: number; exitSec: number } {
  if (durationSec <= 0) return { enterSec: 0, exitSec: 0 };
  const total = enterSec + exitSec;
  if (total <= durationSec) return { enterSec, exitSec };
  const k = durationSec / total;
  return { enterSec: enterSec * k, exitSec: exitSec * k };
}
