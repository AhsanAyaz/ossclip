import { describe, expect, it, vi } from "vitest";
import { COALESCE_MS, editReducer, initialEditState } from "../src/useEdits";

describe("edit state", () => {
  it("starts clean", () => {
    const s = initialEditState();
    expect(s.dirty).toBe(false);
    expect(s.past).toHaveLength(0);
  });

  it("marks dirty and pushes history on a prop patch", () => {
    const s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "999%" },
    });
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("999%");
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
  });

  it("undoes to the previous document", () => {
    let s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "999%" },
    });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-0"]?.props.value).toBeUndefined();
  });

  it("clears dirty on save, and undoing past the save marks it dirty again", () => {
    let s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "9%" },
    });
    s = editReducer(s, { type: "saved" });
    expect(s.dirty).toBe(false);
    s = editReducer(s, { type: "undo" });
    expect(s.dirty).toBe(true);
  });

  it("records a timing patch as a pin", () => {
    const s = editReducer(initialEditState(), {
      type: "patchTiming", sceneId: "scene-0", startSec: 2, endSec: 6,
    });
    expect(s.doc.scenes["scene-0"]!.timing).toEqual({ startSec: 2, endSec: 6 });
  });
});

describe("undo coalescing (PLAN 2026-07-30 Task B5)", () => {
  const patch = (scale: number, coalesce?: string) =>
    ({ type: "patchVideo", sceneId: "scene-0", patch: { scale }, coalesce }) as const;

  it("collapses a same-key burst into ONE undo step", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let s = editReducer(initialEditState(), patch(0.6, "video:scene-0:scale"));
    s = editReducer(s, patch(0.62, "video:scene-0:scale"));
    s = editReducer(s, patch(0.625, "video:scene-0:scale"));
    expect(s.doc.scenes["scene-0"]!.video!.scale).toBe(0.625);
    expect(s.past).toHaveLength(1);
    // One undo lands BEFORE the burst, not mid-keystroke.
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-0"]?.video).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("never merges two gestures separated by more than the window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    let s = editReducer(initialEditState(), patch(0.6, "video:scene-0:scale"));
    now.mockReturnValue(1000 + COALESCE_MS + 1);
    s = editReducer(s, patch(0.7, "video:scene-0:scale"));
    expect(s.past).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("never merges different keys, or keyless commits (drags)", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let s = editReducer(initialEditState(), patch(0.6, "video:scene-0:scale"));
    s = editReducer(s, {
      type: "patchVideo", sceneId: "scene-0", patch: { dx: 5 }, coalesce: "video:scene-0:dx",
    });
    expect(s.past).toHaveLength(2);
    s = editReducer(s, patch(1.1));
    s = editReducer(s, patch(1.2));
    expect(s.past).toHaveLength(4);
    vi.restoreAllMocks();
  });

  it("a commit after an undo starts fresh instead of merging into the undone burst", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let s = editReducer(initialEditState(), patch(0.6, "video:scene-0:scale"));
    s = editReducer(s, { type: "undo" });
    s = editReducer(s, patch(0.9, "video:scene-0:scale"));
    expect(s.past).toHaveLength(1);
    expect(s.doc.scenes["scene-0"]!.video!.scale).toBe(0.9);
    vi.restoreAllMocks();
  });
});

describe("delete a scene with a way back (PLAN 2026-07-30 Task C)", () => {
  it("hideScene writes hidden: true", () => {
    const s = editReducer(initialEditState(), { type: "hideScene", sceneId: "scene-3" });
    expect(s.doc.scenes["scene-3"]!.hidden).toBe(true);
    expect(s.past).toHaveLength(1);
  });

  it("restoreScene DELETES the key rather than writing hidden: false", () => {
    let s = editReducer(initialEditState(), { type: "hideScene", sceneId: "scene-3" });
    s = editReducer(s, { type: "restoreScene", sceneId: "scene-3" });
    expect("hidden" in s.doc.scenes["scene-3"]!).toBe(false);
  });

  it("hiding keeps the scene's other edits so restore brings them back intact", () => {
    let s = editReducer(initialEditState(), {
      type: "patchVideo", sceneId: "scene-3", patch: { scale: 0.8 },
    });
    s = editReducer(s, { type: "hideScene", sceneId: "scene-3" });
    s = editReducer(s, { type: "restoreScene", sceneId: "scene-3" });
    expect(s.doc.scenes["scene-3"]!.video!.scale).toBe(0.8);
  });

  it("restoring a scene that is not hidden is a no-op", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "restoreScene", sceneId: "scene-3" })).toBe(s);
  });
});
