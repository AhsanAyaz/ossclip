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
}

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
    const v = entry as { soundFile?: unknown; atSec?: unknown; gain?: unknown };
    if (typeof v.soundFile !== "string" || v.soundFile.length === 0) continue;
    if (typeof v.atSec !== "number" || !Number.isFinite(v.atSec) || v.atSec < 0) continue;
    // An absent gain is 1 (play it as recorded); a mangled one is refused
    // rather than defaulted, because a wrong LEVEL is audible and silent
    // about being wrong.
    if (v.gain !== undefined && (typeof v.gain !== "number" || !Number.isFinite(v.gain))) continue;
    cues.push({
      soundFile: v.soundFile,
      atSec: v.atSec,
      gain: Math.min(SFX_MAX_VOLUME, Math.max(0, v.gain ?? 1)),
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
 */
export function visibleSfxCues(
  cues: readonly SfxCueProps[],
  fps: number,
  durationInFrames: number,
): Array<SfxCueProps & { from: number }> {
  const out: Array<SfxCueProps & { from: number }> = [];
  for (const cue of cues) {
    const from = Math.round(cue.atSec * fps);
    if (from < 0 || from >= durationInFrames) continue;
    out.push({ ...cue, from });
  }
  return out;
}
