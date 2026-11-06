import {
  applyOverlayOverrides,
  resolveOverlayCues,
  type OverlayCue,
  type OverlayEntrySnapshot,
  type OverlayPlacement,
  type OverrideDoc,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";
import { sfxAudioUrl, type SfxLibrarySound } from "./sfxLane";
import type { SfxPlaybackMarker } from "./sfxPlayback";

/**
 * The overlay lane's data layer (overlay-library spec §Editor): the matched
 * plan from `production.json` plus the user's `overrides.json.overlays`
 * layer, resolved to output instants the timeline can draw and the Player can
 * preview.
 *
 * Pure — no fetch, no player, no DOM — the `sfxLane.ts` split, so which chip
 * exists, where it sits and which one is a ghost are testable without a TTY.
 *
 * ONE RESOLVER. Chip positions come out of core's `resolveOverlayCues`, the
 * function produce renders with, never a second placement rule written here:
 * the cut-word fall-forward (a match moves to the next KEPT mention, a user
 * placement to the next kept word) is subtle enough that two copies would
 * disagree, and then the chip and the render would put the logo on different
 * words (the `resolveSfxCues` / `sceneStartSeconds` one-implementation rule).
 *
 * Like the sfx lane, this reads the PLAN + overrides, never render-props'
 * `overlayCues`: those are the last render's output, which has no cue for a
 * removed match (nothing to draw a restorable ghost from) and none for a chip
 * added this session.
 */

/** `/api/overlays/plan`'s `overlays` — `ProductionOverlaysSchema`'s shape. */
export interface OverlayPlan {
  entries: OverlayEntrySnapshot[];
  placements: OverlayPlacement[];
}

/** One chip in the lane. */
export interface OverlayMarker {
  /** The placement id — the doc address every action writes through. */
  id: string;
  /** Output seconds through the ruler's clock, AFTER any fall-forward. */
  atSec: number;
  endSec: number;
  entryId: string;
  /** The entry's display name (the chip's title and the Inspector's header). */
  name: string;
  look: "overlay" | "card";
  /** A removed MATCH, drawn dimmed and restorable — the sfx mute ghost. */
  removed: boolean;
  /** The placement's STORED word (pre-fall-forward), what a drag compares against. */
  word: number;
  /** `library/<id>.<ext>`, the staged copy (thumbnail via `overlayMediaUrl`). */
  file: string;
  /** In `overlays.added` (spliced on delete) rather than the matched plan (negated). */
  added: boolean;
  /** The stored duration, absent = the look's default (the Inspector's "default" readout). */
  durationSec?: number;
  /** True when the user moved/resized it (overlay-transform) — the
   * Inspector's "Reset position" is live only then. */
  placedByHand: boolean;
  /** The effective pop: the placement's, else the entry's, else `pop`; null = silent. */
  sound: string | null;
  /** What the entry alone would play (entry's, else `pop`) — where the
   * Inspector's sound toggle returns to when switched back on, so an entry
   * with its own sound is not flattened to `pop` by an off/on. */
  defaultSound: string;
}

/**
 * What the tray (Task 8) is being opened FOR: placing a new overlay at a
 * word, or swapping the image of an existing one. The editor's two entry
 * points (the "Add logo/image here…" menus, the Inspector's image button)
 * both speak this, so the tray has one contract.
 */
export type OverlayTrayRequest = { mode: "add"; word: number } | { mode: "swap"; id: string };

/**
 * The look's default duration — plan Global Constraints: overlay 1.5s, card
 * 2.0s. Restated from `resolveOverlayCues` (whose constants are private) for
 * the Inspector's "default (1.5s)" readout only; the resolver stays the one
 * that applies it, and the paired lane test pins that the two agree.
 */
export function overlayDefaultDurationSec(look: "overlay" | "card"): number {
  return look === "card" ? 2.0 : 1.5;
}

/** Spec §Placement schema: the sound when neither the placement nor the entry names one. */
const DEFAULT_SOUND = "pop";

/**
 * Where the browser fetches a staged file (`overlayStagedFile`'s
 * `library/<id>.<ext>`): the WORKDIR copy produce and
 * `/api/overlays/stage` write, served by `/media/` (Task 6 ruling: publicDir
 * IS the workdir). A leading `/` makes `staticFile()` pass it through
 * untouched (ProductionComposition's rule), so the same string works as the
 * chip thumbnail and as the Player's cue file.
 */
export function overlayMediaUrl(stagedFile: string): string {
  return `/media/${stagedFile}`;
}

/**
 * The lane: every live placement plus every removed MATCH (as a ghost), at
 * the output instant the resolver puts it, in time order.
 *
 * A removed placement is resolved with its `removed` flag stripped, so the
 * ghost sits exactly where a restore would put it back, with the user's other
 * edits (look, duration) still applied — `applyOverlayOverrides` itself drops
 * removed placements outright, which is right for the render and wrong for
 * the one surface where a removal has to be undoable.
 *
 * Whatever the resolver DROPS (cut word with no kept successor, word beyond
 * the transcript, unknown entry) is not drawn: the render will not show it,
 * and a chip parked at zero would promise otherwise (the sfx lane's rule).
 * No map (malformed spans, nothing rendered) is no lane content at all.
 */
export function overlayLaneMarkers(
  plan: OverlayPlan | null,
  layer: OverrideDoc["overlays"],
  words: readonly Word[],
  map: TimeMap | null,
): OverlayMarker[] {
  if (map === null) return [];
  const edits = layer?.edits ?? {};
  const removed = new Set(Object.keys(edits).filter((k) => edits[k]?.removed === true));
  const unremoved: OverrideDoc["overlays"] =
    layer === undefined
      ? undefined
      : {
          ...layer,
          edits: Object.fromEntries(
            Object.entries(edits).map(([k, e]) => {
              const { removed: _r, ...rest } = e;
              return [k, rest];
            }),
          ),
        };
  const applied = applyOverlayOverrides(plan ?? undefined, unremoved);
  const { cues } = resolveOverlayCues(applied, words, map, map.outputDuration);
  const byId = new Map<string, OverlayPlacement>();
  for (const p of applied.placements) if (!byId.has(p.id)) byId.set(p.id, p);
  const entries = new Map(applied.entries.map((e) => [e.id, e]));
  const addedIds = new Set((layer?.added ?? []).map((a) => a.id));
  const markers: OverlayMarker[] = [];
  for (const c of cues) {
    const p = byId.get(c.id);
    const entry = p === undefined ? undefined : entries.get(p.entryId);
    // The resolver only emits a cue for a placement whose entry it found, so
    // both lookups succeed; the guard keeps a type, not a case.
    if (p === undefined || entry === undefined) continue;
    markers.push({
      id: c.id,
      atSec: c.atSec,
      endSec: c.endSec,
      entryId: p.entryId,
      name: entry.name,
      look: c.look,
      // A match only: an added placement is spliced, never negated, so a
      // stray `removed` on its id (a hand edit) is not a ghost to restore.
      removed: removed.has(c.id) && !addedIds.has(c.id),
      word: p.word,
      file: c.file,
      added: addedIds.has(c.id),
      ...(p.durationSec !== undefined ? { durationSec: p.durationSec } : {}),
      placedByHand: p.rect !== undefined,
      // `!== undefined`, never `??`: null is an explicit silence at either
      // level, the resolver's own rule.
      sound: p.sound !== undefined ? p.sound : entry.sound !== undefined ? entry.sound : DEFAULT_SOUND,
      defaultSound: entry.sound ?? DEFAULT_SOUND,
    });
  }
  // A stray `removed` on an added id would otherwise draw an extra chip the
  // render does not have (`applyOverlayOverrides` drops it); dropping it here
  // keeps the lane and the render agreeing.
  return markers.filter((m) => !(m.added && edits[m.id]?.removed === true));
}

/**
 * The Player's live overlay layer and its pops, from the same plan + layer +
 * map the lane draws.
 *
 * `cues` are the resolver's, files re-pointed at `/media/` — render-props'
 * own `overlayCues` speak the render's public dir (`library/…` relative),
 * which 404s in the browser, and are the LAST render besides.
 *
 * `sounds` are the pops as `useSfxPreview` markers, NOT as Player `sfxCues`:
 * the composition's SfxTrack is deliberately off in the editor (App.tsx, the
 * 2026-09-18 five-audio-tags crash), and the lane's preview hook is the one
 * place a sound is heard. The lookup hands the resolver the SAME URL the sfx
 * preview fetches (`sfxAudioUrl`) and the library's own gain, so a pop
 * previews from the edit server's sound library exactly like a planned sfx.
 * A sound the library lacks is the resolver's "plays silent" — no marker.
 */
export function overlayPreview(
  plan: OverlayPlan | null,
  layer: OverrideDoc["overlays"],
  words: readonly Word[],
  map: TimeMap | null,
  sounds: readonly SfxLibrarySound[],
): { cues: OverlayCue[]; sounds: SfxPlaybackMarker[] } {
  if (map === null) return { cues: [], sounds: [] };
  const library = new Map(sounds.map((s) => [s.id, s]));
  // URL → id, so a resolved SfxCue (which carries only its file) maps back to
  // the id the preview pool is keyed by.
  const idOfUrl = new Map<string, string>();
  const resolved = resolveOverlayCues(applyOverlayOverrides(plan ?? undefined, layer), words, map, map.outputDuration, {
    soundFile: (soundId) => {
      const s = library.get(soundId);
      if (s === undefined) return undefined;
      const url = sfxAudioUrl(soundId);
      idOfUrl.set(url, soundId);
      return { soundFile: url, gain: s.gain, ...(s.durationSec === undefined ? {} : { durationSec: s.durationSec }) };
    },
  });
  return {
    cues: resolved.cues.map((c) => ({ ...c, file: overlayMediaUrl(c.file) })),
    sounds: resolved.soundCues.flatMap((c, i) => {
      const soundId = idOfUrl.get(c.soundFile);
      return soundId === undefined ? [] : [{ key: overlaySoundKey(c.overlayId ?? String(i)), atSec: c.atSec, soundId, gain: c.gain, muted: false }];
    }),
  };
}

/**
 * The preview pool's key for an overlay's pop. Keyed on the overlay's id, not
 * its position in the list, so App can silence the pop of a logo that has no
 * room to show (final review I3) without guessing which sound was whose.
 */
export function overlaySoundKey(overlayId: string): string {
  return `overlay:${overlayId}`;
}

/**
 * Where a click on an overlay chip parks the playhead (overlay-transform):
 * selecting an overlay you cannot see leaves nothing on the stage to move,
 * so the click also seeks INTO its window. A little past the start, so the
 * entrance pop has settled and the box the user grabs is the full-size one;
 * capped at the window's middle so a short overlay is never overshot.
 */
export function overlaySeekSec(m: { atSec: number; endSec: number }): number {
  return m.atSec + Math.min(0.4, Math.max(0, m.endSec - m.atSec) / 2);
}

