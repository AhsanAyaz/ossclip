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
import type { CaptionLine, CaptionWord } from "./captions";

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
  /**
   * The element is deleted — SOFTLY (PLAN Task 2, one level down from
   * `SceneOverrideSchema.hidden` below): `editStyle`
   * (packages/scenes/src/editable.ts) suppresses it at the one chokepoint
   * every component's leaf renders its edit style through, so no
   * per-component change is needed and the remaining siblings close the
   * gap on their own — the same delete semantics a whole SCENE gets,
   * scoped to one of its elements. The backing array
   * (`props.messages`/`lines`/`nodes`/`items`) is never touched — ids are
   * positional, so hiding `message-1` can't renumber `message-2` out from
   * under its own edits.
   */
  hidden: z.boolean().optional(),
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
   * keyed per word; position is a property of the SCENE, where the timeline
   * selection can address it and "apply to all" can fan it out.
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
 * Keyed by the word's SOURCE time since §137 (`captionKeyFor` below — the
 * original positional key is what a user cut broke), GUARDED by the text that
 * was there when the edit was made — the same verification-anchor pattern as
 * `AppliedRepair.heard` (§17). Captions are derived (repaired transcript
 * through the TimeMap), so a changed cleanup level or repair set can still
 * re-word the stream under an anchor that survived; the guard means a stale
 * edit is DROPPED WITH A LOG rather than silently landing on the wrong word.
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
  key: string,
  seen: string,
): string {
  return captions[key]?.was ?? seen;
}

/**
 * The id a pre-§137 split gets when it is upgraded: its ORIGINAL output
 * milliseconds. Load-bearing for the migration — a saved doc hiding
 * `scene-0@600` must still match the half after the upgrade, and that only
 * holds if the derived id reproduces the old name exactly.
 */
export function legacySplitId(at: number): string {
  return String(Math.round(at * 1000));
}

export const SplitSchema = z.union([
  // `.finite()` is stated rather than assumed. JSON has no Infinity literal
  // but an overflowing one (`1e400`) parses to it, and a non-finite `at`
  // would derive `id: "Infinity"` — one shared name for every such split,
  // the same garbage-derived-key failure `captionKeyFor` refuses for caption
  // words. zod v4's `z.number()` already rejects non-finite where v3's did
  // not, so this is a requirement written down at the site instead of a
  // default that has already changed once underneath this file.
  z.object({ at: z.number().finite().nonnegative(), id: z.string().min(1) }),
  // Legacy: a bare number, upgraded in place so every overrides.json written
  // before §137 parses and keeps its split-half overrides attached.
  z.number().finite().nonnegative().transform((at) => ({ at, id: legacySplitId(at) })),
]);
export type Split = z.infer<typeof SplitSchema>;

/**
 * A split id that no split in `existing` already holds.
 *
 * Uniqueness is load-bearing (§137): the id is the ONLY thing tying an
 * override to a split half — `splitCues` names the half `${rootId}@${id}` and
 * `dropHiddenCues` filters on that exact string — so two splits sharing an id
 * mint two cues with one name, and deleting one half deletes both, as does
 * any framing or timing edit on it.
 *
 * Decoupling `id` from `at` is what made this reachable. While the id was
 * recomputed from the time, two ids could only collide if two splits sat
 * within 0.5ms of each other, which `SPLIT_MIN_PIECE_SEC` forbids. Now a
 * split minted at 1.2s and re-anchored to 0.6s by a re-cut still holds
 * `"1200"`, so ⌘B at 1.2s again asks for an id that is taken — and
 * `addSplit`'s dedupe cannot see it, because that compares `at` and 0.6 is
 * nowhere near 1.2.
 *
 * The suffix is a COUNTER, deliberately, not a nonce or a timestamp: this
 * value is persisted in the user's `overrides.json` and names a cue, so it
 * has to be reproducible from the doc alone.
 */
export function mintSplitId(at: number, existing: readonly Split[]): string {
  const base = legacySplitId(at);
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  // Starts at 2 so the first collision reads as "the second `1200`".
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  /**
   * Captions OFF for the whole video. Doc-global like `theme`, deliberately
   * NOT a per-scene key: visibility is one decision about the output —
   * `captionY`/`captionScale` (per scene, above) style captions, this one
   * removes the track. Optional with NO default so every overrides.json
   * written before the key existed parses byte-identically; absent means
   * visible, and the editor DELETES the key rather than writing `false`
   * (the clearVideo/restoreScene rule — an explicit false is still an
   * override with nothing to say). Produce ORs this with `--no-captions`
   * (`resolveCaptionsHidden`, apps/cli/src/produce.ts): either surface can
   * hide, neither can force captions back on over the other.
   */
  captionsHidden: z.boolean().optional(),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
  /** Retyped caption words, keyed by the word's source time (§137). */
  captions: z.record(z.string(), CaptionEditSchema).default({}),
  /**
   * Scene split points. `at` is ABSOLUTE output seconds (R16 §61 — Cmd/Ctrl+B
   * at the playhead) and moves when a re-cut re-anchors the doc; `id` is
   * minted once when the split is created and NEVER recomputed (§137). The
   * split half is named `${rootId}@${id}`, so re-anchoring `at` cannot rename
   * the half out from under a `hidden` (or any other) override on it — the
   * bug that resurrected a deleted scene in the field case.
   *
   * `at` stays time-anchored rather than scene-anchored on purpose: a re-plan
   * can rename or move scenes, and WHERE to cut is a decision about a MOMENT
   * of the output. Applied by `splitCues` after the plain fill, so a split
   * lands on graphic cues and takes alike.
   */
  splits: z.array(SplitSchema).default([]),
  /**
   * User cuts — ranges of the OUTPUT to remove, in the output seconds of the
   * CURRENT render-props (what the user saw when they cut) (PLAN 2026-08-04
   * Task 4). Optional-with-default like `splits` above, so an `overrides.json`
   * written before this field existed still parses unchanged. Consumed by
   * `produce.ts` (subtracted from the automatic cutlist's keep-spans) and by
   * `recut.ts`'s `remapOverridesThroughRecut`, which re-anchors every OTHER
   * absolute-output-seconds value in this doc through the resulting re-cut —
   * see that module's docstring for why a bare "shift everything after the
   * cut point" is not the actual rule.
   *
   * `src` (review fix wave, PLAN 2026-08-04 Task 4): a cut's `startSec`/
   * `endSec` alone are meaningless without knowing WHICH render-props they
   * were drawn against — a bare output-seconds pair has no faithful
   * representation once its own cut has happened (Task 4b's Bug A: remapping
   * it through the very recut it caused collapses it to a zero-width point).
   * `src` is the cut's resolved SOURCE-time range, computed once — the first
   * produce run that sees a `src`-less cut resolves it against the
   * render-props the user was looking at, and the write-back records it here
   * — and used directly, unconverted, on every run after that. `startSec`/
   * `endSec` are left exactly as the user drew them even once `src` exists:
   * a historical record of what render-props they were looking at, never
   * authoritative again once `src` is present.
   *
   * The editor (PLAN 2026-08-04 Task 4c) MUST NEVER WRITE OR
   * PRESERVE-AND-MODIFY `src` ITSELF — resolving it is produce's job alone.
   * Creating a cut writes ONLY `{startSec, endSec}`; if a cut's range is
   * ever edited/moved (not currently exposed, but the rule holds for any
   * future gesture that would), its `src` is DELETED rather than carried
   * forward, so the next produce re-resolves it against the render-props
   * current at that point rather than an anchor drawn for a range that no
   * longer means the same thing; Restore removes the WHOLE entry, `src`
   * included — there is no "not cut" state for one array entry to hold.
   */
  cuts: z
    .array(
      z.object({
        startSec: z.number().nonnegative(),
        endSec: z.number().nonnegative(),
        src: z
          .object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })
          .optional(),
      }),
    )
    .default([]),
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
 * on the original must render scaled on both halves — so `id@<split id>`
 * inherits everything from `id` (the suffix is the split's own minted id since
 * §137, not a time), with two exceptions that describe the WHOLE original
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
 * split takes the id `${rootId}@${split.id}` — named by the split's OWN
 * minted id (§137), so edits on it stay attached while the split exists,
 * survive further splits of the same original cue, and are reported as
 * orphans (never misapplied) if the split is removed. The id used to be
 * recomputed from the split's CURRENT start time, which meant a re-cut
 * re-anchoring `at` renamed the half and orphaned every override on it —
 * the field case where a deleted scene came back after a 0.6s cut.
 * Runs AFTER `fillPlainCues` so takes split like scenes do, and
 * BEFORE the final override pass so the halves' own edits (framing, timing,
 * elements) land on them. A split that misses every cue — after a re-plan
 * moved the material — is skipped; the time stays in the doc, harmless.
 * NOTE for graphic halves: the second half re-enters through its component's
 * intro animation (a Sequence restarts at its own frame 0) — acceptable for
 * the feature's real use, cutting takes and re-timing halves.
 */
export function splitCues(cues: readonly SceneCue[], splits: readonly Split[]): SceneCue[] {
  const out = [...cues];
  for (const s of [...splits].sort((a, b) => a.at - b.at)) {
    const i = out.findIndex(
      (c) => s.at >= c.startSec + SPLIT_MIN_PIECE_SEC && s.at <= c.endSec - SPLIT_MIN_PIECE_SEC,
    );
    if (i === -1) continue;
    const cue = out[i]!;
    // Derive from the ROOT id, not the (possibly already-split) cue id:
    // `take-0@6000`, never `take-0@3000@6000` — so a half's id depends only
    // on the original cue and the split that made it, and adding an EARLIER
    // split cannot rename later halves out from under their edits.
    out.splice(
      i,
      1,
      { ...cue, endSec: s.at },
      // The suffix comes from the SPLIT's own id, not from `s.at` — that is
      // the §137 fix.
      { ...cue, id: `${cue.id.split("@")[0]}@${s.id}`, startSec: s.at },
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

/**
 * A caption edit's key: the word's source start, quantised to milliseconds
 * (§137). Positional indices were the original design and a user cut breaks
 * them — removing one word shifts every later index, so the `was` guard below
 * fires on every edit and the user's retypes vanish into the report nobody
 * printed. Source time is the one property of a word that a re-cut cannot
 * move.
 *
 * THROWS on a non-finite `srcStart` rather than minting `wNaN`. The type
 * promises a number and `captions.ts:33-39` says outright that the promise is
 * a lie at the render-props boundary — the editor loads that file as an
 * unvalidated cast, so a pre-§137 workdir yields words with the field absent.
 * `w${Math.round(NaN * 1000)}` is `"wNaN"` for EVERY word: one shared anchor
 * for a whole video, under which a single stored edit would rewrite every word
 * in it. That is the failure this whole change exists to prevent, arriving
 * silently. Parse, never coerce — and a loud throw is the parse here, since a
 * missing anchor has no honest fallback. `backfillSrcStart` (Task 6's load
 * path) is what keeps legacy files from reaching this.
 */
export function captionKeyFor(srcStart: number): string {
  if (!Number.isFinite(srcStart)) {
    throw new Error(
      `captionKeyFor: caption words need a finite srcStart (§137), got ${String(srcStart)} — ` +
        `run backfillSrcStart on lines read from a pre-§137 render-props.json`,
    );
  }
  return `w${Math.round(srcStart * 1000)}`;
}

/** A pre-§137 key: a bare non-negative integer, i.e. a caption-word position. */
export function isLegacyCaptionKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * The anchor a word carries, or null when it carries none.
 *
 * `captionKeyFor` THROWS on a non-finite `srcStart` and should: reaching it
 * with one is a programmer error. A word that simply has no `srcStart` is a
 * DATA condition, not a programmer error — the render-props boundary is an
 * unvalidated cast (`captions.ts:33-39`), so a pre-§137 workdir loads with the
 * field absent on every word (the editor's own e2e fixture is exactly that,
 * preserved on purpose). The editor calls `applyCaptionEdits` inside a
 * render-time `useMemo` with no error boundary above it, so a throw down there
 * white-screens the whole editor over a file that merely predates the field
 * (§137 review). Distinguishing the two here keeps the parse loud where it
 * means something and turns the boundary case into "this word can carry no
 * edit" — the edits that then find no home are REPORTED (`found: null` /
 * `unresolved`), which is the honest answer. `backfillSrcStart` on the load
 * path is what makes these words anchorable again.
 *
 * PUBLIC since §137 Task 5, deliberately: the editor needs the same verdict
 * before it writes an edit, and a second copy of "is this word anchorable"
 * living in `apps/editor` is how the two would drift apart. Every caller that
 * holds a word it did not itself construct should come through here rather
 * than calling `captionKeyFor` — a `useEdits` retype runs in a React event
 * handler with no error boundary above it, so a throw there is a crash on any
 * pre-§137 workdir, not a caught parse failure.
 */
export function captionAnchorOf(word: CaptionWord | undefined): string | null {
  if (!word || !Number.isFinite(word.srcStart)) return null;
  return captionKeyFor(word.srcStart);
}

/** How far either side of the stored index the migration will look for `was`. */
const MIGRATION_SEARCH_RADIUS = 8;

/**
 * WHY an edit could not be migrated. Reported rather than folded into one
 * message (§137 Task 6 review, Minor 7): each cause needs something different
 * from the user, and blaming the cut for all of them sends someone looking for
 * a word that is still sitting on screen.
 *  - `not-found`: no word here says `was` any more — a cut removed it, or a
 *    re-plan rewrote it.
 *  - `ambiguous`: several words nearby say `was` and the search cannot tell
 *    which one the user meant.
 *  - `unanchorable`: the word IS here, but carries no source time to key on —
 *    a render-props.json with no usable `spans` to backfill from.
 *  - `collision`: two legacy edits resolved to the same word; neither can be
 *    trusted over the other.
 *  - `superseded`: a legacy edit resolved onto a word an already-source-keyed
 *    edit holds. The CURRENT-format edit wins and is kept; this is the older
 *    duplicate being retired, not a loss of the live edit.
 */
export type CaptionMigrationReason =
  | "not-found"
  | "ambiguous"
  | "unanchorable"
  | "collision"
  | "superseded";

export interface CaptionKeyMigration {
  edits: Record<string, CaptionEdit>;
  /**
   * Edits the migration would not commit — reported, never guessed at. Keyed
   * by their ORIGINAL doc key, which is the only name the user's file knows
   * them by, and carrying WHY (see `CaptionMigrationReason`).
   */
  unresolved: Array<{ key: string; was: string; reason: CaptionMigrationReason }>;
}

/**
 * An answer from `resolveCaptionAnchor`: an anchor, or why there is none.
 * `collision`/`superseded` are excluded because they are not properties of one
 * edit at all — they need the other claims to be visible first.
 */
type AnchorClaim =
  | { to: string }
  | { to: null; reason: Exclude<CaptionMigrationReason, "collision" | "superseded"> };

/**
 * Where one stored edit wants to land, or why it cannot land anywhere.
 *
 * Split out of `migrateCaptionKeys` so every edit can be resolved BEFORE any
 * of them is written: a collision is only visible once both claims exist, and
 * a function that writes as it goes cannot see the second claim coming.
 */
function resolveCaptionAnchor(
  key: string,
  edit: CaptionEdit,
  words: readonly CaptionWord[],
): AnchorClaim {
  // Already a source key (or something that is not a position at all) — the
  // doc's own key stands, and the collision check downstream still applies.
  if (!isLegacyCaptionKey(key)) return { to: key };
  const at = Number(key);
  // The record confirming itself — see `migrateCaptionKeys` for why this
  // wins ahead of the ambiguity rule rather than through it. A confirmed
  // position that carries no anchor resolves to NOTHING rather than falling
  // through to the search: the record already named the word, and letting the
  // search then pick a same-text word elsewhere would rewrite one the user
  // did not edit.
  if (words[at]?.text === edit.was) return anchorOrUnanchorable(words[at]);
  const matches: number[] = [];
  for (let d = 1; d <= MIGRATION_SEARCH_RADIUS; d++) {
    for (const i of [at - d, at + d]) {
      if (words[i]?.text === edit.was) matches.push(i);
    }
  }
  // Ambiguity is judged on the TEXT matches, before anchors are considered —
  // an unanchorable candidate still means the search could not tell two words
  // apart, so it must not silently narrow the field to one.
  if (matches.length === 0) return { to: null, reason: "not-found" };
  if (matches.length > 1) return { to: null, reason: "ambiguous" };
  return anchorOrUnanchorable(words[matches[0]!]);
}

/** The word was FOUND; whether it can be keyed on is a separate question. */
function anchorOrUnanchorable(word: CaptionWord | undefined): AnchorClaim {
  const anchor = captionAnchorOf(word);
  return anchor === null ? { to: null, reason: "unanchorable" } : { to: anchor };
}

/**
 * Upgrade pre-§137 positional keys to source-time keys.
 *
 * Position first, and an exact position hit WINS OUTRIGHT — it is not a
 * guess. The stored index is the position the editor recorded when the user
 * made the edit, and `was` matching the word now sitting there is that record
 * confirming itself: two independent facts agreeing. The same word appearing
 * elsewhere nearby weakens neither, so the ambiguity rule below deliberately
 * does NOT gate this branch (ruling on the §137 plan, task 2: folding the
 * exact hit into the candidate scan makes a confirmed record lose to an
 * unrelated coincidence, and a doc that never drifted at all would stop
 * migrating because the user happened to edit a repeated word — that breaks
 * "every existing overrides.json keeps working" for a case where we have the
 * answer).
 *
 * When the word at that position is NOT the edit's `was`, the position has
 * been PROVEN wrong (a cut removed words before it), so search outward for
 * the `was`: that recovers the field case rather than discarding work the
 * user already did. Ambiguity gates that search alone — two candidates a
 * search genuinely cannot tell apart are reported instead, because a wrong
 * anchor silently rewrites the wrong word, which is worse than an edit the
 * user has to redo.
 *
 * TWO LEGACY EDITS RESOLVING TO THE SAME WORD are that same ambiguity one
 * level up, and both go to `unresolved` — the output is a Record, so writing as
 * we went would have the second edit silently overwrite the first and report
 * nothing, which is the very bug this task was opened for. It is not a corner
 * case:
 *  - an outward search can land on the word another edit exact-hit (`the cat
 *    sat on a mat`, edits at "0" and "5", both `was: "the"`);
 *  - two words can share a `srcStart` outright — `backfillSrcStart`
 *    (`captions.ts:44-50`) maps seam preimages and cut-clamped words onto the
 *    same source instant BY DESIGN, so duplicate keys are manufactured, not
 *    float trivia.
 * Neither edit is guessed at, both are named, and the user can re-apply the
 * one they meant.
 *
 * A LEGACY EDIT COLLIDING WITH AN ALREADY-SOURCE-KEYED ONE is NOT that case,
 * and refusing both was a real bug (§137 Task 6 review, Important 3): a doc
 * holding both key spaces at once — `{"0": …, "w6000": …}` over one word — is
 * the normal shape of any project edited before and after this change, and
 * treating it as an unbreakable tie DELETED the newer, current-format edit
 * whose anchor was never in doubt. The source-keyed edit WINS: it is the one
 * the editor wrote most recently, it names its word directly rather than by a
 * position something may have shifted, and it is the format everything else
 * reads. Only the legacy claim is retired, reported as `superseded`. (There
 * can be at most one source-keyed claimant per anchor: such a claim resolves
 * to its own key, and a Record cannot hold one key twice.)
 */
export function migrateCaptionKeys(
  edits: Record<string, CaptionEdit>,
  lines: readonly CaptionLine[],
): CaptionKeyMigration {
  const words = lines.flatMap((l) => l.words);
  const out: Record<string, CaptionEdit> = {};
  const unresolved: CaptionKeyMigration["unresolved"] = [];

  // Resolve every edit first, write second — see the collision paragraph.
  const claims = Object.entries(edits).map(([key, edit]) => ({
    key,
    edit,
    legacy: isLegacyCaptionKey(key),
    claim: resolveCaptionAnchor(key, edit, words),
  }));
  type Claim = (typeof claims)[number];
  const claimants = new Map<string, Claim[]>();
  for (const c of claims) {
    if (c.claim.to === null) continue;
    const rivals = claimants.get(c.claim.to);
    if (rivals) rivals.push(c);
    else claimants.set(c.claim.to, [c]);
  }

  for (const c of claims) {
    if (c.claim.to === null) {
      unresolved.push({ key: c.key, was: c.edit.was, reason: c.claim.reason });
      continue;
    }
    const rivals = claimants.get(c.claim.to)!;
    // Identity, not `.key` — the winner has to be THIS claim object, or a
    // second claimant would write itself in over the one that already won.
    const winner = rivals.length === 1 ? rivals[0]! : rivals.find((r) => !r.legacy);
    if (winner === c) {
      out[c.claim.to] = c.edit;
      continue;
    }
    unresolved.push({
      key: c.key,
      was: c.edit.was,
      // `winner` undefined means every claimant was legacy: a genuine tie.
      reason: winner === undefined ? "collision" : "superseded",
    });
  }
  return { edits: out, unresolved };
}

export interface AppliedCaptionEdits {
  lines: CaptionLine[];
  /**
   * Edits that did not apply. `found: null` means no word carries that source
   * anchor any more (a cut removed it); a string means the word is there but
   * says something else (a re-plan changed it).
   *
   * `reason` is present ONLY for the third case — a SECOND word carrying an
   * anchor an earlier word already claimed, which is not a stale edit at all
   * (the edit may well have applied, to the first word). Written only when it
   * has something to say, the same rule the override doc's own optional keys
   * follow; absent means the ordinary stale report `found` already
   * distinguishes. A key can therefore appear in this array more than once.
   */
  dropped: Array<{
    key: string;
    expected: string;
    found: string | null;
    reason?: "duplicate-anchor";
  }>;
}

/**
 * Apply retyped caption words. Text only, never timing — the stamps drive the
 * kinetic highlight and the 1:1 constraint is what keeps scene anchors and
 * §21's copy/caption agreement intact.
 *
 * Keyed by source time since §137, so a user cut earlier in the video no
 * longer shifts every later edit onto the wrong word. An edit that does not
 * apply is REPORTED — callers must surface `dropped`; the editor discarding it
 * is what made this failure invisible in the field case.
 *
 * AT MOST ONE WORD per edit — the first carrying the key, and the guard's
 * verdict on that word is final. Keys are millisecond-quantised, so two words
 * CAN share one (`captions.ts:44-50`: backfilled seam preimages and
 * cut-clamped words land on the same source instant by design, and rounding
 * closes sub-millisecond gaps besides). A plain `.map()` rewrites every word
 * that matches — fanning one retype out onto a word the user never touched,
 * which is exactly the "wrong anchor silently rewrites the wrong word" the
 * migration's ambiguity rule refuses to commit, and a breach of the 1:1
 * in-place retype contract above. Later claimants are reported with
 * `reason: "duplicate-anchor"` and left alone rather than edited.
 */
export function applyCaptionEdits(
  lines: readonly CaptionLine[],
  edits: Record<string, CaptionEdit>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (Object.keys(edits).length === 0) return { lines: [...lines], dropped };

  const seen = new Set<string>();
  const out = lines.map((line) => ({
    ...line,
    words: line.words.map((w) => {
      // No anchor, no edit — a pre-§137 word cannot be addressed, and this is
      // the boundary that must not throw (see `captionAnchorOf`). The stored
      // edits then fall out of the sweep below as `found: null`.
      const key = captionAnchorOf(w);
      if (key === null) return w;
      const edit = edits[key];
      if (!edit) return w;
      // An earlier word already answered for this anchor — whichever way it
      // answered. Applying here too would fan one retype onto a second word;
      // re-running the guard here would let an edit be applied AND reported
      // dropped for the same key.
      if (seen.has(key)) {
        dropped.push({ key, expected: edit.was, found: w.text, reason: "duplicate-anchor" });
        return w;
      }
      seen.add(key);
      if (w.text !== edit.was) {
        dropped.push({ key, expected: edit.was, found: w.text });
        return w;
      }
      return { ...w, text: edit.text };
    }),
  }));

  // An anchor no word carries any more — the cut removed the word the user
  // edited. Silence here is exactly the field case, so say it.
  for (const [key, edit] of Object.entries(edits)) {
    if (!seen.has(key)) dropped.push({ key, expected: edit.was, found: null });
  }
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
 * Un-hide ONE element: DELETE only the `hidden` key (PLAN Task 2), so a
 * nudge/scale made before the delete survives the restore — the
 * element-level mirror of `restoreScene`'s "delete the key, don't write a
 * false-ish value" rule below. `clearElementTransform` above stays the FULL
 * reset (nudges included); this is the narrower "bring it back as it was"
 * gesture the element panel's Restore button offers.
 */
export function restoreElement(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
): OverrideDoc {
  const scene = doc.scenes[sceneId];
  const entry = scene?.elements[elementId];
  if (!scene || !entry?.hidden) return doc;
  const { hidden: _dropped, ...rest } = entry;
  // `elements` merges per ID, not per FIELD (`effectiveOverride` above:
  // `elements: { ...base.elements, ...own.elements }` replaces a shared id
  // WHOLESALE, unlike `video`/`pip`, which merge field by field). Review
  // fix wave, PLAN Task 2: a half whose own entry was ONLY `{hidden:true}`
  // would otherwise be left with the empty leftover `{}` once `hidden` is
  // stripped — and that empty object still wins the wholesale merge,
  // permanently shadowing whatever nudge the split ROOT had for this id,
  // even though "restore keeps nudges" is exactly this function's promise.
  // Dropping the key entirely once nothing but `hidden` was ever on it lets
  // the root's own entry (if any) show through again — same "delete rather
  // than leave an inert key" instinct as clearVideo/clearTiming.
  const { [elementId]: _own, ...withoutEntry } = scene.elements;
  const elements =
    Object.keys(rest).length > 0 ? { ...scene.elements, [elementId]: rest } : withoutEntry;
  return {
    ...doc,
    scenes: { ...doc.scenes, [sceneId]: { ...scene, elements } },
  };
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

/**
 * The scene a cue id belongs to, stripping a split half's `@<split id>`
 * suffix. That suffix is opaque since §137 — a minted id, not a time — so the
 * `@` is the only thing this can key on; it is the
 * same idiom `splitCues` itself uses to derive a later half's id from its
 * root, and the same one `effectiveOverride` above inlines to find a half's
 * root entry. Two cues sharing a root are the SAME scene, cut in two.
 *
 * Exported (PLAN Task 2 review fix) for the editor's own use: a hidden
 * ELEMENT on a split half can be inherited from the root (`elements`
 * merges per id in `effectiveOverride`, and `elements` is NOT in that
 * function's inheritance-exclusion list the way `timing`/`hidden` are) —
 * Inspector.tsx's per-row Restore has to know whether the `hidden` it's
 * offering to undo lives on the half's own doc entry or the root's, and
 * this is the same root-id derivation either side of that decision needs.
 */
export function splitRootId(id: string): string {
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
