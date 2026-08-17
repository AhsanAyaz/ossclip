import { describe, expect, it } from "vitest";
import { resolveRenderConcurrency } from "../src/produce";

/**
 * 2026-08-17 render-speed pass. The render is decode-bound: every browser tab
 * waits on OffthreadVideo's ffmpeg extract workers, so the default leaves two
 * cores for them instead of saturating the machine with tabs. The config's
 * `renderConcurrency` is file-only (hand-edited JSON loadConfig doesn't
 * zod-parse), so validation lives here at the consumer — the `dictionary`
 * posture: a malformed value is one warning and the default, never a coerced
 * tab count.
 */

describe("resolveRenderConcurrency", () => {
  it("defaults to cpus-2, leaving cores for the ffmpeg decode workers", () => {
    expect(resolveRenderConcurrency(undefined, 12)).toEqual({ concurrency: 10 });
    expect(resolveRenderConcurrency(undefined, 8)).toEqual({ concurrency: 6 });
  });

  it("floors the default at 2 on small machines", () => {
    expect(resolveRenderConcurrency(undefined, 2)).toEqual({ concurrency: 2 });
    expect(resolveRenderConcurrency(undefined, 3)).toEqual({ concurrency: 2 });
    expect(resolveRenderConcurrency(undefined, 1)).toEqual({ concurrency: 2 });
  });

  it("a valid config integer wins over the default, without a warning", () => {
    expect(resolveRenderConcurrency(4, 12)).toEqual({ concurrency: 4 });
    // Even above cpus — the user asked; the config is the override hatch.
    expect(resolveRenderConcurrency(16, 8)).toEqual({ concurrency: 16 });
  });

  it("rejects a malformed config value with one warning and the default", () => {
    for (const bad of ["4", 0, -1, 2.5, true, null, Number.NaN]) {
      const r = resolveRenderConcurrency(bad, 12);
      expect(r.concurrency).toBe(10);
      expect(r.warning).toBe("⚠ config renderConcurrency ignored — expected a positive integer");
    }
  });
});
