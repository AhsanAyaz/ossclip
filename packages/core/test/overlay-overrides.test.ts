import { describe, expect, it } from "vitest";
import { applyOverlayOverrides, OverrideDocSchema } from "../src/overrides";
import { ProductionSchema, type OverlayEntrySnapshot, type OverlayPlacement } from "../src/schema";

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

  it("an added id with @ is refused (that is the matched-id namespace)", () => {
    expect(() => layer({ added: [{ id: "gde@1", entryId: "gde", word: 1, source: "user" }] })).toThrow();
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
