import type { z } from "zod/v4";
import { AgyError } from "./antigravity";
import type { CallTier, LlmProvider } from "./provider";
import type { LlmUsage } from "./usage";

/**
 * What a fallback announcement needs to say: who failed, who is answering
 * instead, on which call, and (first line of) the failure's own sentence.
 */
export interface FallbackInfo {
  from: string;
  to: string;
  schemaName: string;
  detail: string;
}

/**
 * Falls back to a second provider when — and only when — the primary TIMES
 * OUT (2026-08-22, FINDINGS §143). agy is healthy at small scale and then
 * hangs persistently on the real beat-sheet call: measured 10-minute
 * `--print-timeout` expiries on an 11-minute take while claude-cli planned
 * the same video without complaint — and auto-detection picks agy whenever
 * the CLI is on PATH, so without this every Antigravity user's first real
 * produce dies after the wait.
 *
 * Only the `timeout` class falls back: auth and bad-model failures are
 * deterministic and must keep failing fast with their own guidance —
 * answering them from another provider would paper over a config error the
 * user needs to see. Exactly ONE fallback attempt, no loop: the fallback
 * provider runs its own internal retries.
 *
 * `name` stays the primary's — the detection line already announced it — and
 * the truth of who actually answered lives in `usage` (each record keeps the
 * provider that really made the call) plus the caller's out-loud `onFallback`
 * line. Silent substitution would be worse than the hang.
 */
export class FallbackProvider implements LlmProvider {
  readonly name: string;
  private readonly records: LlmUsage[] = [];

  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
    private readonly onFallback?: (info: FallbackInfo) => void,
  ) {
    this.name = primary.name;
  }

  /** Merged in call order — the sub-providers each keep their own log. */
  get usage(): readonly LlmUsage[] {
    return this.records;
  }

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens?: number;
    tier?: CallTier;
  }): Promise<T> {
    const beforePrimary = this.primary.usage.length;
    const beforeFallback = this.fallback.usage.length;
    try {
      try {
        return await this.primary.complete(req);
      } catch (err) {
        // Branch on the class as DATA — AgyError carries it precisely so a
        // fallback decorator never re-parses human-facing prose
        // (antigravity.ts). Everything that is not an agy timeout rethrows.
        if (!(err instanceof AgyError) || err.failureClass !== "timeout") throw err;
        this.onFallback?.({
          from: this.primary.name,
          to: this.fallback.name,
          schemaName: req.schemaName,
          // First line only: agyFailureMessage is multi-line guidance, and
          // the announcement needs the sentence, not the manual.
          detail: err.message.split("\n")[0]!.trim(),
        });
        return await this.fallback.complete(req);
      }
    } finally {
      // Drain whatever BOTH sub-providers logged, including for calls that
      // threw — a failed attempt still spent the tokens (tiered.ts, §37).
      // Each record keeps the provider that really made the call, which is
      // the attribution the cache keys and the usage report depend on.
      this.records.push(...this.primary.usage.slice(beforePrimary));
      this.records.push(...this.fallback.usage.slice(beforeFallback));
    }
  }
}
