/**
 * ClipScene's audio level, pure so it is tested without Remotion (the
 * SfxTrack / sfx-track.ts split).
 *
 * The clip's own audio plays UNDER the voice at `gainDb`, and nothing is
 * ducked (spec 1.4): it is part of the clip, made with its sound, so it
 * neither waits on `--sfx` nor bends the speaker's level. Remotion's `volume`
 * is linear amplitude, hence the dB conversion; muted is 0 rather than a very
 * low gain so a muted clip is exactly silent in the render's mix.
 */
export function clipVolume(gainDb: number, muted: boolean): number {
  return muted ? 0 : 10 ** (gainDb / 20);
}
