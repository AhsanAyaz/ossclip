import { describe, expect, it } from "vitest";
import { PRODUCER_PROMPT_VERSION } from "@ossclip/core";
import { beatSheetCacheKey } from "../src/produce";

/**
 * The §78 posture, applied to the beat sheet: anything that changes the plan
 * must change the key. The key used to carry neither the prompt version nor
 * the aspect, so a prompt edit would have kept serving sheets the old prompt
 * wrote out of every warm workdir. Pure — no workdir, no LLM.
 */
describe("beatSheetCacheKey", () => {
  const base = {
    promptVersion: PRODUCER_PROMPT_VERSION,
    providerName: "gemini" as const,
    llmModel: "gemini-3.7-flash",
    intent: "make it punchy",
    cleanup: "standard" as const,
    words: ["one", "two", "three"],
    aspect: "9:16" as const,
  };

  it("is stable for identical inputs — a re-run must hit its own cache", () => {
    expect(beatSheetCacheKey(base)).toBe(beatSheetCacheKey({ ...base }));
  });

  it("changes when only the prompt version differs (the §78 fix)", () => {
    // The bump is the ONE regenerate lever: without this, editing the
    // producer prompt leaves every warm workdir answering from the old one.
    expect(beatSheetCacheKey({ ...base, promptVersion: "v1" })).not.toBe(
      beatSheetCacheKey(base),
    );
  });

  it("changes when only the aspect differs", () => {
    // Latent rather than live today — `--aspect 16:9` also derives a `-16x9`
    // workdir, and this cache is a file inside it, so the two plans cannot
    // meet. Keyed anyway: the aspect changes the user prompt (the LANDSCAPE
    // block, R21 §101), and correctness here should not rest on a different
    // module's directory naming.
    expect(beatSheetCacheKey({ ...base, aspect: "16:9" })).not.toBe(beatSheetCacheKey(base));
  });

  it("still separates the things it always separated", () => {
    const key = beatSheetCacheKey(base);
    expect(beatSheetCacheKey({ ...base, providerName: "claude" })).not.toBe(key);
    expect(beatSheetCacheKey({ ...base, llmModel: "gemini-3.5-flash-lite" })).not.toBe(key);
    expect(beatSheetCacheKey({ ...base, intent: "make it calm" })).not.toBe(key);
    expect(beatSheetCacheKey({ ...base, cleanup: "aggressive" })).not.toBe(key);
    expect(beatSheetCacheKey({ ...base, forceComponent: "FlowDiagram" })).not.toBe(key);
    // Keyed on the repaired transcript's TEXT, not its word count: a repair
    // that swaps "coach and" for "code churn" leaves the count identical.
    expect(beatSheetCacheKey({ ...base, words: ["one", "two", "четыре"] })).not.toBe(key);
    // §93f: a clip run and a full run of the same source must not collide.
    expect(beatSheetCacheKey({ ...base, clipTargetSec: 60 })).not.toBe(key);
    expect(
      beatSheetCacheKey({
        ...base,
        clipWindow: { startWord: 0, endWord: 2, startSec: 0, endSec: 1, reason: "r" },
      }),
    ).not.toBe(key);
    // A re-measured framing steers layout choice, so it must replan.
    expect(
      beatSheetCacheKey({
        ...base,
        framing: {
          windows: [{ startSec: 0, endSec: 1, faceFracOfCanvas: 0.3 }],
          canvasAspect: 9 / 16,
          layouts: [],
          zoom: 1.2,
        },
      }),
    ).not.toBe(key);
  });

  it("reads absent and null the same way, so an unset field is not two keys", () => {
    // The call site passes `clipWindow` straight through, and it is
    // `ClipWindow | null` there — a null must key like an omission.
    expect(beatSheetCacheKey({ ...base, clipWindow: null })).toBe(beatSheetCacheKey(base));
  });
});
