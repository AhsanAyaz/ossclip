import { describe, expect, it } from "vitest";
import { defaultOutPath, replayWorkdirWarning } from "../src/produce";

/**
 * Review fix on folder-input-brief.md's first cut: the default --out path
 * used to derive from `input` AFTER a folder run reassigns it to
 * `<workdir>/source-concat.mp4`, so `ossclip produce ~/Downloads/MyClips`
 * with no -o wrote its output INSIDE the hidden .ossclip workdir instead of
 * beside the folder. `defaultOutPath` must always be called with the
 * ORIGINAL input the user typed (produce.ts's `originalInput`), never the
 * reassigned `input` — these tests pin what it does with a folder-shaped
 * (extension-less) path and a normal file path.
 */
describe("defaultOutPath", () => {
  it("appends .ossclip.mp4 to an extension-less folder path", () => {
    expect(defaultOutPath("/Users/x/Downloads/MyClips")).toBe(
      "/Users/x/Downloads/MyClips.ossclip.mp4",
    );
  });

  it("replaces a file's extension for a normal file input", () => {
    expect(defaultOutPath("/Users/x/Downloads/take.mov")).toBe(
      "/Users/x/Downloads/take.ossclip.mp4",
    );
  });

  it("strips a trailing slash before deriving — the tab-completed folder path", () => {
    // Field case 2026-08-18 (second report): shells tab-complete folders WITH
    // the trailing slash, and the bare regex appended after it — the default
    // landed INSIDE the folder as a dotfile (`…/MyClips/.ossclip.mp4`), which
    // is both hidden from the user and exactly the self-ingesting shape the
    // out-path gate refuses. The 144 MB `.ossclip.mp4` found inside the
    // field folder was this bug's artifact.
    expect(defaultOutPath("/Users/x/Downloads/MyClips/")).toBe(
      "/Users/x/Downloads/MyClips.ossclip.mp4",
    );
  });

  it("handles a folder name that itself contains a dot", () => {
    // The same regex a file input already relies on: `(\.[^.]+)?$` strips at
    // most the LAST dot-segment, so "Anthropic v1.2" becomes
    // "Anthropic v1.ossclip.mp4" — same behavior as any other name with a
    // dot in it, not a folder-specific special case.
    expect(defaultOutPath("/Users/x/Downloads/Anthropic v1.2")).toBe(
      "/Users/x/Downloads/Anthropic v1.ossclip.mp4",
    );
  });
});

/**
 * 2026-08-18 field cascade, part 3: a folder input that re-keys between the
 * recorded run and an editor replay derives a DIFFERENT workdir — the edits
 * saved in the old workdir's overrides.json silently stop applying. The edit
 * server passes the replayed workdir via OSSCLIP_REPLAY_WORKDIR; this is the
 * pure drift decision produce prints from.
 */
describe("replayWorkdirWarning", () => {
  it("is null outside a replay — a terminal run never carries the env var", () => {
    expect(replayWorkdirWarning(undefined, "/a/.ossclip/Clips-abc123")).toBeNull();
    expect(replayWorkdirWarning("", "/a/.ossclip/Clips-abc123")).toBeNull();
  });

  it("is null when the replay lands in the workdir it was launched for", () => {
    expect(
      replayWorkdirWarning("/a/.ossclip/Clips-abc123", "/a/.ossclip/Clips-abc123"),
    ).toBeNull();
    // Same directory spelled differently must not trip a false warning.
    expect(
      replayWorkdirWarning("/a/.ossclip/../.ossclip/Clips-abc123", "/a/.ossclip/Clips-abc123"),
    ).toBeNull();
  });

  it("warns loudly, pointing at the overrides.json that will NOT apply", () => {
    const line = replayWorkdirWarning("/a/.ossclip/Clips-abc123", "/a/.ossclip/Clips-def456");
    expect(line).toMatch(/^⚠/);
    expect(line).toContain("/a/.ossclip/Clips-abc123/overrides.json");
    expect(line).toMatch(/will NOT apply/);
  });
});
