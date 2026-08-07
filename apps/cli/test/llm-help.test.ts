import { describe, expect, it } from "vitest";
import { defaultProviderName } from "@ossclip/core";

/**
 * Field report 2026-08-07: `--llm`'s help promised "claude if
 * ANTHROPIC_API_KEY is set, else claude-cli" — omitting the GEMINI-first
 * branch `defaultProviderName` actually implements, so a user with both keys
 * set was told the wrong model would run. This pins BOTH sides: the
 * resolver's real order, and that the help text names the checks in that
 * same order (the drift guard the comment in program.ts points at).
 */
describe("--llm help text vs. defaultProviderName (field report 2026-08-07)", () => {
  it("resolver ground truth: gemini beats claude beats claude-cli", () => {
    expect(defaultProviderName({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" })).toBe("gemini");
    expect(defaultProviderName({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(defaultProviderName({ ANTHROPIC_API_KEY: "a" })).toBe("claude");
    expect(defaultProviderName({})).toBe("claude-cli");
  });

  it("the help text states that exact order", async () => {
    const { buildProgram } = await import("../src/program");
    const produceCmd = buildProgram().commands.find((c) => c.name() === "produce");
    const llm = produceCmd?.options.find((o) => o.long === "--llm");
    expect(llm).toBeDefined();
    const d = llm!.description;
    const gemini = d.indexOf("gemini if GEMINI_API_KEY");
    const claude = d.indexOf("claude if ANTHROPIC_API_KEY");
    const cli = d.indexOf("claude-cli", claude);
    // Each branch present, and in the resolver's order: gemini → claude →
    // claude-cli. An index of -1 fails the ordering checks below on its own.
    expect(gemini).toBeGreaterThanOrEqual(0);
    expect(claude).toBeGreaterThan(gemini);
    expect(cli).toBeGreaterThan(claude);
  });
});
