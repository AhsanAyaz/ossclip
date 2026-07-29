/**
 * Token and cost accounting for the producer's LLM calls.
 *
 * Producing a video is many calls — a repair pass, a beat sheet, and one per
 * scene — so "what did that cost" is a real question with a non-obvious
 * answer. Every provider records one entry per call into its own `usage`
 * array; the CLI prices them at the end and prints a per-call-type breakdown
 * plus a total.
 *
 * Providers record TOKENS, not money. Pricing lives here alone, so a price
 * change is one table edit rather than four provider edits, and so a provider
 * that reports an authoritative cost of its own (the Claude CLI does) can
 * hand it over without every other provider growing a pricing dependency.
 *
 * Two honesty rules, because a wrong number is worse than no number:
 *   - Tokens a provider actually reports are marked exact; anything derived
 *     from text length is marked an estimate and says so in the output.
 *   - Prices change and vary by model. The table below is the DEFAULT
 *     assumption by model family, overridable in `~/.ossclip/config.json`;
 *     a model that matches nothing is reported with tokens and no cost
 *     rather than a guess.
 */

export interface LlmUsage {
  provider: string;
  model?: string;
  /** Which call this was — `beat_sheet`, `transcript_repair`, `StatCard_props`… */
  schemaName: string;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from cache, when the provider distinguishes them. */
  cachedInputTokens?: number;
  /**
   * A cost the provider stated itself, in USD. Authoritative when present —
   * it beats the local price table, which is only ever an assumption.
   */
  reportedCostUsd?: number;
  /** False when tokens were derived from text length rather than reported. */
  exact: boolean;
  /**
   * False when the call does not bill per token — a subscription CLI or the
   * offline mock. The cost is still worth showing (it says what the same work
   * would cost on the API), it just isn't a charge.
   */
  billed: boolean;
  /** Wall-clock milliseconds, so a slow call is visible beside a costly one. */
  ms?: number;
}

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Default price assumptions, in USD per million tokens, keyed by the model
 * FAMILY found in the model id. Family rather than exact id because ids carry
 * dates and revisions that change more often than the tier's pricing does.
 *
 * These are assumptions, not quotes: override them per model or per family in
 * `~/.ossclip/config.json` under `pricing` if your account differs.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-3.6-flash": { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/** Resolve a price for a model id: exact override, override family, then default family. */
export function priceFor(
  model: string | undefined,
  overrides: Record<string, ModelPrice> = {},
): ModelPrice | null {
  if (!model) return null;
  if (overrides[model]) return overrides[model]!;
  const id = model.toLowerCase();
  // Longest key first so `gemini-2.5-flash` wins over a hypothetical `gemini`.
  const byLength = (t: Record<string, ModelPrice>): Array<[string, ModelPrice]> =>
    Object.entries(t).sort((a, b) => b[0].length - a[0].length);
  for (const [family, price] of byLength(overrides)) {
    if (id.includes(family.toLowerCase())) return price;
  }
  for (const [family, price] of byLength(DEFAULT_PRICING)) {
    if (id.includes(family)) return price;
  }
  return null;
}

/**
 * What one call cost, and how confidently.
 *
 * `reported` is the provider's own number; `table` is priced locally from
 * tokens; `unknown` means the model matches no price and we decline to guess.
 *
 * `inputTokens` counts every input token however it was served, including
 * cached ones, and all of them are priced at the full input rate. Cache reads
 * really cost a fraction of that, so a run with cache hits is an OVER-estimate
 * — the safe direction for a number a user might budget against, and the
 * report says so whenever cached tokens are non-zero.
 */
export function costOf(
  record: LlmUsage,
  pricing: Record<string, ModelPrice> = {},
): { usd: number | null; source: "reported" | "table" | "unknown" } {
  if (record.reportedCostUsd !== undefined) {
    return { usd: record.reportedCostUsd, source: "reported" };
  }
  const price = priceFor(record.model, pricing);
  if (!price) return { usd: null, source: "unknown" };
  return {
    usd:
      (record.inputTokens * price.inputPerMTok + record.outputTokens * price.outputPerMTok) /
      1_000_000,
    source: "table",
  };
}

/**
 * Rough token count for providers that do not report one. Deliberately crude —
 * ~4 characters per token is the usual English approximation — and always
 * surfaced as an estimate rather than passed off as measured.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  ms: number;
  /** USD actually charged. Null when a billed call had no known price. */
  billedUsd: number | null;
  /**
   * USD the same tokens would cost at API rates, INCLUDING subscription calls.
   * This is the number that makes a Claude Max run legible: the plan covers
   * it, but it still says how much work the run represents.
   */
  equivalentUsd: number | null;
  /** True when any record's tokens were estimated rather than reported. */
  anyEstimated: boolean;
  /** True when no call billed per token (subscription or offline). */
  allUnbilled: boolean;
  /** Models seen with no price, so the report can name them. */
  unpricedModels: string[];
}

export function summarizeUsage(
  records: readonly LlmUsage[],
  pricing: Record<string, ModelPrice> = {},
): UsageTotals {
  const unpriced = new Set<string>();
  let billed: number | null = 0;
  let equivalent: number | null = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let ms = 0;
  let estimated = false;
  let billedAny = false;

  for (const r of records) {
    input += r.inputTokens;
    output += r.outputTokens;
    cached += r.cachedInputTokens ?? 0;
    ms += r.ms ?? 0;
    if (!r.exact) estimated = true;
    const { usd } = costOf(r, pricing);
    if (usd === null) {
      unpriced.add(r.model ?? r.provider);
      equivalent = null;
      if (r.billed) billed = null;
    } else {
      if (equivalent !== null) equivalent += usd;
      if (r.billed && billed !== null) billed += usd;
    }
    if (r.billed) billedAny = true;
  }

  return {
    calls: records.length,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    ms,
    billedUsd: billedAny ? billed : 0,
    equivalentUsd: equivalent,
    anyEstimated: estimated,
    allUnbilled: !billedAny,
    unpricedModels: [...unpriced],
  };
}

const n = (v: number): string => v.toLocaleString("en-US");
const usd = (v: number): string => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const secs = (msTotal: number): string =>
  msTotal >= 1000 ? `${Math.round(msTotal / 1000)}s` : `${msTotal}ms`;

/** One line for the console: the answer to "what did that cost". */
export function formatUsageLine(
  records: readonly LlmUsage[],
  pricing: Record<string, ModelPrice> = {},
): string {
  const t = summarizeUsage(records, pricing);
  if (t.calls === 0) return "▸ llm: no calls";
  // A bare input total invites the wrong conclusion. On the CLI path ~99% of
  // it is the harness prefix re-sent per call, not anything ossclip wrote —
  // "270k in" reads like a runaway prompt when the real lever is call count.
  const cachedShare = t.inputTokens > 0 ? t.cachedInputTokens / t.inputTokens : 0;
  const inPart =
    cachedShare >= 0.5
      ? `${n(t.inputTokens)} in (${Math.round(cachedShare * 100)}% cached prefix) / ${n(t.outputTokens)} out tokens`
      : `${n(t.inputTokens)} in / ${n(t.outputTokens)} out tokens`;
  const parts = [`${t.calls} calls`, inPart];
  if (t.equivalentUsd === null) {
    parts.push(
      `cost unknown for ${t.unpricedModels.join(", ")} — set \`pricing\` in ~/.ossclip/config.json`,
    );
  } else if (t.allUnbilled) {
    // Zero equivalent means an offline provider, not a generous plan — saying
    // "covered by the subscription" there would be nonsense.
    parts.push(
      t.equivalentUsd === 0
        ? "no charge (offline provider)"
        : `~${usd(t.equivalentUsd)} of API-rate work, covered by the subscription`,
    );
  } else {
    parts.push(`~${usd(t.billedUsd ?? 0)}`);
  }
  if (t.ms > 0) parts.push(secs(t.ms));
  return `▸ llm: ${parts.join(" · ")}${t.anyEstimated ? " (tokens partly estimated)" : ""}`;
}

interface Grouped {
  schemaName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  exact: boolean;
  ms: number;
}

/** Collapse the per-scene calls into one row per call TYPE, in first-seen order. */
export function groupUsage(
  records: readonly LlmUsage[],
  pricing: Record<string, ModelPrice> = {},
): Grouped[] {
  const rows = new Map<string, Grouped>();
  for (const r of records) {
    const row = rows.get(r.schemaName) ?? {
      schemaName: r.schemaName,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0 as number | null,
      exact: true,
      ms: 0,
    };
    const { usd: cost } = costOf(r, pricing);
    row.calls += 1;
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.usd = cost === null || row.usd === null ? null : row.usd + cost;
    row.exact &&= r.exact;
    row.ms += r.ms ?? 0;
    rows.set(r.schemaName, row);
  }
  return [...rows.values()];
}

/** Per-call-type breakdown for report.txt — where the cost actually went. */
export function formatUsageReport(
  records: readonly LlmUsage[],
  pricing: Record<string, ModelPrice> = {},
): string {
  if (records.length === 0) return "";
  const t = summarizeUsage(records, pricing);
  const first = records[0]!;
  // A column of $0.0000 says nothing; an offline run's cost column is a dash.
  const free = t.allUnbilled && t.equivalentUsd === 0;
  const money = (v: number | null): string => (free ? "—" : v === null ? "?" : usd(v));
  const rows = groupUsage(records, pricing).map((g) => {
    const name = g.calls > 1 ? `${g.schemaName} ×${g.calls}` : g.schemaName;
    return (
      `  ${name.padEnd(26)}${n(g.inputTokens).padStart(9)} in ${n(g.outputTokens).padStart(8)} out` +
      `${money(g.usd).padStart(10)}${g.exact ? "" : "  (est)"}`
    );
  });
  const total = money(t.equivalentUsd);
  const notes: string[] = [];
  if (t.cachedInputTokens > 0) {
    notes.push(
      `  ${n(t.cachedInputTokens)} input tokens came from cache and are priced here at the\n` +
        "  full input rate, so the total above is an over-estimate.",
    );
  }
  if (t.allUnbilled) {
    notes.push(
      t.equivalentUsd === 0
        ? "  Nothing was charged — this ran entirely offline."
        : "  Not billed per token — this ran on a subscription. The figures say what\n" +
          "  the same tokens would have cost at API rates.",
    );
  }
  if (t.anyEstimated) {
    notes.push("  Rows marked (est) had their tokens estimated — that provider reports none.");
  }
  if (t.unpricedModels.length > 0) {
    notes.push(
      `  No price known for ${t.unpricedModels.join(", ")} — set \`pricing\` in\n` +
        "  ~/.ossclip/config.json to price it.",
    );
  } else if (t.equivalentUsd !== 0) {
    notes.push("  Prices are the built-in per-family assumption; override in ~/.ossclip/config.json.");
  }
  return (
    `\nllm usage (${first.provider}${first.model ? ` · ${first.model}` : ""}` +
    `${t.ms > 0 ? `, ${secs(t.ms)}` : ""}):\n` +
    rows.join("\n") +
    "\n" +
    `  ${"TOTAL".padEnd(26)}${n(t.inputTokens).padStart(9)} in ${n(t.outputTokens).padStart(8)} out${total.padStart(10)}\n` +
    notes.join("\n") +
    "\n"
  );
}

/** One produce run's entry in the workdir's usage log. */
export interface UsageRun {
  /** ISO timestamp, supplied by the caller so this stays pure. */
  at: string;
  /** Resolved provider, or null when a run made no calls and none is known. */
  provider: string | null;
  /** Models seen this run, first-seen order — the tiering, visible. */
  models: string[];
  /** True when the run made no calls: everything came from the workdir cache. */
  cached: boolean;
  records: LlmUsage[];
  totals: UsageTotals;
  /** True when this entry was reconstructed after the fact, not recorded. */
  backfilled?: boolean;
  /** Why the entry is thin, when it is. */
  note?: string;
}

/**
 * The workdir's usage log (R16 §78).
 *
 * `records`/`totals` describe ONE run, and every run rewrote them — so a
 * fully-cached re-run (zero calls, `records: []`) erased the provenance of
 * the run that actually did the planning. Two real workdirs were left saying
 * nothing about which provider chose their scenes.
 *
 * So the file grows a `runs` history, and the top-level `records`/`totals`
 * now hold the last run THAT MADE CALLS rather than simply the last run —
 * every existing reader keeps working and stops being lied to. The whole
 * shape is optional on read: a pre-§78 file is a valid input.
 */
export interface UsageLog {
  runs: UsageRun[];
  /** Last run that made calls — NOT necessarily the last run. */
  records: LlmUsage[];
  totals: UsageTotals;
}

/** The provider a log knows about, newest run with calls first. */
export function providerOfLog(log: Pick<UsageLog, "runs" | "records">): string | null {
  for (let i = log.runs.length - 1; i >= 0; i--) {
    const run = log.runs[i]!;
    if (!run.cached && run.provider) return run.provider;
  }
  return log.records[0]?.provider ?? null;
}

/** Models the log last saw in a run that made calls. */
function modelsOfLog(log: Pick<UsageLog, "runs" | "records">): string[] {
  for (let i = log.runs.length - 1; i >= 0; i--) {
    const run = log.runs[i]!;
    if (!run.cached && run.models.length > 0) return [...run.models];
  }
  const seen: string[] = [];
  for (const r of log.records) {
    if (r.model && !seen.includes(r.model)) seen.push(r.model);
  }
  return seen;
}

export function appendUsageRun(
  previous: unknown,
  run: { at: string; records: readonly LlmUsage[]; provider?: string | null },
  pricing: Record<string, ModelPrice> = {},
): UsageLog {
  const prev = (previous ?? {}) as Partial<UsageLog>;
  const prevRuns = Array.isArray(prev.runs) ? prev.runs : [];
  const prevRecords = Array.isArray(prev.records) ? prev.records : [];
  const records = [...run.records];
  const cached = records.length === 0;
  const models: string[] = [];
  for (const r of records) {
    if (r.model && !models.includes(r.model)) models.push(r.model);
  }
  // A cached run inherits the models it is REUSING the output of, exactly as
  // it inherits the provider — otherwise the stamp on a cached production
  // names a provider with no models beside it.
  const inheritedModels = cached
    ? modelsOfLog({ runs: prevRuns, records: prevRecords })
    : models;
  // A cached run still names the provider it INHERITS, so the history reads
  // as a continuous account rather than a gap.
  const provider =
    records[0]?.provider ??
    run.provider ??
    providerOfLog({ runs: prevRuns, records: prevRecords });
  const totals = summarizeUsage(records, pricing);
  const entry: UsageRun = { at: run.at, provider, models: inheritedModels, cached, records, totals };
  return {
    runs: [...prevRuns, entry],
    // Never overwrite a real accounting with an empty one.
    records: cached ? prevRecords : records,
    totals: cached && prevRecords.length > 0 ? summarizeUsage(prevRecords, pricing) : totals,
  };
}

/** Marks a run entry whose provider was recovered rather than recorded. */
export const BACKFILL_NOTE =
  "provider recovered from command.json (R16 §78); this run's token counts were lost " +
  "when a cached re-run overwrote them";

/**
 * Rebuild the provenance of a workdir produced before §78 (R16 §79).
 *
 * Those runs left `usage.json` holding `records: []` — a cached re-run
 * overwrote the real accounting — so the only surviving evidence of who
 * planned the video is the `--llm` flag in `command.json`. This claims
 * exactly that and no more: the provider, and when the planning cache was
 * written. Tokens and model names are genuinely gone, and are left empty
 * rather than invented; the entry says so in `note`.
 *
 * Returns null when there is nothing to do — a log that already has history
 * is left alone, because a real record always beats a reconstructed one.
 */
export function backfillUsageLog(
  previous: unknown,
  meta: { provider: string; at: string },
  pricing: Record<string, ModelPrice> = {},
): UsageLog | null {
  const prev = (previous ?? {}) as Partial<UsageLog>;
  if (Array.isArray(prev.runs) && prev.runs.length > 0) return null;
  const records = Array.isArray(prev.records) ? prev.records : [];
  const totals = summarizeUsage(records, pricing);
  const models: string[] = [];
  for (const r of records) {
    if (r.model && !models.includes(r.model)) models.push(r.model);
  }
  const entry: UsageRun = {
    at: meta.at,
    provider: records[0]?.provider ?? meta.provider,
    models,
    cached: records.length === 0,
    records,
    totals,
    backfilled: true,
    note: BACKFILL_NOTE,
  };
  return { runs: [entry], records, totals };
}

/** The `--llm <provider>` a recorded invocation used, if it named one. */
export function providerFromArgv(argv: readonly string[]): string | null {
  const i = argv.lastIndexOf("--llm");
  if (i === -1) return null;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : null;
}
