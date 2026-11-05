import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type OverlayEntrySnapshot } from "@ossclip/core/browser";
import { editReducer, initialEditState, mintOverlayAddedId, type EditState } from "../src/useEdits";

/**
 * The `overlays` slice (overlay-library spec §Editor, "Undo"). The invariants
 * the sfx slice holds, held again: every gesture is one undo step, and an
 * override with nothing left to say is deleted — up to the slot itself, so a
 * project that never touched an overlay saves byte-identical overrides.json.
 */

const state = (overlays?: unknown): EditState => ({
  ...initialEditState(),
  doc: OverrideDocSchema.parse(overlays === undefined ? {} : { overlays }),
});

const GDE: OverlayEntrySnapshot = { id: "gde", name: "GDE", names: ["GDE"], kind: "logo", ext: "png" };

describe("patchOverlay", () => {
  it("writes a match's edit under its id, merging fields", () => {
    let s = editReducer(state(), { type: "patchOverlay", id: "gde@3", patch: { look: "card" } });
    s = editReducer(s, { type: "patchOverlay", id: "gde@3", patch: { sound: null } });
    expect(s.doc.overlays).toEqual({ edits: { "gde@3": { look: "card", sound: null } }, added: [], entries: [] });
    expect(s.past).toHaveLength(2);
  });

  it("rewrites an ADDED placement's own record instead of growing an edit", () => {
    const s = editReducer(
      state({ added: [{ id: "gde-1", entryId: "gde", word: 1, source: "user" }], entries: [GDE] }),
      { type: "patchOverlay", id: "gde-1", patch: { word: 4, durationSec: 2 } },
    );
    expect(s.doc.overlays?.added).toEqual([{ id: "gde-1", entryId: "gde", word: 4, durationSec: 2, source: "user" }]);
    expect(s.doc.overlays?.edits).toEqual({});
  });

  it("is a no-op (no undo step) when nothing changes", () => {
    const s0 = state({ edits: { "gde@3": { look: "card" } } });
    expect(editReducer(s0, { type: "patchOverlay", id: "gde@3", patch: { look: "card" } })).toBe(s0);
  });

  it("coalesces a slider drag into one undo step", () => {
    let s = editReducer(state(), { type: "patchOverlay", id: "gde@3", patch: { durationSec: 2 }, coalesce: true });
    s = editReducer(s, { type: "patchOverlay", id: "gde@3", patch: { durationSec: 2.5 }, coalesce: true });
    expect(s.past).toHaveLength(1);
    expect(s.doc.overlays?.edits["gde@3"]).toEqual({ durationSec: 2.5 });
  });
});

describe("resetOverlayDuration", () => {
  it("drops the stored duration, and the slot with it when nothing is left", () => {
    const s = editReducer(state({ edits: { "gde@3": { durationSec: 4 } } }), { type: "resetOverlayDuration", id: "gde@3" });
    expect(s.doc.overlays).toBeUndefined();
  });

  it("drops an added placement's duration", () => {
    const s = editReducer(
      state({ added: [{ id: "gde-1", entryId: "gde", word: 1, durationSec: 4, source: "user" }] }),
      { type: "resetOverlayDuration", id: "gde-1" },
    );
    expect(s.doc.overlays?.added[0]).toEqual({ id: "gde-1", entryId: "gde", word: 1, source: "user" });
  });
});

describe("removeOverlay / restoreOverlay", () => {
  it("negates a match (ghost) and restore deletes the key and the empty slot", () => {
    let s = editReducer(state(), { type: "removeOverlay", id: "gde@3" });
    expect(s.doc.overlays?.edits).toEqual({ "gde@3": { removed: true } });
    s = editReducer(s, { type: "restoreOverlay", id: "gde@3" });
    expect(s.doc.overlays).toBeUndefined();
    expect("overlays" in s.doc).toBe(false);
  });

  it("keeps the user's other edits through a remove → restore", () => {
    let s = editReducer(state({ edits: { "gde@3": { look: "card" } } }), { type: "removeOverlay", id: "gde@3" });
    s = editReducer(s, { type: "restoreOverlay", id: "gde@3" });
    expect(s.doc.overlays?.edits).toEqual({ "gde@3": { look: "card" } });
  });

  it("splices an added placement out, with any edit keyed to it", () => {
    const s = editReducer(
      state({
        added: [{ id: "gde-1", entryId: "gde", word: 1, source: "user" }],
        edits: { "gde-1": { look: "card" } },
      }),
      { type: "removeOverlay", id: "gde-1" },
    );
    expect(s.doc.overlays).toBeUndefined();
  });

  it("restore of something not removed is a no-op", () => {
    const s0 = state();
    expect(editReducer(s0, { type: "restoreOverlay", id: "gde@3" })).toBe(s0);
  });
});

describe("addOverlay / addOverlayMatches", () => {
  it("mints an @-free id, snapshots the entry, and undo restores the untouched doc", () => {
    const s0 = state();
    const s = editReducer(s0, { type: "addOverlay", entry: GDE, word: 3 });
    expect(s.doc.overlays).toEqual({
      edits: {},
      added: [{ id: "gde-3", entryId: "gde", word: 3, source: "user" }],
      entries: [GDE],
    });
    const undone = editReducer(s, { type: "undo" });
    expect(undone.doc).toEqual(s0.doc);
    expect("overlays" in undone.doc).toBe(false);
  });

  it("upserts the snapshot (a re-pick replaces, never duplicates) and de-collides ids", () => {
    let s = editReducer(state(), { type: "addOverlay", entry: GDE, word: 3 });
    const regif = { ...GDE, ext: "gif" as const, kind: "gif" as const };
    s = editReducer(s, { type: "addOverlay", entry: regif, word: 3 });
    expect(s.doc.overlays?.entries).toEqual([regif]);
    expect(s.doc.overlays?.added.map((a) => a.id)).toEqual(["gde-3", "gde-3-2"]);
  });

  it("stores find-matches results under minted ids, keeping source: match (ruling R5)", () => {
    const s = editReducer(state(), {
      type: "addOverlayMatches",
      placements: [
        { id: "gde@3", entryId: "gde", word: 3, source: "match" },
        { id: "fb@7", entryId: "fb", word: 7, source: "match" },
      ],
      entries: [GDE, { ...GDE, id: "fb", name: "Firebase", names: ["Firebase"] }],
    });
    const added = s.doc.overlays?.added ?? [];
    expect(added.map((a) => [a.id, a.source])).toEqual([
      ["gde-3", "match"],
      ["fb-7", "match"],
    ]);
    for (const a of added) expect(a.id).not.toContain("@");
    // Every stored id passes the doc's own schema — produce refuses a doc that fails to parse.
    expect(() => OverrideDocSchema.parse(s.doc)).not.toThrow();
    expect(s.past).toHaveLength(1);
  });

  it("an empty match result commits nothing", () => {
    const s0 = state();
    expect(editReducer(s0, { type: "addOverlayMatches", placements: [], entries: [] })).toBe(s0);
  });
});

describe("mintOverlayAddedId", () => {
  it("sanitises the base and never yields an @", () => {
    expect(mintOverlayAddedId("a@b", 2, [])).toBe("a-b-2");
    expect(mintOverlayAddedId("", 2, [{ id: "overlay-2" }])).toBe("overlay-2-2");
  });
});
