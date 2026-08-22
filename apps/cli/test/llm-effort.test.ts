import { describe, expect, it } from "vitest";
import { resolveLlmEffort } from "../src/produce";

/**
 * The `--llm-effort` knob (§143: exposed after the hang incident — the knob
 * existed in agy and we passed nothing). The flag arrives already zod-parsed
 * by program.ts; the config's `llmEffort` arrives as whatever the hand-edited
 * JSON held, and this matrix pins the `dictionary` posture for it: exactly
 * low|medium|high, or one warning and agy's default, never a coerced level.
 * Pure — no config file on disk.
 */
describe("resolveLlmEffort", () => {
  it("both absent means neither an effort nor a warning — agy's default stands", () => {
    expect(resolveLlmEffort(undefined, undefined)).toEqual({});
  });

  it("a typed flag wins, including over a valid config value", () => {
    expect(resolveLlmEffort("high", undefined)).toEqual({ effort: "high" });
    expect(resolveLlmEffort("low", "high")).toEqual({ effort: "low" });
  });

  it("a typed flag also beats a MALFORMED config, with no warning", () => {
    // resolveRenderConcurrency's rule: the user asking on the command line
    // gets what they asked for, not a warning about a config key they did
    // not touch this run.
    expect(resolveLlmEffort("medium", "max")).toEqual({ effort: "medium" });
  });

  it("a valid config value supplies the default when the flag is not typed", () => {
    expect(resolveLlmEffort(undefined, "low")).toEqual({ effort: "low" });
    expect(resolveLlmEffort(undefined, "medium")).toEqual({ effort: "medium" });
    expect(resolveLlmEffort(undefined, "high")).toEqual({ effort: "high" });
  });

  it("anything else from the config is one warning and no effort — never a coercion", () => {
    for (const bad of ["max", "HIGH", "", 2, true, ["low"], null]) {
      expect(resolveLlmEffort(undefined, bad)).toEqual({
        warning: "⚠ config llmEffort ignored — expected low|medium|high",
      });
    }
  });
});
