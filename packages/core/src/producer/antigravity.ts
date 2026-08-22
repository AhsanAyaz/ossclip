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
 * The stderr tail out of a `run()` rejection — its format is
 * `<bin> <args> failed (exit N):\n<stderr tail>` — or the message unchanged
 * when it did not come from `run()` (a spawn error, or a zod message from the
 * validation arm).
 *
 * Worth isolating because agy takes the prompt on argv (§132), so the echoed
 * command line is the ENTIRE transcript prompt plus the JSON schema: the
 * failure text a user needs starts thousands of characters in, and the first
 * 400 chars of the raw message — what this error used to print — are our own
 * command line and none of the failure.
 *
 * Splits on the LAST marker: the prompt is user text and could in principle
 * contain the same phrase, but the real one is always after it.
 *
 * An empty result when the marker DID match is returned as empty rather than
 * falling back to the whole message: a silent non-zero exit is a real outcome,
 * and handing the argv echo back would put `--print-timeout 10m` in front of
 * the classifier — the exact false positive the split exists to prevent.
 */
export function agyFailureDetail(message: string): string {
  let tail: string | null = null;
  for (const m of message.matchAll(/\sfailed \(exit [^)]*\):\n/g)) {
    tail = message.slice((m.index ?? 0) + m[0].length);
  }
  return (tail ?? message).trim();
}

/** What the failure text says actually went wrong. See `classifyAgyFailure`. */
export type AgyFailureClass = "auth" | "model" | "timeout" | "schema" | "unknown";

/**
 * Classify a failure so the error can say what happened instead of guessing.
 * Pure and exported so every class is assertable without spawning agy.
 *
 * The incident (2026-08-22): a `--produce --aspect 16:9` run on an 11-minute
 * take timed out twice at AGY_PRINT_TIMEOUT — 10m each, 25 minutes burned —
 * and then died with "Is Antigravity installed and logged in?", while agy was
 * installed, logged in and working. The hint was appended unconditionally, so
 * every failure was reported as an auth failure and this one sent the user to
 * debug auth after a 25-minute wait.
 *
 * The scopes differ on purpose:
 *  - `auth`/`model` test the WHOLE message, with the same patterns
 *    `isNonRetryableAgyFailure` uses, so the class a user is shown can never
 *    disagree with the fail-fast decision that produced it.
 *  - `timeout`/`schema` test only `agyFailureDetail`, because the argv echo
 *    carries our own `--print-timeout 10m` flag and our own `--json-schema`
 *    payload. A pattern as natural as /timeout/ over the whole message would
 *    classify every non-zero exit as a hang — the same over-claiming this
 *    change exists to remove.
 *
 * The timeout pattern is best-effort. agy's wording when `--print-timeout`
 * fires is not a contract we control (§132 measured the SUCCESS envelope, not
 * this), so it matches the plausible surfacings — a phrase, the errno, and the
 * signals a killed child reports — rather than one pinned string. A miss costs
 * the headline and the provider hint; the attempt facts below print either
 * way, and they are what actually self-diagnoses a hang.
 */
export function classifyAgyFailure(message: string): AgyFailureClass {
  if (/authentication|not logged in|login/i.test(message)) return "auth";
  if (/unknown model|invalid model/i.test(message)) return "model";
  const detail = agyFailureDetail(message);
  if (/timed? ?out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(detail)) return "timeout";
  // Ours (`extractJsonObject`), JSON.parse's, and zod's — the three things
  // that can leave a validation message in `lastError`.
  const schemaish = /no JSON object in reply|is not valid JSON|Unexpected (token|end of)|"code":\s*"/i;
  if (schemaish.test(detail)) return "schema";
  return "unknown";
}

/** `600_000 → "10m0s"`, `1_500 → "1.5s"` — an at-a-glance wall time. */
function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * The error thrown when every attempt failed. Pure so the wording is testable
 * without spawning agy, and built around one rule learned from the 2026-08-22
 * incident: the ATTEMPT FACTS print for every class, because they self-diagnose
 * regardless of what the classifier decided. "2 attempts, 10m0s and 10m0s,
 * --print-timeout 10m" tells a user the call hung better than any guess we
 * could make, and it stays true when the guess is wrong.
 *
 * Guidance, by contrast, is class-gated: the sign-in hint only for `auth`, and
 * for `timeout` the actual escape hatch — another provider, or no planner at
 * all — named the way the oversized-prompt error above names them.
 */
export function agyFailureMessage(parts: {
  bin: string;
  schemaName: string;
  lastError: string;
  /** Wall time of every attempt that ran, in order. */
  attemptMs: readonly number[];
  printTimeout: string;
}): string {
  const cls = classifyAgyFailure(parts.lastError);
  const headline =
    cls === "timeout"
      ? " — the call timed out"
      : cls === "schema"
        ? " — the reply never matched the schema"
        : "";
  const times = parts.attemptMs.map(formatElapsed);
  const listed =
    times.length > 1
      ? `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`
      : (times[0] ?? "");
  const detail = agyFailureDetail(parts.lastError).slice(0, 400) || "agy printed nothing";
  const lines = [
    `agy CLI ('${parts.bin}') did not produce valid ${parts.schemaName} JSON${headline}: ${detail}`,
    `${parts.attemptMs.length} attempt${parts.attemptMs.length === 1 ? "" : "s"}` +
      `${listed ? `, ${listed}` : ""}, --print-timeout ${parts.printTimeout}.`,
  ];
  if (cls === "auth") {
    lines.push(
      `Is Antigravity installed and logged in? (https://antigravity.google — run 'agy' once interactively to sign in)`,
    );
  }
  if (cls === "timeout") {
    lines.push(
      `A long take can outrun agy's ${parts.printTimeout} print timeout. ` +
        `Use --llm claude-cli (a logged-in Claude Code subscription) or --llm gemini (needs GEMINI_API_KEY), ` +
        `or drop --produce to cut and caption without a planner.`,
    );
  }
  return lines.join("\n");
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
    // Wall time of every attempt that FAILED, in order — the facts the final
    // error reports. Kept separately from `usage`, which only records attempts
    // that got as far as an envelope: a call killed by --print-timeout never
    // does, and a 10-minute hang is exactly the attempt a user needs to see.
    const attemptMs: number[] = [];
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
        attemptMs.push(Date.now() - started);
        lastError = err instanceof Error ? err.message : String(err);
        // run() embeds the stderr tail in its rejection, so auth/bad-slug
        // failures are matchable here and fail fast instead of re-spending.
        if (isNonRetryableAgyFailure(lastError)) break;
        continue;
      }
      const elapsed = Date.now() - started;
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
        ms: elapsed,
      });
      if (envelope.status !== "SUCCESS") {
        attemptMs.push(elapsed);
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
        attemptMs.push(elapsed);
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(
      agyFailureMessage({
        bin: this.bin,
        schemaName: req.schemaName,
        lastError,
        attemptMs,
        printTimeout: AGY_PRINT_TIMEOUT,
      }),
    );
  }
}
