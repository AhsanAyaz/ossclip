import { useReducer } from "react";
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
  restoreElement,
  setElementTransform,
  type ElementTransform,
  type Layout,
  type OverrideDoc,
  type SceneComponentId,
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
  | { type: "patchTiming"; sceneId: string; startSec: number; endSec: number }
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
  | { type: "addSplit"; t: number }
  | { type: "clearTiming"; sceneId: string }
  /** The global Captions switch (doc-global `captionsHidden`) — one action
   * for both directions rather than a hide/restore pair, because the UI is
   * a single checkbox whose next state it already knows; the reducer keeps
   * the hideScene/restoreScene semantics (write `true` / DELETE the key,
   * no-op guard) either way. */
  | { type: "setCaptionsHidden"; hidden: boolean }
  | { type: "hideScene"; sceneId: string }
  | { type: "restoreScene"; sceneId: string }
  | { type: "cutChunk"; startSec: number; endSec: number }
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
   * current render-props frame, same as `cutChunk`. */
  | {
      type: "cutWords";
      words: Array<{ srcStart: number; was: string }>;
      startSec: number;
      endSec: number;
    }
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
            timing: { startSec: action.startSec, endSec: action.endSec },
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
      // Dedupe within a millisecond: a repeated Cmd+B on the same paused
      // frame is one decision, not a stack of coincident cuts.
      if (state.doc.splits.some((s) => Math.abs(s.at - action.t) < 0.001)) return state;
      // The id is minted HERE, once, and never recomputed (§137). The dedupe
      // above cannot stand in for uniqueness: it compares `at`, and a split
      // re-anchored by a re-cut keeps an id derived from a time it no longer
      // sits at — so `mintSplitId` checks the ids themselves.
      return commit({
        ...state.doc,
        splits: [
          ...state.doc.splits,
          { at: action.t, id: mintSplitId(action.t, state.doc.splits) },
        ].sort((a, b) => a.at - b.at),
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
      // the WINDOW ITSELF for removal from the output, TAKE or SCENE alike,
      // and takes effect on the next produce/Render (App.tsx's `live` memo
      // never reads `doc.cuts` — see its own comment for why).
      //
      // Writes ONLY `{startSec, endSec}` — never a `src` (the schema
      // comment on `OverrideDocSchema.cuts`, packages/core/src/overrides.ts:
      // `src` is produce's own resolved source anchor, and the editor must
      // never write or preserve one).
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
      const cuts = state.doc.cuts.filter(
        (c) => c.src !== undefined || c.startSec !== action.startSec || c.endSec !== action.endSec,
      );
      return commit({
        ...state.doc,
        cuts: [...cuts, { startSec: action.startSec, endSec: action.endSec }],
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
      // rule): the hide entries make the caption disappear NOW (the live
      // preview deliberately never applies `doc.cuts` — App.tsx's `live`
      // memo has the why), and the cut removes the time range on the next
      // produce/Render. Produce then retires hide entries the applied cut
      // made redundant (`pruneHidesInsideCuts`, packages/core/src/recut.ts),
      // so the doc does not accumulate dead keys.
      const hidden = { ...state.doc.captionWordsHidden };
      for (const w of action.words) {
        const key = captionKeyFor(w.srcStart);
        // A key already present keeps its stored `was` — the same
        // first-guard-wins rule as `hideCaptionWords` above.
        if (key in hidden) continue;
        hidden[key] = { was: w.was };
      }
      // Writes ONLY `{startSec, endSec}` — never a `src` — and the filter
      // replaces ONLY an existing SRC-LESS entry at this exact window: see
      // `cutChunk` above for the whole argument (a src-anchored entry
      // sharing the window is a settled, independent decision).
      const cuts = state.doc.cuts.filter(
        (c) => c.src !== undefined || c.startSec !== action.startSec || c.endSec !== action.endSec,
      );
      return commit({
        ...state.doc,
        captionWordsHidden: hidden,
        cuts: [...cuts, { startSec: action.startSec, endSec: action.endSec }],
      });
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

  const save = async (): Promise<void> => {
    const res = await fetch("/api/overrides", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.doc),
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
    patchTiming: (sceneId: string, startSec: number, endSec: number) =>
      dispatch({ type: "patchTiming", sceneId, startSec, endSec }),
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
    addSplit: (t: number) => dispatch({ type: "addSplit", t }),
    setCaptionsHidden: (hidden: boolean) => dispatch({ type: "setCaptionsHidden", hidden }),
    hideScene: (sceneId: string) => dispatch({ type: "hideScene", sceneId }),
    restoreScene: (sceneId: string) => dispatch({ type: "restoreScene", sceneId }),
    cutChunk: (startSec: number, endSec: number) => dispatch({ type: "cutChunk", startSec, endSec }),
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
    hideCaptionWords: (words: Array<{ srcStart: number; was: string }>) =>
      dispatch({ type: "hideCaptionWords", words }),
    restoreCaptionWords: (srcStarts: number[]) =>
      dispatch({ type: "restoreCaptionWords", srcStarts }),
    cutWords: (words: Array<{ srcStart: number; was: string }>, startSec: number, endSec: number) =>
      dispatch({ type: "cutWords", words, startSec, endSec }),
    patchTheme: (patch: Record<string, unknown>) => dispatch({ type: "patchTheme", patch }),
  };
}
