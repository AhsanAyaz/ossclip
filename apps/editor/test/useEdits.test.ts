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

  it("NEVER writes a src key — resolving it is produce's job alone", () => {
    const s = cutTwo();
    expect("src" in s.doc.cuts[0]!).toBe(false);
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
