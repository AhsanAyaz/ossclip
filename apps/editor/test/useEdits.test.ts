import { describe, expect, it, vi } from "vitest";
import { OverrideDocSchema, splitCues, type SceneCue } from "@ossclip/core/browser";
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
  it("cutChunk writes ONLY {startSec, endSec} — no src key", () => {
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

  // The binding contract (packages/core/src/overrides.ts's schema comment,
  // PLAN 2026-08-04 Task 4c): the editor must never write or preserve a
  // cut's `src` — `src` is produce's own resolved source anchor. `cutChunk`
  // only ever replaces an EXISTING SRC-LESS entry at the same window (a
  // genuine re-cut of a window nobody has produced yet); it never invents
  // one.
  it("cutChunk on a window whose EXISTING SRC-LESS entry is stale still writes a fresh, src-less replacement", () => {
    const withStaleCut = editReducer(initialEditState(), {
      type: "cutChunk", startSec: 10, endSec: 14,
    });

    const s = editReducer(withStaleCut, { type: "cutChunk", startSec: 10, endSec: 14 });

    expect(s.doc.cuts).toEqual([{ startSec: 10, endSec: 14 }]); // still exactly one
    expect("src" in s.doc.cuts[0]!).toBe(false);
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
  /** One take long enough to survive two splits and `SPLIT_MIN_PIECE_SEC`. */
  const splitTarget = (): SceneCue =>
    ({ id: "scene-0", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10 }) as SceneCue;

  it("addSplit stores sorted, dedupes within a millisecond", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", t: 7.5 });
    s = editReducer(s, { type: "addSplit", t: 2.25 });
    expect(s.doc.splits.map((x) => x.at)).toEqual([2.25, 7.5]);
    // Every split leaves here NAMEABLE. The exact value is §137's business
    // (`legacySplitId`), but an empty id would name the half `scene-0@` and
    // is only caught by the server's `safeParse` on Save, as a 400.
    expect(s.doc.splits.every((x) => x.id.length > 0)).toBe(true);
    // A repeated ⌘B on the same paused frame is one decision.
    expect(editReducer(s, { type: "addSplit", t: 7.5004 })).toBe(s);
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
    s = editReducer(s, { type: "addSplit", t: 1.2 });

    expect(s.doc.splits).toHaveLength(2);
    expect(new Set(s.doc.splits.map((x) => x.id)).size).toBe(2);

    const halves = splitCues([splitTarget()], s.doc.splits);
    expect(halves).toHaveLength(3);
    expect(new Set(halves.map((c) => c.id)).size).toBe(3);
  });

  it("splits undo like any other edit", () => {
    let s = editReducer(initialEditState(), { type: "addSplit", t: 7.5 });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.splits).toEqual([]);
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
