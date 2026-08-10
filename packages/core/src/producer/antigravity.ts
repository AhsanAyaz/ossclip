import { z } from "zod/v4";
import { run } from "../exec";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";
// Shared fence-stripper for replies that wrap the JSON in prose/markdown.
// A formatting concern, not a Claude dependency (FINDINGS §132, antigravity
// provider).
import { extractJsonObject } from "./claude-cli";

/**
 * agy's own print timeout defaults to 5m, which a beat-sheet call on a long
 * transcript can exceed. Core's `run()` has no timeout of its own, so this
 * flag is the ONLY clock on the spawn — without it a stuck call is a hang,
 * with it a timeout surfaces as retry-then-throw (FINDINGS §132, antigravity
 * provider).
 */
export const AGY_PRINT_TIMEOUT = "10m";

/**
 * agy takes the prompt as an argv argument only — no stdin — and macOS caps
 * ARG_MAX around 1MB. Refuse before the OS does: a pre-spawn check turns
 * E2BIG into a directed error naming providers that can take the prompt
 * (FINDINGS §132, antigravity provider).
 */
export const MAX_AGY_PROMPT_BYTES = 700_000;

/**
 * The argv for one `agy` print-mode call. Pure so the flag set is testable
 * without spawning anything. `--disable-slash-commands` because a transcript
 * prompt that happens to start with `/` must not expand as a skill.
 */
export function buildAgyArgs(
  prompt: string,
  opts: { model?: string; schemaJson: string },
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--json-schema",
    opts.schemaJson,
    "--print-timeout",
    AGY_PRINT_TIMEOUT,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

/**
 * The agy JSON envelope, tolerated rather than trusted: every field absent is
 * a valid outcome — the caller falls back to estimates and says so — so this
 * never throws on a shape it doesn't recognise (same contract as
 * `parseCliEnvelope`).
 *
 * Token mapping into `LlmUsage` terms:
 *   - `outputTokens` folds `thinking_tokens` in: thinking is output-side
 *     spend and LlmUsage has no thinking field of its own.
 *   - Whether `input_tokens` already includes cache reads is not documented,
 *     so it is cross-checked against `total_tokens`: if
 *     input + output + thinking + cache_read exceeds the total, input is
 *     already cache-inclusive and stands alone; otherwise cache reads are
 *     added. Worst case is a conservative over-count — the safe direction
 *     for a number a user might budget against (FINDINGS §132, antigravity
 *     provider).
 */
export function parseAgyEnvelope(stdout: string): {
  status?: string;
  response?: string;
  error?: string;
  structuredOutput?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
} {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!env || typeof env !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const u = (env.usage ?? {}) as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const thinking = num(u.thinking_tokens) ?? 0;
  const cacheRead = num(u.cache_read_tokens) ?? 0;
  const total = num(u.total_tokens);
  const cacheInclusive =
    input !== undefined && total !== undefined
      ? input + (output ?? 0) + thinking + cacheRead > total
      : false;
  return {
    status: str(env.status),
    response: str(env.response),
    error: str(env.error),
    structuredOutput: env.structured_output,
    inputTokens: input === undefined ? undefined : cacheInclusive ? input : input + cacheRead,
    outputTokens: output === undefined ? undefined : output + thinking,
    cachedInputTokens: cacheRead || undefined,
  };
}

/**
 * Failures a retry cannot fix: missing auth and a bad model slug are
 * deterministic, and each retry burns another ~24k-token baseline call (agy's
 * own agent context) for nothing (FINDINGS §132, antigravity provider).
 */
export function isNonRetryableAgyFailure(message: string): boolean {
  return /authentication|not logged in|login|unknown model|invalid model/i.test(message);
}

/**
 * Google Antigravity via the locally installed `agy` CLI. Uses whatever auth
 * the CLI holds — a logged-in subscription, so producing a video consumes
 * plan usage rather than pay-per-token API credits (`billed: false`, and agy
 * reports no cost of its own).
 *
 * The schema rides twice: `--json-schema` for server-side enforcement AND
 * stated in the prompt — the prompt copy is what makes the self-repair retry
 * meaningful, and server enforcement is not our contract, so the reply is
 * still zod-validated here.
 *
 * Requirements: `agy` on PATH (or OSSCLIP_AGY_BIN) and a prior interactive
 * sign-in. The envelope carries no model id, so usage records the requested
 * model or "antigravity-default" (FINDINGS §132, antigravity provider).
 */
export class AntigravityProvider implements LlmProvider {
  readonly name = "antigravity";
  readonly usage: LlmUsage[] = [];

  constructor(
    private model?: string,
    private bin: string = process.env.OSSCLIP_AGY_BIN ?? "agy",
  ) {}

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    const schemaText = JSON.stringify(z.toJSONSchema(req.schema));
    const base =
      `${req.system}\n\n${req.user}\n\n` +
      `Respond with ONLY a JSON object valid against this JSON Schema ("${req.schemaName}"). ` +
      `No markdown fences, no commentary, no tool use — just the JSON:\n${schemaText}`;

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? base
          : `${base}\n\nYour previous reply failed validation:\n${lastError}\nReturn ONLY the corrected JSON.`;
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > MAX_AGY_PROMPT_BYTES) {
        throw new Error(
          `prompt is ${promptBytes.toLocaleString("en-US")} bytes, over the ${MAX_AGY_PROMPT_BYTES.toLocaleString("en-US")}-byte limit for agy — ` +
            `it accepts the prompt only as a command-line argument. ` +
            `Use --llm claude-cli or --llm gemini for a take this long.`,
        );
      }
      const started = Date.now();
      let stdout = "";
      try {
        ({ stdout } = await run(
          this.bin,
          buildAgyArgs(prompt, { model: this.model, schemaJson: schemaText }),
        ));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // run() embeds the stderr tail in its rejection, so auth/bad-slug
        // failures are matchable here and fail fast instead of re-spending.
        if (isNonRetryableAgyFailure(lastError)) break;
        continue;
      }
      // Recorded per ATTEMPT, before validation: a reply that failed the
      // schema still spent the tokens, and a retry is exactly the cost a user
      // would want to see rather than have quietly absorbed.
      const envelope = parseAgyEnvelope(stdout);
      this.usage.push({
        provider: this.name,
        // The envelope names no model, so record what was asked for — or the
        // honest placeholder, which the cost report declines to price.
        model: this.model ?? "antigravity-default",
        schemaName: req.schemaName,
        inputTokens: envelope.inputTokens ?? estimateTokens(prompt),
        outputTokens: envelope.outputTokens ?? estimateTokens(envelope.response ?? stdout),
        cachedInputTokens: envelope.cachedInputTokens,
        exact: envelope.inputTokens !== undefined,
        // The whole point of this provider: agy's cached sign-in means the
        // subscription pays, not a card, and agy reports no cost to forward.
        billed: false,
        ms: Date.now() - started,
      });
      if (envelope.status !== "SUCCESS") {
        lastError =
          envelope.error ?? `agy reported status ${envelope.status ?? "unknown"}: ${stdout.slice(0, 300)}`;
        if (isNonRetryableAgyFailure(lastError)) break;
        continue;
      }
      try {
        // Prefer the server-parsed object, but still validate it — schema
        // enforcement on their side is not a contract on ours.
        if (envelope.structuredOutput !== undefined) {
          return req.schema.parse(envelope.structuredOutput);
        }
        return req.schema.parse(JSON.parse(extractJsonObject(envelope.response ?? stdout)));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(
      `agy CLI ('${this.bin}') did not produce valid ${req.schemaName} JSON: ${lastError.slice(0, 400)}\n` +
        `Is Antigravity installed and logged in? (https://antigravity.google — run 'agy' once interactively to sign in)`,
    );
  }
}
