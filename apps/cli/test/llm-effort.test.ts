import { describe, expect, it } from "vitest";
import { AGY_PRINT_TIMEOUT } from "@ossclip/core";
import { AGY_SLOW_NOTICE_MS, resolveLlmEffort } from "../src/produce";

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

/**
 * The two agy clocks have to stay in order (§149). The spinner's notice exists
 * because a hung call looks exactly like a working one, and it can only do
 * that job if it fires while the wait still has somewhere to go — set it above
 * the budget and it never shows, which is silently back to the 605.9s of dead
 * air the field run hit. Pinned as a RELATIONSHIP, not two numbers, so either
 * can be tuned without quietly disabling the other.
 */
describe("the agy slow-notice fires inside the print-timeout budget", () => {
  // agy takes Go durations ("90s", "10m", "1m30s"); this is the subset the
  // constant is allowed to use.
  const durationMs = (d: string): number => {
    const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(d);
    if (!m || (!m[1] && !m[2])) throw new Error(`unparseable agy duration: ${d}`);
    return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
  };

  it("the budget parses as a Go duration agy would accept", () => {
    expect(durationMs(AGY_PRINT_TIMEOUT)).toBeGreaterThan(0);
  });

  it("the notice lands before the fallback, with room to be read", () => {
    const budget = durationMs(AGY_PRINT_TIMEOUT);
    expect(AGY_SLOW_NOTICE_MS).toBeLessThan(budget);
    // Not a hair before it: the notice is useless if the fallback lands on top
    // of it, so it gets at least half the budget to stand on screen.
    expect(AGY_SLOW_NOTICE_MS).toBeLessThanOrEqual(budget / 2);
  });

  it("the notice waits out a healthy call — 46s is the slowest ever measured", () => {
    expect(AGY_SLOW_NOTICE_MS).toBeGreaterThanOrEqual(30_000);
  });
});
