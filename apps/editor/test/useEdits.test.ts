// @vitest-environment jsdom
// jsdom for the ONE mounted suite at the bottom ("save() stamps scene
// anchors"): `save` closes over the hook's reducer state and its cues ref,
// so it is only reachable through a real mount. The reducer tests above are
// DOM-free and indifferent to the environment.
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  OverrideDocSchema,
  applyOverrides,
  atSplitPoints,
  splitCues,
  type SceneCue,
} from "@ossclip/core/browser";
import {
  COALESCE_MS,
  editReducer,
  initialEditState,
  mintAddedSceneId,
  unseenRefusal,
  useEdits,
} from "../src/useEdits";

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
      type: "patchTiming", sceneId: "scene-0", timing: { startSec: 2, endSec: 6 },
    });
    expect(s.doc.scenes["scene-0"]!.timing).toEqual({ startSec: 2, endSec: 6 });
  });

  it("stores a SRC-anchored timing patch verbatim — the reducer converts no clocks", () => {
    const s = editReducer(initialEditState(), {
      type: "patchTiming", sceneId: "scene-0", timing: { srcStart: 21, srcEnd: 25 },
    });
    expect(s.doc.scenes["scene-0"]!.timing).toEqual({ srcStart: 21, srcEnd: 25 });
    // Still one undo step, still the shape the schema accepts.
    expect(editReducer(s, { type: "undo" }).doc.scenes["scene-0"]?.timing).toBeUndefined();
  });
});

describe("a clip's speed and its resized window are one undo step", () => {
  // A pinned clip (dragged to 10..14), then a speed scrub that resizes it:
  // undo must land on the dragged window AND the old speed together, or the
  // clip plays at 1x in a block sized for 2x.
  const pinned = () =>
    editReducer(initialEditState(), {
      type: "patchTiming", sceneId: "clip-1", timing: { srcStart: 10, srcEnd: 14 },
    });
  const speed = (value: number, srcEnd: number) =>
    ({
      type: "patchProps",
      sceneId: "clip-1",
      patch: { speed: value },
      coalesce: "props:clip-1:speed",
      timing: { srcStart: 10, srcEnd },
    }) as const;

  it("writes both, and one undo restores both", () => {
    let s = editReducer(pinned(), speed(2, 12));
    expect(s.doc.scenes["clip-1"]!.props.speed).toBe(2);
    expect(s.doc.scenes["clip-1"]!.timing).toEqual({ srcStart: 10, srcEnd: 12 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["clip-1"]!.props.speed).toBeUndefined();
    expect(s.doc.scenes["clip-1"]!.timing).toEqual({ srcStart: 10, srcEnd: 14 });
  });

  it("a scrub coalesces like any slider: every tick's window, one step back", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let s = editReducer(pinned(), speed(1.5, 12.667));
    s = editReducer(s, speed(2, 12));
    expect(s.past).toHaveLength(2);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["clip-1"]!.props.speed).toBeUndefined();
    expect(s.doc.scenes["clip-1"]!.timing).toEqual({ srcStart: 10, srcEnd: 14 });
    vi.restoreAllMocks();
  });

  it("a props patch without a window leaves the pin as it was", () => {
    const s = editReducer(pinned(), { type: "patchProps", sceneId: "clip-1", patch: { muted: true } });
    expect(s.doc.scenes["clip-1"]!.timing).toEqual({ srcStart: 10, srcEnd: 14 });
    expect("timing" in editReducer(initialEditState(), speed(2, 12)).doc.scenes["clip-1"]!).toBe(true);
    expect(
      "timing" in
        editReducer(initialEditState(), { type: "patchProps", sceneId: "clip-1", patch: { speed: 2 } }).doc.scenes[
          "clip-1"
        ]!,
    ).toBe(false);
  });
});

describe("patchProps carries item pins and cleared props in the same step (graphic-editor-modal §6)", () => {
  const listDoc = () =>
    OverrideDocSchema.parse({
      scenes: {
        "scene-2": {
          props: { title: "OLD", items: ["A", "B"], kicker: "GONE SOON" },
          itemPins: { component: "BulletList", pins: [null, { src: 3.5, text: "B" }] },
        },
      },
    });
  const save = {
    type: "patchProps",
    sceneId: "scene-2",
    patch: { items: ["A", "B", "C"] },
    itemPins: { component: "BulletList", pins: [null, { src: 3.5, text: "B" }, null] },
    clearKeys: ["kicker"],
  } as const;

  it("writes the props, the pins and the removal as ONE undo step", () => {
    const before = { ...initialEditState(), doc: listDoc() };
    const s = editReducer(before, save);
    const scene = s.doc.scenes["scene-2"]!;
    expect(scene.props).toEqual({ title: "OLD", items: ["A", "B", "C"] });
    expect(scene.itemPins).toEqual(save.itemPins);
    expect(s.past).toHaveLength(1);
    expect(editReducer(s, { type: "undo" }).doc).toEqual(before.doc);
  });

  it("a key both patched and cleared ends absent: clearKeys names what the save leaves unset", () => {
    const s = editReducer(
      { ...initialEditState(), doc: listDoc() },
      { type: "patchProps", sceneId: "scene-2", patch: { kicker: "X" }, clearKeys: ["kicker"] },
    );
    expect("kicker" in s.doc.scenes["scene-2"]!.props).toBe(false);
  });

  it("without itemPins the stored marker is left as it was; with timing, the pin rides the same step", () => {
    const s = editReducer(
      { ...initialEditState(), doc: listDoc() },
      { type: "patchProps", sceneId: "scene-2", patch: { title: "NEW" }, timing: { srcStart: 3, srcEnd: 6 } },
    );
    expect(s.doc.scenes["scene-2"]!.itemPins).toEqual(listDoc().scenes["scene-2"]!.itemPins);
    expect(s.doc.scenes["scene-2"]!.timing).toEqual({ srcStart: 3, srcEnd: 6 });
    expect(s.past).toHaveLength(1);
  });

  it("the hook takes them as an options object, one undo step", () => {
    let api!: ReturnType<typeof useEdits>;
    const Harness = (): null => {
      api = useEdits();
      return null;
    };
    const root = createRoot(document.createElement("div"));
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => api.load(listDoc()));
    act(() =>
      api.patchProps("scene-2", save.patch, { itemPins: save.itemPins, clearKeys: [...save.clearKeys] }),
    );
    expect(api.doc.scenes["scene-2"]!.props).toEqual({ title: "OLD", items: ["A", "B", "C"] });
    expect(api.doc.scenes["scene-2"]!.itemPins).toEqual(save.itemPins);
    act(() => api.undo());
    expect(api.doc).toEqual(listDoc());
    act(() => root.unmount());
  });
});

describe("redo (R17 §80)", () => {
  const patch = (value: string) =>
    ({ type: "patchProps", sceneId: "scene-0", patch: { value } }) as const;

  it("redo restores what undo took back, step by step", () => {
    let s = editReducer(initialEditState(), patch("1%"));
    s = editReducer(s, patch("2%"));
    s = editReducer(s, { type: "undo" });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-0"]?.props.value).toBeUndefined();
    s = editReducer(s, { type: "redo" });
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("1%");
    s = editReducer(s, { type: "redo" });
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("2%");
    // The branch is spent — a further redo is a no-op, same object.
    expect(editReducer(s, { type: "redo" })).toBe(s);
  });

  it("a NEW edit after undo abandons the redo branch — the universal contract", () => {
    let s = editReducer(initialEditState(), patch("1%"));
    s = editReducer(s, { type: "undo" });
    s = editReducer(s, patch("9%"));
    expect(editReducer(s, { type: "redo" })).toBe(s);
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("9%");
  });

  it("redo across a save boundary tracks dirty honestly", () => {
    let s = editReducer(initialEditState(), patch("1%"));
    s = editReducer(s, { type: "saved" });
    s = editReducer(s, { type: "undo" });
    expect(s.dirty).toBe(true);
    // Redo returns to exactly the saved document — clean again.
    s = editReducer(s, { type: "redo" });
    expect(s.dirty).toBe(false);
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("1%");
  });

  it("redo on a fresh state is a no-op", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "redo" })).toBe(s);
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

describe("clearProp — an optional prop back to absent (reveal-timing Task 7)", () => {
  // Unset `pacing` keeps a legacy scene on its legacy stagger; `pacing:"even"`
  // moves it to the paced reveal (Review Focus 5) — so "auto" must DELETE.
  const withPacing = () =>
    editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-2", patch: { pacing: "decelerate", revealSpeed: 0.4 },
    });

  it("deletes the key, keeps the scene's other props, and saves without it", () => {
    const s = editReducer(withPacing(), { type: "clearProp", sceneId: "scene-2", key: "pacing" });
    expect("pacing" in s.doc.scenes["scene-2"]!.props).toBe(false);
    expect(s.doc.scenes["scene-2"]!.props.revealSpeed).toBe(0.4);
    // What `save` writes: the parsed doc, serialized — no `pacing` anywhere.
    expect(JSON.stringify(OverrideDocSchema.parse(s.doc))).not.toContain("pacing");
  });

  it("is one undo step; undo brings the value back and redo clears it again", () => {
    let s = editReducer(withPacing(), { type: "clearProp", sceneId: "scene-2", key: "pacing" });
    expect(s.past).toHaveLength(2);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-2"]!.props.pacing).toBe("decelerate");
    s = editReducer(s, { type: "redo" });
    expect("pacing" in s.doc.scenes["scene-2"]!.props).toBe(false);
  });

  it("clearing a prop that is already absent is a no-op", () => {
    const s = withPacing();
    expect(editReducer(s, { type: "clearProp", sceneId: "scene-2", key: "entrance" })).toBe(s);
    const empty = initialEditState();
    expect(editReducer(empty, { type: "clearProp", sceneId: "scene-2", key: "pacing" })).toBe(empty);
  });
});

describe("delete an individual element with a way back (PLAN Task 2)", () => {
  it("hideElement writes hidden: true onto that element's entry", () => {
    const s = editReducer(initialEditState(), {
      type: "hideElement", sceneId: "scene-3", elementId: "message-1",
    });
    expect(s.doc.scenes["scene-3"]!.elements!["message-1"]).toEqual({ hidden: true });
    expect(s.past).toHaveLength(1);
  });

  it("restoreElement DELETES the hidden key — and, with no other fields left on this entry, the entry itself (review fix wave: an empty leftover would still shadow an inherited root nudge)", () => {
    let s = editReducer(initialEditState(), {
      type: "hideElement", sceneId: "scene-3", elementId: "message-1",
    });
    s = editReducer(s, { type: "restoreElement", sceneId: "scene-3", elementId: "message-1" });
    expect("message-1" in s.doc.scenes["scene-3"]!.elements).toBe(false);
  });

  it("hiding keeps a prior nudge so restore brings it back intact — unlike clearElement's full reset", () => {
    let s = editReducer(initialEditState(), {
      type: "patchElement", sceneId: "scene-3", elementId: "message-1", patch: { dx: 12, scale: 1.2 },
    });
    s = editReducer(s, { type: "hideElement", sceneId: "scene-3", elementId: "message-1" });
    s = editReducer(s, { type: "restoreElement", sceneId: "scene-3", elementId: "message-1" });
    expect(s.doc.scenes["scene-3"]!.elements!["message-1"]).toEqual({ dx: 12, scale: 1.2 });
  });

  it("restoring an element that is not hidden is a no-op", () => {
    const s = initialEditState();
    expect(
      editReducer(s, { type: "restoreElement", sceneId: "scene-3", elementId: "message-1" }),
    ).toBe(s);
  });

  it("hiding one element leaves a sibling element's own edits untouched", () => {
    let s = editReducer(initialEditState(), {
      type: "patchElement", sceneId: "scene-3", elementId: "message-0", patch: { dx: 4 },
    });
    s = editReducer(s, { type: "hideElement", sceneId: "scene-3", elementId: "message-1" });
    expect(s.doc.scenes["scene-3"]!.elements!["message-0"]).toEqual({ dx: 4 });
    expect(s.doc.scenes["scene-3"]!.elements!["message-1"]).toEqual({ hidden: true });
  });
});

describe("user cuts — Delete this chunk / Restore (PLAN 2026-08-04 Task 4c)", () => {
  it("a src-LESS cutChunk writes ONLY {startSec, endSec} — the legacy marked-only shape, byte-identical", () => {
    const s = editReducer(initialEditState(), { type: "cutChunk", startSec: 10, endSec: 14 });
    expect(s.doc.cuts).toEqual([{ startSec: 10, endSec: 14 }]);
    expect("src" in s.doc.cuts[0]!).toBe(false);
    expect(s.past).toHaveLength(1);
  });

  it("restoreChunk removes the entry at the given INDEX", () => {
    let s = editReducer(initialEditState(), { type: "cutChunk", startSec: 10, endSec: 14 });
    s = editReducer(s, { type: "restoreChunk", index: 0 });
    expect(s.doc.cuts).toEqual([]);
  });

  it("restoreChunk on an out-of-bounds index is a no-op (same state, not a new commit)", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "restoreChunk", index: 0 })).toBe(s);
    expect(editReducer(s, { type: "restoreChunk", index: -1 })).toBe(s);
  });

  it("cutting undoes like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "cutChunk", startSec: 10, endSec: 14 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.cuts).toEqual([]);
  });

  it("cutting a DIFFERENT window keeps both entries", () => {
    let s = editReducer(initialEditState(), { type: "cutChunk", startSec: 10, endSec: 14 });
    s = editReducer(s, { type: "cutChunk", startSec: 20, endSec: 22 });
    expect(s.doc.cuts).toEqual([
      { startSec: 10, endSec: 14 },
      { startSec: 20, endSec: 22 },
    ]);
  });

  // Fix round 2 (re-review, PLAN 2026-08-04 Task 4c): the SEAM-COINCIDENCE
  // scenario the reviewer pinned down. Cut [10, 15] → Render resolves it to
  // `{10, 15, src}` and shifts everything after 15 back by 5 — the block
  // that used to sit at [15, 20] now legitimately occupies [10, 15] in the
  // CURRENT render-props' frame, and the Inspector (correctly, per round 1)
  // offers "Delete this chunk" on it. The ORIGINAL implementation filtered
  // by window alone and would have silently deleted the APPLIED cut's own
  // entry here — src and all — the moment this fires.
  it("cutChunk NEVER touches a src-anchored entry at the same window — adds a second, independent entry instead", () => {
    const withAppliedCut = editReducer(initialEditState(), { type: "load", doc: {
      theme: {}, scenes: {}, captions: {}, splits: [],
      cuts: [{ startSec: 10, endSec: 15, src: { startSec: 43.4, endSec: 48.4 } }],
    } });

    const s = editReducer(withAppliedCut, { type: "cutChunk", startSec: 10, endSec: 15 });

    expect(s.doc.cuts).toHaveLength(2);
    // The applied entry survives, byte-for-byte, same src.
    expect(s.doc.cuts).toContainEqual({
      startSec: 10, endSec: 15, src: { startSec: 43.4, endSec: 48.4 },
    });
    // ...plus a FRESH, independent, src-less entry for the new decision.
    expect(s.doc.cuts).toContainEqual({ startSec: 10, endSec: 15 });
  });

  // A src-LESS dispatch dedupes on the WINDOW alone, exactly as it always
  // has: it replaces an EXISTING SRC-LESS entry at that window (a genuine
  // re-cut of a window nobody has produced yet) and never invents a `src` of
  // its own — a writer with no source mapper is the only thing that dispatches
  // this shape since the cut-review rework.
  it("cutChunk on a window whose EXISTING SRC-LESS entry is stale still writes a fresh, src-less replacement", () => {
    const withStaleCut = editReducer(initialEditState(), {
      type: "cutChunk", startSec: 10, endSec: 14,
    });

    const s = editReducer(withStaleCut, { type: "cutChunk", startSec: 10, endSec: 14 });

    expect(s.doc.cuts).toEqual([{ startSec: 10, endSec: 14 }]); // still exactly one
    expect("src" in s.doc.cuts[0]!).toBe(false);
  });

  // Cut-review rework (2026-08-26): the editor MAY write `src` now (the
  // schema comment on `OverrideDocSchema.cuts`), resolved by the WRITE SITE
  // off the preview clock and rounded there to 1ms. The reducer stores it
  // verbatim — it does no arithmetic on these numbers, which is what lets the
  // dedupe below compare them exactly.
  it("cutChunk stores a src the writer resolved, alongside the historical record", () => {
    const s = editReducer(initialEditState(), {
      type: "cutChunk", startSec: 5, endSec: 5, src: { startSec: 5.5, endSec: 6.5 },
    });
    expect(s.doc.cuts).toEqual([{ startSec: 5, endSec: 5, src: { startSec: 5.5, endSec: 6.5 } }]);
  });

  it("a REPEATED src cut at the same source range replaces its predecessor rather than stacking", () => {
    let s = editReducer(initialEditState(), {
      type: "cutChunk", startSec: 6, endSec: 7, src: { startSec: 8, endSec: 9 },
    });
    // The same gesture twice (a double-click) — the record may even differ,
    // the SOURCE range is the identity.
    s = editReducer(s, {
      type: "cutChunk", startSec: 6.001, endSec: 7, src: { startSec: 8, endSec: 9 },
    });
    expect(s.doc.cuts).toEqual([{ startSec: 6.001, endSec: 7, src: { startSec: 8, endSec: 9 } }]);
  });

  it("a src cut at a DIFFERENT source range keeps both — overlap is deliberately not merged", () => {
    // `subtractRangesFromCutlist` is set-like, so two overlapping removals
    // remove exactly what their union would; merging them would silently
    // rewrite entries the user can otherwise Restore one at a time.
    let s = editReducer(initialEditState(), {
      type: "cutChunk", startSec: 0, endSec: 1, src: { startSec: 8, endSec: 9 },
    });
    s = editReducer(s, {
      type: "cutChunk", startSec: 0, endSec: 1, src: { startSec: 8.5, endSec: 9.5 },
    });
    expect(s.doc.cuts).toHaveLength(2);
  });

  it("the src-LESS window filter is unchanged by the new arm: a src write still replaces a src-less entry at the SAME window, and the src-less arm still ignores src-carrying ones", () => {
    // Same window, same last-render frame ⇒ the same decision, re-made with
    // an anchor: one entry, not two. (The seam-coincidence rule guards the
    // other direction — a src-ANCHORED entry is never touched by a src-less
    // write, which the second half here pins.)
    const legacy = editReducer(initialEditState(), { type: "cutChunk", startSec: 10, endSec: 14 });
    const s = editReducer(legacy, {
      type: "cutChunk", startSec: 10, endSec: 14, src: { startSec: 20, endSec: 24 },
    });
    expect(s.doc.cuts).toEqual([
      { startSec: 10, endSec: 14, src: { startSec: 20, endSec: 24 } },
    ]);
    const back = editReducer(s, { type: "cutChunk", startSec: 10, endSec: 14 });
    expect(back.doc.cuts).toEqual([
      { startSec: 10, endSec: 14, src: { startSec: 20, endSec: 24 } },
      { startSec: 10, endSec: 14 },
    ]);
  });

  it("restoreChunk removes an entry even when it carries a resolved src", () => {
    const withSrcOnDisk = editReducer(initialEditState(), { type: "load", doc: {
      theme: {}, scenes: {}, captions: {}, splits: [],
      cuts: [{ startSec: 10, endSec: 14, src: { startSec: 43.4, endSec: 47.9 } }],
    } });
    const s = editReducer(withSrcOnDisk, { type: "restoreChunk", index: 0 });
    expect(s.doc.cuts).toEqual([]);
  });

  // The other half of the seam-coincidence fix: with BOTH a src-anchored
  // and a src-less entry sharing one window, restoreChunk must remove
  // EXACTLY the one its caller means — Timeline's seam passes the applied
  // entry's own index, Inspector's band Restore passes the src-less one's.
  // The ORIGINAL window-filter implementation would have deleted BOTH from
  // either click.
  it("restoreChunk by index removes exactly ONE of two entries sharing a window, never its sibling", () => {
    const doc = {
      theme: {}, scenes: {}, captions: {}, splits: [],
      cuts: [
        { startSec: 10, endSec: 15, src: { startSec: 43.4, endSec: 48.4 } }, // index 0: the seam
        { startSec: 10, endSec: 15 }, // index 1: the band
      ],
    };
    const loaded = editReducer(initialEditState(), { type: "load", doc });

    // The seam's Restore (index 0) removes only the applied entry.
    const seamRestored = editReducer(loaded, { type: "restoreChunk", index: 0 });
    expect(seamRestored.doc.cuts).toEqual([{ startSec: 10, endSec: 15 }]);

    // The band's Restore (index 1) removes only the fresh entry.
    const bandRestored = editReducer(loaded, { type: "restoreChunk", index: 1 });
    expect(bandRestored.doc.cuts).toEqual([
      { startSec: 10, endSec: 15, src: { startSec: 43.4, endSec: 48.4 } },
    ]);
  });
});

describe("graphic box editing (PLAN 2026-07-31 Task 2)", () => {
  it("patchGraphicRect stores the rect; a layout swap clears it", () => {
    let s = editReducer(initialEditState(), {
      type: "patchGraphicRect", sceneId: "scene-0", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    });
    expect(s.doc.scenes["scene-0"]!.graphicRect).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 });
    // The rect belongs to the OLD layout's slot — a swap must not let it
    // silently keep winning over the new layout at render time. From a
    // non-backdrop layout: between two backdrops the box is kept (below).
    s = editReducer(s, {
      type: "patchLayout", sceneId: "scene-0", layout: "graphic-only", from: "lower-third",
    });
    expect(s.doc.scenes["scene-0"]!.graphicRect).toBeUndefined();
    expect(s.doc.scenes["scene-0"]!.layout).toBe("graphic-only");
  });

  describe("a backdrop change keeps the box (scene-backdrop-choice design §2)", () => {
    const rect = { x: 0.14, y: 0.16, w: 0.72, h: 0.68 };
    const withRect = () =>
      editReducer(initialEditState(), { type: "patchGraphicRect", sceneId: "scene-0", rect });

    it("full-bleed → pip-bubble keeps the hand-set rect", () => {
      const s = editReducer(withRect(), {
        type: "patchLayout", sceneId: "scene-0", layout: "pip-bubble", from: "full-bleed",
      });
      expect(s.doc.scenes["scene-0"]!.graphicRect).toEqual(rect);
      expect(s.doc.scenes["scene-0"]!.layout).toBe("pip-bubble");
    });

    it("graphic-only → pip-bubble keeps it", () => {
      const s = editReducer(withRect(), {
        type: "patchLayout", sceneId: "scene-0", layout: "pip-bubble", from: "graphic-only",
      });
      expect(s.doc.scenes["scene-0"]!.graphicRect).toEqual(rect);
    });

    it("full-bleed → lower-third drops it: not a backdrop", () => {
      const s = editReducer(withRect(), {
        type: "patchLayout", sceneId: "scene-0", layout: "lower-third", from: "full-bleed",
      });
      expect(s.doc.scenes["scene-0"]!.graphicRect).toBeUndefined();
      expect(s.doc.scenes["scene-0"]!.layout).toBe("lower-third");
    });
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
  /** One take long enough to survive two splits and `SPLIT_MIN_PIECE_SEC`. */
  const splitTarget = (): SceneCue =>
    ({ id: "scene-0", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10 }) as SceneCue;

  it("addSplit stores sorted, dedupes within a millisecond", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", at: 7.5 });
    s = editReducer(s, { type: "addSplit", at: 2.25 });
    expect(s.doc.splits.map((x) => x.at)).toEqual([2.25, 7.5]);
    // Every split leaves here NAMEABLE. The exact value is §137's business
    // (`legacySplitId`), but an empty id would name the half `scene-0@` and
    // is only caught by the server's `safeParse` on Save, as a 400.
    expect(s.doc.splits.every((x) => x.id.length > 0)).toBe(true);
    // A repeated ⌘B on the same paused frame is one decision.
    expect(editReducer(s, { type: "addSplit", at: 7.5004 })).toBe(s);
  });

  it("a re-anchored split's old time coming round again gets its OWN id (§137)", () => {
    // The four-step field sequence: ⌘B at 1.2s mints `{at: 1.2, id: "1200"}`;
    // a 0.6s cut re-anchors it to `{at: 0.6, id: "1200"}` (the id is data now
    // and deliberately does NOT move); the user then presses ⌘B at 1.2s
    // again. The `.at` dedupe cannot see the collision — 0.6 is nowhere near
    // 1.2 — so a time-derived id would mint a SECOND "1200" and `splitCues`
    // would emit two cues both named `scene-0@1200`. `dropHiddenCues` filters
    // by exact id, so deleting one of those halves deletes both.
    let s = editReducer(initialEditState(), {
      type: "load",
      doc: OverrideDocSchema.parse({ splits: [{ at: 0.6, id: "1200" }] }),
    });
    s = editReducer(s, { type: "addSplit", at: 1.2 });

    expect(s.doc.splits).toHaveLength(2);
    expect(new Set(s.doc.splits.map((x) => x.id)).size).toBe(2);

    const halves = splitCues([splitTarget()], atSplitPoints(s.doc.splits));
    expect(halves).toHaveLength(3);
    expect(new Set(halves.map((c) => c.id)).size).toBe(3);
  });

  it("splits undo like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", at: 7.5 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.splits).toEqual([]);
  });
});

describe("a ⌘B on a take copies the piece's framing (take-framing-identity P1)", () => {
  const take = (): SceneCue =>
    ({ id: "take-1", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10 }) as SceneCue;
  const loaded = (doc: unknown) =>
    editReducer(initialEditState(), { type: "load", doc: OverrideDocSchema.parse(doc) });
  /** The split the last ⌘B minted — found by its anchor, so the tests never
   * restate `mintSplitId`'s derivation. */
  const minted = (s: ReturnType<typeof loaded>, src: number) => s.doc.splits.find((x) => x.src === src)!;

  it("17: splitting a root take copies its framing onto the new half, flags the split, and undoes in one step", () => {
    const before = loaded({ scenes: { "take-1": { video: { scale: 2, dx: 10 } } } });
    const s = editReducer(before, { type: "addSplit", at: 5, src: 5, targetId: "take-1" });
    const split = minted(s, 5);
    expect(s.doc.scenes[`take-1@${split.id}`]!.video).toEqual({ scale: 2, dx: 10 });
    expect(split.ownFraming).toBe(true);
    // One commit: the copy and the flag are one decision.
    expect(s.past).toHaveLength(before.past.length + 1);
    expect(editReducer(s, { type: "undo" }).doc).toEqual(before.doc);
  });

  it("18: splitting a flagged half copies that half's OWN framing, not its root's", () => {
    const s0 = loaded({
      scenes: { "take-1": { video: { scale: 2, dx: 10 } }, "take-1@s1": { video: { dx: -5 } } },
      splits: [{ at: 2, src: 2, id: "s1", ownFraming: true }],
    });
    const s = editReducer(s0, { type: "addSplit", at: 5, src: 5, targetId: "take-1@s1" });
    expect(s.doc.scenes[`take-1@${minted(s, 5).id}`]!.video).toEqual({ dx: -5 });
  });

  it("19: splitting an unflagged legacy half copies the framing it was showing (its root's)", () => {
    const s0 = loaded({
      scenes: { "take-1": { video: { scale: 2, dx: 10 } } },
      splits: [{ at: 2, src: 2, id: "s1" }],
    });
    const s = editReducer(s0, { type: "addSplit", at: 5, src: 5, targetId: "take-1@s1" });
    expect(s.doc.scenes[`take-1@${minted(s, 5).id}`]!.video).toEqual({ scale: 2, dx: 10 });
  });

  it("20: a root with no framing stores no half entry, still flags the split, and a later root reframe leaves the half alone", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", at: 5, src: 5, targetId: "take-1" });
    const split = minted(s, 5);
    expect(s.doc.scenes[`take-1@${split.id}`]).toBeUndefined();
    expect(split.ownFraming).toBe(true);
    s = editReducer(s, { type: "patchVideo", sceneId: "take-1", patch: { scale: 3 } });
    const { cues } = applyOverrides(splitCues([take()], atSplitPoints(s.doc.splits)), s.doc);
    expect(cues.find((c) => c.id === "take-1")!.video).toEqual({ scale: 3 });
    expect(cues.find((c) => c.id === `take-1@${split.id}`)!.video).toBeUndefined();
  });

  it("21: clearing either piece's framing leaves the other's", () => {
    const s0 = editReducer(loaded({ scenes: { "take-1": { video: { scale: 2 } } } }), {
      type: "addSplit", at: 5, src: 5, targetId: "take-1",
    });
    const half = `take-1@${minted(s0, 5).id}`;
    const halfCleared = editReducer(s0, { type: "clearVideo", sceneId: half });
    expect(halfCleared.doc.scenes["take-1"]!.video).toEqual({ scale: 2 });
    const rootCleared = editReducer(s0, { type: "clearVideo", sceneId: "take-1" });
    expect(rootCleared.doc.scenes[half]!.video).toEqual({ scale: 2 });
  });

  it("22: a duplicate ⌘B within a millisecond copies nothing", () => {
    const s0 = loaded({
      scenes: { "take-1": { video: { scale: 2 } } },
      splits: [{ at: 5, src: 5, id: "5000" }],
    });
    expect(editReducer(s0, { type: "addSplit", at: 5.0004, src: 5.0004, targetId: "take-1" })).toBe(s0);
  });

  it("23: a graphic or kept-block target behaves exactly as before — no copy, no flag", () => {
    for (const targetId of ["scene-2", "take-kept-5000"]) {
      const s0 = loaded({ scenes: { [targetId]: { video: { scale: 2 } } } });
      const s = editReducer(s0, { type: "addSplit", at: 5, src: 5, targetId });
      const split = minted(s, 5);
      expect(s.doc.scenes[`${targetId}@${split.id}`], targetId).toBeUndefined();
      expect(split.ownFraming, targetId).toBeUndefined();
    }
  });

  it("24: a stale entry under a reused half key has its framing replaced and its other fields kept", () => {
    const s0 = loaded({
      scenes: {
        "take-1": { video: { scale: 2 } },
        "take-1@5000": { captionY: 0.3, video: { dx: 1 }, pip: { x: 0.4 } },
      },
    });
    const s = editReducer(s0, { type: "addSplit", at: 5, src: 5, targetId: "take-1" });
    expect(minted(s, 5).id).toBe("5000");
    const half = s.doc.scenes["take-1@5000"]!;
    expect(half.video).toEqual({ scale: 2 });
    // The root has no pip, so the stale one goes: the copy is the framing
    // the piece was showing, field for field.
    expect(half.pip).toBeUndefined();
    expect(half.captionY).toBe(0.3);
  });
});

describe("look mode: take looks are written to source ranges (take-looks-by-source L4)", () => {
  // A migrated doc — `takeLooks` present is the marker (L3). The tail of
  // take-1 plays source 12..20 and already has a framing.
  const TAIL = [{ srcIn: 12, srcOut: 20 }];
  const migrated = (extra: Record<string, unknown> = {}) =>
    editReducer(initialEditState(), {
      type: "load",
      doc: OverrideDocSchema.parse({
        takeLooks: [{ srcIn: 12, srcOut: 20, look: { video: { scale: 2, dx: 10 } } }],
        ...extra,
      }),
    });

  it("patchTakeLook writes onto the piece's footage, and clearTakeLookFields is a real reset", () => {
    const s0 = migrated();
    const s1 = editReducer(s0, { type: "patchTakeLook", ranges: TAIL, patch: { captionY: 0.3 } });
    expect(s1.doc.takeLooks).toEqual([{ srcIn: 12, srcOut: 20, look: { video: { scale: 2, dx: 10 }, captionY: 0.3 } }]);
    expect(s1.doc.scenes).toEqual({});
    expect(s1.past).toHaveLength(1);
    const s2 = editReducer(s1, { type: "clearTakeLookFields", ranges: TAIL, fields: ["video"] });
    expect(s2.doc.takeLooks).toEqual([{ srcIn: 12, srcOut: 20, look: { captionY: 0.3 } }]);
    const s3 = editReducer(s2, { type: "clearTakeLookFields", ranges: TAIL, fields: ["captionY"] });
    // Nothing left to say: the entry goes, the marker stays (L3).
    expect(s3.doc.takeLooks).toEqual([]);
    expect(editReducer(s3, { type: "undo" }).doc).toEqual(s2.doc);
  });

  it("the framing unit is expanded from the part's own values: a dx patch keeps the stored scale (R6-2, R7-3)", () => {
    const s = editReducer(migrated(), { type: "patchTakeLook", ranges: TAIL, patch: { video: { dx: -4 } } });
    expect(s.doc.takeLooks![0]!.look.video).toEqual({ scale: 2, dx: -4 });
    // A member absent from the look and from the patch stays absent — never
    // written as a default.
    expect("dy" in s.doc.takeLooks![0]!.look.video!).toBe(false);
  });

  it("a coalesced drag is ONE undo step", () => {
    const key = "look:12:framing";
    let s = migrated();
    for (const dx of [1, 2, 3]) s = editReducer(s, { type: "patchTakeLook", ranges: TAIL, patch: { video: { dx } }, coalesce: key });
    expect(s.past).toHaveLength(1);
    expect(s.doc.takeLooks![0]!.look.video).toEqual({ scale: 2, dx: 3 });
    expect(editReducer(s, { type: "undo" }).doc).toEqual(migrated().doc);
  });

  it("a write that changes nothing makes no commit — the same state back (S1)", () => {
    const s = migrated();
    expect(editReducer(s, { type: "patchTakeLook", ranges: TAIL, patch: { video: { scale: 2 } } })).toBe(s);
    expect(editReducer(s, { type: "clearTakeLookFields", ranges: TAIL, fields: ["pip", "captionY"] })).toBe(s);
    expect(editReducer(s, { type: "patchTakeLook", ranges: [], patch: { captionY: 0.4 } })).toBe(s);
  });

  it("patchCaptionStyleAll writes graphics by id and takes by range, in ONE commit, dropping take ids (N6, R6-6)", () => {
    const s = editReducer(migrated(), {
      type: "patchCaptionStyleAll",
      sceneIds: ["scene-0", "take-1", "take-kept-5000", "added-1"],
      takeRanges: [[{ srcIn: 0, srcOut: 10 }], TAIL],
      y: 0.8,
      scale: 1.2,
    });
    expect(Object.keys(s.doc.scenes).sort()).toEqual(["added-1", "scene-0"]);
    expect(s.doc.scenes["scene-0"]).toMatchObject({ captionY: 0.8, captionScale: 1.2 });
    expect(s.doc.takeLooks).toEqual([
      { srcIn: 0, srcOut: 10, look: { captionY: 0.8, captionScale: 1.2 } },
      { srcIn: 12, srcOut: 20, look: { video: { scale: 2, dx: 10 }, captionY: 0.8, captionScale: 1.2 } },
    ]);
    expect(s.past).toHaveLength(1);
    expect(editReducer(s, { type: "undo" }).doc).toEqual(migrated().doc);
  });

  it("clearCaptionStyle on a take is refused: the look lives on source time, the reset is clearTakeLookFields", () => {
    const s0 = editReducer(migrated(), { type: "patchTakeLook", ranges: TAIL, patch: { captionY: 0.3, captionScale: 1.5 } });
    const refused = editReducer(s0, { type: "clearCaptionStyle", sceneId: "take-1" });
    expect(refused.doc).toBe(s0.doc);
    expect(refused.lastRefusal?.seq).toBe(1);
    const reset = editReducer(s0, { type: "clearTakeLookFields", ranges: TAIL, fields: ["captionY", "captionScale"] });
    expect(reset.doc.takeLooks).toEqual([{ srcIn: 12, srcOut: 20, look: { video: { scale: 2, dx: 10 } } }]);
  });

  it("every id-keyed look action on a look-piece id is refused with lastRefusal; graphics still write (R4-S4, R6-5)", () => {
    const s0 = migrated();
    const actions = [
      { type: "patchVideo", sceneId: "take-1", patch: { scale: 3 } },
      { type: "clearVideo", sceneId: "take-1@14000" },
      { type: "patchPip", sceneId: "take-kept-5000", patch: { x: 0.1 } },
      { type: "clearPip", sceneId: "take-2" },
      { type: "patchLayout", sceneId: "take-2-1", layout: "pip-bubble", from: "full-bleed" },
      { type: "patchCaptionY", sceneId: "take-1", y: 0.2 },
      { type: "patchCaptionScale", sceneId: "take-1", scale: 2 },
      { type: "clearCaptionStyle", sceneId: "take-kept-5000@s1" },
    ] as const;
    let s = s0;
    actions.forEach((action, i) => {
      const next = editReducer(s, action);
      expect(next.doc, action.type).toBe(s0.doc);
      expect(next.past, action.type).toBe(s0.past);
      expect(next.dirty, action.type).toBe(false);
      expect(next.lastRefusal, action.type).toEqual({ message: expect.any(String), seq: i + 1 });
      s = next;
    });
    // A graphic's look is still id-keyed in look mode.
    const g = editReducer(s0, { type: "patchVideo", sceneId: "scene-3", patch: { scale: 3 } });
    expect(g.doc.scenes["scene-3"]!.video).toEqual({ scale: 3 });
    expect(g.lastRefusal).toBeNull();
    // A legacy doc is untouched by the refusal: the same action writes.
    const legacy = editReducer(initialEditState(), { type: "patchVideo", sceneId: "take-1", patch: { scale: 3 } });
    expect(legacy.doc.scenes["take-1"]!.video).toEqual({ scale: 3 });
  });

  it("a look action on a legacy doc is refused, never invented", () => {
    const s0 = initialEditState();
    const s = editReducer(s0, { type: "patchTakeLook", ranges: TAIL, patch: { captionY: 0.3 } });
    expect(s.doc).toBe(s0.doc);
    expect(s.doc.takeLooks).toBeUndefined();
    expect(s.lastRefusal?.seq).toBe(1);
  });

  it("⌘B on a take adds ONLY the split: no copy, no ownFraming flag (L4)", () => {
    const s0 = migrated({ scenes: { "take-1": { hidden: true } } });
    const s = editReducer(s0, { type: "addSplit", at: 14, src: 14, targetId: "take-1" });
    expect(s.doc.splits).toEqual([{ at: 14, src: 14, id: s.doc.splits[0]!.id }]);
    expect(s.doc.scenes).toEqual(s0.doc.scenes);
    expect(s.doc.takeLooks).toEqual(s0.doc.takeLooks);
  });

  it("App shows each refusal once per seq, the same words included (R6-5)", () => {
    expect(unseenRefusal(null, 0)).toBeNull();
    expect(unseenRefusal({ message: "no", seq: 1 }, 0)).toBe("no");
    expect(unseenRefusal({ message: "no", seq: 1 }, 1)).toBeNull();
    expect(unseenRefusal({ message: "no", seq: 2 }, 1)).toBe("no");
  });

  it("load bumps loadCount and keeps the refusal seq growing", () => {
    let s = migrated();
    expect(s.loadCount).toBe(1);
    s = editReducer(s, { type: "patchVideo", sceneId: "take-1", patch: { scale: 3 } });
    s = editReducer(s, { type: "load", doc: s.doc });
    expect(s.loadCount).toBe(2);
    s = editReducer(s, { type: "patchVideo", sceneId: "take-1", patch: { scale: 3 } });
    expect(s.lastRefusal?.seq).toBe(2);
  });
});

describe("caption retype re-edit (R15 §59)", () => {
  // Keyed by the word's SOURCE start since §137 — 4.0s here, where this used
  // to say `index: 4`. The re-edit semantics below are unchanged; only the
  // key space moved.
  it("a second edit of the same word keeps the BASE was, so the guard holds", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "hello", was: "helo",
    });
    // The re-editor sees the LIVE text ("hello") — the stored guard must
    // stay anchored to the base ("helo") or applyCaptionEdits drops it.
    s = editReducer(s, { type: "patchCaption", srcStart: 4, text: "hullo", was: "hello" });
    expect(s.doc.captions.w4000).toEqual({ text: "hullo", was: "helo" });
  });

  it("retyping back to the BASE text clears the override, even via the live text", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "hello", was: "helo",
    });
    s = editReducer(s, { type: "patchCaption", srcStart: 4, text: "helo", was: "hello" });
    expect("w4000" in s.doc.captions).toBe(false);
  });
});

describe("caption word hide / restore (§59b, revisited 2026-08-18)", () => {
  it("hides a whole selection in ONE commit — one undo step restores every word", () => {
    let s = editReducer(initialEditState(), {
      type: "hideCaptionWords",
      words: [
        { srcStart: 4, was: "hello" },
        { srcStart: 5.5, was: "world" },
      ],
    });
    expect(s.doc.captionWordsHidden).toEqual({
      w4000: { was: "hello" },
      w5500: { was: "world" },
    });
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionWordsHidden).toEqual({});
  });

  it("skips already-hidden keys — the original `was` guard survives a re-hide", () => {
    const first = editReducer(initialEditState(), {
      type: "hideCaptionWords",
      words: [{ srcStart: 4, was: "hello" }],
    });
    // Re-hiding with a different observed text must not overwrite the stored
    // guard: `was` anchors the stale check, like `captionEditWas` for retypes.
    const mixed = editReducer(first, {
      type: "hideCaptionWords",
      words: [
        { srcStart: 4, was: "hullo" },
        { srcStart: 6, was: "there" },
      ],
    });
    expect(mixed.doc.captionWordsHidden).toEqual({
      w4000: { was: "hello" },
      w6000: { was: "there" },
    });
  });

  it("mints NO undo step when every word is already hidden — same state object", () => {
    const s = editReducer(initialEditState(), {
      type: "hideCaptionWords",
      words: [{ srcStart: 4, was: "hello" }],
    });
    expect(
      editReducer(s, { type: "hideCaptionWords", words: [{ srcStart: 4, was: "hello" }] }),
    ).toBe(s);
  });

  it("restore DELETES the keys; absent keys are skipped without failing the rest", () => {
    let s = editReducer(initialEditState(), {
      type: "hideCaptionWords",
      words: [
        { srcStart: 4, was: "hello" },
        { srcStart: 5.5, was: "world" },
      ],
    });
    s = editReducer(s, { type: "restoreCaptionWords", srcStarts: [4, 99] });
    expect(s.doc.captionWordsHidden).toEqual({ w5500: { was: "world" } });
    // DELETE, never `false` — the restoreScene rule.
    expect("w4000" in s.doc.captionWordsHidden).toBe(false);
  });

  it("restore with nothing to delete returns the SAME state — no phantom undo step", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "restoreCaptionWords", srcStarts: [4] })).toBe(s);
  });

  it("hide → restore round-trips the doc to exactly what it was", () => {
    const before = initialEditState();
    let s = editReducer(before, {
      type: "hideCaptionWords",
      words: [
        { srcStart: 4, was: "hello" },
        { srcStart: 5.5, was: "world" },
      ],
    });
    s = editReducer(s, { type: "restoreCaptionWords", srcStarts: [4, 5.5] });
    expect(s.doc).toEqual(before.doc);
  });
});

describe("caption LINE timing (patchCaptionLineTiming, 2026-08-18)", () => {
  it("writes every entry in ONE undo step — one drag of a seam is one gesture", () => {
    // A drag writes BOTH sides of the seam it moved (the moved line and the
    // neighbour that meets it there), so the bulk shape is the only shape.
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 4, lead: 0, tail: -0.5 },
        { srcStart: 6, lead: -0.5, tail: 0.2 },
        { srcStart: 9, lead: 0.2, tail: 0 },
      ],
    });
    expect(s.doc.captionLineTiming).toEqual({
      w4000: { lead: 0, tail: -0.5 },
      w6000: { lead: -0.5, tail: 0.2 },
      w9000: { lead: 0.2, tail: 0 },
    });
    expect(s.past).toHaveLength(1);
    // ONE undo puts the whole seam move back — not three.
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionLineTiming).toEqual({});
  });

  it("keys by SOURCE time (§137), never by output time or position", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4.25, lead: 0.12, tail: -0.08 }],
    });
    expect(s.doc.captionLineTiming).toEqual({ w4250: { lead: 0.12, tail: -0.08 } });
  });

  it("a second patch of the same line OVERWRITES the entry", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0.12, tail: -0.08 }],
    });
    s = editReducer(s, {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0.2, tail: 0 }],
    });
    expect(s.doc.captionLineTiming).toEqual({ w4000: { lead: 0.2, tail: 0 } });
  });

  it("sub-millisecond entries DELETE their keys, in the same commit", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 4, lead: 0.2, tail: 0.2 },
        { srcStart: 5, lead: 0.2, tail: 0.2 },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 4, lead: 0.0004, tail: -0.0002 },
        { srcStart: 5, lead: 0, tail: 0 },
      ],
    });
    // DELETE, never a pair of zeros — the clearVideo/restoreScene rule.
    expect(s.doc.captionLineTiming).toEqual({});
    expect("w4000" in s.doc.captionLineTiming).toBe(false);
    expect(s.past).toHaveLength(depth + 1);
  });

  it("ONE delta over a millisecond is still a real nudge, not a delete", () => {
    // The clear rule needs BOTH deltas near zero — a pure lead nudge with
    // tail 0 is exactly what a neighbour of a moved seam carries.
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0.05, tail: 0 }],
    });
    expect(s.doc.captionLineTiming).toEqual({ w4000: { lead: 0.05, tail: 0 } });
  });

  it("mixes writes and deletes in ONE commit — the shape a re-drag actually has", () => {
    // Dragging a seam back to base clears the line it came from while the
    // line it moved onto takes a real delta; both land together.
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 4, lead: 0.2, tail: 0.2 },
        { srcStart: 5, lead: 0.2, tail: 0.2 },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 4, lead: 0.0001, tail: 0 },
        { srcStart: 5, lead: -0.3, tail: -0.3 },
        { srcStart: 6, lead: 0.4, tail: 0.4 },
      ],
    });
    expect(s.doc.captionLineTiming).toEqual({
      w5000: { lead: -0.3, tail: -0.3 },
      w6000: { lead: 0.4, tail: 0.4 },
    });
    expect(s.past).toHaveLength(depth + 1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionLineTiming).toEqual({
      w4000: { lead: 0.2, tail: 0.2 },
      w5000: { lead: 0.2, tail: 0.2 },
    });
  });

  it("a fold that changes nothing returns the SAME state — no phantom undo step", () => {
    // A drag that ends where it started re-sends every line's existing deltas,
    // plus near-zero ones for lines that never had a key.
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0.2, tail: 0.2 }],
    });
    expect(
      editReducer(s, {
        type: "patchCaptionLineTiming",
        entries: [
          { srcStart: 4, lead: 0.2, tail: 0.2 },
          { srcStart: 5, lead: 0, tail: 0 },
        ],
      }),
    ).toBe(s);
  });

  it("an empty entry list is a no-op", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "patchCaptionLineTiming", entries: [] })).toBe(s);
  });

  it("nudge → reset round-trips the doc to exactly what it was", () => {
    const before = initialEditState();
    let s = editReducer(before, {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0.12, tail: -0.08 }],
    });
    s = editReducer(s, {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: 0, tail: 0 }],
    });
    expect(s.doc).toEqual(before.doc);
  });

  it("writes a doc the schema still accepts — the seam deltas are in range", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [{ srcStart: 4, lead: -1.5, tail: 2.25 }],
    });
    expect(OverrideDocSchema.parse(s.doc).captionLineTiming).toEqual({
      w4000: { lead: -1.5, tail: 2.25 },
    });
  });
});

describe("caption line WINDOWS (patchCaptionLineWindows, 2026-08-26)", () => {
  it("writes every selected line's window in ONE undo step — one Apply is one gesture", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [
        { srcStart: 4, window: { srcStart: 3.5, srcEnd: 5.5 } },
        { srcStart: 6, window: { srcStart: 5.5, srcEnd: 7.25 } },
      ],
    });
    expect(s.doc.captionLineWindows).toEqual({
      w4000: { srcStart: 3.5, srcEnd: 5.5 },
      w6000: { srcStart: 5.5, srcEnd: 7.25 },
    });
    expect(s.past).toHaveLength(1);
    // ONE undo puts the whole placement back — not two.
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionLineWindows).toEqual({});
  });

  it("keys by SOURCE time (§137) and stores SOURCE seconds — one clock end to end", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [{ srcStart: 4.25, window: { srcStart: 4.25, srcEnd: 6 } }],
    });
    expect(s.doc.captionLineWindows).toEqual({ w4250: { srcStart: 4.25, srcEnd: 6 } });
  });

  it("a null window DELETES the key — a window that restates the derivation is not an override", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [
        { srcStart: 4, window: { srcStart: 3.5, srcEnd: 5.5 } },
        { srcStart: 6, window: { srcStart: 5.5, srcEnd: 7.25 } },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionLineWindows",
      entries: [
        { srcStart: 4, window: null },
        // Mixed with a real write, the shape a re-drag actually has: one line
        // back on its derived position, its neighbour moved again.
        { srcStart: 6, window: { srcStart: 5.6, srcEnd: 7.4 } },
      ],
    });
    expect(s.doc.captionLineWindows).toEqual({ w6000: { srcStart: 5.6, srcEnd: 7.4 } });
    expect("w4000" in s.doc.captionLineWindows).toBe(false);
    expect(s.past).toHaveLength(depth + 1);
  });

  it("a fold that changes nothing returns the SAME state — no phantom undo step", () => {
    // Apply re-sends every selected line, including neighbours the drag never
    // moved and lines that never had a key.
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [{ srcStart: 4, window: { srcStart: 3.5, srcEnd: 5.5 } }],
    });
    expect(
      editReducer(s, {
        type: "patchCaptionLineWindows",
        entries: [
          { srcStart: 4, window: { srcStart: 3.5, srcEnd: 5.5 } },
          { srcStart: 6, window: null },
        ],
      }),
    ).toBe(s);
  });

  it("an empty entry list is a no-op", () => {
    const s = initialEditState();
    expect(editReducer(s, { type: "patchCaptionLineWindows", entries: [] })).toBe(s);
  });

  it("place → clear round-trips the doc to exactly what it was", () => {
    const before = initialEditState();
    let s = editReducer(before, {
      type: "patchCaptionLineWindows",
      entries: [{ srcStart: 4, window: { srcStart: 3.5, srcEnd: 5.5 } }],
    });
    s = editReducer(s, {
      type: "patchCaptionLineWindows",
      entries: [{ srcStart: 4, window: null }],
    });
    expect(s.doc).toEqual(before.doc);
  });

  it("writes a doc the schema still accepts — ordered and at least the floor wide", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [{ srcStart: 4, window: { srcStart: 12.5, srcEnd: 14 } }],
    });
    expect(OverrideDocSchema.parse(s.doc).captionLineWindows).toEqual({
      w4000: { srcStart: 12.5, srcEnd: 14 },
    });
  });
});

describe("patchCaptionRange — multi-word free-text rewrite (2026-08-18)", () => {
  it("scrub-on-create: removes per-word edits and hides INSIDE the interval, keeps outside, appends — ONE commit", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "in-a", was: "a",
    });
    s = editReducer(s, { type: "patchCaption", srcStart: 7, text: "out-b", was: "b" });
    s = editReducer(s, {
      type: "hideCaptionWords",
      words: [
        { srcStart: 5, was: "c" },
        { srcStart: 3, was: "d" },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      // `was` is the BASE-joined run ("a c e"), NEVER the live join carrying
      // the retype ("in-a c e"): this same commit scrubs the retype at 4, so
      // the run applyCaptionRangeEdits' whole-run guard reads at apply time
      // IS the base run — a live-joined `was` would drop the rewrite forever.
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "new run", was: "a c e",
    });
    // Inside [w4000, w6000]: the edit at 4 and the hide at 5 are superseded
    // (they would dangle as permanent drop reports over re-minted anchors);
    // outside: the edit at 7 and the hide at 3 survive untouched.
    expect(s.doc.captions).toEqual({ w7000: { text: "out-b", was: "b" } });
    expect(s.doc.captionWordsHidden).toEqual({ w3000: { was: "d" } });
    expect(s.doc.captionRangeEdits).toEqual([
      { fromKey: "w4000", toKey: "w6000", text: "new run", was: "a c e" },
    ]);
    // ONE commit for scrub + append...
    expect(s.past).toHaveLength(depth + 1);
    // ...so one undo reverses all of it together.
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captions).toEqual({
      w4000: { text: "in-a", was: "a" },
      w7000: { text: "out-b", was: "b" },
    });
    expect(s.doc.captionWordsHidden).toEqual({ w5000: { was: "c" }, w3000: { was: "d" } });
    expect(s.doc.captionRangeEdits).toEqual([]);
  });

  /**
   * The line-timing layer joins the same scrub (2026-08-19 review). Its keys
   * are a line's FIRST word's anchor, so a rewrite covering that word
   * re-mints it: the nudge then addresses a word no line begins on, core
   * reports `found: null` forever, and the drop banner blames a cut. Nothing
   * else in the doc prunes these records.
   */
  it("scrub-on-create: removes line-timing nudges INSIDE the interval, keeps the ones outside", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [
        // Keyed to a line whose first word sits INSIDE the rewritten run…
        { srcStart: 5, lead: -0.2, tail: 0 },
        // …and one whose first word is well outside it.
        { srcStart: 9, lead: 0.1, tail: 0.1 },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "new run", was: "a c e",
    });
    expect(s.doc.captionLineTiming).toEqual({ w9000: { lead: 0.1, tail: 0.1 } });
    // ONE commit for the whole scrub — the nudge goes with the rewrite it
    // could no longer address, in the same undo step.
    expect(s.past).toHaveLength(depth + 1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionLineTiming).toEqual({
      w5000: { lead: -0.2, tail: 0 },
      w9000: { lead: 0.1, tail: 0.1 },
    });
  });

  it("the bulk range apply scrubs line-timing per occurrence too", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineTiming",
      entries: [
        { srcStart: 5, lead: -0.2, tail: 0 },
        { srcStart: 12, lead: 0.3, tail: 0 },
        { srcStart: 20, lead: 0.1, tail: 0 },
      ],
    });
    s = editReducer(s, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 4, toSrcStart: 6, was: "a c e" },
        { fromSrcStart: 11, toSrcStart: 13, was: "a c e" },
      ],
      text: "new run",
    });
    // Only the nudge outside every rewritten interval survives.
    expect(s.doc.captionLineTiming).toEqual({ w20000: { lead: 0.1, tail: 0 } });
  });

  it("scrub-on-create: removes line WINDOWS keyed INSIDE the interval, keeps the ones outside", () => {
    // The line-timing scrub's hazard, one layer over: a window's key is a
    // line's FIRST word's anchor, and a rewrite covering that word re-mints
    // it — the record would dangle forever, `found: null`, misdiagnosed by
    // the banner as "the cut removed the caption you placed".
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [
        // Keyed to a line whose first word sits INSIDE the rewritten run…
        { srcStart: 5, window: { srcStart: 4.8, srcEnd: 6.5 } },
        // …and one whose first word is well outside it.
        { srcStart: 9, window: { srcStart: 8.9, srcEnd: 10.2 } },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "new run", was: "a c e",
    });
    expect(s.doc.captionLineWindows).toEqual({ w9000: { srcStart: 8.9, srcEnd: 10.2 } });
    // ONE commit for the whole scrub — the window goes with the rewrite it
    // could no longer address, in the same undo step.
    expect(s.past).toHaveLength(depth + 1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionLineWindows).toEqual({
      w5000: { srcStart: 4.8, srcEnd: 6.5 },
      w9000: { srcStart: 8.9, srcEnd: 10.2 },
    });
  });

  it("the bulk range apply scrubs line WINDOWS per occurrence too", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionLineWindows",
      entries: [
        { srcStart: 5, window: { srcStart: 4.8, srcEnd: 6.5 } },
        { srcStart: 12, window: { srcStart: 11.9, srcEnd: 13.1 } },
        { srcStart: 20, window: { srcStart: 19.5, srcEnd: 21 } },
      ],
    });
    s = editReducer(s, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 4, toSrcStart: 6, was: "a c e" },
        { fromSrcStart: 11, toSrcStart: 13, was: "a c e" },
      ],
      text: "new run",
    });
    // Only the window outside every rewritten interval survives.
    expect(s.doc.captionLineWindows).toEqual({ w20000: { srcStart: 19.5, srcEnd: 21 } });
  });

  it("the LINE-TIMING scrub never coerces legacy positional keys either", () => {
    // The `patchCaptionRange` legacy guard covers all three maps: a bare
    // positional key is not source-time addressable, and `Number("17")`
    // would read position 17 as 7ms — inside a low interval — deleting a
    // record this scrub cannot honestly locate.
    const loaded = editReducer(initialEditState(), {
      type: "load",
      doc: OverrideDocSchema.parse({
        captionLineTiming: { "17": { lead: 0.1, tail: 0 }, w500: { lead: 0.2, tail: 0 } },
      }),
    });
    const s = editReducer(loaded, {
      type: "patchCaptionRange", fromSrcStart: 0, toSrcStart: 0.9, text: "new", was: "a b",
    });
    expect(s.doc.captionLineTiming).toEqual({ "17": { lead: 0.1, tail: 0 } });
  });

  it("the interval scrub never coerces LEGACY positional keys — preserved for write-back", () => {
    // `migrateLoadedDoc` keeps the positional edits it could not place IN
    // the doc, under their original bare-integer keys ("0", "17"), so a save
    // round-trips them. `Number(key.slice(1))` misreads position 17 as 7ms
    // and position 0 as 0ms — both inside a low interval — so an uncorrected
    // scrub silently deleted them. Parse, never coerce: a legacy key is not
    // source-time addressable at all.
    const loaded = editReducer(initialEditState(), {
      type: "load",
      doc: OverrideDocSchema.parse({
        captions: {
          "0": { text: "legacy-zero", was: "z" },
          "17": { text: "legacy-seventeen", was: "s" },
          w500: { text: "in-interval", was: "i" },
        },
      }),
    });
    const s = editReducer(loaded, {
      type: "patchCaptionRange", fromSrcStart: 0, toSrcStart: 0.9, text: "new", was: "a b",
    });
    // The source-keyed edit inside [0, 900]ms is scrubbed; both legacy keys
    // survive verbatim even though their coerced values land in the interval.
    expect(s.doc.captions).toEqual({
      "0": { text: "legacy-zero", was: "z" },
      "17": { text: "legacy-seventeen", was: "s" },
    });
  });

  it("an OVERLAPPING existing range edit is replaced; a disjoint one is kept", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 10, toSrcStart: 12, text: "p q", was: "d e f",
    });
    // [5, 8] overlaps [4, 6] but not [10, 12].
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 5, toSrcStart: 8, text: "z", was: "y g h",
    });
    expect(s.doc.captionRangeEdits).toEqual([
      { fromKey: "w10000", toKey: "w12000", text: "p q", was: "d e f" },
      { fromKey: "w5000", toKey: "w8000", text: "z", was: "y g h" },
    ]);
  });

  it("a re-edit of the SAME pair keeps the base `was` — the captionEditWas rule", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    // The re-editor sees the LIVE rewritten text ("x y") — storing it as
    // `was` would stale the whole-run guard against the base lines.
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "z w q", was: "x y",
    });
    expect(s.doc.captionRangeEdits).toEqual([
      { fromKey: "w4000", toKey: "w6000", text: "z w q", was: "a b c" },
    ]);
  });

  it("retyping the run back to its base `was` DELETES the entry", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    s = editReducer(s, {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "a b c", was: "x y",
    });
    expect(s.doc.captionRangeEdits).toEqual([]);
  });

  it("empty (or whitespace-only) text is a cancel — same state object, no commit", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    expect(
      editReducer(s, {
        type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "   ", was: "x y",
      }),
    ).toBe(s);
  });

  it("text === was with no stored entry is a no-op — nothing to clear, no phantom undo step", () => {
    const s = initialEditState();
    expect(
      editReducer(s, {
        type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "a b c", was: "a b c",
      }),
    ).toBe(s);
  });
});

describe("patchCaptionAllOccurrences — Apply to all, single-token (2026-08-18)", () => {
  it("writes every occurrence in ONE commit — one undo step reverses all of them", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionAllOccurrences",
      entries: [
        { srcStart: 4, was: "helo" },
        { srcStart: 7, was: "helo" },
        { srcStart: 9.5, was: "helo" },
      ],
      text: "hello",
    });
    expect(s.doc.captions).toEqual({
      w4000: { text: "hello", was: "helo" },
      w7000: { text: "hello", was: "helo" },
      w9500: { text: "hello", was: "helo" },
    });
    // "Retype every helo" is one gesture (the patchCaptionStyleAll rule).
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captions).toEqual({});
  });

  it("per-key captionEditWas: a re-edit sees the LIVE text but the stored guard stays base", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "hello", was: "helo",
    });
    s = editReducer(s, {
      type: "patchCaptionAllOccurrences",
      // The caller observed the live "hello" at 4, the base "helo" at 7.
      entries: [
        { srcStart: 4, was: "hello" },
        { srcStart: 7, was: "helo" },
      ],
      text: "hullo",
    });
    expect(s.doc.captions).toEqual({
      w4000: { text: "hullo", was: "helo" },
      w7000: { text: "hullo", was: "helo" },
    });
  });

  it("text === was CLEARS that entry's key, per entry — the clearVideo rule, occurrence-wise", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "hullo", was: "helo",
    });
    // Retyping every occurrence back to "helo": key 4's override is cleared;
    // key 7 never had one and must not gain a base-restating entry.
    s = editReducer(s, {
      type: "patchCaptionAllOccurrences",
      entries: [
        { srcStart: 4, was: "hullo" },
        { srcStart: 7, was: "helo" },
      ],
      text: "helo",
    });
    expect(s.doc.captions).toEqual({});
  });

  it("an unchanged document is a no-op — same state object, no phantom undo step", () => {
    const s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "hello", was: "helo",
    });
    expect(
      editReducer(s, {
        type: "patchCaptionAllOccurrences",
        entries: [
          // Already carrying exactly this text/guard...
          { srcStart: 4, was: "hello" },
          // ...and a text===was with no stored key to clear.
          { srcStart: 7, was: "hello" },
        ],
        text: "hello",
      }),
    ).toBe(s);
  });
});

describe("patchCaptionRangeAllOccurrences — Apply to all, multi-word (2026-08-18)", () => {
  it("appends an entry per occurrence with the per-interval scrub applied to EACH — one commit, one undo", () => {
    // Seed a retype and a hide inside the FIRST interval, a retype inside
    // the SECOND, and a hide outside both — the scrub must run per
    // occurrence, and the outsider must survive.
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 4, text: "in-first", was: "a",
    });
    s = editReducer(s, { type: "patchCaption", srcStart: 11, text: "in-second", was: "d" });
    s = editReducer(s, {
      type: "hideCaptionWords",
      words: [
        { srcStart: 5, was: "b" },
        { srcStart: 20, was: "z" },
      ],
    });
    const depth = s.past.length;
    s = editReducer(s, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 4, toSrcStart: 6, was: "a b c" },
        { fromSrcStart: 10, toSrcStart: 12, was: "a b c" },
      ],
      text: "q r",
    });
    expect(s.doc.captions).toEqual({});
    expect(s.doc.captionWordsHidden).toEqual({ w20000: { was: "z" } });
    expect(s.doc.captionRangeEdits).toEqual([
      { fromKey: "w4000", toKey: "w6000", text: "q r", was: "a b c" },
      { fromKey: "w10000", toKey: "w12000", text: "q r", was: "a b c" },
    ]);
    // ONE commit for the whole gesture, selection and occurrences together...
    expect(s.past).toHaveLength(depth + 1);
    // ...so one undo reverses everything.
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captions).toEqual({
      w4000: { text: "in-first", was: "a" },
      w11000: { text: "in-second", was: "d" },
    });
    expect(s.doc.captionWordsHidden).toEqual({ w5000: { was: "b" }, w20000: { was: "z" } });
    expect(s.doc.captionRangeEdits).toEqual([]);
  });

  it("legacy positional keys are immune to every occurrence's scrub — the patchCaptionRange guard", () => {
    const loaded = editReducer(initialEditState(), {
      type: "load",
      doc: OverrideDocSchema.parse({
        captions: {
          "0": { text: "legacy-zero", was: "z" },
          "17": { text: "legacy-seventeen", was: "s" },
        },
      }),
    });
    // Both coerced values (0ms, 7ms) would land inside these low intervals —
    // parse, never coerce (the F7 lesson): a positional key is not
    // source-time addressable at all.
    const s = editReducer(loaded, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 0, toSrcStart: 0.005, was: "a" },
        { fromSrcStart: 0.006, toSrcStart: 0.01, was: "a" },
      ],
      text: "b",
    });
    expect(s.doc.captions).toEqual({
      "0": { text: "legacy-zero", was: "z" },
      "17": { text: "legacy-seventeen", was: "s" },
    });
  });

  it("text === was per entry DELETES that pair's entry while other entries still apply", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    // The bulk rewrite lands the FIRST pair back on its base run (its `was`
    // inherits "a b c" — the same-pair captionRangeEditWas rule), so that
    // entry is deleted; the second pair gains a fresh entry.
    s = editReducer(s, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 4, toSrcStart: 6, was: "x y" },
        { fromSrcStart: 10, toSrcStart: 12, was: "a b c" },
      ],
      text: "a b c",
    });
    expect(s.doc.captionRangeEdits).toEqual([]);
    // The second pair's text ("a b c") differs from... its was is "a b c"
    // too, so BOTH resolve as back-to-base: no entries at all. Assert the
    // asymmetric case explicitly with a diverging second base:
    let t = editReducer(initialEditState(), {
      type: "patchCaptionRange", fromSrcStart: 4, toSrcStart: 6, text: "x y", was: "a b c",
    });
    t = editReducer(t, {
      type: "patchCaptionRangeAllOccurrences",
      entries: [
        { fromSrcStart: 4, toSrcStart: 6, was: "x y" },
        { fromSrcStart: 10, toSrcStart: 12, was: "d e f" },
      ],
      text: "a b c",
    });
    expect(t.doc.captionRangeEdits).toEqual([
      { fromKey: "w10000", toKey: "w12000", text: "a b c", was: "d e f" },
    ]);
  });

  it("empty text and all-no-op entries return the SAME state", () => {
    const s = initialEditState();
    expect(
      editReducer(s, {
        type: "patchCaptionRangeAllOccurrences",
        entries: [{ fromSrcStart: 4, toSrcStart: 6, was: "a b" }],
        text: "   ",
      }),
    ).toBe(s);
    // text === was with nothing stored for either pair: nothing to delete,
    // nothing to append — no phantom undo step.
    expect(
      editReducer(s, {
        type: "patchCaptionRangeAllOccurrences",
        entries: [
          { fromSrcStart: 4, toSrcStart: 6, was: "a b" },
          { fromSrcStart: 10, toSrcStart: 12, was: "a b" },
        ],
        text: "a b",
      }),
    ).toBe(s);
  });
});

describe("cutWords — Remove captions + video (§59b revisited)", () => {
  const cutTwo = () =>
    editReducer(initialEditState(), {
      type: "cutWords",
      words: [
        { srcStart: 4, was: "hello" },
        { srcStart: 5.5, was: "world" },
      ],
      startSec: 1.0,
      endSec: 1.6,
    });

  it("writes the hides AND the cut in ONE commit — one undo reverts both together", () => {
    let s = cutTwo();
    expect(s.doc.captionWordsHidden).toEqual({
      w4000: { was: "hello" },
      w5500: { was: "world" },
    });
    expect(s.doc.cuts).toEqual([{ startSec: 1.0, endSec: 1.6 }]);
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionWordsHidden).toEqual({});
    expect(s.doc.cuts).toEqual([]);
  });

  it("a src-LESS dispatch writes no src key — the legacy marked-only shape (App's null-mapper fallback)", () => {
    const s = cutTwo();
    expect("src" in s.doc.cuts[0]!).toBe(false);
  });

  it("stores the src App resolved through the OLD clock, in the same one commit", () => {
    // The panel's window is old-clock, so App maps it with `oldToSourceSec`
    // — the reducer just records what arrives (cut-review rework).
    const s = editReducer(initialEditState(), {
      type: "cutWords",
      words: [{ srcStart: 4, was: "hello" }],
      startSec: 1.0,
      endSec: 1.6,
      src: { startSec: 4, endSec: 4.6 },
    });
    expect(s.doc.cuts).toEqual([
      { startSec: 1.0, endSec: 1.6, src: { startSec: 4, endSec: 4.6 } },
    ]);
    expect(s.doc.captionWordsHidden).toEqual({ w4000: { was: "hello" } });
    expect(s.past).toHaveLength(1);
  });

  it("a repeat of the same src range replaces its predecessor — the cutChunk dedupe arm, shared", () => {
    let s = editReducer(initialEditState(), {
      type: "cutWords",
      words: [{ srcStart: 4, was: "hello" }],
      startSec: 1.0,
      endSec: 1.6,
      src: { startSec: 4, endSec: 4.6 },
    });
    s = editReducer(s, {
      type: "cutWords",
      words: [{ srcStart: 4, was: "hello" }],
      startSec: 1.0,
      endSec: 1.6,
      src: { startSec: 4, endSec: 4.6 },
    });
    expect(s.doc.cuts).toHaveLength(1);
  });

  it("never touches a src-anchored sibling cut at the same window (the cutChunk rule)", () => {
    const withAppliedCut = editReducer(initialEditState(), { type: "load", doc: {
      theme: {}, scenes: {}, captions: {}, captionWordsHidden: {}, splits: [],
      cuts: [{ startSec: 1.0, endSec: 1.6, src: { startSec: 43.4, endSec: 44.0 } }],
    } });
    const s = editReducer(withAppliedCut, {
      type: "cutWords",
      words: [{ srcStart: 4, was: "hello" }],
      startSec: 1.0,
      endSec: 1.6,
    });
    expect(s.doc.cuts).toHaveLength(2);
    // The applied entry survives, byte-for-byte, same src...
    expect(s.doc.cuts).toContainEqual({
      startSec: 1.0, endSec: 1.6, src: { startSec: 43.4, endSec: 44.0 },
    });
    // ...plus a fresh, independent, src-less entry for the new decision.
    expect(s.doc.cuts).toContainEqual({ startSec: 1.0, endSec: 1.6 });
  });

  it("replaces a stale SRC-LESS entry at the exact window rather than stacking a duplicate", () => {
    let s = cutTwo();
    s = editReducer(s, {
      type: "cutWords",
      words: [{ srcStart: 4, was: "hello" }],
      startSec: 1.0,
      endSec: 1.6,
    });
    expect(s.doc.cuts).toEqual([{ startSec: 1.0, endSec: 1.6 }]);
  });

  it("an already-hidden key keeps its stored `was` — the hideCaptionWords guard", () => {
    const hidden = editReducer(initialEditState(), {
      type: "hideCaptionWords",
      words: [{ srcStart: 4, was: "hello" }],
    });
    const s = editReducer(hidden, {
      type: "cutWords",
      // The re-delete sees the LIVE text after a retype — the stored guard
      // must survive, like `captionEditWas` for retypes.
      words: [{ srcStart: 4, was: "hullo" }],
      startSec: 1.0,
      endSec: 1.6,
    });
    expect(s.doc.captionWordsHidden).toEqual({ w4000: { was: "hello" } });
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
    s = editReducer(s, {
      type: "patchLayout", sceneId: "scene-0", layout: "video-top", from: "pip-bubble",
    });
    expect(s.doc.scenes["scene-0"]!.pip).toEqual({ cornerRadius: 0.2 });
  });
});

describe("graphic backdrop colour (backdrop-color §4)", () => {
  it("patchBackdropColor sets the scene's backdropColor", () => {
    const s = editReducer(initialEditState(), {
      type: "patchBackdropColor", sceneId: "scene-0", color: "#123456",
    });
    expect(s.doc.scenes["scene-0"]!.backdropColor).toBe("#123456");
    expect(OverrideDocSchema.safeParse(s.doc).success).toBe(true);
  });

  it("one colour-wheel drag (one coalesce key) is ONE undo step", () => {
    const key = "backdropColor:scene-0";
    let s = editReducer(initialEditState(), {
      type: "patchBackdropColor", sceneId: "scene-0", color: "#111111", coalesce: key,
    });
    s = editReducer(s, {
      type: "patchBackdropColor", sceneId: "scene-0", color: "#222222", coalesce: key,
    });
    expect(s.doc.scenes["scene-0"]!.backdropColor).toBe("#222222");
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-0"]?.backdropColor).toBeUndefined();
  });

  it("clearBackdropColor DELETES the key", () => {
    let s = editReducer(initialEditState(), {
      type: "patchBackdropColor", sceneId: "scene-0", color: "#123456",
    });
    s = editReducer(s, { type: "clearBackdropColor", sceneId: "scene-0" });
    expect("backdropColor" in s.doc.scenes["scene-0"]!).toBe(false);
  });

  it("clearBackdropColor on a scene without one is a no-op — same state, no undo step", () => {
    const s = initialEditState();
    const after = editReducer(s, { type: "clearBackdropColor", sceneId: "scene-0" });
    expect(after).toBe(s);
    expect(after.past).toHaveLength(0);
  });
});

describe("setCaptionsHidden (the global Captions toggle)", () => {
  it("hide writes captionsHidden: true as one undo-able commit", () => {
    const s = editReducer(initialEditState(), { type: "setCaptionsHidden", hidden: true });
    expect(s.doc.captionsHidden).toBe(true);
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
  });

  it("show DELETES the key rather than writing false — the clearVideo rule", () => {
    let s = editReducer(initialEditState(), { type: "setCaptionsHidden", hidden: true });
    s = editReducer(s, { type: "setCaptionsHidden", hidden: false });
    expect("captionsHidden" in s.doc).toBe(false);
  });

  it("no-op guard both ways: re-committing the current state mints no undo step", () => {
    const fresh = initialEditState();
    // Already visible — "show" must return the SAME state object, not a
    // byte-identical copy that pushes a phantom undo entry.
    expect(editReducer(fresh, { type: "setCaptionsHidden", hidden: false })).toBe(fresh);
    const hidden = editReducer(fresh, { type: "setCaptionsHidden", hidden: true });
    expect(editReducer(hidden, { type: "setCaptionsHidden", hidden: true })).toBe(hidden);
  });

  it("undo/redo walk the toggle like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "setCaptionsHidden", hidden: true });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionsHidden).toBeUndefined();
    s = editReducer(s, { type: "redo" });
    expect(s.doc.captionsHidden).toBe(true);
  });
});

describe("setCaptionTheme (the global Captions theme select)", () => {
  it("stores a preset id and DELETES the key on undefined", () => {
    let s = editReducer(initialEditState(), { type: "setCaptionTheme", value: "founder" });
    expect(s.doc.captionTheme).toBe("founder");
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "setCaptionTheme", value: undefined });
    expect("captionTheme" in s.doc).toBe(false);
  });

  it("no-op guards: re-committing the current state mints no undo step", () => {
    const fresh = initialEditState();
    expect(editReducer(fresh, { type: "setCaptionTheme", value: undefined })).toBe(fresh);
    const themed = editReducer(fresh, { type: "setCaptionTheme", value: "punch" });
    expect(editReducer(themed, { type: "setCaptionTheme", value: "punch" })).toBe(themed);
  });

  it("undo/redo walk the theme change and schema round-trips cleanly", () => {
    let s = editReducer(initialEditState(), { type: "setCaptionTheme", value: "boxed" });
    expect(OverrideDocSchema.safeParse(s.doc).success).toBe(true);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.captionTheme).toBeUndefined();
    s = editReducer(s, { type: "redo" });
    expect(s.doc.captionTheme).toBe("boxed");
  });
});

describe("setColorGrade (the global Color section)", () => {
  it("stores an object, an explicit false, and DELETES the key on undefined — three states, not two", () => {
    let s = editReducer(initialEditState(), {
      type: "setColorGrade", value: { preset: "punchy", intensity: 0.5 },
    });
    expect(s.doc.colorGrade).toEqual({ preset: "punchy", intensity: 0.5 });
    expect(s.dirty).toBe(true);
    s = editReducer(s, { type: "setColorGrade", value: false });
    expect(s.doc.colorGrade).toBe(false);
    // `undefined` is "inherit", a DIFFERENT decision from `false` (produce's
    // override layer falls through vs switches off) — so the key must go,
    // not flip.
    s = editReducer(s, { type: "setColorGrade", value: undefined });
    expect("colorGrade" in s.doc).toBe(false);
  });

  it("no-op guards: re-committing the current state mints no undo step", () => {
    const fresh = initialEditState();
    expect(editReducer(fresh, { type: "setColorGrade", value: undefined })).toBe(fresh);
    const graded = editReducer(fresh, { type: "setColorGrade", value: { preset: "mono" } });
    expect(editReducer(graded, { type: "setColorGrade", value: { preset: "mono" } })).toBe(graded);
  });

  it("slider commits under one coalesce key collapse into one undo step (B5)", () => {
    let s = editReducer(initialEditState(), {
      type: "setColorGrade", value: { preset: "mono", intensity: 0.4 }, coalesce: "colorGrade:intensity",
    });
    s = editReducer(s, {
      type: "setColorGrade", value: { preset: "mono", intensity: 0.6 }, coalesce: "colorGrade:intensity",
    });
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect("colorGrade" in s.doc).toBe(false);
  });

  it("round-trips the overrides schema — what the editor writes, produce parses", () => {
    const s = editReducer(initialEditState(), {
      type: "setColorGrade", value: { lut: "kodak.cube", exposure: 0.5 },
    });
    expect(OverrideDocSchema.safeParse(s.doc).success).toBe(true);
    const off = editReducer(s, { type: "setColorGrade", value: false });
    expect(OverrideDocSchema.safeParse(off.doc).success).toBe(true);
  });
});

describe("cleanup veto actions (cut review step 3)", () => {
  it("setReasonEnabled(false) writes the category veto, and dirty/undo come free from commit()", () => {
    let s = editReducer(initialEditState(), {
      type: "setReasonEnabled", reason: "pause", enabled: false,
    });
    expect(s.doc.cleanup.reasons.pause).toBe(false);
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "undo" });
    expect(s.doc.cleanup.reasons.pause).toBeUndefined();
  });

  it("setReasonEnabled(true) DELETES the key — never writes true (the captionsHidden rule)", () => {
    let s = editReducer(initialEditState(), {
      type: "setReasonEnabled", reason: "pause", enabled: false,
    });
    s = editReducer(s, { type: "setReasonEnabled", reason: "pause", enabled: true });
    expect("pause" in s.doc.cleanup.reasons).toBe(false);
  });

  it("re-enabling swallows a tolerated on-disk true instead of preserving dead weight", () => {
    const loaded = OverrideDocSchema.parse({ cleanup: { reasons: { retake: true } } });
    let s = editReducer(initialEditState(), { type: "load", doc: loaded });
    s = editReducer(s, { type: "setReasonEnabled", reason: "retake", enabled: true });
    expect("retake" in s.doc.cleanup.reasons).toBe(false);
    expect(s.dirty).toBe(true);
  });

  it("no-op guards both ways — an unchanged document mints no undo step", () => {
    const base = initialEditState();
    // Already enabled (key absent): re-enabling is the SAME state object.
    expect(editReducer(base, { type: "setReasonEnabled", reason: "pause", enabled: true })).toBe(base);
    const disabled = editReducer(base, {
      type: "setReasonEnabled", reason: "pause", enabled: false,
    });
    expect(
      editReducer(disabled, { type: "setReasonEnabled", reason: "pause", enabled: false }),
    ).toBe(disabled);
  });

  it("toggleKept adds an individual veto, and toggling again removes the entry (never a false-ish value)", () => {
    let s = editReducer(initialEditState(), { type: "toggleKept", srcIn: 12.4, srcOut: 13.1 });
    expect(s.doc.cleanup.kept).toEqual([{ srcIn: 12.4, srcOut: 13.1 }]);
    expect(s.past).toHaveLength(1);
    s = editReducer(s, { type: "toggleKept", srcIn: 12.4, srcOut: 13.1 });
    expect(s.doc.cleanup.kept).toEqual([]);
  });

  it("toggleKept removes by OVERLAP, not endpoint equality — a re-produce can shift the boundary", () => {
    // The veto was stored against 12.4..13.1; the seam the user clicks after
    // a re-produce says 12.433..13.1. The click must still UN-veto.
    let s = editReducer(initialEditState(), { type: "toggleKept", srcIn: 12.4, srcOut: 13.1 });
    s = editReducer(s, { type: "toggleKept", srcIn: 12.433, srcOut: 13.1 });
    expect(s.doc.cleanup.kept).toEqual([]);
  });

  it("a degenerate span is refused — an entry that can never overlap anything is dead weight", () => {
    const base = initialEditState();
    expect(editReducer(base, { type: "toggleKept", srcIn: 5, srcOut: 5 })).toBe(base);
  });
});

// Same mount conventions as cover-panel.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("save() stamps scene anchors from the synced live cues (handoff-edit-anchoring)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const anchoredCue = (id: string, anchor: { startWord: number; endWord: number }): SceneCue => ({
    id,
    layout: "video-top",
    component: "StatCard",
    props: { label: "CODE CHURN", value: "861%", inverted: false },
    startSec: 0,
    endSec: 5,
    anchor,
  });

  it("PUTs a body whose scene entry carries the synced cue's anchor — and leaves the in-memory doc unstamped", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    let api!: ReturnType<typeof useEdits>;
    const Harness = (): null => {
      api = useEdits();
      return null;
    };
    const root = createRoot(document.createElement("div"));
    act(() => {
      root.render(React.createElement(Harness));
    });
    // An edit mints the scene-0 entry; syncCues feeds the live cue list the
    // way App's effect does.
    act(() => api.patchProps("scene-0", { value: "999%" }));
    act(() => api.syncCues([anchoredCue("scene-0", { startWord: 4, endWord: 9 })]));
    await act(async () => {
      await api.save();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/overrides");
    expect(init.method).toBe("PUT");
    // Parsed back through the same schema the server's PUT handler runs, so
    // this asserts the anchor SURVIVES the round-trip, not just that some
    // bytes were sent. The user's own edit rides along unharmed.
    const body = OverrideDocSchema.parse(JSON.parse(init.body as string));
    expect(body.scenes["scene-0"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
    expect(body.scenes["scene-0"]!.props).toEqual({ value: "999%" });
    // The in-memory doc deliberately stays UNstamped (a `load` dispatch would
    // clear undo history; the stamp is recomputed on every save) — but the
    // save still marked the state clean.
    expect(api.doc.scenes["scene-0"]!.anchor).toBeUndefined();
    expect(api.dirty).toBe(false);
    act(() => root.unmount());
  });
});

describe("cleanup dismissals (cut-review rework, 2026-08-26)", () => {
  it("dismissRemoval stores the range and subsumes any overlapping veto", () => {
    let s = editReducer(initialEditState(), { type: "toggleKept", srcIn: 5, srcOut: 7 });
    expect(s.doc.cleanup.kept).toEqual([{ srcIn: 5, srcOut: 7 }]);
    s = editReducer(s, { type: "dismissRemoval", srcIn: 5.1, srcOut: 6.9 });
    // One state per range: the veto goes, the dismissal stands.
    expect(s.doc.cleanup.kept).toEqual([]);
    expect(s.doc.cleanup.dismissed).toEqual([{ srcIn: 5.1, srcOut: 6.9 }]);
  });

  it("a second overlapping dismissal is a no-op; a degenerate span is refused", () => {
    let s = editReducer(initialEditState(), { type: "dismissRemoval", srcIn: 5, srcOut: 7 });
    expect(editReducer(s, { type: "dismissRemoval", srcIn: 6, srcOut: 6.5 })).toBe(s);
    expect(editReducer(s, { type: "dismissRemoval", srcIn: 9, srcOut: 9 })).toBe(s);
  });

  it("restoreDismissed removes by overlap and no-ops when nothing matches", () => {
    let s = editReducer(initialEditState(), { type: "dismissRemoval", srcIn: 5, srcOut: 7 });
    expect(editReducer(s, { type: "restoreDismissed", srcIn: 20, srcOut: 21 })).toBe(s);
    s = editReducer(s, { type: "restoreDismissed", srcIn: 5.5, srcOut: 6 });
    expect(s.doc.cleanup.dismissed).toEqual([]);
  });

  it("dismissals undo like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "dismissRemoval", srcIn: 5, srcOut: 7 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.cleanup.dismissed).toEqual([]);
  });
});

describe("rekeyCaptionKeys — caption anchors after a range re-transcription (Phase A)", () => {
  /** A doc holding one of each source-keyed caption record, all on w1000. */
  const seeded = () => ({
    ...initialEditState(),
    doc: OverrideDocSchema.parse({
      captions: { w1000: { text: "JSON", was: "Jason" } },
      captionWordsHidden: { w1000: { was: "um" } },
      captionLineTiming: { w1000: { lead: -0.2, tail: 0.4 } },
      captionRangeEdits: [{ fromKey: "w1000", toKey: "w2000", text: "new", was: "old" }],
    }),
  });

  it("moves every record type onto the corrected stamps in ONE commit", () => {
    const s = editReducer(seeded(), {
      type: "rekeyCaptionKeys",
      mapping: [
        { fromMs: 1000, toMs: 1420 },
        { fromMs: 2000, toMs: 2380 },
      ],
    });
    expect(s.doc.captions).toEqual({ w1420: { text: "JSON", was: "Jason" } });
    expect(s.doc.captionWordsHidden).toEqual({ w1420: { was: "um" } });
    expect(s.doc.captionLineTiming).toEqual({ w1420: { lead: -0.2, tail: 0.4 } });
    expect(s.doc.captionRangeEdits[0]).toMatchObject({ fromKey: "w1420", toKey: "w2380" });
    // ONE undo step, not four — the keep that triggered the re-decode and
    // the re-key it caused come back together.
    expect(s.past).toHaveLength(1);
  });

  it("undo puts every anchor back where the user's edit was made", () => {
    const before = seeded();
    let s = editReducer(before, { type: "rekeyCaptionKeys", mapping: [{ fromMs: 1000, toMs: 1420 }] });
    s = editReducer(s, { type: "undo" });
    expect(s.doc).toEqual(before.doc);
  });

  it("an empty mapping is a no-op — never a ⌘Z that appears to do nothing", () => {
    const before = seeded();
    expect(editReducer(before, { type: "rekeyCaptionKeys", mapping: [] })).toBe(before);
  });

  it("parks a collided entry and warns rather than overwriting the other", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = editReducer(
      {
        ...initialEditState(),
        doc: OverrideDocSchema.parse({
          captions: { w1000: { text: "a", was: "a" }, w1200: { text: "b", was: "b" } },
        }),
      },
      {
        type: "rekeyCaptionKeys",
        mapping: [
          { fromMs: 1000, toMs: 1500 },
          { fromMs: 1200, toMs: 1500 },
        ],
      },
    );
    expect(s.doc.captions).toEqual({
      w1500: { text: "a", was: "a" },
      w1200: { text: "b", was: "b" },
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("addScene / removeAddedScene (editor-added-graphics §6)", () => {
  const add = {
    component: "TitleCard",
    props: { title: "HELLO" },
    srcStart: 1,
    srcEnd: 2.4,
    baseIds: [] as string[],
  };

  it("addScene appends a minted entry in ONE undo step, and undo restores the doc", () => {
    const before = initialEditState();
    const s = editReducer(before, { type: "addScene", ...add });
    expect(s.doc.addedScenes).toEqual([
      { id: "added-1", component: "TitleCard", props: { title: "HELLO" }, srcStart: 1, srcEnd: 2.4 },
    ]);
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
    const undone = editReducer(s, { type: "undo" });
    expect(undone.doc).toEqual(before.doc);
    // The emptied list is not left behind as `addedScenes: []` (§1).
    expect("addedScenes" in undone.doc).toBe(false);
  });

  it("mints one past the highest id in the doc, the scenes keys AND the base cues", () => {
    let s = editReducer(initialEditState(), { type: "addScene", ...add });
    s = editReducer(s, { type: "addScene", ...add });
    expect(s.doc.addedScenes!.map((e) => e.id)).toEqual(["added-1", "added-2"]);
    // `added-7` lives only in the base cues (a past run baked it, the entry
    // is gone): reusing it would preview that old cue (§1).
    const fromBase = editReducer(initialEditState(), { type: "addScene", ...add, baseIds: ["scene-0", "added-7"] });
    expect(fromBase.doc.addedScenes!.map((e) => e.id)).toEqual(["added-8"]);
    // A leftover split-half edit names its root too.
    const fromKeys = editReducer(
      { ...initialEditState(), doc: OverrideDocSchema.parse({ scenes: { "added-4@s1#orphaned": { hidden: true } } }) },
      { type: "addScene", ...add },
    );
    expect(fromKeys.doc.addedScenes!.map((e) => e.id)).toEqual(["added-5"]);
  });

  it("mintAddedSceneId is the reducer's own mint", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "added-2": { props: { title: "X" } } } });
    expect(mintAddedSceneId(doc, ["added-3"])).toBe("added-4");
    const s = editReducer({ ...initialEditState(), doc }, { type: "addScene", ...add, baseIds: ["added-3"] });
    expect(s.doc.addedScenes!.at(-1)!.id).toBe("added-4");
  });

  it("removeAddedScene removes the entry and every key rooted at it, not added-10, and leaves splits", () => {
    const doc = OverrideDocSchema.parse({
      addedScenes: [
        { id: "added-1", component: "TitleCard", props: { title: "A" }, srcStart: 1, srcEnd: 2 },
        { id: "added-10", component: "TitleCard", props: { title: "B" }, srcStart: 5, srcEnd: 6 },
      ],
      scenes: {
        "added-1": { props: { title: "EDITED" } },
        "added-1@3": { hidden: true },
        "added-1#orphaned": { props: { title: "OLD" } },
        "added-10": { props: { title: "KEEP" } },
        "scene-0": { props: { value: "9" } },
      },
      splits: [{ id: "3", at: 1.5 }],
    });
    const s = editReducer({ ...initialEditState(), doc }, { type: "removeAddedScene", id: "added-1" });
    expect(s.doc.addedScenes!.map((e) => e.id)).toEqual(["added-10"]);
    expect(Object.keys(s.doc.scenes).sort()).toEqual(["added-10", "scene-0"]);
    // A split is a time point, not tied to an id (§6).
    expect(s.doc.splits).toEqual(doc.splits);
    expect(s.past).toHaveLength(1);
    expect(editReducer(s, { type: "undo" }).doc).toEqual(doc);
  });

  it("addScene writes the entry and scenes[newId] (item pins, timing) in ONE commit (graphic-editor-modal §6)", () => {
    const before = initialEditState();
    const scenePatch = {
      itemPins: { component: "BulletList", pins: [null, null] },
      timing: { srcStart: 1.1, srcEnd: 2.4 },
    };
    const s = editReducer(before, {
      type: "addScene",
      ...add,
      component: "BulletList",
      props: { items: ["A", "B"] },
      scenePatch,
    });
    expect(s.doc.addedScenes!.map((e) => e.id)).toEqual(["added-1"]);
    expect(s.doc.scenes["added-1"]).toEqual({ props: {}, elements: {}, ...scenePatch });
    expect(s.past).toHaveLength(1);
    expect(editReducer(s, { type: "undo" }).doc).toEqual(before.doc);
  });

  it("addScene with an empty or absent scenePatch leaves scenes untouched", () => {
    expect(editReducer(initialEditState(), { type: "addScene", ...add }).doc.scenes).toEqual({});
    expect(editReducer(initialEditState(), { type: "addScene", ...add, scenePatch: {} }).doc.scenes).toEqual({});
  });

  it("removing the last entry removes the key; an unknown id is a no-op", () => {
    let s = editReducer(initialEditState(), { type: "addScene", ...add });
    s = editReducer(s, { type: "removeAddedScene", id: "added-1" });
    expect("addedScenes" in s.doc).toBe(false);
    expect(editReducer(s, { type: "removeAddedScene", id: "added-9" })).toBe(s);
  });

  it("the hook's addScene returns the id the reducer minted", () => {
    let api!: ReturnType<typeof useEdits>;
    const Harness = (): null => {
      api = useEdits();
      return null;
    };
    const root = createRoot(document.createElement("div"));
    act(() => {
      root.render(React.createElement(Harness));
    });
    let first = "";
    act(() => {
      first = api.addScene({ ...add, baseIds: ["added-2"] });
    });
    expect(first).toBe("added-3");
    expect(api.doc.addedScenes!.map((e) => e.id)).toEqual(["added-3"]);
    let second = "";
    act(() => {
      second = api.addScene(add);
    });
    expect(second).toBe("added-4");
    act(() => api.removeAddedScene("added-3"));
    expect(api.doc.addedScenes!.map((e) => e.id)).toEqual(["added-4"]);
    act(() => root.unmount());
  });
});
