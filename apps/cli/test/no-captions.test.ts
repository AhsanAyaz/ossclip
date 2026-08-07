import { describe, expect, it } from "vitest";
import { resolveCaptionsHidden } from "../src/produce";

/**
 * The global captions OFF switch. The matrix under test is the whole
 * contract: captions default ON (undefined flag, no override → visible),
 * and hidden is an OR of the two surfaces — `--no-captions` on produce, or
 * the editor's doc-global `captionsHidden` override — with NEITHER able to
 * force captions back on over the other. That last row is the deliberate
 * difference from resolveWatermark's flag-beats-config rule: the override
 * is the user's own saved edit, not a machine default, so a typed
 * `--captions` must not silently discard it (see the function's own doc
 * comment in produce.ts).
 */
describe("resolveCaptionsHidden", () => {
  it("defaults visible with no flag and no override", () => {
    expect(resolveCaptionsHidden(undefined, undefined)).toBe(false);
  });

  it("--no-captions hides regardless of the override", () => {
    expect(resolveCaptionsHidden(false, undefined)).toBe(true);
    expect(resolveCaptionsHidden(false, false)).toBe(true);
    expect(resolveCaptionsHidden(false, true)).toBe(true);
  });

  it("the editor override hides regardless of the flag", () => {
    expect(resolveCaptionsHidden(undefined, true)).toBe(true);
    // OR, not precedence: a typed --captions cannot out-vote the user's own
    // saved editor edit.
    expect(resolveCaptionsHidden(true, true)).toBe(true);
  });

  it("a typed --captions with no override is simply the default, visible", () => {
    expect(resolveCaptionsHidden(true, undefined)).toBe(false);
    expect(resolveCaptionsHidden(true, false)).toBe(false);
  });

  it("an explicit override false is not hidden — only true means hidden", () => {
    expect(resolveCaptionsHidden(undefined, false)).toBe(false);
  });
});
