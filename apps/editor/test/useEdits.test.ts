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

describe("graphic box editing (PLAN 2026-07-31 Task 2)", () => {
  it("patchGraphicRect stores the rect; a layout swap clears it", () => {
    let s = editReducer(initialEditState(), {
      type: "patchGraphicRect", sceneId: "scene-0", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    });
    expect(s.doc.scenes["scene-0"]!.graphicRect).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 });
    // The rect belongs to the OLD layout's slot — a swap must not let it
    // silently keep winning over the new layout at render time.
    s = editReducer(s, { type: "patchLayout", sceneId: "scene-0", layout: "graphic-only" });
    expect(s.doc.scenes["scene-0"]!.graphicRect).toBeUndefined();
    expect(s.doc.scenes["scene-0"]!.layout).toBe("graphic-only");
  });

  it("clearGraphicRect deletes the key via the reducer", () => {
    let s = editReducer(initialEditState(), {
      type: "patchGraphicRect", sceneId: "scene-0", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    });
    s = editReducer(s, { type: "clearGraphicRect", sceneId: "scene-0" });
    expect("graphicRect" in s.doc.scenes["scene-0"]!).toBe(false);
  });
});

describe("caption position and size (R15 §56 / R16 §64)", () => {
  it("patchCaptionY / patchCaptionScale store; clearCaptionStyle DELETES both keys", () => {
    let s = editReducer(initialEditState(), { type: "patchCaptionY", sceneId: "scene-0", y: 0.3 });
    s = editReducer(s, { type: "patchCaptionScale", sceneId: "scene-0", scale: 1.4 });
    expect(s.doc.scenes["scene-0"]!.captionY).toBe(0.3);
    expect(s.doc.scenes["scene-0"]!.captionScale).toBe(1.4);
    s = editReducer(s, { type: "clearCaptionStyle", sceneId: "scene-0" });
    expect("captionY" in s.doc.scenes["scene-0"]!).toBe(false);
    expect("captionScale" in s.doc.scenes["scene-0"]!).toBe(false);
    expect(editReducer(s, { type: "clearCaptionStyle", sceneId: "scene-0" }).doc).toBe(s.doc);
  });

  it("patchCaptionStyleAll writes every scene in ONE commit — one undo step", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionStyleAll",
      sceneIds: ["scene-0", "scene-2", "take-0"],
      y: 0.85,
      scale: 1.3,
    });
    for (const id of ["scene-0", "scene-2", "take-0"]) {
      expect(s.doc.scenes[id]!.captionY).toBe(0.85);
      expect(s.doc.scenes[id]!.captionScale).toBe(1.3);
    }
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes).toEqual({});
  });

  it("keeps a scene's other edits when fanning out, and skips absent fields", () => {
    let s = editReducer(initialEditState(), {
      type: "patchVideo", sceneId: "scene-0", patch: { scale: 0.8 },
    });
    s = editReducer(s, { type: "patchCaptionStyleAll", sceneIds: ["scene-0"], y: 0.2 });
    expect(s.doc.scenes["scene-0"]!.video!.scale).toBe(0.8);
    expect("captionScale" in s.doc.scenes["scene-0"]!).toBe(false);
  });
});

describe("scene splits (R16 §61)", () => {
  it("addSplit stores sorted, dedupes within a millisecond", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", t: 7.5 });
    s = editReducer(s, { type: "addSplit", t: 2.25 });
    expect(s.doc.splits).toEqual([2.25, 7.5]);
    // A repeated ⌘B on the same paused frame is one decision.
    expect(editReducer(s, { type: "addSplit", t: 7.5004 })).toBe(s);
  });

  it("splits undo like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", t: 7.5 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.splits).toEqual([]);
  });
});

describe("caption retype re-edit (R15 §59)", () => {
  it("a second edit of the same word keeps the BASE was, so the guard holds", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", index: 4, text: "hello", was: "helo",
    });
    // The re-editor sees the LIVE text ("hello") — the stored guard must
    // stay anchored to the base ("helo") or applyCaptionEdits drops it.
    s = editReducer(s, { type: "patchCaption", index: 4, text: "hullo", was: "hello" });
    expect(s.doc.captions["4"]).toEqual({ text: "hullo", was: "helo" });
  });

  it("retyping back to the BASE text clears the override, even via the live text", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", index: 4, text: "hello", was: "helo",
    });
    s = editReducer(s, { type: "patchCaption", index: 4, text: "helo", was: "hello" });
    expect("4" in s.doc.captions).toBe(false);
  });
});

describe("pip bubble editing (R14 §52)", () => {
  it("patchPip merges field by field, like patchVideo", () => {
    let s = editReducer(initialEditState(), {
      type: "patchPip", sceneId: "scene-0", patch: { cornerRadius: 0.3 },
    });
    s = editReducer(s, { type: "patchPip", sceneId: "scene-0", patch: { y: 0.2 } });
    expect(s.doc.scenes["scene-0"]!.pip).toEqual({ cornerRadius: 0.3, y: 0.2 });
  });

  it("clearPip DELETES the key — a pip restating the defaults is still an override", () => {
    let s = editReducer(initialEditState(), {
      type: "patchPip", sceneId: "scene-0", patch: { cornerRadius: 1 },
    });
    s = editReducer(s, { type: "clearPip", sceneId: "scene-0" });
    expect("pip" in s.doc.scenes["scene-0"]!).toBe(false);
  });

  it("clearPip on a scene without one is a no-op", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "clearPip", sceneId: "scene-0" })).toBe(s);
  });

  it("a layout swap KEEPS the pip — it re-applies when the scene returns to pip-bubble", () => {
    // Unlike the graphic rect (whose geometry belongs to one layout's slot),
    // the pip override is scoped at RENDER time: other layouts ignore it, so
    // there is nothing stale for a swap to leave behind.
    let s = editReducer(initialEditState(), {
      type: "patchPip", sceneId: "scene-0", patch: { cornerRadius: 0.2 },
    });
    s = editReducer(s, { type: "patchLayout", sceneId: "scene-0", layout: "video-top" });
    expect(s.doc.scenes["scene-0"]!.pip).toEqual({ cornerRadius: 0.2 });
  });
});
