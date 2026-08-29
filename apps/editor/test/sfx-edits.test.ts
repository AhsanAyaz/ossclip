import { describe, expect, it } from "vitest";
import { OverrideDocSchema, sfxPlacementKey } from "@ossclip/core/browser";
import { editReducer, initialEditState, mintSfxAddedId, type EditState } from "../src/useEdits";

/**
 * The `sfx` slice (Phase 4, 2026-08-29) — the editor's half of the round-trip
 * `applySfxOverrides` completes.
 *
 * Two invariants run through every case here, because breaking either one
 * silently loses the user's work:
 *  - edits are keyed by `sfxPlacementKey` off the PLAN, so a re-plan that
 *    keeps a placement keeps its edit;
 *  - an override with nothing left to say is DELETED, up to and including the
 *    `sfx` slot itself — an overrides.json written before this key existed
 *    must stay byte-identical after an edit is undone.
 */

const state = (sfx?: unknown): EditState => ({
  ...initialEditState(),
  doc: OverrideDocSchema.parse(sfx === undefined ? {} : { sfx }),
});

/** The plan record the writers pass alongside every planned-placement patch. */
const PLANNED = { soundId: "ding", word: 2 };
const KEY = sfxPlacementKey(PLANNED);

describe("patchSfx — retime, swap and gain on a planned placement", () => {
  it("writes the edit under the PLAN's key, not the edited values'", () => {
    const next = editReducer(state(), {
      type: "patchSfx",
      key: KEY,
      patch: { word: 7 },
      planned: PLANNED,
    });
    expect(next.doc.sfx).toEqual({ edits: { "ding@2": { word: 7 } }, added: [] });
  });

  it("merges fields rather than replacing the entry", () => {
    const next = editReducer(state({ edits: { "ding@2": { word: 7 } } }), {
      type: "patchSfx",
      key: KEY,
      patch: { soundId: "vine-boom" },
      planned: PLANNED,
    });
    expect(next.doc.sfx?.edits["ding@2"]).toEqual({ word: 7, soundId: "vine-boom" });
  });

  it("DELETES a field dragged back onto what the model planned", () => {
    const next = editReducer(state({ edits: { "ding@2": { word: 7, gain: 0.5 } } }), {
      type: "patchSfx",
      key: KEY,
      patch: { word: 2 },
      planned: PLANNED,
    });
    // The clearVideo rule: an override restating the plan would keep winning
    // after a re-plan moved the placement underneath it.
    expect(next.doc.sfx?.edits["ding@2"]).toEqual({ gain: 0.5 });
  });

  it("reads an absent planned gain as 1, so a slider back at 1× clears itself", () => {
    const next = editReducer(state({ edits: { "ding@2": { gain: 1.5 } } }), {
      type: "patchSfx",
      key: KEY,
      patch: { gain: 1 },
      planned: PLANNED,
    });
    // …and with nothing else stored, the whole slot goes.
    expect(next.doc.sfx).toBeUndefined();
  });

  it("keeps a gain that equals the plan's own explicit gain out of the doc", () => {
    const next = editReducer(state(), {
      type: "patchSfx",
      key: KEY,
      patch: { gain: 0.5 },
      planned: { ...PLANNED, gain: 0.5 },
    });
    expect(next.doc.sfx).toBeUndefined();
    expect(next.past).toHaveLength(0);
  });

  it("mints no undo step for a patch that changes nothing", () => {
    const before = state({ edits: { "ding@2": { word: 7 } } });
    const after = editReducer(before, {
      type: "patchSfx",
      key: KEY,
      patch: { word: 7 },
      planned: PLANNED,
    });
    expect(after).toBe(before);
  });

  it("coalesces a gain scrub into one undo step", () => {
    let s = state();
    for (const gain of [0.2, 0.3, 0.4]) {
      s = editReducer(s, {
        type: "patchSfx",
        key: KEY,
        patch: { gain },
        planned: PLANNED,
        coalesce: `sfx:${KEY}:gain`,
      });
    }
    expect(s.doc.sfx?.edits["ding@2"]).toEqual({ gain: 0.4 });
    expect(s.past).toHaveLength(1);
  });
});

describe("mute / restore — the planned placement's delete and its way back", () => {
  it("mutes by NEGATING the plan entry, keeping it for the ghost", () => {
    const next = editReducer(state(), { type: "muteSfx", key: KEY });
    expect(next.doc.sfx).toEqual({ edits: { "ding@2": { muted: true } }, added: [] });
  });

  it("keeps an existing retime when muting", () => {
    const next = editReducer(state({ edits: { "ding@2": { word: 7 } } }), {
      type: "muteSfx",
      key: KEY,
    });
    expect(next.doc.sfx?.edits["ding@2"]).toEqual({ word: 7, muted: true });
  });

  it("restores by DELETING the key — never `muted: false`", () => {
    const next = editReducer(state({ edits: { "ding@2": { muted: true } } }), {
      type: "restoreSfx",
      key: KEY,
    });
    // The whole slot goes with the last entry (the captionsHidden rule).
    expect(next.doc.sfx).toBeUndefined();
    expect(JSON.stringify(next.doc)).not.toContain("muted");
  });

  it("restores WITHOUT discarding the retime the same placement carries", () => {
    // Un-muting says nothing about where the user dragged it; silently
    // throwing that away would be a §137-shaped loss nobody printed.
    const next = editReducer(state({ edits: { "ding@2": { word: 7, muted: true } } }), {
      type: "restoreSfx",
      key: KEY,
    });
    expect(next.doc.sfx?.edits["ding@2"]).toEqual({ word: 7 });
  });

  it("no-ops both ways on a placement already in that state", () => {
    const muted = state({ edits: { "ding@2": { muted: true } } });
    expect(editReducer(muted, { type: "muteSfx", key: KEY })).toBe(muted);
    const clean = state();
    expect(editReducer(clean, { type: "restoreSfx", key: KEY })).toBe(clean);
  });
});

describe("added placements — the user's own", () => {
  it("mints an id and stores the placement", () => {
    const next = editReducer(state(), { type: "addSfx", soundId: "pop", word: 4 });
    expect(next.doc.sfx?.added).toEqual([{ id: "pop-4", soundId: "pop", word: 4 }]);
  });

  it("grows no `gain: undefined` key when none was asked for", () => {
    const next = editReducer(state(), { type: "addSfx", soundId: "pop", word: 4 });
    expect(Object.keys(next.doc.sfx!.added[0]!)).toEqual(["id", "soundId", "word"]);
  });

  it("patches an added placement in place, with no plan to restate", () => {
    const next = editReducer(state({ added: [{ id: "pop-4", soundId: "pop", word: 4 }] }), {
      type: "patchSfxAdded",
      id: "pop-4",
      patch: { word: 1, gain: 1 },
    });
    // gain 1 is stored, unlike the planned path's clear-to-inherit: an added
    // placement HAS no plan value to fall back to.
    expect(next.doc.sfx?.added).toEqual([{ id: "pop-4", soundId: "pop", word: 1, gain: 1 }]);
  });

  it("ignores a patch for an id nothing answers to", () => {
    const before = state({ added: [{ id: "pop-4", soundId: "pop", word: 4 }] });
    expect(editReducer(before, { type: "patchSfxAdded", id: "nope", patch: { word: 1 } })).toBe(
      before,
    );
  });

  it("mints no undo step for a patch that changes nothing", () => {
    const before = state({ added: [{ id: "pop-4", soundId: "pop", word: 4 }] });
    expect(editReducer(before, { type: "patchSfxAdded", id: "pop-4", patch: { word: 4 } })).toBe(
      before,
    );
  });

  it("DELETES by splicing — an added placement leaves no ghost", () => {
    const next = editReducer(
      state({
        added: [
          { id: "pop-4", soundId: "pop", word: 4 },
          { id: "ding-9", soundId: "ding", word: 9 },
        ],
      }),
      { type: "removeSfxAdded", id: "pop-4" },
    );
    expect(next.doc.sfx?.added).toEqual([{ id: "ding-9", soundId: "ding", word: 9 }]);
  });

  it("drops the whole sfx slot when the last added placement goes", () => {
    const next = editReducer(state({ added: [{ id: "pop-4", soundId: "pop", word: 4 }] }), {
      type: "removeSfxAdded",
      id: "pop-4",
    });
    expect(next.doc.sfx).toBeUndefined();
  });
});

describe("mintSfxAddedId", () => {
  /** `SfxAddedPlacementSchema`'s own pattern — produce THROWS on a doc that
   * fails it, so a minted id that misses it costs the user their edit layer. */
  const PATTERN = /^[A-Za-z0-9_-]+$/;

  it("mints a pattern-safe id with no `@` in it", () => {
    const id = mintSfxAddedId("vine-boom", 12, []);
    expect(id).toBe("vine-boom-12");
    expect(id).toMatch(PATTERN);
    // `@` is `sfxPlacementKey`'s separator: one spelling must never read as
    // the other.
    expect(id).not.toContain("@");
  });

  it("counts up rather than colliding, reproducibly from the doc alone", () => {
    const existing = [{ id: "pop-4" }, { id: "pop-4-2" }];
    expect(mintSfxAddedId("pop", 4, existing)).toBe("pop-4-3");
    // Same doc, same answer — the id is persisted and names a record, so it
    // may not depend on a clock or a nonce (mintSplitId's rule).
    expect(mintSfxAddedId("pop", 4, existing)).toBe("pop-4-3");
  });

  it("sanitises anything a future id vocabulary could bring in", () => {
    // The library's ids are slugs today; this invariant must not depend on a
    // promise made in another package.
    expect(mintSfxAddedId("../etc/passwd", 1, [])).toMatch(PATTERN);
    expect(mintSfxAddedId("a@b.c", 1, [])).toBe("a-b-c-1");
    expect(mintSfxAddedId("@@@", 1, [])).toBe("sfx-1");
  });

  it("never mints a negative or fractional word into the id", () => {
    expect(mintSfxAddedId("pop", -3, [])).toBe("pop-0");
    expect(mintSfxAddedId("pop", 2.7, [])).toBe("pop-2");
  });

  it("mints ids a fresh reducer run keeps unique across repeated adds", () => {
    let s = state();
    for (let i = 0; i < 3; i++) s = editReducer(s, { type: "addSfx", soundId: "pop", word: 4 });
    expect(s.doc.sfx?.added.map((a) => a.id)).toEqual(["pop-4", "pop-4-2", "pop-4-3"]);
  });
});

describe("the sfx slot itself", () => {
  it("stays ABSENT on a doc no sfx gesture has touched", () => {
    // Every overrides.json written before this key existed must round-trip
    // byte-identically (the schema's `captionsHidden` rule).
    expect(JSON.stringify(initialEditState().doc)).not.toContain("sfx");
  });

  it("survives the PUT parse it will be saved through", () => {
    const next = editReducer(
      editReducer(state(), { type: "addSfx", soundId: "pop", word: 4 }),
      { type: "muteSfx", key: KEY },
    );
    expect(OverrideDocSchema.parse(JSON.parse(JSON.stringify(next.doc))).sfx).toEqual(next.doc.sfx);
  });

  it("undoes back to a doc with no sfx key at all", () => {
    const added = editReducer(state(), { type: "addSfx", soundId: "pop", word: 4 });
    const undone = editReducer(added, { type: "undo" });
    expect(undone.doc.sfx).toBeUndefined();
  });
});
