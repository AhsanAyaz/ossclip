import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applySfxOverrides,
  sfxPlacementKey,
  type SfxPlannedPlacement,
} from "../src/overrides";

/**
 * The user's layer over the `--sfx` placement plan (Phase 3). Pure: no
 * library, no filesystem, no TimeMap — everything here is the plan a produce
 * run loads and the doc the editor writes, which is exactly what
 * `applySfxOverrides` sits between.
 */
const plan: SfxPlannedPlacement[] = [
  { soundId: "whoosh-soft", word: 3 },
  { soundId: "ding", word: 12, gain: 0.8 },
  { soundId: "pop", word: 20 },
];

const doc = (sfx: unknown): ReturnType<typeof OverrideDocSchema.parse>["sfx"] =>
  OverrideDocSchema.parse({ sfx }).sfx;

describe("applySfxOverrides (the SFX edit layer)", () => {
  it("passes the plan through untouched when the doc has no sfx layer", () => {
    // Absent-means-as-planned: a project that never opened the panel must
    // render exactly what the model placed.
    const out = applySfxOverrides(plan, undefined);
    expect(out.placements).toEqual(plan);
    expect(out.dropped).toEqual([]);
  });

  it("RETIMES a placement to another word, keeping everything else", () => {
    const out = applySfxOverrides(plan, doc({ edits: { "ding@12": { word: 14 } } }));
    // The patch is a patch: the planned gain survives a drag.
    expect(out.placements).toContainEqual({ soundId: "ding", word: 14, gain: 0.8 });
    expect(out.dropped).toEqual([]);
  });

  it("SWAPS the sound while the anchor stays where the model put it", () => {
    const out = applySfxOverrides(plan, doc({ edits: { "pop@20": { soundId: "vine-boom" } } }));
    expect(out.placements).toContainEqual({ soundId: "vine-boom", word: 20 });
  });

  it("sets a GAIN, over the planned one", () => {
    const out = applySfxOverrides(plan, doc({ edits: { "ding@12": { gain: 0.2 } } }));
    expect(out.placements).toContainEqual({ soundId: "ding", word: 12, gain: 0.2 });
  });

  it("MUTES by removing the placement while the doc entry stays", () => {
    const layer = doc({ edits: { "ding@12": { muted: true } } });
    const out = applySfxOverrides(plan, layer);
    expect(out.placements.map((p) => p.soundId)).toEqual(["whoosh-soft", "pop"]);
    // Kept, not deleted — the editor draws a restorable ghost from it, and
    // Restore is what deletes the key.
    expect(layer!.edits["ding@12"]).toEqual({ muted: true });
    // A mute is not a drop: nothing went wrong, the user un-planned it.
    expect(out.dropped).toEqual([]);
  });

  it("ADDS the user's own placements, indistinguishable from planned ones", () => {
    const out = applySfxOverrides(
      plan,
      doc({ added: [{ id: "u1", soundId: "record-scratch", word: 6, gain: 1.5 }] }),
    );
    expect(out.placements).toHaveLength(4);
    // No `id` travels downstream — it names the doc entry, not a placement.
    expect(out.placements[1]).toEqual({ soundId: "record-scratch", word: 6, gain: 1.5 });
  });

  it("REPORTS a stale key instead of guessing at a nearby placement", () => {
    // The re-plan case: the model no longer places a ding on word 12, so the
    // user's work on it is lost — and silence about that is the field failure
    // the `was`-guard posture exists to prevent.
    const out = applySfxOverrides(
      [{ soundId: "whoosh-soft", word: 3 }],
      doc({ edits: { "ding@12": { gain: 0.2 } } }),
    );
    expect(out.placements).toEqual([{ soundId: "whoosh-soft", word: 3 }]);
    expect(out.dropped).toEqual([{ key: "ding@12", reason: "stale key" }]);
  });

  it("applies a duplicate key to the FIRST placement only, and reports the rest", () => {
    // `normalizeSfxPlan`'s spacing pass makes this unreachable from a fresh
    // plan, but a hand-edited production.json is user data too: the edit must
    // land once, deterministically, rather than fan out onto both.
    const dupes: SfxPlannedPlacement[] = [
      { soundId: "ding", word: 12 },
      { soundId: "ding", word: 12 },
    ];
    const out = applySfxOverrides(dupes, doc({ edits: { "ding@12": { gain: 0.1 } } }));
    expect(out.placements).toEqual([
      { soundId: "ding", word: 12, gain: 0.1 },
      { soundId: "ding", word: 12 },
    ]);
    expect(out.dropped).toEqual([{ key: "ding@12", reason: "duplicate key" }]);
  });

  it("returns the plan in word order, so a retime and an add land where they play", () => {
    const out = applySfxOverrides(
      plan,
      doc({
        // A drag backwards past its neighbour, plus an added effect between
        // two planned ones.
        edits: { "pop@20": { word: 1 } },
        added: [{ id: "u1", soundId: "click", word: 8 }],
      }),
    );
    expect(out.placements.map((p) => p.word)).toEqual([1, 3, 8, 12]);
  });

  it("does NOT re-enforce spacing or the density budget — an explicit edit outranks both", () => {
    // Those passes price the MODEL's plan; a user who stacks two effects has
    // said what they want, the same way a user cut outranks a cleanup veto.
    const out = applySfxOverrides(
      plan,
      doc({ edits: { "ding@12": { word: 3 } }, added: [{ id: "u1", soundId: "pop", word: 3 }] }),
    );
    expect(out.placements.filter((p) => p.word === 3)).toHaveLength(3);
  });

  it("leaves the caller's plan array alone", () => {
    const before = JSON.stringify(plan);
    applySfxOverrides(plan, doc({ edits: { "ding@12": { word: 99, muted: true } } }));
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe("sfxPlacementKey", () => {
  it("is the (sound, word) pair — the identity a re-plan preserves or stales", () => {
    expect(sfxPlacementKey({ soundId: "ding", word: 12 })).toBe("ding@12");
  });
});

describe("the overrides.json sfx slot", () => {
  it("is absent by default, so a pre-feature doc grows no key", () => {
    const parsed = OverrideDocSchema.parse({ theme: {}, scenes: {} });
    expect(parsed.sfx).toBeUndefined();
    expect("sfx" in parsed).toBe(false);
  });

  it("defaults its two halves once the key exists", () => {
    expect(OverrideDocSchema.parse({ sfx: {} }).sfx).toEqual({ edits: {}, added: [] });
  });

  it("round-trips through a JSON cycle, which is what overrides.json is", () => {
    const parsed = OverrideDocSchema.parse({
      sfx: {
        edits: { "ding@12": { word: 14, soundId: "pop", gain: 1.4, muted: false } },
        added: [{ id: "sfx-added-1", soundId: "vine-boom", word: 3 }],
      },
    });
    expect(OverrideDocSchema.parse(JSON.parse(JSON.stringify(parsed))).sfx).toEqual(parsed.sfx);
  });

  it("parses, never coerces — hand-editable user data is validated", () => {
    // Word indices are integers, never seconds; a fractional one is a unit
    // confusion, not a value to round.
    expect(OverrideDocSchema.safeParse({ sfx: { edits: { "a@1": { word: 2.5 } } } }).success).toBe(
      false,
    );
    // The library's own 0–2 gain range, shared with SfxSoundSchema.
    expect(OverrideDocSchema.safeParse({ sfx: { edits: { "a@1": { gain: 3 } } } }).success).toBe(
      false,
    );
    expect(
      OverrideDocSchema.safeParse({ sfx: { edits: { "a@1": { muted: "yes" } } } }).success,
    ).toBe(false);
  });

  it("refuses an added id that could spell a planned key or a path", () => {
    // `@` is `sfxPlacementKey`'s separator and the split-half namespace's —
    // one spelling must never read as the other; a `/` or `.` would read as a
    // path, and nothing may ever resolve a file against this name.
    for (const id of ["ding@12", "../etc/passwd", "a b", ""]) {
      expect(
        OverrideDocSchema.safeParse({ sfx: { added: [{ id, soundId: "pop", word: 1 }] } }).success,
      ).toBe(false);
    }
    expect(
      OverrideDocSchema.safeParse({ sfx: { added: [{ id: "sfx-1_A", soundId: "pop", word: 1 }] } })
        .success,
    ).toBe(true);
  });
});
