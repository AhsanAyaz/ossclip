import { describe, expect, it } from "vitest";
import { concurrencyFlag } from "../src/program";
import { resolveRenderConcurrency } from "../src/produce";

/**
 * 2026-08-17 render-speed pass. The render is decode-bound: every browser tab
 * waits on OffthreadVideo's ffmpeg extract workers, so the default leaves two
 * cores for them instead of saturating the machine with tabs. The config's
 * `renderConcurrency` is file-only (hand-edited JSON loadConfig doesn't
 * zod-parse), so validation lives here at the consumer — the `dictionary`
 * posture: a malformed value is one warning and the default, never a coerced
 * tab count.
 *
 * `--concurrency` joined the precedence on 2026-08-19, when the cpus-2 guess
 * (a CPU guess with no memory term) resolved to 12 tabs on a 14-core / 36GB
 * Mac and Chrome died WHOLE on a 1080×1920 source. The flag is the hatch that
 * does not require editing a config file mid-investigation, and it is
 * validated at commander's front door instead of here.
 */

describe("resolveRenderConcurrency", () => {
  it("defaults to cpus-2, leaving cores for the ffmpeg decode workers", () => {
    expect(resolveRenderConcurrency(undefined, undefined, 12)).toEqual({ concurrency: 10 });
    expect(resolveRenderConcurrency(undefined, undefined, 8)).toEqual({ concurrency: 6 });
  });

  it("floors the default at 2 on small machines", () => {
    expect(resolveRenderConcurrency(undefined, undefined, 2)).toEqual({ concurrency: 2 });
    expect(resolveRenderConcurrency(undefined, undefined, 3)).toEqual({ concurrency: 2 });
    expect(resolveRenderConcurrency(undefined, undefined, 1)).toEqual({ concurrency: 2 });
  });

  it("a valid config integer wins over the default, without a warning", () => {
    expect(resolveRenderConcurrency(undefined, 4, 12)).toEqual({ concurrency: 4 });
    // Even above cpus — the user asked; the config is the override hatch.
    expect(resolveRenderConcurrency(undefined, 16, 8)).toEqual({ concurrency: 16 });
  });

  it("rejects a malformed config value with one warning and the default", () => {
    for (const bad of ["4", 0, -1, 2.5, true, null, Number.NaN]) {
      const r = resolveRenderConcurrency(undefined, bad, 12);
      expect(r.concurrency).toBe(10);
      expect(r.warning).toBe("⚠ config renderConcurrency ignored — expected a positive integer");
    }
  });

  it("the flag beats the config, which beats the default", () => {
    expect(resolveRenderConcurrency(4, 8, 12)).toEqual({ concurrency: 4 });
    expect(resolveRenderConcurrency(undefined, 8, 12)).toEqual({ concurrency: 8 });
    expect(resolveRenderConcurrency(undefined, undefined, 12)).toEqual({ concurrency: 10 });
  });

  it("the flag beats a MALFORMED config, silently", () => {
    // The run the user asked for is the run they get; warning about a config
    // key they did not touch this time would be noise on a flag that exists
    // to get a crashing render moving again.
    expect(resolveRenderConcurrency(2, "lots", 12)).toEqual({ concurrency: 2 });
  });
});

describe("concurrencyFlag", () => {
  it("takes a positive whole number of tabs", () => {
    expect(concurrencyFlag("4")).toBe(4);
    expect(concurrencyFlag("1")).toBe(1);
    expect(concurrencyFlag("12")).toBe(12);
  });

  it("rejects rather than coerces — §93a", () => {
    // "4x" and "" would be NaN/0 under parseInt/truthiness and reach the
    // render as garbage; 0 and negatives would open no tabs at all.
    for (const bad of ["4x", "", " ", "abc", "0", "-1", "2.5", "NaN", "Infinity"]) {
      expect(() => concurrencyFlag(bad)).toThrow(/--concurrency wants a positive whole number/);
    }
  });
});
