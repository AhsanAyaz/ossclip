/**
 * The `--sfx` sound track's props and frame math (core's `resolveSfxCues`
 * owns the word→output-time half and the gain product).
 *
 * Pure and JSX-free, `cover-in-video.ts`'s posture: the props gate, the frame
 * rounding and the volume clamp are the whole behavior, and this package
 * carries no jsdom — none of it would be assertable inside the component.
 */

/** One effect: a staged file, an OUTPUT-time instant, a mix level. */
export interface SfxCueProps {
  /** File under the render's public dir — `sfx/<id>.<ext>` (or a `/media/…` URL). */
  soundFile: string;
  atSec: number;
  gain: number;
  /**
   * The sound's own length, when the pack declared one. Present so the
   * renderer can BOUND the cue's Sequence — see `SFX_FALLBACK_DURATION_SEC`
   * for why an unbounded one took the editor's preview down (2026-09-18).
   */
  durationSec?: number;
}

/**
 * How long a cue's Sequence lasts when the pack declared no `durationSec`.
 *
 * There has to be a bound. An unbounded Sequence keeps its `<Audio>` MOUNTED
 * for the rest of the composition, so the mounted-audio count only ever grew
 * with the playhead — and the editor's `<Player>` mounts its audio through a
 * fixed pool of shared tags. The sixth cue of this project's thirteen threw
 * "Tried to simultaneously mount 6 <Html5Audio /> tags", Remotion's error
 * boundary replaced the whole stage with a warning triangle, and NOTHING
 * played again — not even the takes before the cue — until a reload (field
 * report 2026-09-18, ".ossclip/CAA ship karachi After"). The render never saw
 * it: an ffmpeg render mounts no shared tags.
 *
 * Generous on purpose: longer than any sound in the bundled packs, so a cue
 * with no declared length is bounded without being TRUNCATED. A sound that
 * really does run past it is cut off at ten seconds, which is the trade a
 * pack author fixes by declaring `durationSec`.
 */
export const SFX_FALLBACK_DURATION_SEC = 10;

/**
 * The loudest a cue may play. `HTMLMediaElement.volume` THROWS an
 * IndexSizeError above 1, so an un-clamped gain would take the editor's
 * preview down entirely — while the render, which mixes the samples itself,
 * would happily amplify. Preview and render must agree, so both get the clamp
 * and the ceiling is 1.
 */
export const SFX_MAX_VOLUME = 1;

/**
 * Whether a render-props `sfxCues` entry is a cue this renderer will mount —
 * `coverInVideoPropsFor`'s posture (parse, never coerce, CLAUDE.md):
 * render-props.json is user-visible and hand-editable, every pre-feature file
 * has no key at all, and a mangled entry must fall back to SILENCE rather than
 * mount an `undefined` src or a NaN-frame Sequence over the take.
 *
 * Per ENTRY, not all-or-nothing: one bad cue costs that cue, the drop-bad-item
 * rule the whole SFX path is built on.
 */
export function sfxCuesFor(value: unknown): SfxCueProps[] {
  if (!Array.isArray(value)) return [];
  const cues: SfxCueProps[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const v = entry as {
      soundFile?: unknown;
      atSec?: unknown;
      gain?: unknown;
      durationSec?: unknown;
    };
    if (typeof v.soundFile !== "string" || v.soundFile.length === 0) continue;
    if (typeof v.atSec !== "number" || !Number.isFinite(v.atSec) || v.atSec < 0) continue;
    // An absent gain is 1 (play it as recorded); a mangled one is refused
    // rather than defaulted, because a wrong LEVEL is audible and silent
    // about being wrong.
    if (v.gain !== undefined && (typeof v.gain !== "number" || !Number.isFinite(v.gain))) continue;
    // A mangled length is DROPPED, not the cue: the sound still has a fallback
    // bound to fall back on, and silencing a whoosh over a number nobody hears
    // would be a worse trade than the rest of this parser's drops.
    const durationSec =
      typeof v.durationSec === "number" && Number.isFinite(v.durationSec) && v.durationSec > 0
        ? v.durationSec
        : undefined;
    cues.push({
      soundFile: v.soundFile,
      atSec: v.atSec,
      gain: Math.min(SFX_MAX_VOLUME, Math.max(0, v.gain ?? 1)),
      ...(durationSec === undefined ? {} : { durationSec }),
    });
  }
  return cues;
}

/**
 * The cues that actually have a frame to fire on, with that frame.
 *
 * `Math.round`, matching `frameWindow`'s start (FINDINGS §115) — an effect is
 * an instant, so there is no end time whose independent rounding could collide
 * with it. A cue at or past the composition's last frame is DROPPED rather
 * than clamped to it: a whoosh planned for a moment the render no longer
 * reaches must not pile onto the final frame with everything else that fell
 * off the end.
 *
 * `durationInFrames` per cue is the LENGTH the Sequence gets (2026-09-18): the
 * declared `durationSec`, or `SFX_FALLBACK_DURATION_SEC`, clamped so a cue
 * near the end never asks for frames the composition does not have — Remotion
 * truncates the tail anyway, and a Sequence that ends WITH the composition is
 * the same mounted-forever tag this bound exists to retire.
 */
export function visibleSfxCues(
  cues: readonly SfxCueProps[],
  fps: number,
  durationInFrames: number,
): Array<SfxCueProps & { from: number; durationInFrames: number }> {
  const out: Array<SfxCueProps & { from: number; durationInFrames: number }> = [];
  for (const cue of cues) {
    const from = Math.round(cue.atSec * fps);
    if (from < 0 || from >= durationInFrames) continue;
    const want = Math.ceil((cue.durationSec ?? SFX_FALLBACK_DURATION_SEC) * fps);
    out.push({ ...cue, from, durationInFrames: Math.max(1, Math.min(want, durationInFrames - from)) });
  }
  return out;
}
