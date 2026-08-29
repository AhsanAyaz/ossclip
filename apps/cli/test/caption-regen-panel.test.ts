import { describe, expect, it } from "vitest";
import { captionRegenProvider } from "../src/caption-regen-panel";

const none = (): boolean => false;

describe("captionRegenProvider (2026-08-29)", () => {
  it("the usage log's provider wins — truthful even after a §143 fallback", () => {
    const usageLog = {
      runs: [
        { at: "t0", provider: "antigravity", models: [], cached: false, records: [], totals: {} },
        // A fully-cached re-run inherits, and providerOfLog skips it.
        { at: "t1", provider: "gemini", models: [], cached: true, records: [], totals: {} },
      ],
      records: [],
    };
    expect(
      captionRegenProvider({
        usageLog,
        commandArgs: ["produce", "in.mp4", "--llm", "claude"],
        env: {},
        hasBin: none,
      }),
    ).toEqual({ status: "ready", provider: "antigravity" });
  });

  it("a hand-edited log naming garbage falls through to the pin — parsed, never coerced", () => {
    const usageLog = {
      runs: [{ at: "t0", provider: "geminni", models: [], cached: false, records: [], totals: {} }],
      records: [],
    };
    expect(
      captionRegenProvider({
        usageLog,
        commandArgs: ["produce", "in.mp4", "--llm", "gemini"],
        env: {},
        hasBin: none,
      }),
    ).toEqual({ status: "ready", provider: "gemini" });
  });

  it("no log: the --llm pin decides, last occurrence wins (commander's rule)", () => {
    expect(
      captionRegenProvider({
        usageLog: null,
        commandArgs: ["produce", "in.mp4", "--llm", "claude", "--llm", "mock"],
        env: {},
        hasBin: none,
      }),
    ).toEqual({ status: "ready", provider: "mock" });
  });

  it("no log, no pin: defaultProviderName's detection, keys included", () => {
    expect(
      captionRegenProvider({
        usageLog: null,
        commandArgs: null,
        env: { GEMINI_API_KEY: "k" },
        hasBin: none,
      }),
    ).toEqual({ status: "ready", provider: "gemini" });
    // The subscription CLI beats an ambient key (§132's order, unrestated).
    expect(
      captionRegenProvider({
        usageLog: null,
        commandArgs: null,
        env: { GEMINI_API_KEY: "k" },
        hasBin: (bin) => bin === "agy",
      }),
    ).toEqual({ status: "ready", provider: "antigravity" });
  });

  it("nothing reachable: unavailable with the actionable sentence, never a doomed claude-cli pick", () => {
    const state = captionRegenProvider({ usageLog: null, commandArgs: null, env: {}, hasBin: none });
    expect(state.status).toBe("unavailable");
    expect(state.status === "unavailable" && state.reason).toContain("GEMINI_API_KEY");
  });

  it("a corrupt log shape (non-array runs) reads as no log at all", () => {
    expect(
      captionRegenProvider({
        usageLog: { runs: "oops", records: {} },
        commandArgs: ["produce", "in.mp4", "--llm", "claude-cli"],
        env: {},
        hasBin: none,
      }),
    ).toEqual({ status: "ready", provider: "claude-cli" });
  });
});
