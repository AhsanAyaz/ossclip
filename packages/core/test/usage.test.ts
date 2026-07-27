import { describe, expect, it } from "vitest";
import {
  costOf,
  estimateTokens,
  formatUsageLine,
  formatUsageReport,
  groupUsage,
  priceFor,
  summarizeUsage,
  type LlmUsage,
} from "../src/producer/usage";

const call = (over: Partial<LlmUsage> = {}): LlmUsage => ({
  provider: "claude",
  model: "claude-opus-5",
  schemaName: "beat_sheet",
  inputTokens: 10_000,
  outputTokens: 1_000,
  exact: true,
  billed: true,
  ...over,
});

describe("pricing (FINDINGS §36)", () => {
  it("matches a dated model id by family", () => {
    expect(priceFor("claude-sonnet-4-5-20250929")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("an exact override beats the family table", () => {
    const p = priceFor("claude-opus-5", { "claude-opus-5": { inputPerMTok: 1, outputPerMTok: 2 } });
    expect(p).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it("prefers the longest matching family, so a flash id is not priced as pro", () => {
    expect(priceFor("gemini-2.5-flash-preview")!.inputPerMTok).toBe(0.3);
  });

  it("declines to guess for an unknown model", () => {
    // The whole point: a wrong cost is worse than an absent one.
    expect(priceFor("some-local-llama")).toBeNull();
    expect(costOf(call({ model: "some-local-llama" }))).toEqual({ usd: null, source: "unknown" });
  });

  it("a provider's own cost wins over the local table", () => {
    // The claude CLI states a cost; ours is only ever an assumption.
    expect(costOf(call({ reportedCostUsd: 0.42 }))).toEqual({ usd: 0.42, source: "reported" });
  });

  it("prices opus at the published per-million rates", () => {
    // 10k in @ $15/M + 1k out @ $75/M = $0.15 + $0.075
    expect(costOf(call()).usd).toBeCloseTo(0.225, 6);
  });
});

describe("totals", () => {
  it("separates what was charged from what the work was worth", () => {
    // The subscription case, which is what a Claude Max user actually runs:
    // nothing is billed, but "how much work was that" still has an answer.
    const t = summarizeUsage([
      call({ provider: "claude-cli", billed: false, reportedCostUsd: 0.3 }),
      call({ provider: "claude-cli", billed: false, reportedCostUsd: 0.2 }),
    ]);
    expect(t.billedUsd).toBe(0);
    expect(t.equivalentUsd).toBeCloseTo(0.5, 6);
    expect(t.allUnbilled).toBe(true);
  });

  it("one unpriced call voids the total rather than under-reporting it", () => {
    const t = summarizeUsage([call(), call({ model: "mystery-model" })]);
    expect(t.equivalentUsd).toBeNull();
    expect(t.unpricedModels).toEqual(["mystery-model"]);
  });

  it("an unpriced UNBILLED call leaves the billed total intact", () => {
    // Nothing about the mock's tokens can change what the API charged.
    const t = summarizeUsage([call(), call({ provider: "mock", billed: false, model: undefined })]);
    expect(t.billedUsd).toBeCloseTo(0.225, 6);
    expect(t.equivalentUsd).toBeNull();
  });

  it("carries the estimate flag up from any single call", () => {
    expect(summarizeUsage([call(), call({ exact: false })]).anyEstimated).toBe(true);
  });

  it("no calls is not an error", () => {
    const t = summarizeUsage([]);
    expect(t).toMatchObject({ calls: 0, billedUsd: 0, equivalentUsd: 0, allUnbilled: true });
    expect(formatUsageLine([])).toContain("no calls");
    expect(formatUsageReport([])).toBe("");
  });
});

describe("output", () => {
  const run: LlmUsage[] = [
    call({ schemaName: "transcript_repair", inputTokens: 4_000, outputTokens: 200 }),
    call({ schemaName: "beat_sheet", inputTokens: 6_000, outputTokens: 1_500 }),
    call({ schemaName: "StatCard_props", inputTokens: 900, outputTokens: 120 }),
    call({ schemaName: "StatCard_props", inputTokens: 800, outputTokens: 110 }),
  ];

  it("groups the per-scene calls by type and keeps the totals whole", () => {
    const rows = groupUsage(run);
    expect(rows.map((r) => r.schemaName)).toEqual([
      "transcript_repair",
      "beat_sheet",
      "StatCard_props",
    ]);
    expect(rows[2]!.calls).toBe(2);
    expect(rows[2]!.inputTokens).toBe(1_700);
    const t = summarizeUsage(run);
    expect(rows.reduce((s, r) => s + r.inputTokens, 0)).toBe(t.inputTokens);
  });

  it("the console line answers the question in one sentence", () => {
    const line = formatUsageLine(run);
    expect(line).toContain("4 calls");
    expect(line).toContain("11,700 in");
    expect(line).toMatch(/\$\d/);
  });

  it("says plainly when a subscription paid, not $0.00 with no explanation", () => {
    const line = formatUsageLine(run.map((r) => ({ ...r, billed: false })));
    expect(line).toContain("subscription");
  });

  it("does not call an offline run 'covered by the subscription'", () => {
    // The mock costs nothing because it never left the machine — telling the
    // user a plan absorbed it, or offering to price "mock", is nonsense.
    const offline = run.map(
      (r): LlmUsage => ({ ...r, provider: "mock", model: undefined, billed: false, reportedCostUsd: 0 }),
    );
    expect(formatUsageLine(offline)).toContain("offline");
    expect(formatUsageLine(offline)).not.toContain("subscription");
    expect(formatUsageLine(offline)).not.toContain("config.json");
    const report = formatUsageReport(offline);
    expect(report).toContain("entirely offline");
    expect(report).not.toContain("$0.0000");
  });

  it("names the model it cannot price and where to fix it", () => {
    const line = formatUsageLine([call({ model: "mystery-model" })]);
    expect(line).toContain("mystery-model");
    expect(line).toContain("config.json");
  });

  it("the report shows every call type and one total", () => {
    const report = formatUsageReport(run);
    expect(report).toContain("StatCard_props ×2");
    expect(report).toContain("TOTAL");
    expect(report).toContain("11,700");
  });

  it("flags cached tokens as making the total an over-estimate", () => {
    const report = formatUsageReport([call({ cachedInputTokens: 5_000 })]);
    expect(report).toMatch(/over-estimate/);
  });
});

describe("token estimation", () => {
  it("is never zero, so an estimated call is still visible", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
