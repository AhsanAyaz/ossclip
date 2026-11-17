import { frameWindow } from "./frames";
import type { SceneCue } from "./scene-schema";

/**
 * A cue moved to start at frame 0 of its own clip (§162, Review Focus 1).
 * Browser-safe on purpose — the renderer's one-scene composition receives
 * the rebased cue, and this module imports only `./frames` and a type — so
 * it lives apart from `kit-plan.ts`, which hashes with `node:crypto`.
 *
 * The end is the scene's frame window in the full render
 * (`frameWindow(startSec, endSec, fps)`), so the clip is exactly as many
 * frames long as the scene was on screen, and §115's end-from-end rounding
 * is not re-derived from a rounded duration.
 *
 * The fields shifted are the ones that hold an ABSOLUTE output second:
 * `reveal.itemAtSec` (each item's word) and `entryAtSec` (the entry word).
 * They move by the old UNROUNDED `startSec`, not by `from / fps`, because
 * reveal.ts places an item at `(t − cueStartSec) · fps`; shifting both by
 * the same amount gives the same frame. Not clamped at 0: an item spoken
 * before the final start (floor, de-overlap, a drag) is legitimately
 * negative, and reveal.ts interpolates its unmatched neighbours from the
 * unclamped value — clamping here would move them. A rebased cue may
 * therefore fail `SceneCueSchema`'s nonnegative bounds; it is built, never
 * read back from a file, so it is not re-parsed.
 *
 * Everything else stays as it was: `kept` is SOURCE seconds, `anchor` is
 * word indices, `graphicRect`/`elements`/`video`/`pip` are geometry, and
 * `props` carries no output time (ClipScene's `durationSec` is a length).
 */
export function rebaseCue(cue: SceneCue, fps: number): SceneCue {
  const { durationInFrames } = frameWindow(cue.startSec, cue.endSec, fps);
  const shift = (t: number): number => t - cue.startSec;
  const out: SceneCue = { ...cue, startSec: 0, endSec: durationInFrames / fps };
  if (cue.reveal !== undefined) {
    out.reveal = { itemAtSec: cue.reveal.itemAtSec.map((t) => (t === null ? null : shift(t))) };
  }
  if (cue.entryAtSec !== undefined) out.entryAtSec = shift(cue.entryAtSec);
  return out;
}
