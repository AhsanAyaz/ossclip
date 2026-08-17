import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  PORTRAIT_OVERRIDE_BASENAME,
  portraitExtensionForMime,
  portraitOverridePath,
  resolvePortrait,
} from "../src/portrait-override";

// The per-project portrait override's pure half (editor face swap,
// 2026-08-17): the extension matrix, the mime reverse lookup and the ONE
// precedence rule — no filesystem anywhere (`exists` injected).

const WORK = "/w";
const exists = (paths: string[]) => (p: string) => paths.includes(p);

describe("portraitOverridePath", () => {
  it("finds an override under each accepted extension", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const path = join(WORK, `${PORTRAIT_OVERRIDE_BASENAME}.${ext}`);
      expect(portraitOverridePath(WORK, exists([path]))).toBe(path);
    }
  });

  it("answers null when no override exists", () => {
    expect(portraitOverridePath(WORK, () => false)).toBeNull();
  });

  it("multiple overrides pick deterministically by table order, not readdir luck", () => {
    // The POST endpoint enforces at most one override; two can only be a
    // hand-copied file, and the pick must at least be stable: png first, per
    // PORTRAIT_MIME_TYPES key order.
    const png = join(WORK, `${PORTRAIT_OVERRIDE_BASENAME}.png`);
    const webp = join(WORK, `${PORTRAIT_OVERRIDE_BASENAME}.webp`);
    expect(portraitOverridePath(WORK, exists([webp, png]))).toBe(png);
    const jpg = join(WORK, `${PORTRAIT_OVERRIDE_BASENAME}.jpg`);
    const jpeg = join(WORK, `${PORTRAIT_OVERRIDE_BASENAME}.jpeg`);
    expect(portraitOverridePath(WORK, exists([jpeg, jpg]))).toBe(jpg);
  });
});

describe("portraitExtensionForMime", () => {
  it("maps each accepted mime to a table extension — jpg wins jpeg's tie", () => {
    expect(portraitExtensionForMime("image/png")).toBe("png");
    // image/jpeg spells two extensions; the FIRST table key wins so the
    // override filename is deterministic across uploads.
    expect(portraitExtensionForMime("image/jpeg")).toBe("jpg");
    expect(portraitExtensionForMime("image/webp")).toBe("webp");
  });

  it("anything outside the table is undefined, never a guessed extension", () => {
    expect(portraitExtensionForMime("image/gif")).toBeUndefined();
    expect(portraitExtensionForMime("text/html")).toBeUndefined();
    expect(portraitExtensionForMime("")).toBeUndefined();
  });
});

describe("resolvePortrait — override > flag > config", () => {
  it("the override beats an explicit flag AND a config portrait", () => {
    expect(
      resolvePortrait({
        overridePath: "/w/portrait-override.png",
        flagPortrait: "/typed.png",
        cfgPortrait: "/cfg.png",
      }),
    ).toEqual({ path: "/w/portrait-override.png", source: "override" });
  });

  it("the flag beats the config; the config alone still resolves", () => {
    expect(
      resolvePortrait({ overridePath: null, flagPortrait: "/typed.png", cfgPortrait: "/cfg.png" }),
    ).toEqual({ path: "/typed.png", source: "flag" });
    expect(
      resolvePortrait({ overridePath: null, flagPortrait: undefined, cfgPortrait: "/cfg.png" }),
    ).toEqual({ path: "/cfg.png", source: "config" });
  });

  it("nothing anywhere is undefined; a non-string config is ignored, never coerced", () => {
    expect(
      resolvePortrait({ overridePath: null, flagPortrait: undefined, cfgPortrait: undefined }),
    ).toBeUndefined();
    // The `portrait` posture: config.json is hand-edited, and `true` there
    // must read as "no portrait", not the string "true".
    expect(
      resolvePortrait({ overridePath: null, flagPortrait: undefined, cfgPortrait: true }),
    ).toBeUndefined();
  });

  it("expandHome covers the flag and config paths, never the server-built override", () => {
    expect(
      resolvePortrait({
        overridePath: null,
        flagPortrait: "~/face.png",
        cfgPortrait: undefined,
        home: "/home/u",
      }),
    ).toEqual({ path: "/home/u/face.png", source: "flag" });
    expect(
      resolvePortrait({
        overridePath: null,
        flagPortrait: undefined,
        cfgPortrait: "~/face.png",
        home: "/home/u",
      }),
    ).toEqual({ path: "/home/u/face.png", source: "config" });
  });
});
