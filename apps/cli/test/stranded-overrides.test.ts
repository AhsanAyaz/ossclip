import { describe, expect, it } from "vitest";
import {
  MAX_STRANDED_POINTERS,
  strandedOverrideSiblings,
  strandedPointerLine,
  workdirBaseName,
  type SiblingWorkdirEntry,
} from "../src/stranded-overrides";

const entry = (name: string, over: Partial<SiblingWorkdirEntry> = {}): SiblingWorkdirEntry => ({
  name,
  hasOverrides: true,
  mtimeMs: 1,
  ...over,
});

describe("workdirBaseName", () => {
  it("matches deriveWorkdir's basename transform for folders and files", () => {
    expect(workdirBaseName("/v/MyClips")).toBe("MyClips");
    expect(workdirBaseName("/v/take.mp4")).toBe("take");
  });
});

describe("strandedOverrideSiblings", () => {
  it("finds a re-keyed sibling that holds editor edits (§131 residue)", () => {
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [entry("MyClips-bbbbbbbb")],
    });
    expect(r).toEqual(["MyClips-bbbbbbbb"]);
  });

  it("never crosses folders on a shared prefix: MyClips2 is not MyClips", () => {
    // The §131 brief's explicit trap: a loose startsWith("MyClips") would
    // claim MyClips2's workdirs. Requiring `-` + exactly 8 hex after the base
    // is what keeps the two apart.
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [entry("MyClips2-bbbbbbbb"), entry("MyClips-extra-bbbbbbbb")],
    });
    expect(r).toEqual([]);
  });

  it("requires exactly 8 lowercase hex — not shorter, longer, or non-hex", () => {
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [
        entry("MyClips-bbbb"), // too short
        entry("MyClips-bbbbbbbbb"), // 9 chars
        entry("MyClips-gggggggg"), // not hex
        entry("MyClips-BBBBBBBB"), // sha1 hex digests are lowercase
      ],
    });
    expect(r).toEqual([]);
  });

  it("excludes the current run's own hash, in either aspect variant", () => {
    // Same hash + -16x9 is the same content reachable via --aspect, not a
    // stranded re-key; a DIFFERENT hash's -16x9 workdir is stranded.
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [
        entry("MyClips-aaaaaaaa"),
        entry("MyClips-aaaaaaaa-16x9"),
        entry("MyClips-cccccccc-16x9"),
      ],
    });
    expect(r).toEqual(["MyClips-cccccccc-16x9"]);
  });

  it("skips siblings without overrides.json — nothing is stranded there", () => {
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [entry("MyClips-bbbbbbbb", { hasOverrides: false })],
    });
    expect(r).toEqual([]);
  });

  it("orders newest edit first and caps the list", () => {
    const r = strandedOverrideSiblings({
      base: "MyClips",
      currentHash: "aaaaaaaa",
      entries: [
        entry("MyClips-11111111", { mtimeMs: 10 }),
        entry("MyClips-22222222", { mtimeMs: 40 }),
        entry("MyClips-33333333", { mtimeMs: 30 }),
        entry("MyClips-44444444", { mtimeMs: 20 }),
      ],
    });
    expect(r).toEqual(["MyClips-22222222", "MyClips-33333333", "MyClips-44444444"]);
    expect(r).toHaveLength(MAX_STRANDED_POINTERS);
  });

  it("handles a base containing regex metacharacters as literal text", () => {
    // The matcher is string-slicing, not a regex built from the base — a
    // folder named "clips (v2)" must neither crash nor mis-match.
    const r = strandedOverrideSiblings({
      base: "clips (v2)",
      currentHash: "aaaaaaaa",
      entries: [entry("clips (v2)-bbbbbbbb"), entry("clips (v3)-bbbbbbbb")],
    });
    expect(r).toEqual(["clips (v2)-bbbbbbbb"]);
  });
});

describe("strandedPointerLine", () => {
  it("names the path, the fact edits don't carry over, and the edit command", () => {
    const line = strandedPointerLine("/v/.ossclip/MyClips-bbbbbbbb");
    expect(line).toContain("/v/.ossclip/MyClips-bbbbbbbb");
    expect(line).toContain("don't carry over");
    expect(line).toContain("ossclip edit '/v/.ossclip/MyClips-bbbbbbbb'");
  });
});
