import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfigPatch } from "@ossclip/core";
import { artifactPath, resolveYoutube } from "../src/produce";

/**
 * The `--youtube` pack switch — resolveWatermark's contract verbatim (the
 * matrix below is the same one watermark.test.ts pins): default OFF, the
 * config supplies a once-set default, and a TYPED flag beats the config in
 * both directions, or `youtube: true` in the config would be a trap you
 * can't escape per run.
 */
describe("resolveYoutube", () => {
  it("defaults off with no flag and no config", () => {
    expect(resolveYoutube(undefined, undefined)).toBe(false);
  });

  it("the config turns it on when the flag is not typed", () => {
    expect(resolveYoutube(undefined, true)).toBe(true);
    expect(resolveYoutube(undefined, false)).toBe(false);
  });

  it("a typed flag beats the config in both directions", () => {
    expect(resolveYoutube(false, true)).toBe(false); // --no-youtube vs config-on
    expect(resolveYoutube(true, false)).toBe(true); // --youtube vs config-off
    expect(resolveYoutube(true, undefined)).toBe(true);
    expect(resolveYoutube(false, undefined)).toBe(false);
  });

  // config.json is hand-editable and loadConfig doesn't zod-parse it — a
  // malformed value must stay OFF (the safe default for an opt-in extra that
  // spends LLM calls), never be coerced on by truthiness.
  it("a non-boolean config value stays off", () => {
    expect(resolveYoutube(undefined, "yes" as unknown as boolean)).toBe(false);
    expect(resolveYoutube(undefined, 1 as unknown as boolean)).toBe(false);
  });
});

describe("the youtube preferences round-trip through config.json", () => {
  it("writes youtube/portrait/thumbnailModel and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-youtube-"));
    const path = saveConfigPatch(
      { youtube: true, portrait: "/me.jpg", thumbnailModel: "gemini-3.1-flash-lite-image" },
      dir,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      youtube: true,
      portrait: "/me.jpg",
      thumbnailModel: "gemini-3.1-flash-lite-image",
    });
  });
});

/**
 * The sibling-artifact path, centralized from the inline replace idiom. The
 * dotted-directory row is the reason it isn't a bare `(\.[^.]+)?$` replace:
 * that regex reads a dotted FOLDER as the extension of an extensionless
 * output and writes the artifact outside the folder the user chose.
 */
describe("artifactPath", () => {
  it("swaps the extension for the suffix", () => {
    expect(artifactPath("/videos/final.mp4", ".cover.jpg")).toBe("/videos/final.cover.jpg");
    expect(artifactPath("/videos/final.mov", ".youtube.md")).toBe("/videos/final.youtube.md");
  });

  it("appends the suffix to an extensionless output", () => {
    expect(artifactPath("/videos/final", ".cover.jpg")).toBe("/videos/final.cover.jpg");
  });

  it("never mistakes a dotted directory for the extension", () => {
    expect(artifactPath("/out.v2/final", ".cover.jpg")).toBe("/out.v2/final.cover.jpg");
    expect(artifactPath("/out.v2/final.mp4", ".youtube.md")).toBe("/out.v2/final.youtube.md");
  });

  it("only the LAST extension is swapped on a multi-dot name", () => {
    expect(artifactPath("./take.ossclip.mp4", ".cover.jpg")).toBe("./take.ossclip.cover.jpg");
  });
});
