import type { SfxMarker } from "./sfxLane";

/**
 * The SFX preview's SCHEDULER (Phase 4 follow-up, 2026-08-29): given where the
 * playhead was and where it is now, which sounds should be heard.
 *
 * Pure — no `Audio`, no player, no timers — the `openCommand`/`openInBrowser`
 * split applied to a stream of playhead samples: Timeline's `useSfxPreview`
 * owns the elements and the events, and everything that decides WHETHER a
 * sound fires lives here, where it can be tested without a TTY or a codec (the
 * e2e's headless Chromium ships no H.264, so the player's own clock is not
 * available to lean on).
 *
 * The lane's diamonds are the input (`sfxLaneMarkers`), NOT render-props'
 * `sfxCues` — same argument sfxLane.ts's header makes, one clock further on: a
 * placement dragged, muted or added this session has no cue yet, and the whole
 * point of previewing is to hear the edit before the render exists.
 */

/**
 * What the scheduler needs of a marker — the lane's own type, narrowed, so an
 * `SfxMarker[]` passes straight in while this module stays independent of the
 * merge that produced it.
 */
export type SfxPlaybackMarker = Pick<SfxMarker, "key" | "atSec" | "soundId" | "gain" | "muted">;

/**
 * A forward jump larger than this is a SEEK, not playback, and fires nothing.
 *
 * Without it, dropping the playhead from 0:02 to 4:00 would machine-gun every
 * placement in between — the whole track at once, which is neither what the
 * render sounds like nor anything a user could review. 0.75s is comfortably
 * above the largest honest gap between two `frameupdate` samples (a dropped
 * frame or two at 30fps, plus a slow re-render) and far below any deliberate
 * scrub worth calling a seek.
 */
export const SFX_SEEK_JUMP_SEC = 0.75;

/**
 * The placements crossed since the last sample.
 *
 * HALF-OPEN, `(prevSec, curSec]`: a marker exactly at `curSec` fires now, and
 * the same marker at the NEXT sample's `prevSec` does not fire again — the one
 * rule that keeps a sound from double-triggering on the frame boundary it sits
 * on. `curSec <= prevSec` yields nothing at all, which covers both a paused
 * player (the Player re-emits `frameupdate` on scrubs and re-renders) and a
 * backwards scrub: rewinding past a sound is not hearing it.
 *
 * Muted placements are skipped rather than played silently — a mute is
 * "restorable, not happening" (the lane's hollow diamond), and the render drops
 * the cue outright.
 */
export function sfxToFire(
  prevSec: number,
  curSec: number,
  markers: readonly SfxPlaybackMarker[],
): SfxPlaybackMarker[] {
  if (!(curSec > prevSec)) return [];
  if (curSec - prevSec > SFX_SEEK_JUMP_SEC) return [];
  // The lane is already in time order (`sfxLaneMarkers` sorts it), so the
  // filtered run is too — multiple markers inside one tick come out in the
  // order they will be heard.
  return markers.filter((m) => !m.muted && m.atSec > prevSec && m.atSec <= curSec);
}

/**
 * The `volume` for one preview fire.
 *
 * CLAMPED TO 1 because that is all an `HTMLAudioElement` has: the doc allows a
 * gain up to 2 (`SfxPlacementEditSchema`/`SfxAddedPlacementSchema`, both
 * `min(0).max(2)`, multiplied by the library sound's own at resolve time) and
 * the render honours it, so a boosted placement previews quieter here than
 * it will sound in the export. That is a preview-fidelity limit of the element,
 * not a bug to file — the alternative (a WebAudio graph with a GainNode) buys
 * one stop of headroom for a whole second audio stack in the editor.
 *
 * A non-finite gain (a hand-edited overrides.json that got past nothing,
 * `NaN` from a division) falls back to 1 rather than leaving `volume`
 * untouched — assigning NaN to `volume` throws in some engines, and the
 * scheduler must never cost the playback it is decorating.
 */
export function previewVolume(gain: number): number {
  if (!Number.isFinite(gain)) return 1;
  return Math.min(1, Math.max(0, gain));
}

/**
 * The distinct sounds this lane can still fire, in first-appearance order.
 *
 * What to preload: one element per SOUND, not per marker — a `ding` placed
 * eight times is one file. Muted placements are excluded for the same reason
 * `sfxToFire` skips them (nothing to hear), and un-muting one re-derives the
 * lane, which re-runs the preload with the sound now in the list.
 */
export function sfxPreloadIds(markers: readonly SfxPlaybackMarker[]): string[] {
  const ids: string[] = [];
  for (const m of markers) {
    if (m.muted) continue;
    if (!ids.includes(m.soundId)) ids.push(m.soundId);
  }
  return ids;
}
