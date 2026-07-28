import { z } from "zod/v4";
import {
  LayoutSchema,
  SceneComponentIdSchema,
  ThemeSchema,
  type SceneCue,
  type SceneComponentId,
  type Theme,
} from "./scene-schema";
import { resolveSceneProps } from "./scene-registry";
import type { CaptionLine } from "./captions";

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
  /**
   * Component/layout swaps (design spec Scope: v1 in-scope). Optional — most
   * scenes never touch these — and validated against the same enums the
   * producer itself is constrained to, so an override can't name a component
   * or layout that doesn't exist in the registry.
   */
  component: SceneComponentIdSchema.optional(),
  layout: LayoutSchema.optional(),
  /**
   * How the VIDEO sits inside this scene's slot, when the automatic
   * face-aware crop gets it wrong.
   *
   * The motivating case: a `pip-bubble` fed a portrait canvas is cover-cropped
   * width-first, which puts the head at ~120% of the circle's diameter — and
   * that ratio is fixed no matter how large the bubble is, so no constant can
   * fix it. Zooming out inside a round mask would leave crescent gaps, so the
   * automatic path leaves it and this is the escape hatch: `scale` below 1
   * shows more of the source (the gap fills with the stage backdrop), `dy`
   * nudges the crop up or down.
   *
   * Deliberately per SCENE, not global: it is a property of one layout meeting
   * one moment's framing, which is exactly what the editor is for.
   */
  video: z
    .object({
      scale: z.number().positive().max(4).optional(),
      dy: z.number().optional(),
      dx: z.number().optional(),
    })
    .optional(),
});
export type SceneOverride = z.infer<typeof SceneOverrideSchema>;

/**
 * One retyped caption word (PLAN 2026-07-29 Task 7, scope (a) — decided with
 * the author: 1:1 in-place retype, timing untouched).
 *
 * Keyed by the word's position in the caption stream, GUARDED by the text
 * that was there when the edit was made — the same verification-anchor
 * pattern as `AppliedRepair.heard` (§17). Captions are derived (repaired
 * transcript through the TimeMap), so a changed cleanup level or repair set
 * can shift positions; the guard means a stale edit is DROPPED WITH A LOG
 * rather than silently landing on the wrong word.
 */
export const CaptionEditSchema = z.object({
  /** The replacement text. */
  text: z.string().min(1).max(80),
  /** The word this edit replaced — the stale-index guard. */
  was: z.string(),
});
export type CaptionEdit = z.infer<typeof CaptionEditSchema>;

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
  /** Retyped caption words, keyed by caption-stream word index. */
  captions: z.record(z.string(), CaptionEditSchema).default({}),
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
/**
 * Props for a scene whose COMPONENT the user just swapped.
 *
 * The producer's `cue.props` were written for the OLD component and are not
 * merged in here at all — they were shaped for a different schema (a
 * `StatCard`'s `value`/`label` mean nothing to a `FlowDiagram`) and passing
 * them through would either fail validation or silently satisfy it with
 * garbage. Falling back to the NEW component's `defaultProps` — same base
 * `resolveSceneProps` always starts from — renders something coherent
 * instead. `resolveSceneProps` returning null (an override value that fits
 * no schema at all) still can't drop the scene: the registry's own
 * `defaultProps` are the floor every component is built to satisfy on their
 * own, so that's the guaranteed-valid fallback.
 */
function resolveSwappedProps(
  component: SceneComponentId,
  propsOverride: Record<string, unknown>,
): Record<string, unknown> {
  return (
    resolveSceneProps(component, {}, propsOverride) ??
    // The override didn't fit the new schema at all — fall back to the
    // registry's OWN defaults with nothing layered on top, run back through
    // `resolveSceneProps` (rather than the raw `defaultProps` object) so
    // zod-defaulted fields (e.g. `emphasizeLast`) are filled in the same way
    // every other resolved cue's props are. `defaultProps` is guaranteed to
    // validate on its own — every component in the registry is built on that
    // invariant — so this can never itself return null.
    resolveSceneProps(component, {}, {})!
  );
}

export function applyOverrides(cues: readonly SceneCue[], doc: OverrideDoc): AppliedOverrides {
  const ids = new Set(cues.map((c) => c.id));
  const orphans = Object.keys(doc.scenes).filter((id) => !ids.has(id));
  const out = cues.map((cue) => {
    const o = doc.scenes[cue.id];
    if (!o) return cue;
    const swapped = o.component !== undefined && o.component !== cue.component;
    const component = o.component ?? cue.component;
    const props = swapped ? resolveSwappedProps(component, o.props) : { ...cue.props, ...o.props };
    return {
      ...cue,
      component,
      layout: o.layout ?? cue.layout,
      props,
      ...(Object.keys(o.elements).length > 0 ? { elements: o.elements } : {}),
      ...(o.video ? { video: o.video } : {}),
      ...(o.timing ? { startSec: o.timing.startSec, endSec: o.timing.endSec, pinned: true } : {}),
    };
  });
  return { cues: out, orphans };
}

export interface AppliedCaptionEdits {
  lines: CaptionLine[];
  /** Edits whose guard failed — the word at that index is not what they knew. */
  dropped: Array<{ index: number; expected: string; found: string }>;
}

/**
 * Apply retyped caption words. Text only, never timing — the stamps drive the
 * kinetic highlight and the 1:1 constraint is what keeps scene anchors and
 * §21's copy/caption agreement intact. An edit whose `was` no longer matches
 * is reported, not applied and not silently discarded.
 */
export function applyCaptionEdits(
  lines: readonly CaptionLine[],
  edits: Record<string, CaptionEdit>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (Object.keys(edits).length === 0) return { lines: [...lines], dropped };
  let index = 0;
  const out = lines.map((line) => ({
    ...line,
    words: line.words.map((w) => {
      const edit = edits[String(index++)];
      if (!edit) return w;
      if (w.text !== edit.was) {
        dropped.push({ index: index - 1, expected: edit.was, found: w.text });
        return w;
      }
      return { ...w, text: edit.text };
    }),
  }));
  return { lines: out, dropped };
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
