import { z } from "zod/v4";
import { ThemeSchema, type SceneCue, type Theme } from "./scene-schema";

/**
 * The user's edit layer (SPEC: direct manipulation).
 *
 * Kept in its OWN file, never in production.json: that document is derived and
 * every `produce` run overwrites it, so a user layer stored there would
 * evaporate on the next run. Separation is what lets the producer re-roll
 * `props` while hand edits survive — the merge rule from BRAINSTORM §4.6.
 */

export const ElementTransformSchema = z.object({
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().positive().optional(),
});
export type ElementTransform = z.infer<typeof ElementTransformSchema>;

export const SceneOverrideSchema = z.object({
  /** Merged over the producer's props, key by key. */
  props: z.record(z.string(), z.unknown()).default({}),
  /** Per-element nudges, keyed by the component's `data-edit-id`. */
  elements: z.record(z.string(), ElementTransformSchema).default({}),
  /**
   * Absolute output time. Setting this PINS the scene: it stops tracking the
   * words it was anchored to, which is why the UI has to say so out loud.
   */
  timing: z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }).optional(),
});
export type SceneOverride = z.infer<typeof SceneOverrideSchema>;

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
});
export type OverrideDoc = z.infer<typeof OverrideDocSchema>;

export const emptyOverrideDoc = (): OverrideDoc => OverrideDocSchema.parse({});

export interface AppliedOverrides {
  cues: SceneCue[];
  /** Scene ids the document mentions that the current plan no longer has. */
  orphans: string[];
}

/**
 * Merge the user's layer onto assembled cues.
 *
 * Orphans are REPORTED rather than dropped quietly: after a re-plan, edits
 * pointing at scenes that no longer exist are the user's lost work, and
 * silence would make it look like the editor forgot them.
 */
export function applyOverrides(cues: readonly SceneCue[], doc: OverrideDoc): AppliedOverrides {
  const ids = new Set(cues.map((c) => c.id));
  const orphans = Object.keys(doc.scenes).filter((id) => !ids.has(id));
  const out = cues.map((cue) => {
    const o = doc.scenes[cue.id];
    if (!o) return cue;
    return {
      ...cue,
      props: { ...cue.props, ...o.props },
      ...(Object.keys(o.elements).length > 0 ? { elements: o.elements } : {}),
      ...(o.timing ? { startSec: o.timing.startSec, endSec: o.timing.endSec, pinned: true } : {}),
    };
  });
  return { cues: out, orphans };
}

/** Theme tokens the user set, over whatever the production already had. */
export function resolveTheme(base: Theme, doc: OverrideDoc): Theme {
  return ThemeSchema.parse({ ...base, ...doc.theme });
}

export function setElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
  patch: ElementTransform,
): OverrideDoc {
  const scene = doc.scenes[sceneId] ?? SceneOverrideSchema.parse({});
  return {
    ...doc,
    scenes: {
      ...doc.scenes,
      [sceneId]: {
        ...scene,
        elements: { ...scene.elements, [elementId]: { ...scene.elements[elementId], ...patch } },
      },
    },
  };
}

/** Reset: DELETE the entry, so "reset" stays distinct from "nudged to 0,0". */
export function clearElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene) return doc;
  const { [elementId]: _removed, ...rest } = scene.elements;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: { ...scene, elements: rest } } };
}

/**
 * Un-pin: DELETE the `timing` override so the scene goes back to tracking its
 * word anchors. Distinct from setting a timing that happens to match the
 * derived one — this removes the override entirely.
 */
export function clearTiming(doc: OverrideDoc, sceneId: string): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene || !scene.timing) return doc;
  const { timing: _removed, ...rest } = scene;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: rest } };
}

/** Same floor `assembleScenes` enforces — a pinned scene re-clamped past this
 * would be as unrenderable as one the assembler produced. */
const MIN_PINNED_SCENE_SEC = 1.2;
const PINNED_GAP_SEC = 0.05;

export interface ReclampResult {
  cues: SceneCue[];
  /** Ids whose pinned timing had to move to stop overlapping a neighbour. */
  adjusted: string[];
}

/**
 * Re-clamp every PINNED cue's absolute timing against its current neighbours
 * in the array, in order.
 *
 * A pin freezes a scene's timing at whatever the neighbours' timing was the
 * moment it was set — but a re-plan (a `--cleanup` level change, a re-run
 * after new source material) can move those neighbours, leaving the pinned
 * cue's frozen window overlapping one of them or the whole array out of
 * time order. That reaches `SceneLayer` and `buildCaptionLines`'
 * `breakpoints`, both of which assume non-overlapping, increasing windows.
 * The editor already clamps a pinned nudge against its neighbours at DRAG
 * time (`apps/editor/src/timing.ts`'s `clampTiming`) — this is the same
 * clamp, re-run here because a re-plan can invalidate a clamp that was
 * correct when it was made without the user touching anything.
 */
export function reclampPinnedTiming(cues: readonly SceneCue[]): ReclampResult {
  const out = cues.map((c) => ({ ...c }));
  const adjusted: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!;
    if (!cue.pinned) continue;
    const prev = out[i - 1];
    const next = out[i + 1];
    const lo = prev ? prev.endSec + PINNED_GAP_SEC : 0;
    const hi = next ? next.startSec - PINNED_GAP_SEC : Number.POSITIVE_INFINITY;
    let s = Math.min(Math.max(cue.startSec, lo), Math.max(lo, hi - MIN_PINNED_SCENE_SEC));
    let e = Math.max(Math.min(cue.endSec, hi), s + MIN_PINNED_SCENE_SEC);
    if (e > hi) {
      e = hi;
      s = Math.max(lo, e - MIN_PINNED_SCENE_SEC);
    }
    if (s !== cue.startSec || e !== cue.endSec) {
      out[i] = { ...cue, startSec: s, endSec: e };
      adjusted.push(cue.id);
    }
  }
  return { cues: out, adjusted };
}
