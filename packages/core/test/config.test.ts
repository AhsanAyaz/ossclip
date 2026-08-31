import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";

/**
 * The 2026-08-27 publish E2E's catch: `postizUrl` was declared on
 * `OssclipConfig` and documented as "config.json, non-secret" — but
 * `loadConfig`'s hand-written mapping never copied it, so `ossclip publish`
 * reported "missing postizUrl" against a config.json that plainly had it.
 * A key that exists only in the type is invisible at runtime; this suite
 * pins the mapping, on the pure half so no homedir is involved.
 */
describe("resolveConfig — file keys actually reach the resolved config", () => {
  it("passes postizUrl through from the file config", () => {
    const cfg = resolveConfig({ postizUrl: "http://localhost:4007" }, {});
    expect(cfg.postizUrl).toBe("http://localhost:4007");
  });

  it("file-only keys survive alongside env-resolved ones", () => {
    const cfg = resolveConfig(
      { postizUrl: "http://localhost:4007", watermark: true, ffmpegPath: "/from/file" },
      { OSSCLIP_FFMPEG: "/from/env" },
    );
    expect(cfg.ffmpegPath).toBe("/from/env");
    expect(cfg.watermark).toBe(true);
    expect(cfg.postizUrl).toBe("http://localhost:4007");
  });

  it("passes sfxBundledPack through, including the `false` that is its whole point", () => {
    // The postizUrl lesson verbatim: a mapping that drops this key would let a
    // user write `"sfxBundledPack": false` and still hear every stock sound,
    // with nothing anywhere able to say why.
    expect(resolveConfig({ sfxBundledPack: false }, {}).sfxBundledPack).toBe(false);
    expect(resolveConfig({ sfxBundledPack: true }, {}).sfxBundledPack).toBe(true);
    // Absent stays absent — the consumer's default (include) is the one that
    // decides, not a value invented here.
    expect(resolveConfig({}, {}).sfxBundledPack).toBeUndefined();
  });

  it("passes colorGrade through untouched — validation lives at the consumer", () => {
    // The postizUrl lesson again: a structured key the mapping drops is
    // invisible at runtime. Passed as `unknown` on purpose — produce's
    // resolveProductionColorGrade is where a malformed grade earns its
    // warning, so even a bogus value must survive the trip there.
    const grade = { preset: "talking-head", intensity: 0.5 };
    expect(resolveConfig({ colorGrade: grade }, {}).colorGrade).toEqual(grade);
    expect(resolveConfig({ colorGrade: "not-a-grade" }, {}).colorGrade).toBe("not-a-grade");
    expect(resolveConfig({}, {}).colorGrade).toBeUndefined();
  });

  it("an absent file yields defaults with postizUrl undefined — publish then names the miss", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.postizUrl).toBeUndefined();
    expect(cfg.ffmpegPath).toBeTruthy();
  });
});
