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
      /** `false` switches the automatic idle-zoom layer off for this scene. */
      autoZoom: z.boolean().optional(),
    })
    .optional(),
  /**
   * The pip bubble's mask roundness and placement (R14 §52) — mirrors
   * `SceneCueSchema.pip`, validated here because this is the hand-editable
   * layer. Per scene like `video`: it is one bubble meeting one moment's
   * staging. Ignored unless the scene's resolved layout is `pip-bubble`, so
   * it survives a layout round-trip instead of bending other layouts.
   */
  pip: z
    .object({
      cornerRadius: z.number().min(0).max(1).optional(),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /**
   * Vertical centre for this scene's captions (R15 §56). NOT part of the
   * top-level `captions` key — that one is the caption TEXT retype map,
   * keyed by word index; position is a property of the SCENE, where the
   * timeline selection can address it and "apply to all" can fan it out.
   */
  captionY: z.number().min(0).max(1).optional(),
  /** Caption size multiplier (R16 §64) — same per-scene, fan-out-able shape
   * as `captionY`, and the same reasoning for living on the scene. */
  captionScale: z.number().min(0.2).max(3).optional(),
  /**
   * The graphic slot, reshaped by hand (PLAN 2026-07-31 Task 2) — frame
   * fractions like every other rect. Validated HERE even though
   * `SceneCueSchema.graphicRect` is not: this one is hand-editable user
   * data, and §35's lesson is that validators are the constraint. The
   * renderer additionally clamps into the platform-safe area at draw time.
   */
  graphicRect: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0.08).max(1),
      h: z.number().min(0.05).max(1),
    })
    .optional(),
  /**
   * The scene is deleted — SOFTLY (PLAN 2026-07-30 Task C): the cue drops
   * from the render (`dropHiddenCues`) and its window becomes a plain take,
   * but the plan still has the scene and the timeline shows a restorable
   * ghost. Restore DELETES this key rather than writing `false`, matching
   * `clearVideo`/`clearTiming`: an explicit `hidden: false` would still be
   * an override with nothing to say.
   */
  hidden: z.boolean().optional(),
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

/**
 * The `was` a caption edit should store (R15 §59). The FIRST edit's `was` is
 * the base truth (the word as transcribed); every later re-edit of the same
 * index sees the LIVE (already-edited) text, and storing that as `was` would
 * make `applyCaptionEdits`' stale-guard drop the edit against the base lines.
 * Preserving the existing entry's `was` keeps the guard anchored to the base
 * — and makes "retyped back to the original" detectable, which is when the
 * override should clear entirely.
 */
export function captionEditWas(
  captions: Record<string, CaptionEdit>,
  index: number,
  seen: string,
): string {
  return captions[String(index)]?.was ?? seen;
}

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
  /** Retyped caption words, keyed by caption-stream word index. */
  captions: z.record(z.string(), CaptionEditSchema).default({}),
  /**
   * Scene split points in ABSOLUTE output seconds (R16 §61 — Cmd/Ctrl+B at
   * the playhead). Time-anchored rather than scene-anchored on purpose: a
   * re-plan can rename or move scenes, and a split is a decision about a
   * MOMENT of the output. Applied by `splitCues` after the plain fill, so a
   * split lands on graphic cues and takes alike.
   */
  splits: z.array(z.number().nonnegative()).default([]),
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

/**
 * The override entry a cue resolves against: its own, layered over its split
 * ROOT's (R16 §68). A split half is still the same scene — captions scaled
 * on the original must render scaled on both halves — so `id@ms` inherits
 * everything from `id`, with two exceptions that describe the WHOLE original
 * rather than a piece of it: `timing` (the root's absolute window would undo
 * the split) and `hidden` (deleting the original is not deleting one half).
 * The half's OWN entry wins key by key, and the record-shaped keys merge
 * field-wise so nudging one field on a half doesn't drop the rest of what it
 * inherited.
 */
function effectiveOverride(
  scenes: Record<string, SceneOverride>,
  id: string,
): SceneOverride | undefined {
  const own = scenes[id];
  const at = id.indexOf("@");
  if (at === -1) return own;
  const root = scenes[id.slice(0, at)];
  if (!root) return own;
  const { timing: _timing, hidden: _hidden, ...base } = root;
  if (!own) return { ...base, props: { ...base.props }, elements: { ...base.elements } };
  return {
    ...base,
    ...own,
    props: { ...base.props, ...own.props },
    elements: { ...base.elements, ...own.elements },
    ...(base.video || own.video ? { video: { ...base.video, ...own.video } } : {}),
    ...(base.pip || own.pip ? { pip: { ...base.pip, ...own.pip } } : {}),
  };
}

export function applyOverrides(cues: readonly SceneCue[], doc: OverrideDoc): AppliedOverrides {
  const ids = new Set(cues.map((c) => c.id));
  const orphans = Object.keys(doc.scenes).filter((id) => !ids.has(id));
  const out = cues.map((cue) => {
    const o = effectiveOverride(doc.scenes, cue.id);
    if (!o) return cue;
    const swapped = o.component !== undefined && o.component !== cue.component;
    const component = o.component ?? cue.component;
    const props =
      o.component !== undefined && swapped
        ? resolveSwappedProps(o.component, o.props)
        : { ...cue.props, ...o.props };
    // A rect `routeAroundSourceText` baked into the base cue was computed
    // FOR that cue's original layout — under a layout override it would
    // silently keep winning over the new layout's slot, parking the graphic
    // where the OLD layout needed it. Same reason the editor's `patchLayout`
    // drops the override rect on a swap. A hand-set `o.graphicRect` is the
    // user's own placement and still wins below.
    const layoutSwapped = o.layout !== undefined && o.layout !== cue.layout;
    const { graphicRect: _staleRouted, ...cueSansRoutedRect } = cue;
    return {
      ...(layoutSwapped ? cueSansRoutedRect : cue),
      component,
      layout: o.layout ?? cue.layout,
      props,
      ...(Object.keys(o.elements).length > 0 ? { elements: o.elements } : {}),
      ...(o.video ? { video: o.video } : {}),
      ...(o.pip ? { pip: o.pip } : {}),
      ...(o.captionY !== undefined ? { captionY: o.captionY } : {}),
      ...(o.captionScale !== undefined ? { captionScale: o.captionScale } : {}),
      // After ...cue, so a hand-set rect WINS over one routeAroundSourceText
      // baked into the base cues.
      ...(o.graphicRect ? { graphicRect: o.graphicRect } : {}),
      // Never onto an ALREADY-pinned cue (R16 §68): the second override pass
      // runs after `splitCues`, and re-applying a pinned scene's original
      // window to its first half — which kept the scene's id — would undo
      // the cut and overlap the second half. An unsplit pinned cue skips a
      // byte-identical re-application; a not-yet-pinned cue pins as before.
      ...(o.timing && !cue.pinned
        ? { startSec: o.timing.startSec, endSec: o.timing.endSec, pinned: true }
        : {}),
    };
  });
  return { cues: out, orphans };
}

/**
 * A split half shorter than this is a slip, not an edit — the split is
 * ignored rather than minting an unusably thin cue. Exported so the editor
 * can refuse the keystroke up front instead of silently no-opping.
 */
export const SPLIT_MIN_PIECE_SEC = 0.3;

/**
 * Cut cues at the stored split points (R16 §61).
 *
 * Both halves keep everything but their window; the half STARTING at the
 * split takes the id `${id}@${ms}` — named by its start time, so edits on it
 * stay attached while the split exists, survive further splits of the same
 * original cue, and are reported as orphans (never misapplied) if the split
 * is removed. Runs AFTER `fillPlainCues` so takes split like scenes do, and
 * BEFORE the final override pass so the halves' own edits (framing, timing,
 * elements) land on them. A split that misses every cue — after a re-plan
 * moved the material — is skipped; the time stays in the doc, harmless.
 * NOTE for graphic halves: the second half re-enters through its component's
 * intro animation (a Sequence restarts at its own frame 0) — acceptable for
 * the feature's real use, cutting takes and re-timing halves.
 */
export function splitCues(cues: readonly SceneCue[], times: readonly number[]): SceneCue[] {
  const out = [...cues];
  for (const t of [...times].sort((a, b) => a - b)) {
    const i = out.findIndex(
      (c) => t >= c.startSec + SPLIT_MIN_PIECE_SEC && t <= c.endSec - SPLIT_MIN_PIECE_SEC,
    );
    if (i === -1) continue;
    const cue = out[i]!;
    // Derive from the ROOT id, not the (possibly already-split) cue id:
    // `take-0@6000`, never `take-0@3000@6000` — so a half's id depends only
    // on the original cue and its own start time, and adding an EARLIER
    // split cannot rename later halves out from under their edits.
    out.splice(
      i,
      1,
      { ...cue, endSec: t },
      { ...cue, id: `${cue.id.split("@")[0]}@${Math.round(t * 1000)}`, startSec: t },
    );
  }
  return out;
}

export interface DropHiddenResult {
  cues: SceneCue[];
  /** Ids the edit layer hid, in cue order — for the console and the ghosts. */
  hidden: string[];
}

/**
 * Drop the cues the user deleted. A separate pass rather than a branch in
 * `applyOverrides`, deliberately: that function's 1:1 contract (every cue in
 * → every cue out) is load-bearing for its callers and much of its test
 * suite, and hiding is the one edit that breaks it. Runs immediately after
 * it, in `produce.ts` and the editor's live memo alike — BEFORE the plain
 * fill, so a deleted scene's window becomes an editable take on both sides.
 */
export function dropHiddenCues(cues: readonly SceneCue[], doc: OverrideDoc): DropHiddenResult {
  const hidden: string[] = [];
  const out = cues.filter((cue) => {
    if (doc.scenes[cue.id]?.hidden !== true) return true;
    hidden.push(cue.id);
    return false;
  });
  return { cues: out, hidden };
}

/**
 * Split at the stored split points BEFORE dropping hidden cues (PLAN
 * 2026-08-04 Task 1, bug 3).
 *
 * `dropHiddenCues` matches by the EXACT id the user deleted, and a split
 * root's `hidden` is meant to apply only to "the root's own post-split
 * segment (the half that still carries the bare id)" per `effectiveOverride`
 * above — but `produce.ts` and the editor's live memo both called
 * `dropHiddenCues` on the ROOT cues, before `splitCues` had run. That erased
 * the ENTIRE pre-split window (both halves at once); the plain fill then
 * covered it with one take, and the later `splitCues` call cut that PLAIN
 * take into two plain pieces — killing the graphic on the half the user
 * never asked to delete (field case: `scene-6` deleted, `scene-6@36400` died
 * with it). Splitting first means a hidden root id only ever matches the
 * post-split cue that kept the bare id, exactly the exception
 * `effectiveOverride` already promises. Safe to call again after the fill's
 * own `splitCues` pass — re-splitting at a boundary that already exists is a
 * no-op (the split point sits exactly on the joint, so neither piece's
 * window contains it).
 */
export function splitThenDropHidden(
  cues: readonly SceneCue[],
  doc: OverrideDoc,
): DropHiddenResult {
  return dropHiddenCues(splitCues(cues, doc.splits), doc);
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

/**
 * Reset the hand-set graphic box: DELETE the key so the cue falls back to
 * its layout slot (or the routed rect), distinct from a rect that happens
 * to equal the default.
 */
export function clearGraphicRect(doc: OverrideDoc, sceneId: string): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene || !scene.graphicRect) return doc;
  const { graphicRect: _removed, ...rest } = scene;
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

/** The scene a cue id belongs to, stripping a split half's `@ms` suffix —
 * same idiom `splitCues` itself uses to derive a later half's id from its
 * root. Two cues sharing a root are the SAME scene, cut in two. */
function splitRootId(id: string): string {
  const at = id.indexOf("@");
  return at === -1 ? id : id.slice(0, at);
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
    // Two adjacent pinned cues that are split halves of the SAME scene are
    // not independent neighbours (PLAN 2026-08-04 Task 1 follow-up, found in
    // review): `splitThenDropHidden` now runs `splitCues` before this
    // function, so a pinned+split scene reaches here as two entries, both
    // still `pinned: true`, with an EXACT boundary (`left.endSec ===
    // right.startSec`) that `splitCues` already cut. Applying the usual
    // `PINNED_GAP_SEC` buffer between them would carve a sliver out of the
    // seam that `fillPlainCues` then fills with a spurious plain take
    // spliced between the two halves — bug 3 again, one layer up, even
    // though the cue array itself looks correctly split.
    const prevIsSibling = prev?.pinned === true && splitRootId(prev.id) === splitRootId(cue.id);
    const nextIsSibling = next?.pinned === true && splitRootId(next.id) === splitRootId(cue.id);
    const lo = prev ? prev.endSec + (prevIsSibling ? 0 : PINNED_GAP_SEC) : 0;
    const hi = next
      ? next.startSec - (nextIsSibling ? 0 : PINNED_GAP_SEC)
      : Number.POSITIVE_INFINITY;
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
