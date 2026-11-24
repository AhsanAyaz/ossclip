import { describe, expect, it } from "vitest";
import {
  AssetNameSchema,
  ShotHistorySchema,
  ShotIdSchema,
  discardUnfinished,
  notesForRedraw,
  stampVersionIdeas,
  versionDurationSec,
  versionIdea,
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

describe("each version's own idea and length (§169, Draw again)", () => {
  it("ShotVersionSchema parses a version without them (an existing record) and with them; refuses a length of 0", () => {
    expect(history({ versions: [{ n: 1, result: "ok", kitVersion: 1 }], draft: 1, nextVersion: 2 }).versions[0]).toEqual({
      n: 1,
      result: "ok",
      kitVersion: 1,
    });
    const v = { n: 1, result: "ok" as const, kitVersion: 1, idea: "a cat", durationSec: 5 };
    expect(history({ versions: [v], draft: 1, nextVersion: 2 }).versions[0]).toEqual(v);
    expect(
      ShotHistorySchema.safeParse({ ...history(), versions: [{ ...v, durationSec: 0 }], draft: 1, nextVersion: 2 }).success,
    ).toBe(false);
  });

  it("versionIdea and versionDurationSec: the version's own, else the history's", () => {
    const h = history({
      idea: "now",
      durationSec: 6,
      versions: [
        { n: 1, result: "ok", kitVersion: 1, idea: "before", durationSec: 3 },
        { n: 2, result: "ok", kitVersion: 1 },
      ],
      draft: 2,
      nextVersion: 3,
    });
    expect(versionIdea(h, 1)).toBe("before");
    expect(versionDurationSec(h, 1)).toBe(3);
    expect(versionIdea(h, 2)).toBe("now");
    expect(versionDurationSec(h, 2)).toBe(6);
    expect(versionIdea(h, 9)).toBe("now");
  });

  it("stampVersionIdeas gives a version without them the history's, and leaves a version's own alone", () => {
    const h = history({
      idea: "old",
      durationSec: 4,
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: "ok", kitVersion: 1, idea: "older", durationSec: 3 },
      ],
      draft: 1,
      nextVersion: 3,
    });
    expect(stampVersionIdeas(h).versions).toEqual([
      { n: 1, result: "ok", kitVersion: 1, idea: "old", durationSec: 4 },
      { n: 2, result: "ok", kitVersion: 1, idea: "older", durationSec: 3 },
    ]);
  });

  it("notesForRedraw sends only the notes made on versions of the draft's idea", () => {
    const h = history({
      idea: "new",
      versions: [
        { n: 1, result: "ok", kitVersion: 1, idea: "old" },
        { n: 2, result: "ok", kitVersion: 1, idea: "old" },
        { n: 3, result: "ok", kitVersion: 1, idea: "new" },
        { n: 4, result: "ok", kitVersion: 1, idea: "new" },
      ],
      draft: 4,
      nextVersion: 5,
      notes: [
        { onVersion: 1, text: "about the old drawing" },
        { onVersion: 3, text: "about the new drawing" },
      ],
    });
    expect(notesForRedraw(h)).toEqual([{ onVersion: 3, text: "about the new drawing" }]);
    // The author made an old-idea version the draft again: its notes are the ones that apply.
    expect(notesForRedraw({ ...h, draft: 2 })).toEqual([{ onVersion: 1, text: "about the old drawing" }]);
    // A record from before the fields: every version is the history's idea, so every note is sent, as before.
    const legacy = history({
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: "ok", kitVersion: 1 },
      ],
      draft: 2,
      nextVersion: 3,
      notes: [{ onVersion: 1, text: "bigger" }],
    });
    expect(notesForRedraw(legacy)).toEqual([{ onVersion: 1, text: "bigger" }]);
    expect(notesForRedraw({ ...legacy, draft: null })).toEqual([]);
  });
});
