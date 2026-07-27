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
