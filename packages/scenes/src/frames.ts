/**
 * Output seconds → a `<Sequence>` frame window.
 *
 * The invariant: **the end frame comes from the end TIME**, never from a
 * rounded duration. `Math.round(start · fps) + Math.round((end - start) · fps)`
 * is not `Math.round(end · fps)` — the two roundings are independent, so a
 * window whose start rounds down and whose duration rounds up reaches one
 * frame past where it should, and lands on top of the next window's first
 * frame (FINDINGS §115).
 *
 * That off-by-one is invisible in the timings — the seconds never overlap —
 * and shows up only in the render, as one frame with two things on it. Every
 * adjacent-`<Sequence>` track wants this: captions (two lines at once, and at
 * two different anchors when the pair straddles a cue boundary), scene cues
 * (two graphics at once), and the EDL (two video spans, plus a fade ramp
 * measured against the wrong length).
 *
 * Sub-frame windows still get one frame — a zero-length `<Sequence>` renders
 * nothing, and a caption that vanishes entirely is worse than one that
 * briefly shares a frame.
 */
export function frameWindow(
  startSec: number,
  endSec: number,
  fps: number,
): { from: number; durationInFrames: number } {
  const from = Math.round(startSec * fps);
  const to = Math.round(endSec * fps);
  return { from, durationInFrames: Math.max(1, to - from) };
}
