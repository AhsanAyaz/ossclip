import { useReducer } from "react";
import {
  clearElementTransform,
  clearGraphicRect,
  clearTiming,
  emptyOverrideDoc,
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
  | { type: "patchTiming"; sceneId: string; startSec: number; endSec: number }
  | {
      type: "patchVideo";
      sceneId: string;
      patch: { scale?: number; dy?: number; dx?: number; autoZoom?: boolean };
      coalesce?: string;
    }
  | { type: "clearVideo"; sceneId: string }
  | { type: "clearTiming"; sceneId: string }
  | { type: "hideScene"; sceneId: string }
  | { type: "restoreScene"; sceneId: string }
  | { type: "patchGraphicRect"; sceneId: string; rect: GraphicRect; coalesce?: string }
  | { type: "clearGraphicRect"; sceneId: string }
  | { type: "patchComponent"; sceneId: string; component: SceneComponentId }
  | { type: "patchLayout"; sceneId: string; layout: Layout }
  | { type: "patchCaption"; index: number; text: string; was: string }
  | { type: "patchTheme"; patch: Record<string, unknown> }
  | { type: "undo" }
  | { type: "saved" };

export const initialEditState = (): EditState => ({
  doc: emptyOverrideDoc(),
  past: [],
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
      dirty: true,
      savedAt: state.savedAt,
      lastCoalesce: coalesce !== undefined ? { key: coalesce, at: now } : null,
    };
  };

  switch (action.type) {
    case "load":
      return { doc: action.doc, past: [], dirty: false, savedAt: 0, lastCoalesce: null };
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
      const key = String(action.index);
      if (action.text === action.was) {
        const { [key]: _dropped, ...rest } = state.doc.captions;
        return commit({ ...state.doc, captions: rest });
      }
      return commit({
        ...state.doc,
        captions: { ...state.doc.captions, [key]: { text: action.text, was: action.was } },
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
    load: (doc: OverrideDoc) => dispatch({ type: "load", doc }),
    undo: () => dispatch({ type: "undo" }),
    save,
    patchProps: (sceneId: string, patch: Record<string, unknown>, coalesce?: string) =>
      dispatch({ type: "patchProps", sceneId, patch, coalesce }),
    patchElement: (sceneId: string, elementId: string, patch: ElementTransform, coalesce?: string) =>
      dispatch({ type: "patchElement", sceneId, elementId, patch, coalesce }),
    clearElement: (sceneId: string, elementId: string) =>
      dispatch({ type: "clearElement", sceneId, elementId }),
    patchTiming: (sceneId: string, startSec: number, endSec: number) =>
      dispatch({ type: "patchTiming", sceneId, startSec, endSec }),
    clearTiming: (sceneId: string) => dispatch({ type: "clearTiming", sceneId }),
    patchVideo: (
      sceneId: string,
      patch: { scale?: number; dy?: number; dx?: number; autoZoom?: boolean },
      coalesce?: string,
    ) => dispatch({ type: "patchVideo", sceneId, patch, coalesce }),
    clearVideo: (sceneId: string) => dispatch({ type: "clearVideo", sceneId }),
    hideScene: (sceneId: string) => dispatch({ type: "hideScene", sceneId }),
    restoreScene: (sceneId: string) => dispatch({ type: "restoreScene", sceneId }),
    patchGraphicRect: (sceneId: string, rect: GraphicRect, coalesce?: string) =>
      dispatch({ type: "patchGraphicRect", sceneId, rect, coalesce }),
    clearGraphicRect: (sceneId: string) => dispatch({ type: "clearGraphicRect", sceneId }),
    patchComponent: (sceneId: string, component: SceneComponentId) =>
      dispatch({ type: "patchComponent", sceneId, component }),
    patchLayout: (sceneId: string, layout: Layout) => dispatch({ type: "patchLayout", sceneId, layout }),
    patchCaption: (index: number, text: string, was: string) =>
      dispatch({ type: "patchCaption", index, text, was }),
    patchTheme: (patch: Record<string, unknown>) => dispatch({ type: "patchTheme", patch }),
  };
}
