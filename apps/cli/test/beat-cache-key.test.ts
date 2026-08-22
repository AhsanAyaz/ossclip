import { describe, expect, it } from "vitest";
import { PRODUCER_PROMPT_VERSION, type LlmUsage } from "@ossclip/core";
import { actualProvider, beatSheetCacheKey, clipWindowCacheKey } from "../src/produce";

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

  it("changes when only the effort differs (§143)", () => {
    // The knob steers the editorial call, so a re-run at a different effort
    // must not serve the old plan — the §78 posture.
    const key = beatSheetCacheKey(base);
    expect(beatSheetCacheKey({ ...base, llmEffort: "low" })).not.toBe(key);
    expect(beatSheetCacheKey({ ...base, llmEffort: "low" })).not.toBe(
      beatSheetCacheKey({ ...base, llmEffort: "high" }),
    );
  });

  it("an unset effort keeps the key byte-identical to the pre-knob code", () => {
    // "fc437963" was computed by THIS fixture against the shipped algorithm
    // at HEAD 404a469, BEFORE the effort field existed (a temporary test
    // logged it). If this fails, every user's warm workdir re-runs the LLM —
    // the exact cache invalidation the conditional append exists to prevent.
    expect(beatSheetCacheKey({ ...base, promptVersion: "vX-fixed" })).toBe("fc437963");
  });
});

/**
 * The same posture, one call earlier: the clip window is chosen by the SAME
 * producer prompt (`produceScenes(…, clip: {…})`), so a prompt edit that
 * leaves this key untouched serves a window selected under the old prompt and
 * plans the whole video against it.
 */
describe("clipWindowCacheKey", () => {
  const base = {
    promptVersion: PRODUCER_PROMPT_VERSION,
    providerName: "antigravity" as const,
    llmModel: "gemini-3.7-flash",
    intent: "make it punchy",
    clipTargetSec: 60,
    words: ["one", "two", "three"],
    aspect: "9:16" as const,
  };

  it("is stable for identical inputs — a re-run must hit its own cache", () => {
    expect(clipWindowCacheKey(base)).toBe(clipWindowCacheKey({ ...base }));
  });

  it("changes when only the prompt version differs (the §78 fix)", () => {
    // Accepted cost of the bump: an already-resolved window is thrown away and
    // one LLM call re-selects it. That is the right price — planning against a
    // window the current prompt would not have chosen is the worse outcome.
    expect(clipWindowCacheKey({ ...base, promptVersion: "v1" })).not.toBe(clipWindowCacheKey(base));
  });

  it("changes when only the aspect differs", () => {
    // Latent, not live: `--aspect 16:9` derives a `-16x9` workdir and this
    // cache is a file inside it, so the two selections cannot meet today.
    // Keyed anyway — the aspect reaches both halves of the prompt.
    expect(clipWindowCacheKey({ ...base, aspect: "16:9" })).not.toBe(clipWindowCacheKey(base));
  });

  it("still separates the things it always separated", () => {
    const key = clipWindowCacheKey(base);
    expect(clipWindowCacheKey({ ...base, providerName: "claude" })).not.toBe(key);
    expect(clipWindowCacheKey({ ...base, llmModel: "gemini-3.5-flash-lite" })).not.toBe(key);
    expect(clipWindowCacheKey({ ...base, intent: "make it calm" })).not.toBe(key);
    expect(clipWindowCacheKey({ ...base, clipTargetSec: 30 })).not.toBe(key);
    expect(clipWindowCacheKey({ ...base, words: ["one", "two", "четыре"] })).not.toBe(key);
    expect(
      clipWindowCacheKey({
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

  it("does not collide with the beat-sheet key for the same inputs", () => {
    // Both files live in the same workdir under different prefixes, so a
    // collision is cosmetic rather than dangerous — but the two answer
    // different questions and should not look interchangeable.
    expect(clipWindowCacheKey(base)).not.toBe(
      beatSheetCacheKey({ ...base, cleanup: "standard" as const }),
    );
  });

  it("re-keying with the answering provider yields a different key (§143)", () => {
    // The write-side half of the fallback attribution: after agy timed out
    // and claude-cli answered, the cache write must land under a key the
    // primary's read would NOT hit — and a later `--llm claude-cli` run would.
    expect(clipWindowCacheKey({ ...base, providerName: "claude-cli" })).not.toBe(
      clipWindowCacheKey(base),
    );
  });

  it("changes when only the effort differs (§143)", () => {
    // The window is chosen by the same editorial call the knob steers.
    const key = clipWindowCacheKey(base);
    expect(clipWindowCacheKey({ ...base, llmEffort: "medium" })).not.toBe(key);
  });

  it("an unset effort keeps the key byte-identical to the pre-knob code", () => {
    // "fe2ae666": this fixture against the shipped algorithm at HEAD 404a469,
    // captured before the effort field existed — see beatSheetCacheKey's twin
    // test for what breaking it costs.
    expect(clipWindowCacheKey({ ...base, promptVersion: "vX-fixed" })).toBe("fe2ae666");
  });
});

/**
 * Cache-write attribution after a §143 timeout fallback (2026-08-22): the
 * plan in hand is the fallback's work, and the write must key on the provider
 * that actually answered — not the primary that failed. Pure — the usage log
 * is the whole input.
 */
describe("actualProvider", () => {
  const rec = (provider: string, schemaName: string): LlmUsage => ({
    provider,
    schemaName,
    inputTokens: 1,
    outputTokens: 1,
    exact: true,
    billed: false,
  });

  it("the last record matching the schema wins — the answer that survived", () => {
    expect(
      actualProvider(
        [
          rec("antigravity", "transcript_repair"),
          rec("antigravity", "clip_beat_sheet"),
          rec("claude-cli", "clip_beat_sheet"),
        ],
        "clip_beat_sheet",
        "antigravity",
      ),
    ).toBe("claude-cli");
  });

  it("no matching record leaves the resolved provider standing", () => {
    expect(
      actualProvider([rec("antigravity", "transcript_repair")], "beat_sheet", "antigravity"),
    ).toBe("antigravity");
  });

  it("an empty log (the cached path) leaves the resolved provider standing", () => {
    expect(actualProvider([], "beat_sheet", "gemini")).toBe("gemini");
  });
});
