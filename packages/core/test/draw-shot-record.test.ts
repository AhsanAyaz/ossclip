import { describe, expect, it } from "vitest";
import {
  AssetNameSchema,
  ShotHistorySchema,
  ShotIdSchema,
  discardUnfinished,
  type ShotHistory,
} from "../src/draw/shot-record";

/**
 * The drawn shot's record (storyboard design §9, plan Task 6; §167): the two
 * names a path is built from, and the one rule every load applies. Pure, so
 * no filesystem; apps/cli/test/draw-shot-store.test.ts covers the files.
 */

function history(over: Partial<ShotHistory> = {}): ShotHistory {
  return ShotHistorySchema.parse({
    id: "goldfish",
    idea: "a goldfish swims in",
    spokenLine: "",
    durationSec: 4,
    versions: [],
    draft: null,
    nextVersion: 1,
    notes: [],
    runs: [],
    ...over,
  });
}

describe("ShotIdSchema (Review Focus 4)", () => {
  it.each(["../x", "a/b", "a\\b", "", "Probe", "PROBE", ".hidden", "-lead", "a".repeat(41)])("rejects %j", (id) => {
    expect(ShotIdSchema.safeParse(id).success).toBe(false);
  });

  it.each(["probe", "shot-1", "7", "a".repeat(40)])("accepts %j", (id) => {
    expect(ShotIdSchema.safeParse(id).success).toBe(true);
  });
});

describe("AssetNameSchema (Review Focus 4)", () => {
  it.each(["../logo.png", "a/b.png", "a\\b.png", "x.exe", "logo", ".logo.png", "logo.png.exe", ""])("rejects %j", (name) => {
    expect(AssetNameSchema.safeParse(name).success).toBe(false);
  });

  it.each(["logo.png", "EGM-logo.dark.PNG", "photo.jpeg", "x.jpg", "mark.svg", "pic_1.webp"])("accepts %j", (name) => {
    expect(AssetNameSchema.safeParse(name).success).toBe(true);
  });
});

describe("discardUnfinished (Review Focus 5)", () => {
  it("drops a version with no result and keeps nextVersion", () => {
    const h = history({
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, kitVersion: 1 },
      ],
      draft: 1,
      nextVersion: 3,
    });
    const out = discardUnfinished(h);
    expect(out.versions.map((v) => v.n)).toEqual([1]);
    expect(out.nextVersion).toBe(3);
    expect(out.draft).toBe(1);
  });

  it("sets the draft to the latest remaining ok version when the draft is gone", () => {
    const h = history({
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: "ok", kitVersion: 1 },
        { n: 3, result: { failed: "type error" }, kitVersion: 1 },
        { n: 4, kitVersion: 1 },
      ],
      draft: 4,
      nextVersion: 5,
    });
    expect(discardUnfinished(h).draft).toBe(2);
  });

  it("sets the draft to null when no ok version remains", () => {
    const h = history({
      versions: [
        { n: 1, result: { failed: "blank" }, kitVersion: 1 },
        { n: 2, kitVersion: 1 },
      ],
      draft: 2,
      nextVersion: 3,
    });
    const out = discardUnfinished(h);
    expect(out.draft).toBeNull();
    expect(out.versions.map((v) => v.n)).toEqual([1]);
  });

  it("keeps a draft the author chose that still names an ok version", () => {
    const h = history({
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: "ok", kitVersion: 1 },
      ],
      draft: 1,
      nextVersion: 3,
    });
    expect(discardUnfinished(h)).toEqual(h);
  });
});

describe("ShotHistorySchema", () => {
  it("refuses a record whose id would leave the storyboard folder", () => {
    expect(ShotHistorySchema.safeParse({ ...history(), id: "../x" }).success).toBe(false);
  });
});
