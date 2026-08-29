import { describe, expect, it } from "vitest";
import { ProductionSchema, ProductionSfxSchema } from "../src/schema";
import { SfxPlacementSchema, normalizeSfxPlan } from "../src/producer/sfx";
import type { BeatSheet } from "../src/producer/beats";
import type { LoadedSfxSound } from "../src/sfx-pack";
import type { Transcript } from "../src/schema";

/** One graphic moment, so `scene-0` is a link `normalizeSfxPlan` accepts. */
const sheet: BeatSheet = {
  hook: "THE HOOK",
  moments: [
    { startWord: 0, endWord: 9, purpose: "open", onScreenCopy: "OPEN", sceneKind: "TitleCard" },
  ],
};

/**
 * `production.json`'s `sfx` slot: an OPTIONAL field, and the copy of the
 * placement shape that keeps `schema.ts` free of the producer (and therefore
 * of node) — see the field's own comment for why the duplication is
 * deliberate. This file is the pin that stops it becoming a second truth.
 */

/** The smallest production the schema accepts — everything else is optional. */
const bareProduction = {
  version: 1,
  source: {
    path: "/takes/raw.mp4",
    probe: { duration: 12, width: 1080, height: 1920, fps: 30, hasAudio: true },
  },
  cleanup: "standard",
  render: { width: 1080, height: 1920, fps: 30 },
};

describe("ProductionSchema.sfx", () => {
  it("parses a production.json written before --sfx existed", () => {
    // The whole compatibility claim: every workdir on disk predates this
    // field, and the editor re-reads them.
    const parsed = ProductionSchema.parse(bareProduction);
    expect(parsed.sfx).toBeUndefined();
  });

  it("round-trips a plan through JSON without changing it", () => {
    const withSfx = {
      ...bareProduction,
      sfx: {
        level: "meme",
        placements: [
          { soundId: "ding", word: 12 },
          // The scene link rides the round trip: the editor reads this field
          // back out of production.json through `/api/sfx/plan` to place the
          // marker on the graphic rather than on the word.
          { soundId: "whoosh-soft", word: 20, sceneId: "scene-0" },
          { soundId: "scratch", word: 40, gain: 0.6, rationale: "the pivot" },
        ],
      },
    };
    const parsed = ProductionSchema.parse(JSON.parse(JSON.stringify(withSfx)));
    expect(parsed.sfx).toEqual(withSfx.sfx);
  });

  it("refuses a level it does not know, rather than coercing one", () => {
    // `meme` is the level that unlocks the meme-tagged sounds, so a
    // hand-edited "loud" must be an error, never a silent fallback.
    expect(() =>
      ProductionSchema.parse({ ...bareProduction, sfx: { level: "loud", placements: [] } }),
    ).toThrow();
  });

  it("keeps word ANCHORS, not seconds — a second-stamped plan is not a plan", () => {
    expect(() =>
      ProductionSfxSchema.parse({
        level: "normal",
        placements: [{ soundId: "ding", word: 2.5 }],
      }),
    ).toThrow();
  });

  it("stores exactly the fields a planned placement carries (the anti-drift pin)", () => {
    // The two shapes are written in two modules on purpose (browser-safety);
    // if Phase 3 adds a field to one, this fails until it is added to both.
    const stored = Object.keys(ProductionSfxSchema.shape.placements.element.shape).sort();
    expect(stored).toEqual(Object.keys(SfxPlacementSchema.shape).sort());
    // Named out loud as well as compared, so a field DELETED from both at
    // once still trips this — `sceneId` is the one the editor and the
    // resolver both read back off disk (2026-08-29).
    expect(stored).toContain("sceneId");
  });

  it("keeps sceneId OPTIONAL — a pre-2026-08-29 plan has none", () => {
    // Every plan on disk predates the field, and the whole compatibility
    // claim is that they parse byte-identically.
    const parsed = ProductionSfxSchema.parse({
      level: "normal",
      placements: [{ soundId: "ding", word: 12 }],
    });
    expect(parsed.placements[0]).toEqual({ soundId: "ding", word: 12 });
    // …and a hand-edited non-string is refused, not coerced to one.
    expect(() =>
      ProductionSfxSchema.parse({
        level: "normal",
        placements: [{ soundId: "ding", word: 12, sceneId: 3 }],
      }),
    ).toThrow();
  });

  it("stores what normalizeSfxPlan actually produces", () => {
    // Not a hand-written literal: the real output of the deterministic gate,
    // parsed by the storage schema — the exact hand-off produce performs.
    const transcript: Transcript = {
      language: "en",
      words: Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 })),
    };
    const sounds: LoadedSfxSound[] = [
      {
        id: "ding",
        kind: "sound",
        file: "ding.mp3",
        whenToUse: "a takeaway landing",
        tags: [],
        gain: 1,
        absPath: "/packs/starter/ding.mp3",
        packName: "ossclip-starter",
      },
    ];
    const { plan } = normalizeSfxPlan(
      { placements: [{ soundId: "ding", word: 3, gain: 0.8, rationale: "the payoff" }] },
      transcript,
      sounds,
      "normal",
      sheet,
    );
    expect(() =>
      ProductionSfxSchema.parse({ level: "normal", placements: plan.placements }),
    ).not.toThrow();
  });
});
