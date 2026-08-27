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

  it("an absent file yields defaults with postizUrl undefined — publish then names the miss", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.postizUrl).toBeUndefined();
    expect(cfg.ffmpegPath).toBeTruthy();
  });
});
