import { describe, expect, it } from "vitest";
import { captionPackingFor } from "../src/produce";

/**
 * Orientation-dependent caption packing (2026-08-16 v2 review, user
 * screenshot): landscape's 44px-on-1920px captions carry ~2.6× portrait's
 * horizontal text budget, so 3-word lines look sparse there. Portrait MUST
 * return the core defaults verbatim (`captions.ts:117-118`) — that is what
 * keeps a portrait run's output byte-identical to before the helper
 * existed.
 */
describe("captionPackingFor", () => {
  it("portrait restates the core defaults exactly — 3 words, 1.2s", () => {
    expect(captionPackingFor(false)).toEqual({ maxWordsPerLine: 3, maxLineDuration: 1.2 });
  });

  it("landscape doubles both — 6 words, 2.4s", () => {
    expect(captionPackingFor(true)).toEqual({ maxWordsPerLine: 6, maxLineDuration: 2.4 });
  });
});
