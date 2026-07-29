import { describe, expect, it } from "vitest";
import {
  appendUsageRun,
  backfillUsageLog,
  providerFromArgv,
  providerOfLog,
  type LlmUsage,
} from "../src";

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

describe("backfilling a pre-§78 workdir (R16 §79)", () => {
  it("recovers the provider and marks the entry as reconstructed", () => {
    // What the two real Agents workdirs looked like: a cached re-run had
    // already flattened the accounting to nothing.
    const emptied = { records: [], totals: { calls: 0 } };
    const log = backfillUsageLog(emptied, { provider: "gemini", at: AT })!;
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.provider).toBe("gemini");
    expect(log.runs[0]!.backfilled).toBe(true);
    expect(log.runs[0]!.note).toContain("command.json");
    // Tokens are genuinely lost — claim nothing.
    expect(log.runs[0]!.models).toEqual([]);
    expect(log.runs[0]!.totals.calls).toBe(0);
  });

  it("refuses to touch a log that already has history — a record beats a guess", () => {
    const real = appendUsageRun({}, { at: AT, records: [call("claude-cli", "claude-opus-5")] });
    expect(backfillUsageLog(real, { provider: "gemini", at: AT })).toBeNull();
  });

  it("keeps surviving records and prefers THEIR provider over the argv's", () => {
    // A workdir whose usage was never emptied: the recorded provider is the
    // fact, the flag only ever a hint.
    const legacy = { records: [call("claude-cli", "claude-opus-5")], totals: { calls: 1 } };
    const log = backfillUsageLog(legacy, { provider: "gemini", at: AT })!;
    expect(log.runs[0]!.provider).toBe("claude-cli");
    expect(log.runs[0]!.models).toEqual(["claude-opus-5"]);
    expect(log.runs[0]!.cached).toBe(false);
    expect(log.records).toHaveLength(1);
  });
});

describe("providerFromArgv", () => {
  it("reads the flag out of a recorded invocation", () => {
    expect(providerFromArgv(["produce", "a.mp4", "--produce", "--llm", "gemini"])).toBe("gemini");
    expect(providerFromArgv(["produce", "a.mp4", "--produce"])).toBeNull();
    // A trailing `--llm` with no value is not a provider named "--out".
    expect(providerFromArgv(["produce", "--llm", "--out", "x.mp4"])).toBeNull();
    // §75 appends the resolved provider, so the LAST flag is the one that ran.
    expect(providerFromArgv(["--llm", "claude", "--llm", "gemini"])).toBe("gemini");
  });
});
