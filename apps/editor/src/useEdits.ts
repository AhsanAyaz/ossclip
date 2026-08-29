import { useReducer, useRef } from "react";
import {
  captionEditWas,
  captionKeyFor,
  captionRangeEditWas,
  isLegacyCaptionKey,
  clearElementTransform,
  clearGraphicRect,
  clearTiming,
  emptyOverrideDoc,
  mintSplitId,
  rekeyCaptionRecords,
  restoreElement,
  setElementTransform,
  stampSceneAnchors,
  type ElementTransform,
  type Layout,
  type OverrideDoc,
  type RemovalReason,
  type SceneComponentId,
  type SceneCue,
  type SceneTiming,
  type SfxAddedPlacement,
  type SfxPlacementEdit,
  type StampMove,
} from "@ossclip/core/browser";

/** A hand-set graphic slot, frame fractions (R11 Task 2). */
export interface GraphicRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditState {
  doc: OverrideDoc;
  /** Snapshots, newest last. Undo is free because the doc is plain JSON. */
  past: OverrideDoc[];
  /** Undone snapshots, next-to-redo last (R17 §80). A NEW commit clears
   * this — the branch you undid away from is gone once you edit again,
   * which is the redo semantics every editor has. */
  future: OverrideDoc[];
  dirty: boolean;
  /** History length at the last save, so undoing past it re-marks dirty. */
  savedAt: number;
  /** The last commit's coalesce key + time — see COALESCE_MS. */
  lastCoalesce: { key: string; at: number } | null;
}

/**
 * Commits carrying the SAME coalesce key within this window collapse into
 * one undo step (PLAN 2026-07-30 Task B5): typing "0.62" into a number field
 * or scrubbing the zoom slider is one gesture, not four. Drags pass no key —
 * each drag is its own step — and two gestures separated by more than this
 * never merge, however identical their keys.
 */
export const COALESCE_MS = 600;

export type EditAction =
  | { type: "load"; doc: OverrideDoc }
  | { type: "patchProps"; sceneId: string; patch: Record<string, unknown>; coalesce?: string }
  | {
      type: "patchElement";
      sceneId: string;
      elementId: string;
      patch: ElementTransform;
      coalesce?: string;
    }
  | { type: "clearElement"; sceneId: string; elementId: string }
  /** Soft-delete ONE element (PLAN Task 2) — the element-level mirror of
   * `hideScene`/`restoreScene` below. */
  | { type: "hideElement"; sceneId: string; elementId: string }
  | { type: "restoreElement"; sceneId: string; elementId: string }
  /** The pinned window, in whichever clock the writer resolved at the
   * gesture (`SceneTimingSchema`) — stored VERBATIM: this reducer is not a
   * place where clocks get converted, because it has no map and could only
   * guess at which one the caller meant. */
  | { type: "patchTiming"; sceneId: string; timing: SceneTiming }
  | {
      type: "patchVideo";
      sceneId: string;
      patch: { scale?: number; dy?: number; dx?: number; autoZoom?: boolean };
      coalesce?: string;
    }
  | { type: "clearVideo"; sceneId: string }
  | {
      type: "patchPip";
      sceneId: string;
      patch: { cornerRadius?: number; x?: number; y?: number };
      coalesce?: string;
    }
  | { type: "clearPip"; sceneId: string }
  | { type: "patchCaptionY"; sceneId: string; y: number; coalesce?: string }
  | { type: "patchCaptionScale"; sceneId: string; scale: number; coalesce?: string }
  /** Clears BOTH caption style keys (position and scale) — one Reset. */
  | { type: "clearCaptionStyle"; sceneId: string }
  /** §56b's cheap bulk: ONE commit (one undo step) writing the same caption
   * style to every listed scene — "the captions are too low for this whole
   * video". R16 §64 rides along: scale fans out with position. */
  | { type: "patchCaptionStyleAll"; sceneIds: string[]; y?: number; scale?: number }
  | { type: "addSplit"; at?: number; src?: number }
  | { type: "clearTiming"; sceneId: string }
  /** The global Captions switch (doc-global `captionsHidden`) — one action
   * for both directions rather than a hide/restore pair, because the UI is
   * a single checkbox whose next state it already knows; the reducer keeps
   * the hideScene/restoreScene semantics (write `true` / DELETE the key,
   * no-op guard) either way. */
  | { type: "setCaptionsHidden"; hidden: boolean }
  | { type: "hideScene"; sceneId: string }
  | { type: "restoreScene"; sceneId: string }
  /** `startSec`/`endSec` are the OLD-clock historical record; `src` — when
   * the writer could resolve one (cut-review rework, 2026-08-26) — is the
   * SOURCE range, authoritative and live-applied. See the reducer case. */
  | {
      type: "cutChunk";
      startSec: number;
      endSec: number;
      src?: { startSec: number; endSec: number };
    }
  /** `index` is the entry's position in `doc.cuts` at the moment the caller
   * looked it up — identity, not a window match (fix round 2, PLAN
   * 2026-08-04 Task 4c re-review; see the reducer case's own comment). */
  | { type: "restoreChunk"; index: number }
  | { type: "patchGraphicRect"; sceneId: string; rect: GraphicRect; coalesce?: string }
  | { type: "clearGraphicRect"; sceneId: string }
  | { type: "patchComponent"; sceneId: string; component: SceneComponentId }
  | { type: "patchLayout"; sceneId: string; layout: Layout }
  /** `srcStart` is the word's SOURCE start in seconds — never its position,
   * and never its OUTPUT start (§137). Callers must have already established
   * that the word HAS an anchor (`captionAnchorOf`); the reducer derives the
   * key with `captionKeyFor`, which throws on a non-finite one by design. */
  | { type: "patchCaption"; srcStart: number; text: string; was: string }
  /** Free-text rewrite of a contiguous word RUN (`captionRangeEdits`) — the
   * one gesture allowed to change word count. `fromSrcStart`/`toSrcStart`
   * are the endpoints' SOURCE starts (§137, the `patchCaption` anchor
   * contract — callers pre-validate with `captionAnchorOf`); `was` is the
   * NFC-joined BASE texts of the run — never the live (post-retype) join.
   * The reducer scrubs every per-word retype inside the interval in the
   * SAME commit, so at apply time the edits layer no longer rewrites
   * anything inside it and the whole-run guard compares against the base
   * run — a live-joined `was` carrying a retype would fail that guard
   * forever (the `captionEditWas` base-truth rule, applied run-wide). */
  | {
      type: "patchCaptionRange";
      fromSrcStart: number;
      toSrcStart: number;
      text: string;
      was: string;
    }
  /** "Apply to all (n)" for a single-token, single-word rewrite: fold the
   * `patchCaption` case's semantics over EVERY entry against one draft doc —
   * per-key `captionEditWas`, clear-when-text===was — in ONE commit, because
   * "retype every 'helo'" is one gesture and must be one undo step (the
   * `patchCaptionStyleAll` precedent). Same anchor contract as `patchCaption`;
   * each entry's `was` is that occurrence's own BASE text. */
  | {
      type: "patchCaptionAllOccurrences";
      entries: Array<{ srcStart: number; was: string }>;
      text: string;
    }
  /** The multi-word sibling: fold `patchCaptionRange`'s FULL per-interval
   * logic (scrub of captions + hides + overlapping entries, then append;
   * text===was deletes the pair's entry) over every occurrence on one draft
   * doc, ONE commit — one undo step for the whole gesture, selection and
   * occurrences together. Entry `was` values are BASE-joined runs, the same
   * base-truth rule as `patchCaptionRange`'s own docstring. */
  | {
      type: "patchCaptionRangeAllOccurrences";
      entries: Array<{ fromSrcStart: number; toSrcStart: number; was: string }>;
      text: string;
    }
  /** Per-LINE caption TIMING nudge (`captionLineTiming`) — `lead` moves a
   * caption line's OPENING seam, `tail` its CLOSING one, both DELTAS in
   * seconds against the line's derived window, keyed by the LINE's FIRST
   * WORD's SOURCE time (§137, the `patchCaption` anchor contract — callers
   * pre-validate with `captionAnchorOf`, and `captionKeyFor` throwing on a
   * non-finite `srcStart` is by design).
   *
   * BULK BY CONSTRUCTION, with no single-line sibling: one seam is shared by
   * two lines (`applyCaptionLineTiming`), so a drag legitimately writes both
   * sides at once and that is ONE gesture — one undo step (the
   * `hideCaptionWords`/`patchCaptionStyleAll` precedent; a per-line dispatch
   * would make the user press undo twice to put one seam back). Per entry:
   * both deltas under 1ms in magnitude DELETES that key (a line dragged back
   * to base clears itself — the clearVideo/patchCaption clear-override rule),
   * everything else writes, and a fold that changes nothing returns the SAME
   * state rather than minting a phantom undo step. */
  | {
      type: "patchCaptionLineTiming";
      entries: Array<{ srcStart: number; lead: number; tail: number }>;
    }
  /** Per-LINE caption display WINDOWS (`captionLineWindows`) — the audio-first
   * timing tool's write. `window` is an ABSOLUTE span in SOURCE seconds (what
   * the user dragged against the waveform), `srcStart` the LINE's FIRST WORD's
   * source time, i.e. the key (§137, the `patchCaption` anchor contract:
   * callers pre-validate with `captionAnchorOf`, and `captionKeyFor` throwing
   * on a non-finite `srcStart` is by design).
   *
   * BULK, like `patchCaptionLineTiming` above, but for a different reason:
   * windows share no seams — one Apply places EVERY line in the selection, and
   * that is one gesture and one undo step (the `hideCaptionWords` precedent).
   * `window: null` DELETES the key, which is what the widget sends for a line
   * dragged back onto its derived position: an entry that restates the
   * derivation is still an override (the clearVideo/patchCaption
   * clear-override rule), and the caller owns that comparison because only it
   * knows the derived window. A fold that changes nothing returns the SAME
   * state rather than minting a phantom undo step. */
  | {
      type: "patchCaptionLineWindows";
      entries: Array<{
        srcStart: number;
        window: { srcStart: number; srcEnd: number } | null;
      }>;
    }
  /** Hide the selection's words from the captions in ONE commit — one gesture,
   * one undo step (the `patchCaptionStyleAll` precedent). Same anchor contract
   * as `patchCaption` above: callers pre-validate with `captionAnchorOf`, and
   * the reducer's `captionKeyFor` throwing on a non-finite `srcStart` is by
   * design. `was` is the LIVE (post-retype) text — hides apply after retypes
   * (`applyCaptionLayers`). */
  | { type: "hideCaptionWords"; words: Array<{ srcStart: number; was: string }> }
  /** The way back: DELETE the keys (restoreScene's rule), one commit. */
  | { type: "restoreCaptionWords"; srcStarts: number[] }
  /** "Remove captions + video" for a word selection (§59b revisited) — the
   * hide entries AND a `cuts` entry, in ONE commit. Same anchor contract as
   * `hideCaptionWords` above; `startSec`/`endSec` are output seconds of the
   * LAST RENDER's frame and `src` the resolved SOURCE range, same pair as
   * `cutChunk`. The panel's window is OLD-clock, so App resolves `src`
   * through `clock.oldToSourceSec`, never the live one. */
  | {
      type: "cutWords";
      words: Array<{ srcStart: number; was: string }>;
      startSec: number;
      endSec: number;
      src?: { startSec: number; endSec: number };
    }
  /** The cleanup veto layer's category switch (cut review step 3) —
   * `enabled: false` writes `cleanup.reasons[reason] = false` ("keep all
   * pauses"); `enabled: true` DELETES the key, never writes `true` (the
   * captionsHidden rule: a true entry restates the default). Since cut
   * review step 4 the preview PLAYS the veto live (App's `liveRecut`) as
   * well as the next produce/Render applying it. */
  | { type: "setReasonEnabled"; reason: RemovalReason; enabled: boolean }
  /** One removal span's individual veto, SOURCE seconds (the schema's
   * recut-immune anchoring). Toggling OFF removes every `cleanup.kept` entry
   * OVERLAPPING the span, not just an exact-endpoint match — the same
   * overlap rule `vetoedRemovals` matches with, so a click always inverts
   * the state the seam is showing. */
  | { type: "toggleKept"; srcIn: number; srcOut: number }
  | { type: "dismissRemoval"; srcIn: number; srcOut: number }
  | { type: "restoreDismissed"; srcIn: number; srcOut: number }
  /**
   * Move every caption record onto the stamps a range re-transcription just
   * corrected (Phase A, 2026-08-26). The mapping is EXACT — it comes out of
   * the splice `/api/retranscribe-range` performed, not out of a search — and
   * the server deliberately does not apply it: `overrides.json` is
   * client-owned, so the re-key has to happen HERE, as one commit, so one ⌘Z
   * takes it back with the keep that triggered it.
   */
  | { type: "rekeyCaptionKeys"; mapping: readonly StampMove[] }
  /**
   * Retime / swap / re-gain ONE planned sound effect (`sfx.edits`, Phase 4),
   * keyed by `sfxPlacementKey` — the PLAN's own `${soundId}@${word}`, never a
   * key derived from the live (already-edited) values: re-keying on every drag
   * is exactly what the content-derived key exists to avoid (the schema's own
   * argument, packages/core/src/overrides.ts).
   *
   * `planned` is the plan's values for this placement, and it is what makes
   * this a PATCH: a field dragged back onto what the model planned DELETES
   * that field rather than storing it (the clearVideo/patchCaption
   * clear-override rule — an override restating the base would keep winning
   * after a re-plan moved the placement underneath it), and an entry left with
   * nothing to say goes entirely. Absent `planned.gain` reads as 1, the same
   * `p.gain ?? 1` the resolver multiplies by.
   */
  | {
      type: "patchSfx";
      key: string;
      patch: { word?: number; soundId?: string; gain?: number };
      planned: { word: number; soundId: string; gain?: number };
      coalesce?: string;
    }
  /** Delete a PLANNED placement: `muted: true` NEGATES it (the plan itself
   * lives in production.json and produce rewrites it every run, so there is
   * nothing to delete there) and the lane keeps a restorable ghost — the
   * `hideScene` contract for a track of instants. */
  | { type: "muteSfx"; key: string }
  /**
   * The way back. Drops `muted`, and DELETES the whole entry when nothing else
   * remains — which for the mute-only entry this normally undoes is exactly
   * the schema's "restore deletes the key" (never `muted: false`, the
   * restoreScene rule). A user who also dragged or re-gained the placement
   * keeps that work: silently discarding an edit the gesture never mentioned
   * would be the §137 failure, a change nobody printed.
   */
  | { type: "restoreSfx"; key: string }
  /** A placement of the user's OWN (`sfx.added`) — id minted here, once, and
   * never recomputed (`mintSfxAddedId`). */
  | { type: "addSfx"; soundId: string; word: number; gain?: number }
  /** The added placement's editor. No `planned` counterpart, because there is
   * no plan to restate: every field of an added placement IS the user's, so a
   * value equal to yesterday's is still the whole record. */
  | {
      type: "patchSfxAdded";
      id: string;
      patch: { word?: number; soundId?: string; gain?: number };
      coalesce?: string;
    }
  /** Delete an ADDED placement: spliced out, not muted — there is no plan
   * entry left behind for a ghost to negate. */
  | { type: "removeSfxAdded"; id: string }
  | { type: "patchTheme"; patch: Record<string, unknown> }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved" };

export const initialEditState = (): EditState => ({
  doc: emptyOverrideDoc(),
  past: [],
  future: [],
  dirty: false,
  savedAt: 0,
  lastCoalesce: null,
});

const withScene = (doc: OverrideDoc, id: string) =>
  doc.scenes[id] ?? { props: {}, elements: {} };

/** The sfx slot as a value, for reducers that have to read it before it
 * exists — the doc's own key stays ABSENT until something is actually stored
 * (see `withSfx`). */
const sfxSlot = (doc: OverrideDoc): { edits: Record<string, SfxPlacementEdit>; added: SfxAddedPlacement[] } =>
  doc.sfx ?? { edits: {}, added: [] };

/**
 * Write the sfx slot back, or REMOVE it when it has nothing left to say.
 *
 * The `captionsHidden`/`clearVideo` rule, applied to a whole record: `sfx` is
 * optional with no default precisely so an overrides.json written before the
 * key existed parses byte-identically, and a project whose last SFX edit was
 * just undone must not keep an empty `{edits:{},added:[]}` as dead weight in
 * every save from then on.
 */
const withSfx = (
  doc: OverrideDoc,
  next: { edits: Record<string, SfxPlacementEdit>; added: SfxAddedPlacement[] },
): OverrideDoc => {
  if (Object.keys(next.edits).length > 0 || next.added.length > 0) return { ...doc, sfx: next };
  if (doc.sfx === undefined) return doc;
  const { sfx: _dropped, ...rest } = doc;
  return rest;
};

/**
 * An id for a user-added placement that no entry in `existing` already holds.
 *
 * `mintSplitId`'s contract, restated for the other namespace this editor
 * mints into (that function's doc comment owns the full argument): the id is
 * PERSISTED in overrides.json and is the only thing tying an edit to the
 * placement it names, so it is minted ONCE at the gesture and never
 * recomputed — `${soundId}@${word}` would re-key itself the instant the user
 * dragged or swapped it, and an array index renumbers on every delete. The
 * suffix is a COUNTER, not a nonce or a timestamp, so the value is
 * reproducible from the document alone.
 *
 * The base is sanitised rather than trusted: every id must match
 * `SfxAddedPlacementSchema`'s `/^[A-Za-z0-9_-]+$/` — no `@`, which is the
 * separator `sfxPlacementKey` builds PLANNED keys with, and nothing that
 * could read as a path — and produce THROWS on an overrides.json that fails
 * to parse. The library's own ids are slugs today, but this invariant must
 * not depend on a promise made in another package.
 */
export function mintSfxAddedId(
  soundId: string,
  word: number,
  existing: readonly { id: string }[],
): string {
  const slug = soundId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `${slug === "" ? "sfx" : slug}-${Math.max(0, Math.trunc(word))}`;
  const taken = new Set(existing.map((e) => e.id));
  if (!taken.has(base)) return base;
  // Starts at 2 so the first collision reads as "the second `ding-4`".
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function editReducer(state: EditState, action: EditAction): EditState {
  const commit = (doc: OverrideDoc, coalesce?: string): EditState => {
    const now = Date.now();
    // Same key, still inside the window → REPLACE the top of history rather
    // than pushing: the burst's first commit already snapshotted the
    // pre-gesture doc, which is exactly where one undo should land.
    const merge =
      coalesce !== undefined &&
      state.lastCoalesce !== null &&
      state.lastCoalesce.key === coalesce &&
      now - state.lastCoalesce.at < COALESCE_MS;
    return {
      doc,
      past: merge ? state.past : [...state.past, state.doc],
      // Editing after an undo abandons the undone branch (R17 §80).
      future: [],
      dirty: true,
      savedAt: state.savedAt,
      lastCoalesce: coalesce !== undefined ? { key: coalesce, at: now } : null,
    };
  };

  switch (action.type) {
    case "load":
      return {
        doc: action.doc,
        past: [],
        future: [],
        dirty: false,
        savedAt: 0,
        lastCoalesce: null,
      };
    case "patchProps": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: {
            ...state.doc.scenes,
            [action.sceneId]: { ...scene, props: { ...scene.props, ...action.patch } },
          },
        },
        action.coalesce,
      );
    }
    case "patchElement":
      return commit(
        setElementTransform(state.doc, action.sceneId, action.elementId, action.patch),
        action.coalesce,
      );
    case "clearElement":
      return commit(clearElementTransform(state.doc, action.sceneId, action.elementId));
    case "hideElement":
      // Merge `{hidden:true}` via setElementTransform (PLAN Task 2) — its
      // patch type widened to include `hidden` alongside dx/dy/scale, so
      // this is the same merge-a-patch path every nudge already takes.
      return commit(
        setElementTransform(state.doc, action.sceneId, action.elementId, { hidden: true }),
      );
    case "restoreElement": {
      // No-op guard BEFORE commit (same shape as restoreScene above): an
      // element that isn't hidden must not push a no-op onto the undo
      // stack just because `restoreElement` (overrides.ts) itself returns
      // a byte-identical doc rather than the SAME reference through the
      // spread in `commit`.
      const entry = state.doc.scenes[action.sceneId]?.elements[action.elementId];
      if (!entry?.hidden) return state;
      return commit(restoreElement(state.doc, action.sceneId, action.elementId));
    }
    case "patchTiming": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: {
          ...state.doc.scenes,
          [action.sceneId]: {
            ...scene,
            timing: action.timing,
          },
        },
      });
    }
    case "clearTiming":
      return commit(clearTiming(state.doc, action.sceneId));
    case "patchVideo": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: {
            ...state.doc.scenes,
            [action.sceneId]: { ...scene, video: { ...scene.video, ...action.patch } },
          },
        },
        action.coalesce,
      );
    }
    case "clearVideo": {
      const scene = state.doc.scenes[action.sceneId];
      if (!scene?.video) return state;
      // DELETE rather than reset to 1: an explicit scale of 1 is still an
      // override, and would keep overriding after a re-produce changed the
      // framing underneath it.
      const { video: _dropped, ...rest } = scene;
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: rest },
      });
    }
    case "patchPip": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: {
            ...state.doc.scenes,
            [action.sceneId]: { ...scene, pip: { ...scene.pip, ...action.patch } },
          },
        },
        action.coalesce,
      );
    }
    case "clearPip": {
      const scene = state.doc.scenes[action.sceneId];
      if (!scene?.pip) return state;
      // DELETE, same rule as clearVideo: a pip that restates the defaults is
      // still an override.
      const { pip: _dropped, ...rest } = scene;
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: rest },
      });
    }
    case "patchCaptionY": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, captionY: action.y } },
        },
        action.coalesce,
      );
    }
    case "patchCaptionScale": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: {
            ...state.doc.scenes,
            [action.sceneId]: { ...scene, captionScale: action.scale },
          },
        },
        action.coalesce,
      );
    }
    case "clearCaptionStyle": {
      const scene = state.doc.scenes[action.sceneId];
      if (scene?.captionY === undefined && scene?.captionScale === undefined) return state;
      const { captionY: _y, captionScale: _s, ...rest } = scene;
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: rest },
      });
    }
    case "patchCaptionStyleAll": {
      const scenes = { ...state.doc.scenes };
      for (const id of action.sceneIds) {
        const scene = scenes[id] ?? { props: {}, elements: {} };
        scenes[id] = {
          ...scene,
          ...(action.y !== undefined ? { captionY: action.y } : {}),
          ...(action.scale !== undefined ? { captionScale: action.scale } : {}),
        };
      }
      return commit({ ...state.doc, scenes });
    }
    case "addSplit": {
      // A split needs at least one anchor (SplitSchema's refine) — a
      // dispatch with neither is a caller bug, dropped rather than stored.
      if (action.at === undefined && action.src === undefined) return state;
      // Dedupe within a millisecond: a repeated Cmd+B on the same paused
      // frame is one decision, not a stack of coincident cuts. Compared on
      // `src` when both sides carry it (the authoritative anchor), else on
      // `at` — a src-only split (revived material) and an at-only legacy
      // entry can never be "the same" gesture.
      const dup = state.doc.splits.some((s) =>
        action.src !== undefined && s.src !== undefined
          ? Math.abs(s.src - action.src) < 0.001
          : action.at !== undefined && s.at !== undefined
            ? Math.abs(s.at - action.at) < 0.001
            : false,
      );
      if (dup) return state;
      // The id is minted HERE, once, and never recomputed (§137). Minted
      // from the SOURCE ms when available — the stable anchor — else the
      // old-clock at; `mintSplitId` checks the ids themselves either way.
      return commit({
        ...state.doc,
        splits: [
          ...state.doc.splits,
          {
            ...(action.at !== undefined ? { at: action.at } : {}),
            ...(action.src !== undefined ? { src: action.src } : {}),
            id: mintSplitId(action.src ?? action.at!, state.doc.splits),
          },
        ].sort((a, b) => (a.at ?? a.src ?? 0) - (b.at ?? b.src ?? 0)),
      });
    }
    case "setCaptionsHidden": {
      // No-op guard BOTH ways (restoreScene's shape, doubled because one
      // action serves both directions): re-committing the state the doc is
      // already in must not mint an undo step for an unchanged document.
      if (action.hidden === (state.doc.captionsHidden === true)) return state;
      if (action.hidden) return commit({ ...state.doc, captionsHidden: true });
      // DELETE the key rather than writing false — the clearVideo/
      // restoreScene rule: an explicit `captionsHidden: false` is still an
      // override with nothing to say, and would survive as dead weight in
      // every overrides.json saved after one toggle round-trip.
      const { captionsHidden: _dropped, ...rest } = state.doc;
      return commit(rest);
    }
    case "hideScene": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, hidden: true } },
      });
    }
    case "restoreScene": {
      const scene = state.doc.scenes[action.sceneId];
      if (!scene?.hidden) return state;
      // DELETE the key rather than writing hidden: false — same rule as
      // clearVideo/clearTiming: an explicit false is still an override.
      const { hidden: _dropped, ...rest } = scene;
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: rest },
      });
    }
    case "cutChunk": {
      // Delete this chunk (PLAN 2026-08-04 Task 4c) — split-then-delete
      // becomes the actual cutting gesture the dogfooding verdict asked
      // for: split isolates a chunk into its own block, this removes it.
      // Soft like `hideScene`, but a DIFFERENT axis of soft — `hideScene`
      // only drops a graphic and keeps the window's duration; this marks
      // the WINDOW ITSELF for removal from the output, TAKE or SCENE alike.
      //
      // `src` (cut-review rework, 2026-08-26) is the writer's own resolved
      // SOURCE range — the schema on `OverrideDocSchema.cuts` now allows the
      // editor to write it, and the writers resolve it at the gesture off
      // the preview clock. Present ⇒ the entry is LIVE-APPLIED: the preview
      // subtracts it and the material genuinely stops playing (retime-
      // preview.ts's module doc). Absent ⇒ the legacy marked-only entry,
      // effective on the next produce/Render, byte-identical to before —
      // which is exactly what a writer with no source mapper still writes.
      //
      // Fix round 2 (re-review, PLAN 2026-08-04 Task 4c): the filter below
      // ONLY replaces an existing SRC-LESS entry at this exact window — a
      // SRC-ANCHORED entry at the same window is left completely alone,
      // never touched, whatever it is. That coincidence is not a fluke: a
      // cut [10, 15] → Render (the entry becomes `{10, 15, src}`, and
      // everything after 15 shifts back by 5) → the block that used to sit
      // at [15, 20] now legitimately occupies [10, 15] in THIS render-props'
      // frame — exactly what the Inspector's "Delete this chunk" is for.
      // Filtering by window alone (the original implementation) would
      // silently delete the APPLIED cut's own entry, src and all, the
      // instant the user cut that new block — the previously-removed
      // material would return on the next produce with no seam, no notice,
      // no way to tell it happened. Two entries sharing one window (one
      // src-anchored, one fresh) is the honest state here: they describe
      // two INDEPENDENT decisions that happen to land on the same numbers,
      // and `resolveCutSourceRanges`/`applyUserCuts` (packages/core/src/
      // recut.ts) already resolve every `cuts` entry independently — a
      // src-anchored one used directly, a src-less one converted through
      // `priorMap` — so nothing downstream needs them deduplicated.
      //
      // The src-equality arm (cut-review rework) is the same idea one level
      // up: two dispatches of the SAME gesture (a double-click, an undo-less
      // repeat on the same block) resolve to the same source range, and the
      // second must REPLACE the first rather than stack. Exact equality is
      // right here because both numbers are rounded to 1ms AT THE WRITE
      // SITES before they arrive — this reducer never does arithmetic on
      // them — so a repeat of one gesture produces bit-identical values.
      // OVERLAPPING (rather than identical) src ranges are DELIBERATELY not
      // merged: `subtractRangesFromCutlist` (recut.ts) is set-like, so two
      // overlapping removals remove exactly what one union would, and a
      // merge would silently rewrite entries the user could otherwise
      // Restore one at a time.
      const cuts = state.doc.cuts.filter((c) =>
        c.src === undefined
          ? c.startSec !== action.startSec || c.endSec !== action.endSec
          : action.src === undefined ||
            c.src.startSec !== action.src.startSec ||
            c.src.endSec !== action.src.endSec,
      );
      return commit({
        ...state.doc,
        cuts: [
          ...cuts,
          // Spread, not `src: action.src` — a src-less write must not grow a
          // `src: undefined` key, or every legacy overrides.json this editor
          // touches changes shape for nothing.
          { startSec: action.startSec, endSec: action.endSec, ...(action.src ? { src: action.src } : {}) },
        ],
      });
    }
    case "restoreChunk": {
      // The way back (PLAN 2026-08-04 Task 4c): removes the WHOLE entry,
      // same "delete the key, don't write a false-ish value" rule as
      // `restoreScene`'s `hidden` removal — there is no "not cut" state for
      // one `cuts` array entry to hold, so the entry itself has to go.
      //
      // Fix round 2 (re-review): keyed by INDEX, not by a window filter.
      // Once a src-anchored and a src-less entry can legitimately share one
      // window (see `cutChunk` above), a window filter can no longer tell
      // WHICH of the (up to two) matching entries the caller meant — the
      // original implementation removed EVERY entry sharing the window,
      // so a seam click (meant to restore only the applied cut) would also
      // silently delete an unrelated fresh cut at the same numbers, and
      // vice versa. Both callers (`Timeline.tsx`'s seam, `Inspector.tsx`'s
      // band Restore) already hold the exact array index of the ONE entry
      // they're offering Restore for — Timeline's `cuts.map((cut, i) =>
      // …)` and Inspector's `cuts.findIndex(…)` — so identity-by-index is
      // free to obtain at every call site and removes exactly one entry,
      // never a sibling that happens to share its numbers.
      if (action.index < 0 || action.index >= state.doc.cuts.length) return state;
      const cuts = state.doc.cuts.filter((_, i) => i !== action.index);
      return commit({ ...state.doc, cuts });
    }
    case "patchComponent": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, component: action.component } },
      });
    }
    case "patchLayout": {
      // A layout swap picks a NEW slot — a stale hand-set rect would
      // silently keep winning over it at render time, so it goes with the
      // old layout.
      const { graphicRect: _stale, ...scene } = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, layout: action.layout } },
      });
    }
    case "patchGraphicRect": {
      const scene = withScene(state.doc, action.sceneId);
      return commit(
        {
          ...state.doc,
          scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, graphicRect: action.rect } },
        },
        action.coalesce,
      );
    }
    case "clearGraphicRect":
      return commit(clearGraphicRect(state.doc, action.sceneId));
    case "patchCaption": {
      // Retyping a word back to its original CLEARS the override — same rule
      // as clearVideo: an override that matches the base is still an
      // override, and would shadow a future re-produce's repaired text.
      // "Original" means the BASE text: a re-edit's caller sees the LIVE
      // (already-edited) word, and `captionEditWas` keeps the stored guard
      // anchored to the truth `applyCaptionEdits` will compare against —
      // without it, editing the same word twice stored the first edit as
      // `was` and the guard dropped the whole edit on the next merge (R15).
      // Keyed by SOURCE time (§137). The positional key this replaced is the
      // whole bug: a user cut removes a word, every later index shifts by one,
      // and the `was` guard below then fires on edits that were never stale —
      // dropping four of the user's retypes into a report nobody printed.
      const key = captionKeyFor(action.srcStart);
      const was = captionEditWas(state.doc.captions, key, action.was);
      if (action.text === was) {
        const { [key]: _dropped, ...rest } = state.doc.captions;
        return commit({ ...state.doc, captions: rest });
      }
      return commit({
        ...state.doc,
        captions: { ...state.doc.captions, [key]: { text: action.text, was } },
      });
    }
    case "patchCaptionRange": {
      const fromKey = captionKeyFor(action.fromSrcStart);
      const toKey = captionKeyFor(action.toSrcStart);
      const text = action.text.trim();
      // Empty is a cancel, never stored: rewriting a run to nothing is a
      // DELETE, which is the hide layer's gesture, with its own confirm.
      if (!text) return state;
      // The captionEditWas rule, per PAIR: a re-edit of the same run sees the
      // LIVE (already-rewritten) text, and storing that as `was` would stale
      // the guard against the base lines. The base truth survives re-edits —
      // and the ACTION's own `was` must already be the BASE-joined run text
      // (the action docstring's contract): the scrub below removes every
      // per-word retype inside the interval in this same commit, so the run
      // `applyCaptionRangeEdits`' whole-run guard reads IS the base run. A
      // live-joined `was` (containing a retype) would drop the edit
      // permanently on the very next apply. Same-pair inheritance here still
      // wins whenever an entry for the pair exists.
      const was = captionRangeEditWas(state.doc.captionRangeEdits, fromKey, toKey, action.was);
      if (text === was) {
        // Retyped back to the original: DELETE the entry (the clearVideo/
        // patchCaption rule — an override restating the base is still an
        // override), or no-op when there is nothing to delete.
        const rest = state.doc.captionRangeEdits.filter(
          (e) => e.fromKey !== fromKey || e.toKey !== toKey,
        );
        if (rest.length === state.doc.captionRangeEdits.length) return state;
        return commit({ ...state.doc, captionRangeEdits: rest });
      }
      // ONE commit: scrub, then append. A range edit re-mints the words
      // inside its interval with synthetic anchors on every apply — a
      // per-word edit or hide keyed to a pre-rewrite anchor inside it would
      // dangle as a permanent drop report, and two overlapping range edits
      // would fight over the same words — so the new gesture SUPERSEDES all
      // of them (the cuts-supersede-hides philosophy, `pruneHidesInsideCuts`).
      const lo = Math.min(Math.round(action.fromSrcStart * 1000), Math.round(action.toSrcStart * 1000));
      const hi = Math.max(Math.round(action.fromSrcStart * 1000), Math.round(action.toSrcStart * 1000));
      const inInterval = (key: string): boolean => {
        // A LEGACY positional key ("0", "17") is never source-time
        // addressable: `migrateLoadedDoc` preserves the ones it could not
        // place in the doc for write-back, and `Number(key.slice(1))` would
        // misread position 17 as 7ms — silently deleting an edit this scrub
        // cannot honestly locate. Parse, never coerce (CLAUDE.md): only §137
        // `w<ms>` keys carry an interval-testable instant. Hides can never
        // be legacy (the layer postdates §137), but the guard covers both
        // maps below so the invariant is stated once, here, rather than
        // depending on each map's history.
        if (isLegacyCaptionKey(key)) return false;
        const ms = Number(key.slice(1));
        return ms >= lo && ms <= hi;
      };
      const captions = Object.fromEntries(
        Object.entries(state.doc.captions).filter(([key]) => !inInterval(key)),
      );
      const captionWordsHidden = Object.fromEntries(
        Object.entries(state.doc.captionWordsHidden).filter(([key]) => !inInterval(key)),
      );
      // The LINE TIMING layer scrubs on the same interval (2026-08-19
      // review). Its keys are a line's FIRST word's anchor, so a rewrite
      // covering that word re-mints it and the nudge dangles forever: core
      // reports `found: null` and the banner misdiagnoses it as "the cut
      // removed the caption you nudged" — nothing else prunes these records
      // anywhere. A nudge on a line whose first word survives OUTSIDE the
      // interval keeps its key and rides along, which is correct: that
      // caption is still there and still moved.
      const captionLineTiming = Object.fromEntries(
        Object.entries(state.doc.captionLineTiming).filter(([key]) => !inInterval(key)),
      );
      // The WINDOW layer scrubs on the same interval, same hazard as the
      // timing keys above (2026-08-26 review): its keys are a line's FIRST
      // word's anchor too, and nothing else prunes these records anywhere.
      const captionLineWindows = Object.fromEntries(
        Object.entries(state.doc.captionLineWindows).filter(([key]) => !inInterval(key)),
      );
      const captionRangeEdits = [
        ...state.doc.captionRangeEdits.filter((e) => {
          const eLo = Math.min(Number(e.fromKey.slice(1)), Number(e.toKey.slice(1)));
          const eHi = Math.max(Number(e.fromKey.slice(1)), Number(e.toKey.slice(1)));
          return eHi < lo || eLo > hi;
        }),
        { fromKey, toKey, text, was },
      ];
      return commit({
        ...state.doc,
        captions,
        captionWordsHidden,
        captionLineTiming,
        captionLineWindows,
        captionRangeEdits,
      });
    }
    case "patchCaptionAllOccurrences": {
      // The `patchCaption` case's semantics, folded over every entry against
      // ONE draft map (see the action docstring): per-key `captionEditWas`
      // keeps each occurrence's guard anchored to ITS base text, and
      // text===was clears that key (the clearVideo rule) instead of storing
      // an override restating the base.
      let captions = state.doc.captions;
      let changed = false;
      for (const entry of action.entries) {
        const key = captionKeyFor(entry.srcStart);
        const was = captionEditWas(captions, key, entry.was);
        if (action.text === was) {
          if (!(key in captions)) continue;
          const { [key]: _dropped, ...rest } = captions;
          captions = rest;
          changed = true;
          continue;
        }
        const prev = captions[key];
        if (prev !== undefined && prev.text === action.text && prev.was === was) continue;
        captions = { ...captions, [key]: { text: action.text, was } };
        changed = true;
      }
      // An unchanged document must not mint an undo step (the restoreScene
      // no-op-guard shape) — unlike single `patchCaption`, a bulk apply can
      // legitimately find every occurrence already carrying the text.
      if (!changed) return state;
      return commit({ ...state.doc, captions });
    }
    case "patchCaptionRangeAllOccurrences": {
      const text = action.text.trim();
      // Empty is a cancel, the `patchCaptionRange` rule — deleting runs is
      // the hide layer's gesture, with its own confirm.
      if (!text) return state;
      let doc = state.doc;
      let changed = false;
      for (const entry of action.entries) {
        // `patchCaptionRange`'s full per-interval logic, on the DRAFT doc so
        // each occurrence's scrub sees the previous occurrences' work — one
        // commit at the end (the action docstring's one-gesture rule).
        const fromKey = captionKeyFor(entry.fromSrcStart);
        const toKey = captionKeyFor(entry.toSrcStart);
        const was = captionRangeEditWas(doc.captionRangeEdits, fromKey, toKey, entry.was);
        if (text === was) {
          // Back to the base run: DELETE this pair's entry (the clearVideo/
          // patchCaption rule), or skip when there is nothing to delete.
          const rest = doc.captionRangeEdits.filter(
            (e) => e.fromKey !== fromKey || e.toKey !== toKey,
          );
          if (rest.length === doc.captionRangeEdits.length) continue;
          doc = { ...doc, captionRangeEdits: rest };
          changed = true;
          continue;
        }
        const lo = Math.min(
          Math.round(entry.fromSrcStart * 1000),
          Math.round(entry.toSrcStart * 1000),
        );
        const hi = Math.max(
          Math.round(entry.fromSrcStart * 1000),
          Math.round(entry.toSrcStart * 1000),
        );
        const inInterval = (key: string): boolean => {
          // Parse, never coerce (the `patchCaptionRange` legacy-key guard,
          // the F7 lesson): a positional key ("17") is not source-time
          // addressable and must survive the scrub verbatim.
          if (isLegacyCaptionKey(key)) return false;
          const ms = Number(key.slice(1));
          return ms >= lo && ms <= hi;
        };
        doc = {
          ...doc,
          captions: Object.fromEntries(
            Object.entries(doc.captions).filter(([key]) => !inInterval(key)),
          ),
          captionWordsHidden: Object.fromEntries(
            Object.entries(doc.captionWordsHidden).filter(([key]) => !inInterval(key)),
          ),
          // The line-timing scrub, per occurrence — `patchCaptionRange`'s
          // rule and its full why: a re-minted first word leaves the nudge
          // keyed to a word no line begins on, dangling forever.
          captionLineTiming: Object.fromEntries(
            Object.entries(doc.captionLineTiming).filter(([key]) => !inInterval(key)),
          ),
          // The WINDOW scrub too — same first-word key, same dangle
          // (`patchCaptionRange`'s 2026-08-26 note).
          captionLineWindows: Object.fromEntries(
            Object.entries(doc.captionLineWindows).filter(([key]) => !inInterval(key)),
          ),
          captionRangeEdits: [
            ...doc.captionRangeEdits.filter((e) => {
              const eLo = Math.min(Number(e.fromKey.slice(1)), Number(e.toKey.slice(1)));
              const eHi = Math.max(Number(e.fromKey.slice(1)), Number(e.toKey.slice(1)));
              return eHi < lo || eLo > hi;
            }),
            { fromKey, toKey, text, was },
          ],
        };
        changed = true;
      }
      if (!changed) return state;
      return commit(doc);
    }
    case "patchCaptionLineTiming": {
      // Every entry folded onto ONE draft record and committed once (see the
      // action docstring) — the `hideCaptionWords`/`patchCaptionAllOccurrences`
      // shape.
      let timing = state.doc.captionLineTiming;
      let changed = false;
      for (const entry of action.entries) {
        const key = captionKeyFor(entry.srcStart);
        // Sub-millisecond both ways is "no nudge": DELETE the key rather than
        // storing deltas the render could never show (the clearVideo/
        // patchCaption rule). One drag writes both sides of a seam, so a
        // gesture legitimately mixes a real delta on the line the user moved
        // with a cleared one on the neighbour it moved back to base.
        if (Math.abs(entry.lead) < 0.001 && Math.abs(entry.tail) < 0.001) {
          if (!(key in timing)) continue;
          const { [key]: _dropped, ...rest } = timing;
          timing = rest;
          changed = true;
          continue;
        }
        // Already carrying exactly these deltas — a drag that ends where it
        // started must not mint an undo step (the `patchCaptionAllOccurrences`
        // guard; a re-drag routinely re-sends a neighbour's unchanged deltas).
        const prev = timing[key];
        if (prev !== undefined && prev.lead === entry.lead && prev.tail === entry.tail) continue;
        timing = { ...timing, [key]: { lead: entry.lead, tail: entry.tail } };
        changed = true;
      }
      // An unchanged document must not mint an undo step (the restoreScene
      // no-op-guard shape).
      if (!changed) return state;
      return commit({ ...state.doc, captionLineTiming: timing });
    }
    case "patchCaptionLineWindows": {
      // Every entry folded onto ONE draft record and committed once — one
      // Apply is one gesture (see the action docstring), the same shape as
      // `patchCaptionLineTiming` above.
      let windows = state.doc.captionLineWindows;
      let changed = false;
      for (const entry of action.entries) {
        const key = captionKeyFor(entry.srcStart);
        if (entry.window === null) {
          // Back on its derived position: DELETE the key rather than storing a
          // window that says what the derivation already says (the clearVideo/
          // patchCaption clear-override rule).
          if (!(key in windows)) continue;
          const { [key]: _dropped, ...rest } = windows;
          windows = rest;
          changed = true;
          continue;
        }
        // Already carrying exactly this window — an Apply that moved nothing
        // must not mint an undo step (`patchCaptionLineTiming`'s guard; the
        // widget re-sends every selected line's window on every Apply, so an
        // unchanged neighbour routinely comes back untouched).
        const prev = windows[key];
        if (
          prev !== undefined &&
          prev.srcStart === entry.window.srcStart &&
          prev.srcEnd === entry.window.srcEnd
        ) {
          continue;
        }
        windows = { ...windows, [key]: { ...entry.window } };
        changed = true;
      }
      // An unchanged document must not mint an undo step (the restoreScene
      // no-op-guard shape).
      if (!changed) return state;
      return commit({ ...state.doc, captionLineWindows: windows });
    }
    case "hideCaptionWords": {
      // ONE commit for the whole selection, however many words it holds —
      // "delete these four words" is one gesture and must be one undo step,
      // the same reasoning as patchCaptionStyleAll's bulk write.
      const hidden = { ...state.doc.captionWordsHidden };
      let added = false;
      for (const w of action.words) {
        const key = captionKeyFor(w.srcStart);
        // A key already present keeps its stored `was`: hiding an
        // already-hidden word again (a selection that swept over one) must not
        // overwrite the original guard text with whatever the caller saw —
        // same instinct as `captionEditWas` keeping the first edit's `was`.
        if (key in hidden) continue;
        hidden[key] = { was: w.was };
        added = true;
      }
      // Every word was already hidden — an unchanged document must not mint
      // an undo step (the restoreScene no-op-guard shape).
      if (!added) return state;
      return commit({ ...state.doc, captionWordsHidden: hidden });
    }
    case "restoreCaptionWords": {
      // DELETE the keys, never write a false-ish value — the restoreScene/
      // captionsHidden rule: an entry with nothing to say is still an
      // override, dead weight in every overrides.json saved after it.
      const hidden = { ...state.doc.captionWordsHidden };
      let removed = false;
      for (const srcStart of action.srcStarts) {
        const key = captionKeyFor(srcStart);
        if (!(key in hidden)) continue;
        delete hidden[key];
        removed = true;
      }
      if (!removed) return state;
      return commit({ ...state.doc, captionWordsHidden: hidden });
    }
    case "cutWords": {
      // "This word is gone" is ONE gesture, so BOTH layers land in ONE
      // commit (one undo step — the hideCaptionWords/patchCaptionStyleAll
      // rule): the hide entries make the caption disappear NOW, and the cut
      // removes the time range — live too when it carries a `src` (the
      // cut-review rework; `cutChunk`'s case above owns the whole argument),
      // on the next produce/Render otherwise. Produce then retires hide
      // entries the applied cut made redundant (`pruneHidesInsideCuts`,
      // packages/core/src/recut.ts), so the doc does not accumulate dead
      // keys.
      const hidden = { ...state.doc.captionWordsHidden };
      for (const w of action.words) {
        const key = captionKeyFor(w.srcStart);
        // A key already present keeps its stored `was` — the same
        // first-guard-wins rule as `hideCaptionWords` above.
        if (key in hidden) continue;
        hidden[key] = { was: w.was };
      }
      // Same two dedupe arms as `cutChunk` above, for the same reasons (that
      // case owns the argument): a src-less dispatch replaces only a src-less
      // entry at this exact window, a src-carrying one replaces only an entry
      // at the exact same SOURCE range.
      const cuts = state.doc.cuts.filter((c) =>
        c.src === undefined
          ? c.startSec !== action.startSec || c.endSec !== action.endSec
          : action.src === undefined ||
            c.src.startSec !== action.src.startSec ||
            c.src.endSec !== action.src.endSec,
      );
      return commit({
        ...state.doc,
        captionWordsHidden: hidden,
        cuts: [
          ...cuts,
          { startSec: action.startSec, endSec: action.endSec, ...(action.src ? { src: action.src } : {}) },
        ],
      });
    }
    case "setReasonEnabled": {
      const { reasons } = state.doc.cleanup;
      if (action.enabled) {
        // DELETE the key rather than writing true — the captionsHidden/
        // restoreScene rule: an entry restating the default is still an
        // override. Also swallows a tolerated on-disk `true` (schema comment)
        // instead of preserving it as dead weight. No-op guard first, so
        // re-enabling an already-enabled reason mints no undo step.
        if (!(action.reason in reasons)) return state;
        const { [action.reason]: _dropped, ...rest } = reasons;
        return commit({ ...state.doc, cleanup: { ...state.doc.cleanup, reasons: rest } });
      }
      if (reasons[action.reason] === false) return state;
      return commit({
        ...state.doc,
        cleanup: {
          ...state.doc.cleanup,
          reasons: { ...reasons, [action.reason]: false },
        },
      });
    }
    case "toggleKept": {
      // A degenerate span can never overlap anything (`vetoedRemovals`' strict
      // inequalities), so an entry for it would be permanently inert — refuse
      // rather than store dead weight.
      if (!(action.srcOut > action.srcIn)) return state;
      const { kept } = state.doc.cleanup;
      // Overlap, not endpoint equality (the action docstring): a re-produce
      // can shift a removal's boundary by a frame, and the entry that vetoed
      // it must still be the one this click removes.
      const rest = kept.filter((k) => !(k.srcIn < action.srcOut && k.srcOut > action.srcIn));
      const cleanup =
        rest.length < kept.length
          ? // Un-veto: the entries GO — the restoreChunk/restoreScene rule,
            // there is no "not vetoed" value for an entry to hold.
            { ...state.doc.cleanup, kept: rest }
          : { ...state.doc.cleanup, kept: [...kept, { srcIn: action.srcIn, srcOut: action.srcOut }] };
      return commit({ ...state.doc, cleanup });
    }
    case "dismissRemoval": {
      // "Not a <reason>" (cut-review rework, 2026-08-26): the classification
      // was wrong, so the marker leaves the lane and the material is
      // ordinary footage. Same degenerate-span refusal as toggleKept.
      if (!(action.srcOut > action.srcIn)) return state;
      const { kept, dismissed } = state.doc.cleanup;
      if (dismissed.some((d) => d.srcIn < action.srcOut && d.srcOut > action.srcIn)) return state;
      return commit({
        ...state.doc,
        cleanup: {
          ...state.doc.cleanup,
          // One state per range: a dismissal subsumes any overlapping veto —
          // "kept · retake" and "not a retake" cannot both be true.
          kept: kept.filter((k) => !(k.srcIn < action.srcOut && k.srcOut > action.srcIn)),
          dismissed: [...dismissed, { srcIn: action.srcIn, srcOut: action.srcOut }],
        },
      });
    }
    case "restoreDismissed": {
      const { dismissed } = state.doc.cleanup;
      // Overlap, not endpoint equality — the toggleKept rule: the entry that
      // dismissed a (possibly boundary-shifted) proposal is the one this
      // restore removes.
      const rest = dismissed.filter((d) => !(d.srcIn < action.srcOut && d.srcOut > action.srcIn));
      if (rest.length === dismissed.length) return state;
      return commit({
        ...state.doc,
        cleanup: { ...state.doc.cleanup, dismissed: rest },
      });
    }
    case "rekeyCaptionKeys": {
      // An empty mapping is the common answer (the re-decode agreed with the
      // stamps already there), and it must NOT commit: a no-op undo step in
      // the middle of the user's history is a ⌘Z that appears to do nothing.
      if (action.mapping.length === 0) return state;
      const { doc, reports } = rekeyCaptionRecords(state.doc, action.mapping);
      // Parked entries are named rather than silently dropped (§137's
      // never-misapply rule, which `rekeyCaptionRecords` carries) — console
      // is where the editor's other layer reports already land.
      for (const line of reports) console.warn(`caption re-key: ${line}`);
      return commit(doc);
    }
    case "patchSfx": {
      const slot = sfxSlot(state.doc);
      const prev = slot.edits[action.key];
      const next: SfxPlacementEdit = { ...prev };
      // Per FIELD, against the plan (see the action docstring): equal to what
      // the model planned ⇒ DELETE the field, so the placement goes back to
      // inheriting a later re-plan's value for it.
      if (action.patch.word !== undefined) {
        if (action.patch.word === action.planned.word) delete next.word;
        else next.word = action.patch.word;
      }
      if (action.patch.soundId !== undefined) {
        if (action.patch.soundId === action.planned.soundId) delete next.soundId;
        else next.soundId = action.patch.soundId;
      }
      if (action.patch.gain !== undefined) {
        // Absent in the plan means 1 (`resolveSfxCues`' `p.gain ?? 1`), so a
        // slider dragged back to 1 on an ungained placement clears itself.
        if (action.patch.gain === (action.planned.gain ?? 1)) delete next.gain;
        else next.gain = action.patch.gain;
      }
      // A gesture that changed nothing must not mint an undo step (the
      // restoreScene no-op-guard shape) — a drag that ends on the word it
      // started on re-sends the same value on every pointer-up.
      const same =
        prev !== undefined &&
        prev.word === next.word &&
        prev.soundId === next.soundId &&
        prev.gain === next.gain &&
        prev.muted === next.muted;
      if (same) return state;
      const edits = { ...slot.edits };
      // An entry with no fields left is an override with nothing to say — it
      // goes, rather than sitting in overrides.json as `{}` (the clearVideo
      // rule).
      if (Object.keys(next).length === 0) {
        if (prev === undefined) return state;
        delete edits[action.key];
      } else {
        edits[action.key] = next;
      }
      return commit(withSfx(state.doc, { ...slot, edits }), action.coalesce);
    }
    case "muteSfx": {
      const slot = sfxSlot(state.doc);
      const prev = slot.edits[action.key];
      if (prev?.muted === true) return state;
      return commit(
        withSfx(state.doc, {
          ...slot,
          // MERGED onto whatever is stored: a placement the user retimed and
          // then muted keeps its retime, so restoring it puts it back where
          // they dragged it rather than where the model planned it.
          edits: { ...slot.edits, [action.key]: { ...prev, muted: true } },
        }),
      );
    }
    case "restoreSfx": {
      const slot = sfxSlot(state.doc);
      const prev = slot.edits[action.key];
      if (prev?.muted !== true) return state;
      const { muted: _dropped, ...rest } = prev;
      const edits = { ...slot.edits };
      // Nothing else stored ⇒ the whole key goes: `muted: false` is an
      // override restating the default (the schema's own "restore DELETES the
      // key" rule), and `{}` is the same thing spelled differently.
      if (Object.keys(rest).length === 0) delete edits[action.key];
      else edits[action.key] = rest;
      return commit(withSfx(state.doc, { ...slot, edits }));
    }
    case "addSfx": {
      const slot = sfxSlot(state.doc);
      return commit(
        withSfx(state.doc, {
          ...slot,
          added: [
            ...slot.added,
            {
              id: mintSfxAddedId(action.soundId, action.word, slot.added),
              soundId: action.soundId,
              word: action.word,
              // Spread, not `gain: action.gain` — a default-gain add must not
              // grow a `gain: undefined` key (the `cutChunk` src rule).
              ...(action.gain !== undefined ? { gain: action.gain } : {}),
            },
          ],
        }),
      );
    }
    case "patchSfxAdded": {
      const slot = sfxSlot(state.doc);
      const i = slot.added.findIndex((a) => a.id === action.id);
      // A patch for an id nothing answers to is a caller bug, dropped rather
      // than stored as a placement with no sound (`addSplit`'s posture).
      if (i === -1) return state;
      const prev = slot.added[i]!;
      const next: SfxAddedPlacement = {
        ...prev,
        ...(action.patch.soundId !== undefined ? { soundId: action.patch.soundId } : {}),
        ...(action.patch.word !== undefined ? { word: action.patch.word } : {}),
        ...(action.patch.gain !== undefined ? { gain: action.patch.gain } : {}),
      };
      // The no-op guard again — a drag that lands where it started.
      if (next.soundId === prev.soundId && next.word === prev.word && next.gain === prev.gain) {
        return state;
      }
      const added = slot.added.slice();
      added[i] = next;
      return commit(withSfx(state.doc, { ...slot, added }), action.coalesce);
    }
    case "removeSfxAdded": {
      const slot = sfxSlot(state.doc);
      const added = slot.added.filter((a) => a.id !== action.id);
      if (added.length === slot.added.length) return state;
      return commit(withSfx(state.doc, { ...slot, added }));
    }
    case "patchTheme":
      return commit({ ...state.doc, theme: { ...state.doc.theme, ...action.patch } });
    case "undo": {
      if (state.past.length === 0) return state;
      const doc = state.past[state.past.length - 1]!;
      const past = state.past.slice(0, -1);
      // A commit after an undo must never merge into the burst it undid.
      return {
        doc,
        past,
        future: [...state.future, state.doc],
        savedAt: state.savedAt,
        dirty: past.length !== state.savedAt,
        lastCoalesce: null,
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const doc = state.future[state.future.length - 1]!;
      const past = [...state.past, state.doc];
      return {
        doc,
        past,
        future: state.future.slice(0, -1),
        savedAt: state.savedAt,
        dirty: past.length !== state.savedAt,
        lastCoalesce: null,
      };
    }
    case "saved":
      return { ...state, dirty: false, savedAt: state.past.length };
  }
}

/**
 * The hook the App consumes: reducer state plus named helpers, so components
 * dispatch by calling a function rather than constructing action objects.
 */
export function useEdits() {
  const [state, dispatch] = useReducer(editReducer, undefined, initialEditState);
  // The live cue list, for stamping anchors at save time (handoff-edit-
  // anchoring). A REF, not state: the cues are App's derived view of the doc
  // this hook already owns, so mirroring them as state here would re-render
  // on every keystroke for data `save()` alone reads.
  const cuesRef = useRef<readonly SceneCue[]>([]);

  const save = async (): Promise<void> => {
    // Stamped at the PUT, from the cues in memory — never from disk (see
    // stampSceneAnchors' doc comment for the mid-session re-render reason).
    // The in-memory doc deliberately stays UNstamped after a 200: a `load`
    // dispatch would clear undo history, and the stamp is recomputed on
    // every save anyway, so memory and disk converge without touching it.
    const stamped = stampSceneAnchors(state.doc, cuesRef.current);
    const res = await fetch("/api/overrides", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stamped),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "save failed");
    }
    dispatch({ type: "saved" });
  };

  return {
    doc: state.doc,
    dirty: state.dirty,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    load: (doc: OverrideDoc) => dispatch({ type: "load", doc }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    save,
    /** App feeds the live cue memo here so `save()` stamps against exactly
     * what the user is looking at — including split halves, whose ids are
     * what their edits address. */
    syncCues: (cues: readonly SceneCue[]) => {
      cuesRef.current = cues;
    },
    patchProps: (sceneId: string, patch: Record<string, unknown>, coalesce?: string) =>
      dispatch({ type: "patchProps", sceneId, patch, coalesce }),
    patchElement: (sceneId: string, elementId: string, patch: ElementTransform, coalesce?: string) =>
      dispatch({ type: "patchElement", sceneId, elementId, patch, coalesce }),
    clearElement: (sceneId: string, elementId: string) =>
      dispatch({ type: "clearElement", sceneId, elementId }),
    hideElement: (sceneId: string, elementId: string) =>
      dispatch({ type: "hideElement", sceneId, elementId }),
    restoreElement: (sceneId: string, elementId: string) =>
      dispatch({ type: "restoreElement", sceneId, elementId }),
    patchTiming: (sceneId: string, timing: SceneTiming) =>
      dispatch({ type: "patchTiming", sceneId, timing }),
    clearTiming: (sceneId: string) => dispatch({ type: "clearTiming", sceneId }),
    patchVideo: (
      sceneId: string,
      patch: { scale?: number; dy?: number; dx?: number; autoZoom?: boolean },
      coalesce?: string,
    ) => dispatch({ type: "patchVideo", sceneId, patch, coalesce }),
    clearVideo: (sceneId: string) => dispatch({ type: "clearVideo", sceneId }),
    patchPip: (
      sceneId: string,
      patch: { cornerRadius?: number; x?: number; y?: number },
      coalesce?: string,
    ) => dispatch({ type: "patchPip", sceneId, patch, coalesce }),
    clearPip: (sceneId: string) => dispatch({ type: "clearPip", sceneId }),
    patchCaptionY: (sceneId: string, y: number, coalesce?: string) =>
      dispatch({ type: "patchCaptionY", sceneId, y, coalesce }),
    patchCaptionScale: (sceneId: string, scale: number, coalesce?: string) =>
      dispatch({ type: "patchCaptionScale", sceneId, scale, coalesce }),
    clearCaptionStyle: (sceneId: string) => dispatch({ type: "clearCaptionStyle", sceneId }),
    patchCaptionStyleAll: (sceneIds: string[], style: { y?: number; scale?: number }) =>
      dispatch({ type: "patchCaptionStyleAll", sceneIds, ...style }),
    addSplit: (split: { at?: number; src?: number }) =>
      dispatch({ type: "addSplit", at: split.at, src: split.src }),
    setCaptionsHidden: (hidden: boolean) => dispatch({ type: "setCaptionsHidden", hidden }),
    hideScene: (sceneId: string) => dispatch({ type: "hideScene", sceneId }),
    restoreScene: (sceneId: string) => dispatch({ type: "restoreScene", sceneId }),
    /** `src` is OPTIONAL and its absence is meaningful: a writer with no
     * source mapper (no spans, no live map) falls back to the legacy
     * marked-only entry rather than storing a guessed source range — the
     * ⌘B/`addSplit` posture. Rounded to 1ms by the WRITE SITE (the reducer's
     * src-equality dedupe compares exactly). */
    cutChunk: (startSec: number, endSec: number, src?: { startSec: number; endSec: number }) =>
      dispatch({ type: "cutChunk", startSec, endSec, src }),
    restoreChunk: (index: number) => dispatch({ type: "restoreChunk", index }),
    patchGraphicRect: (sceneId: string, rect: GraphicRect, coalesce?: string) =>
      dispatch({ type: "patchGraphicRect", sceneId, rect, coalesce }),
    clearGraphicRect: (sceneId: string) => dispatch({ type: "clearGraphicRect", sceneId }),
    patchComponent: (sceneId: string, component: SceneComponentId) =>
      dispatch({ type: "patchComponent", sceneId, component }),
    patchLayout: (sceneId: string, layout: Layout) => dispatch({ type: "patchLayout", sceneId, layout }),
    patchCaption: (srcStart: number, text: string, was: string) =>
      dispatch({ type: "patchCaption", srcStart, text, was }),
    patchCaptionRange: (fromSrcStart: number, toSrcStart: number, text: string, was: string) =>
      dispatch({ type: "patchCaptionRange", fromSrcStart, toSrcStart, text, was }),
    patchCaptionAllOccurrences: (entries: Array<{ srcStart: number; was: string }>, text: string) =>
      dispatch({ type: "patchCaptionAllOccurrences", entries, text }),
    patchCaptionRangeAllOccurrences: (
      entries: Array<{ fromSrcStart: number; toSrcStart: number; was: string }>,
      text: string,
    ) => dispatch({ type: "patchCaptionRangeAllOccurrences", entries, text }),
    patchCaptionLineTiming: (
      entries: Array<{ srcStart: number; lead: number; tail: number }>,
    ) => dispatch({ type: "patchCaptionLineTiming", entries }),
    patchCaptionLineWindows: (
      entries: Array<{ srcStart: number; window: { srcStart: number; srcEnd: number } | null }>,
    ) => dispatch({ type: "patchCaptionLineWindows", entries }),
    hideCaptionWords: (words: Array<{ srcStart: number; was: string }>) =>
      dispatch({ type: "hideCaptionWords", words }),
    restoreCaptionWords: (srcStarts: number[]) =>
      dispatch({ type: "restoreCaptionWords", srcStarts }),
    /** `src` optional on the same terms as `cutChunk` above — and resolved
     * from the OLD clock (`oldToSourceSec`), because the window comes from
     * the transcript panel, which is timed against the last render. */
    cutWords: (
      words: Array<{ srcStart: number; was: string }>,
      startSec: number,
      endSec: number,
      src?: { startSec: number; endSec: number },
    ) => dispatch({ type: "cutWords", words, startSec, endSec, src }),
    setReasonEnabled: (reason: RemovalReason, enabled: boolean) =>
      dispatch({ type: "setReasonEnabled", reason, enabled }),
    toggleKept: (srcIn: number, srcOut: number) => dispatch({ type: "toggleKept", srcIn, srcOut }),
    dismissRemoval: (srcIn: number, srcOut: number) =>
      dispatch({ type: "dismissRemoval", srcIn, srcOut }),
    restoreDismissed: (srcIn: number, srcOut: number) =>
      dispatch({ type: "restoreDismissed", srcIn, srcOut }),
    rekeyCaptionKeys: (mapping: readonly StampMove[]) =>
      dispatch({ type: "rekeyCaptionKeys", mapping }),
    /** `planned` is the PLAN's values for this placement (the action's
     * docstring): the caller holds them on the marker it is editing, and they
     * are what makes a drag back onto the planned word clear the override
     * instead of pinning it. */
    patchSfx: (
      key: string,
      patch: { word?: number; soundId?: string; gain?: number },
      planned: { word: number; soundId: string; gain?: number },
      coalesce?: string,
    ) => dispatch({ type: "patchSfx", key, patch, planned, coalesce }),
    muteSfx: (key: string) => dispatch({ type: "muteSfx", key }),
    restoreSfx: (key: string) => dispatch({ type: "restoreSfx", key }),
    addSfx: (soundId: string, word: number, gain?: number) =>
      dispatch({ type: "addSfx", soundId, word, gain }),
    patchSfxAdded: (
      id: string,
      patch: { word?: number; soundId?: string; gain?: number },
      coalesce?: string,
    ) => dispatch({ type: "patchSfxAdded", id, patch, coalesce }),
    removeSfxAdded: (id: string) => dispatch({ type: "removeSfxAdded", id }),
    patchTheme: (patch: Record<string, unknown>) => dispatch({ type: "patchTheme", patch }),
  };
}
