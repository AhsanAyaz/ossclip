import { useReducer } from "react";
import {
  clearElementTransform,
  clearTiming,
  emptyOverrideDoc,
  setElementTransform,
  type ElementTransform,
  type Layout,
  type OverrideDoc,
  type SceneComponentId,
} from "@ossclip/core/browser";

export interface EditState {
  doc: OverrideDoc;
  /** Snapshots, newest last. Undo is free because the doc is plain JSON. */
  past: OverrideDoc[];
  dirty: boolean;
  /** History length at the last save, so undoing past it re-marks dirty. */
  savedAt: number;
}

export type EditAction =
  | { type: "load"; doc: OverrideDoc }
  | { type: "patchProps"; sceneId: string; patch: Record<string, unknown> }
  | { type: "patchElement"; sceneId: string; elementId: string; patch: ElementTransform }
  | { type: "clearElement"; sceneId: string; elementId: string }
  | { type: "patchTiming"; sceneId: string; startSec: number; endSec: number }
  | { type: "clearTiming"; sceneId: string }
  | { type: "patchComponent"; sceneId: string; component: SceneComponentId }
  | { type: "patchLayout"; sceneId: string; layout: Layout }
  | { type: "patchTheme"; patch: Record<string, unknown> }
  | { type: "undo" }
  | { type: "saved" };

export const initialEditState = (): EditState => ({
  doc: emptyOverrideDoc(),
  past: [],
  dirty: false,
  savedAt: 0,
});

const withScene = (doc: OverrideDoc, id: string) =>
  doc.scenes[id] ?? { props: {}, elements: {} };

export function editReducer(state: EditState, action: EditAction): EditState {
  const commit = (doc: OverrideDoc): EditState => ({
    doc,
    past: [...state.past, state.doc],
    dirty: true,
    savedAt: state.savedAt,
  });

  switch (action.type) {
    case "load":
      return { doc: action.doc, past: [], dirty: false, savedAt: 0 };
    case "patchProps": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: {
          ...state.doc.scenes,
          [action.sceneId]: { ...scene, props: { ...scene.props, ...action.patch } },
        },
      });
    }
    case "patchElement":
      return commit(
        setElementTransform(state.doc, action.sceneId, action.elementId, action.patch),
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
    case "patchComponent": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, component: action.component } },
      });
    }
    case "patchLayout": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: { ...state.doc.scenes, [action.sceneId]: { ...scene, layout: action.layout } },
      });
    }
    case "patchTheme":
      return commit({ ...state.doc, theme: { ...state.doc.theme, ...action.patch } });
    case "undo": {
      if (state.past.length === 0) return state;
      const doc = state.past[state.past.length - 1]!;
      const past = state.past.slice(0, -1);
      return { doc, past, savedAt: state.savedAt, dirty: past.length !== state.savedAt };
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
    patchProps: (sceneId: string, patch: Record<string, unknown>) =>
      dispatch({ type: "patchProps", sceneId, patch }),
    patchElement: (sceneId: string, elementId: string, patch: ElementTransform) =>
      dispatch({ type: "patchElement", sceneId, elementId, patch }),
    clearElement: (sceneId: string, elementId: string) =>
      dispatch({ type: "clearElement", sceneId, elementId }),
    patchTiming: (sceneId: string, startSec: number, endSec: number) =>
      dispatch({ type: "patchTiming", sceneId, startSec, endSec }),
    clearTiming: (sceneId: string) => dispatch({ type: "clearTiming", sceneId }),
    patchComponent: (sceneId: string, component: SceneComponentId) =>
      dispatch({ type: "patchComponent", sceneId, component }),
    patchLayout: (sceneId: string, layout: Layout) => dispatch({ type: "patchLayout", sceneId, layout }),
    patchTheme: (patch: Record<string, unknown>) => dispatch({ type: "patchTheme", patch }),
  };
}
