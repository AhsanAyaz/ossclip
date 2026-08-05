import { describe, expect, it } from "vitest";
import { defaultOutPath } from "../src/produce";

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
