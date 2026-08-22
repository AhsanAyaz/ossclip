import { describe, expect, it } from "vitest";
import { appendUsageRun, providerOfLog, type LlmUsage } from "../src";

const call = (provider: string, model: string, schemaName = "beat_sheet"): LlmUsage => ({
  provider,
  model,
  schemaName,
  inputTokens: 100,
  outputTokens: 10,
  exact: true,
  billed: true,
  ms: 500,
});

const AT = "2026-07-29T12:00:00.000Z";

describe("usage log is append-only (R16 §78)", () => {
  it("a cached re-run does NOT erase the provider that planned the video", () => {
    // The reported case: two real workdirs whose usage.json read
    // `records: []` because the last run made no calls, leaving nothing to
    // say whether Gemini or Claude had chosen their scenes.
    const first = appendUsageRun({}, { at: AT, records: [call("gemini", "gemini-3.6-flash")] });
    const second = appendUsageRun(first, { at: AT, records: [], provider: "gemini" });

    expect(second.records).toHaveLength(1); // the real accounting survives
    expect(second.totals.calls).toBe(1);
    expect(providerOfLog(second)).toBe("gemini");
    expect(second.runs).toHaveLength(2);
    expect(second.runs[1]!.cached).toBe(true);
    expect(second.runs[1]!.provider).toBe("gemini"); // inherited, not a gap
    // …models too, or a cached production is stamped with a provider and no
    // models beside it.
    expect(second.runs[1]!.models).toEqual(["gemini-3.6-flash"]);
  });

  it("keeps one entry per run, in order, with its own totals", () => {
    let log = appendUsageRun({}, { at: AT, records: [call("claude-cli", "claude-opus-5")] });
    log = appendUsageRun(log, { at: AT, records: [] });
    log = appendUsageRun(log, { at: AT, records: [call("gemini", "gemini-3.6-flash")] });

    expect(log.runs.map((r) => r.provider)).toEqual(["claude-cli", "claude-cli", "gemini"]);
    expect(log.runs.map((r) => r.cached)).toEqual([false, true, false]);
    expect(log.runs[1]!.totals.calls).toBe(0);
    // Top-level tracks the newest run WITH calls.
    expect(log.records[0]!.provider).toBe("gemini");
    expect(providerOfLog(log)).toBe("gemini");
  });

  it("a failed attempt's model never reaches the run's model list (§143)", () => {
    // The 2026-08-22 fallback incident: agy's timed-out attempt recorded its
    // "antigravity-default" placeholder, and the production stamp read
    // "planned by claude-cli (antigravity-default)". The cost stays in the
    // records; the attribution list skips it — including what a cached
    // re-run inherits.
    const failedAgy = { ...call("antigravity", "antigravity-default"), failed: true };
    const first = appendUsageRun(
      {},
      { at: AT, records: [failedAgy, call("claude-cli", "claude-fable-5")] },
    );
    expect(first.runs[0]!.models).toEqual(["claude-fable-5"]);
    expect(first.records).toHaveLength(2); // the spend itself is not erased
    const cached = appendUsageRun(first, { at: AT, records: [], provider: "antigravity" });
    expect(cached.runs[1]!.models).toEqual(["claude-fable-5"]);
  });

  it("records the models a run used, first-seen order — the tiering is visible", () => {
    const log = appendUsageRun(
      {},
      {
        at: AT,
        records: [
          call("claude-cli", "claude-opus-5", "beat_sheet"),
          call("claude-cli", "claude-haiku-4-5", "scene_props_batch"),
          call("claude-cli", "claude-haiku-4-5", "transcript_repair"),
        ],
      },
    );
    expect(log.runs[0]!.models).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("a pre-§78 file is a valid input, not an error", () => {
    // The old shape: { records, totals } with no history.
    const legacy = {
      records: [call("claude-cli", "claude-opus-5")],
      totals: { calls: 1 },
    };
    const log = appendUsageRun(legacy, { at: AT, records: [] });
    expect(providerOfLog(log)).toBe("claude-cli");
    expect(log.records).toHaveLength(1);
    expect(log.runs).toHaveLength(1);
  });

  it("garbage and absence both start a fresh history", () => {
    for (const previous of [undefined, null, 42, "nope", { runs: "bad", records: 7 }]) {
      const log = appendUsageRun(previous, { at: AT, records: [call("gemini", "g")] });
      expect(log.runs).toHaveLength(1);
      expect(log.records).toHaveLength(1);
    }
  });

  it("with no calls and nothing remembered, the provider is honestly null", () => {
    const log = appendUsageRun({}, { at: AT, records: [] });
    expect(providerOfLog(log)).toBeNull();
    expect(log.runs[0]!.provider).toBeNull();
  });
});
