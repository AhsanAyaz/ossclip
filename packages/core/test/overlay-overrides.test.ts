import { describe, expect, it } from "vitest";
import { matchLibrary } from "../src/overlay-match";
import { applyOverlayOverrides, OverrideDocSchema, overlayRematchGuards } from "../src/overrides";
import { ProductionSchema, type OverlayEntrySnapshot, type OverlayPlacement, type Segment } from "../src/schema";
import { TimeMap } from "../src/timemap";

/**
 * The user's layer over the matched overlay plan (spec §Placement schema).
 * Pure: the plan is what production.json stores, the layer what the editor
 * writes into overrides.json.
 */
const gde: OverlayEntrySnapshot = { id: "gde", name: "GDE", names: ["GDE"], kind: "logo", ext: "png" };
const fb: OverlayEntrySnapshot = { id: "fb", name: "Firebase", names: ["Firebase"], kind: "logo", ext: "svg" };

const plan: { entries: OverlayEntrySnapshot[]; placements: OverlayPlacement[] } = {
  entries: [gde, fb],
  placements: [
    { id: "gde@3", entryId: "gde", word: 3, source: "match" },
    { id: "fb@12", entryId: "fb", word: 12, source: "match" },
  ],
};

const layer = (overlays: unknown) => OverrideDocSchema.parse({ overlays }).overlays;

describe("applyOverlayOverrides", () => {
  it("passes the plan through when there is no layer, and yields nothing for no plan", () => {
    expect(applyOverlayOverrides(plan, undefined)).toEqual({ ...plan, dropped: [] });
    expect(applyOverlayOverrides(undefined, undefined)).toEqual({ entries: [], placements: [], dropped: [] });
  });

  it("edit patches look/duration/sound", () => {
    const out = applyOverlayOverrides(
      plan,
      layer({ edits: { "gde@3": { look: "card", durationSec: 3, sound: null } } }),
    );
    expect(out.placements[0]).toEqual({
      id: "gde@3",
      entryId: "gde",
      word: 3,
      source: "match",
      look: "card",
      durationSec: 3,
      sound: null,
    });
    expect(out.placements[1]).toEqual(plan.placements[1]);
    expect(out.dropped).toEqual([]);
  });

  it("edit can swap the entry and move the word", () => {
    const out = applyOverlayOverrides(plan, layer({ edits: { "gde@3": { entryId: "fb", word: 5 } } }));
    // The id stays the plan's — it is the key the edit is stored under.
    expect(out.placements[0]).toEqual({ id: "gde@3", entryId: "fb", word: 5, source: "match" });
  });

  it("removed true drops a match and survives a re-produce", () => {
    const l = layer({ edits: { "gde@3": { removed: true } } });
    const first = applyOverlayOverrides(plan, l);
    expect(first.placements.map((p) => p.id)).toEqual(["fb@12"]);
    // A re-produce re-matches the same first mention → the same stable id → still removed.
    const replanned = structuredClone(plan);
    const again = applyOverlayOverrides(replanned, l);
    expect(again.placements.map((p) => p.id)).toEqual(["fb@12"]);
    expect(again.dropped).toEqual([]);
  });

  it("added placements appended", () => {
    const out = applyOverlayOverrides(
      plan,
      layer({ added: [{ id: "u1", entryId: "gde", word: 1, source: "user" }] }),
    );
    expect(out.placements.map((p) => p.id)).toEqual(["gde@3", "fb@12", "u1"]);
  });

  it("an edit keyed by an added id applies to that added placement", () => {
    const out = applyOverlayOverrides(
      plan,
      layer({ added: [{ id: "u1", entryId: "gde", word: 1, source: "user" }], edits: { u1: { look: "card" } } }),
    );
    expect(out.placements[2]).toEqual({ id: "u1", entryId: "gde", word: 1, source: "user", look: "card" });
    expect(out.dropped).toEqual([]);
    const removed = applyOverlayOverrides(
      plan,
      layer({ added: [{ id: "u1", entryId: "gde", word: 1, source: "user" }], edits: { u1: { removed: true } } }),
    );
    expect(removed.placements.map((p) => p.id)).toEqual(["gde@3", "fb@12"]);
  });

  it("override entry snapshot wins over plan entry", () => {
    const swapped: OverlayEntrySnapshot = { ...gde, ext: "gif", kind: "gif" };
    const meme: OverlayEntrySnapshot = { id: "meme", name: "Meme", names: ["Meme"], kind: "gif", ext: "gif" };
    const out = applyOverlayOverrides(plan, layer({ entries: [swapped, meme] }));
    expect(out.entries).toEqual([swapped, fb, meme]);
  });

  it("stale edit key reported", () => {
    const out = applyOverlayOverrides(plan, layer({ edits: { "gde@7": { look: "card" } } }));
    expect(out.dropped).toEqual([{ key: "gde@7", reason: "stale key" }]);
    expect(out.placements).toEqual(plan.placements);
  });

  it("a removal addressing nothing is a tombstone, not a stale key (ruling R17)", () => {
    const out = applyOverlayOverrides(plan, layer({ edits: { "gde@19": { removed: true }, "x@1": { look: "card" } } }));
    expect(out.dropped).toEqual([{ key: "x@1", reason: "stale key" }]);
    expect(out.placements).toEqual(plan.placements);
  });

  it("an added id with @ is refused (that is the matched-id namespace)", () => {
    expect(() => layer({ added: [{ id: "gde@1", entryId: "gde", word: 1, source: "user" }] })).toThrow();
  });
});

describe("overlayRematchGuards (ruling R17)", () => {
  /** Word i starts at 2i source seconds. */
  const words = ["so", "I", "became", "GDE", "and", "used", "Firebase", "a", "lot"].map((text, i) => ({
    text,
    start: i * 2,
    end: i * 2 + 0.4,
  }));
  const library = [
    { id: "gde", names: ["GDE"] },
    { id: "fb", names: ["Firebase"] },
  ];
  const keepAll = new TimeMap([{ srcIn: 0, srcOut: 30, kind: "keep" } satisfies Segment]);
  const fresh = (l: ReturnType<typeof layer>) =>
    matchLibrary(words, library, { ...overlayRematchGuards(undefined, l, words, keepAll), minGapSec: 0 });

  it("a fresh match never re-places an entry Find-matches already put in added", () => {
    // The I1 bug: Find-matches stored GDE in `added` under an @-free id, so a
    // fresh produce matched `gde@3` again — two cues and two pops on word 3.
    const l = layer({ added: [{ id: "gde-3", entryId: "gde", word: 3, source: "match" }], entries: [gde] });
    const { placements } = fresh(l);
    expect(placements.map((p) => p.id)).toEqual(["fb@6"]);
    const applied = applyOverlayOverrides({ entries: [gde, fb], placements }, l);
    expect(applied.placements.filter((p) => p.entryId === "gde")).toHaveLength(1);
  });

  it("the editor's tombstone keeps a deleted Find-matches placement from returning", () => {
    const l = layer({ edits: { "gde@3": { removed: true } } });
    expect(fresh(l).placements.map((p) => p.id)).toEqual(["fb@6"]);
    // Without the tombstone the same layer re-matches it — the resurrection.
    expect(fresh(layer({})).placements.map((p) => p.id)).toEqual(["gde@3", "fb@6"]);
  });

  it("a fresh produce passes no plan, so the previous run's own matches re-derive", () => {
    expect(overlayRematchGuards(undefined, undefined, words, keepAll)).toEqual({
      skipEntryIds: new Set(),
      occupiedStarts: [],
    });
    // A swap edit on a plan id is not "handled" without the plan: the match
    // must come back for the swap to apply to it.
    const swap = layer({ edits: { "gde@3": { entryId: "fb" } } });
    expect(overlayRematchGuards(undefined, swap, words, keepAll).skipEntryIds).toEqual(new Set());
  });

  it("with a plan: placed, swapped-from and removed entries are all handled", () => {
    const g = overlayRematchGuards(plan, layer({ edits: { "gde@3": { entryId: "meme" }, "fb@12": { removed: true } } }), words);
    expect(g.skipEntryIds).toEqual(new Set(["gde", "fb", "meme"]));
  });

  it("occupiedStarts come from the resolver with a map, from word starts without", () => {
    const cut = new TimeMap([
      { srcIn: 0, srcOut: 4, kind: "keep" },
      { srcIn: 4, srcOut: 8, kind: "remove" },
      { srcIn: 8, srcOut: 30, kind: "keep" },
    ] satisfies Segment[]);
    const l = layer({ added: [{ id: "gde-1", entryId: "gde", word: 6, source: "user" }], entries: [gde] });
    // Word 6 at source 12s plays at 8s once 4s of source are cut before it.
    expect(overlayRematchGuards(undefined, l, words, cut).occupiedStarts).toEqual([8]);
    expect(overlayRematchGuards(undefined, l, words).occupiedStarts).toEqual([12]);
  });
});

describe("back-compat", () => {
  it("OverrideDocSchema.parse({}) has no overlays key", () => {
    expect("overlays" in OverrideDocSchema.parse({})).toBe(false);
  });

  const bare = {
    version: 1,
    source: { path: "/v.mp4", probe: { duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true } },
    cleanup: "standard",
    render: { width: 1080, height: 1920, fps: 30 },
  };

  it("ProductionSchema without overlays parses unchanged", () => {
    const parsed = ProductionSchema.parse(bare);
    expect("overlays" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(bare));
  });

  it("ProductionSchema keeps an overlays plan", () => {
    const prod = ProductionSchema.parse(JSON.parse(JSON.stringify({ ...bare, overlays: plan })));
    expect(prod.overlays).toEqual(plan);
  });
});
