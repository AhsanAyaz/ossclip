import { sfxPlacementKey, type OverrideDoc, type TimeMap, type Word } from "@ossclip/core/browser";

/**
 * The SFX lane's data layer (Phase 4, 2026-08-29): the plan the model wrote
 * plus the user's override layer, resolved to output instants the timeline can
 * draw.
 *
 * Pure — no fetch, no player, no DOM — so the merge rules below (which marker
 * exists, where it sits, which one is a ghost) are testable without a TTY, the
 * `openCommand`/`openInBrowser` split applied to a track of instants.
 *
 * TWO SOURCES, ONE LANE, and the pairing is load-bearing. The plan comes from
 * `production.json` via `/api/sfx/plan` and the edits from `overrides.json` —
 * NEVER from render-props' `sfxCues`. Cues are the LAST RENDER's resolved
 * output: a mute has no cue at all (there is nothing to draw a restorable ghost
 * from), an edit made this session has no cue yet, and a re-plan renumbers them
 * — while `sfxPlacementKey` is content-derived and survives exactly as long as
 * the placement it names. The lane therefore draws the plan ∩ overrides merge,
 * which is the same pairing `applySfxOverrides` renders from.
 */

/** One placement as `production.json` stores it (`ProductionSfxSchema`). */
export interface SfxPlanPlacement {
  soundId: string;
  /** Index into the REPAIRED transcript — the word space `/api/sfx/plan`'s
   * `words` are in, never `/api/transcript`'s raw one (that route's header
   * owns the argument). */
  word: number;
  /** The scene whose ENTRANCE this sound marks, when it has one — the marker
   * then sits at that scene's LIVE start rather than at its word
   * (`SfxPlacementSchema` owns the full argument). Absent on every plan
   * written before 2026-08-29, which is why nothing here may require it. */
  sceneId?: string;
  gain?: number;
  rationale?: string;
}

/** The `sfx` field of `production.json`, as the editor receives it. */
export interface SfxPlan {
  level: string;
  placements: SfxPlanPlacement[];
}

/** One sound in `/api/sfx/library`'s metadata list. */
export interface SfxLibrarySound {
  id: string;
  whenToUse: string;
  tags: string[];
  gain: number;
  durationSec?: number;
  packName: string;
}

/** A word that survived the cut, at the output instant it lands on. */
export interface SfxWordAnchor {
  /** Index into the repaired transcript — what a placement stores. */
  word: number;
  atSec: number;
}

/**
 * One diamond in the lane.
 *
 * `key` is the doc address the Inspector and the drag write through: a
 * `sfxPlacementKey` for a planned placement, the minted `id` for an added one.
 * The two namespaces cannot collide — an added id may not contain `@`
 * (`SfxAddedPlacementSchema`), and every planned key does.
 */
export interface SfxMarker {
  key: string;
  kind: "planned" | "added";
  /** LIVE values (the plan patched by the edit), which is what to display. */
  soundId: string;
  word: number;
  /** The per-placement gain multiplier; absent in both layers means 1, which
   * is exactly what `resolveSfxCues` multiplies by (`p.gain ?? 1`). */
  gain: number;
  /** A planned placement the user muted — drawn dimmed, restorable. Added
   * placements are never muted: deleting one splices it out of `added`. */
  muted: boolean;
  /** Output seconds, through the same clock the ruler draws. */
  atSec: number;
  /**
   * Set exactly when this marker is POSITIONED BY a scene: the link is live
   * and that scene is on the timeline, so `atSec` is its start rather than
   * the word's. Absent covers all three of the other cases — no link, a link
   * the user broke by dragging (`applySfxOverrides`' rule, mirrored below),
   * and a link whose scene is gone (which falls back to the word here exactly
   * as `resolveSfxCues` does). So a surface reading this can say "follows
   * scene-3" without having to re-check whether it really does.
   */
  sceneId?: string;
  /**
   * The PLAN's own values for this placement, absent on an added one. The
   * clear-override rule needs them: an edit that restates the plan is still an
   * override and would keep overriding after a re-plan changed the placement
   * underneath it (the `clearVideo`/`patchCaption` rule), so the writer
   * compares against these and drops the field instead.
   */
  planned?: { soundId: string; word: number; gain?: number };
}

/** Where the preview `<audio>` fetches a sound. The id is the library's own
 * (`SfxSoundSchema.id` is a slug), and the server resolves the FILE from its
 * loaded library — the client never names a path. */
export function sfxAudioUrl(soundId: string): string {
  return `/api/sfx/audio?id=${encodeURIComponent(soundId)}`;
}

/**
 * Every transcript word that is still in the output, at its output instant.
 *
 * The snap targets for a marker drag and the lookup behind "add a sound at the
 * playhead". A word the cut removed has no honest position, so it is simply
 * absent — `resolveSfxCues` drops a placement anchored to one for the same
 * reason (an effect on a cut word "would fire over speech that never motivated
 * it"), and a drag must not be able to drop a marker there either.
 */
export function sfxWordAnchors(
  words: readonly Word[],
  map: TimeMap | null,
): SfxWordAnchor[] {
  if (map === null) return [];
  const anchors: SfxWordAnchor[] = [];
  for (let i = 0; i < words.length; i++) {
    const mapped = map.mapWord(words[i]!);
    if (mapped === null) continue;
    anchors.push({ word: i, atSec: mapped.start });
  }
  return anchors;
}

/**
 * The word nearest an output instant, or null when there is none.
 *
 * Linear rather than a binary search on purpose: `anchors` is one entry per
 * transcript word (thousands at most) and this runs per pointer-move, which is
 * the same budget `snapTargets` already spends per drag frame.
 */
export function nearestSfxWord(anchors: readonly SfxWordAnchor[], sec: number): number | null {
  let best: SfxWordAnchor | null = null;
  let bestDist = Infinity;
  for (const a of anchors) {
    const dist = Math.abs(a.atSec - sec);
    // Strictly closer, so an exact tie keeps the EARLIER word — the
    // `applySnap` tie-break, restated so the outcome never depends on scan
    // order.
    if (dist < bestDist) {
      best = a;
      bestDist = dist;
    }
  }
  return best === null ? null : best.word;
}

/**
 * The lane: the model's plan with the user's layer applied, as markers.
 *
 * `applySfxOverrides`' semantics, minus the one thing the render does not
 * need — a muted placement stays here as a dimmed ghost, because the editor is
 * where it has to be restorable (the `SceneOverrideSchema.hidden` contract).
 * Level-gating is deliberately absent: an explicit user choice outranks the
 * model's gate (Phase 3 doctrine), so a `meme` sound swapped into a `subtle`
 * video draws exactly like any other.
 *
 * A marker whose word is CUT, or beyond the transcript, is dropped rather than
 * parked at zero: `resolveSfxCues` drops those placements too, so drawing one
 * would promise an effect the render will not play (the Timeline's own
 * no-spans rule — "skipping the seam entirely is safer than a parked,
 * misleading target").
 *
 * `sceneStarts` is the LIVE scene positions (`sceneStartSeconds` over the cue
 * list the player is drawing, so the user's in-session move or trim is
 * already in it): a placement with a `sceneId` draws at its scene's start, not
 * at its word, which is the whole point of the link — the diamond has to move
 * WITH the graphic, not after the next produce. Defaults to empty, and an
 * empty map behaves like every scene being gone: back to the word anchor,
 * the same fallback `resolveSfxCues` takes.
 */
export function sfxLaneMarkers(
  plan: SfxPlan | null,
  sfx: OverrideDoc["sfx"],
  anchors: readonly SfxWordAnchor[],
  sceneStarts: ReadonlyMap<string, number> = new Map(),
): SfxMarker[] {
  if (plan === null) return [];
  const atSec = new Map(anchors.map((a) => [a.word, a.atSec]));
  const markers: SfxMarker[] = [];
  const claimed = new Set<string>();
  for (const p of plan.placements) {
    const key = sfxPlacementKey(p);
    // The duplicate-key rule (`applySfxOverrides`): the edit belongs to the
    // FIRST placement answering to the key; a later twin draws as planned
    // rather than as a second copy of somebody else's edit.
    const edit = claimed.has(key) ? undefined : sfx?.edits[key];
    claimed.add(key);
    const word = edit?.word ?? p.word;
    // The scene link, mirrored from `applySfxOverrides` (that function's
    // comment owns the why): an explicit retime BREAKS it, so a dragged
    // marker stays where the user dropped it instead of snapping back to the
    // graphic. Mirrored rather than shared because the two sides answer
    // different questions — the render's is "where does this fire", the
    // lane's is "where do I draw it" — and they must agree, which is what the
    // paired tests pin.
    const sceneId = edit?.word !== undefined ? undefined : p.sceneId;
    const sceneAt = sceneId === undefined ? undefined : sceneStarts.get(sceneId);
    // A scene that is gone falls back to the word, `resolveSfxCues`' rule:
    // the word anchor is required precisely so nothing is orphaned by a
    // deleted graphic.
    const at = sceneAt ?? atSec.get(word);
    if (at === undefined) continue;
    markers.push({
      key,
      kind: "planned",
      soundId: edit?.soundId ?? p.soundId,
      word,
      gain: edit?.gain ?? p.gain ?? 1,
      muted: edit?.muted === true,
      atSec: at,
      // Only when the scene is what PUT it there (see the field's doc).
      ...(sceneAt !== undefined && sceneId !== undefined ? { sceneId } : {}),
      planned: {
        soundId: p.soundId,
        word: p.word,
        ...(p.gain !== undefined ? { gain: p.gain } : {}),
      },
    });
  }
  for (const add of sfx?.added ?? []) {
    const at = atSec.get(add.word);
    if (at === undefined) continue;
    markers.push({
      key: add.id,
      kind: "added",
      soundId: add.soundId,
      word: add.word,
      gain: add.gain ?? 1,
      muted: false,
      atSec: at,
    });
  }
  // Time order, stable — `applySfxOverrides` sorts the plan it hands the
  // resolver for the same reason: a retimed or added effect must read in the
  // order it will be heard, not in the order the model happened to write it.
  return markers
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.atSec - b.m.atSec || a.i - b.i)
    .map((e) => e.m);
}
