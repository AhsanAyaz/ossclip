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
  it("portrait restates the core defaults — 3 words (5 choreographed), 1.2s (2.2s choreographed)", () => {
    expect(captionPackingFor(false)).toEqual({
      maxWordsPerLine: 3,
      maxLineDuration: 1.2,
      maxChoreographedWords: 5,
      maxChoreographedDuration: 2.2,
    });
  });

  it("landscape doubles standard and raises choreographed ceilings — 6 words (8 choreographed), 2.4s (3.2s choreographed)", () => {
    expect(captionPackingFor(true)).toEqual({
      maxWordsPerLine: 6,
      maxLineDuration: 2.4,
      maxChoreographedWords: 8,
      maxChoreographedDuration: 3.2,
    });
  });
});
