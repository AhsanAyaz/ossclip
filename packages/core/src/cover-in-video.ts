/**
 * `--cover-in-video` (§93): the cover image OVERLAID on the short's opening
 * frames, for the platforms that ignore an uploaded cover and use frame 1.
 *
 * OVERLAY, never insertion. Inserting a still at the head would shift every
 * output instant after it — audio, spans, splits, pinned timing, caption
 * stamps — which is the §93 A/V-sync trap the roadmap item refused to rush.
 * Painting over frames that already exist changes no clock at all, so nothing
 * downstream has to be re-anchored and an off run stays byte-identical.
 *
 * The cost of the overlay is the mirror image: whatever it covers is LOST for
 * its duration, not delayed. That is what bounds the window below.
 */

/**
 * Longest the cover may sit on top of the video. Half a second is about the
 * shortest a still reads as a deliberate first frame in a feed scrub; more
 * than that and the overlay is eating the hook the whole pipeline exists to
 * put in the first two seconds.
 */
export const COVER_IN_VIDEO_CAP_SEC = 0.5;

/**
 * Shortest window worth rendering. A take whose first word lands at 0.04s
 * would otherwise get a one-or-two-frame flash that reads as a glitch rather
 * than a cover — and the floor deliberately eats the head of that first word,
 * because a cover nobody can see is not a cover.
 */
export const COVER_IN_VIDEO_FLOOR_SEC = 0.2;

/**
 * How long the cover overlay lasts, in OUTPUT seconds.
 *
 * It ends at the FIRST WORD's start: the moment speech begins is the moment
 * the overlay starts costing content, and the head of a take is usually a
 * breath or a settle nobody misses. Clamped into `[floorSec, capSec]` — see
 * the two constants for what each bound is protecting.
 *
 * `words` are OUTPUT-clock words (caption words, post-cut): the caller owns
 * the clock, this owns the arithmetic. No words at all — a `--no-produce` run,
 * a silent take, a transcript that came back empty — takes the cap, since
 * there is no speech for the overlay to be in the way of.
 *
 * Pure so the whole matrix is testable without a transcript on disk.
 */
export function coverInVideoWindow(
  words: readonly { start: number }[],
  opts: { capSec: number; floorSec: number },
): number {
  const first = words[0]?.start;
  // `Number.isFinite`, not a truthiness check: a first word at exactly 0 is a
  // real value (it floors below), while a NaN start from a mangled transcript
  // must fall back to the cap rather than propagate into a frame count.
  if (first === undefined || !Number.isFinite(first)) return opts.capSec;
  return Math.min(opts.capSec, Math.max(opts.floorSec, first));
}
