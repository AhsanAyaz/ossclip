import { z } from "zod/v4";
import { run } from "../exec";
import { attemptFactsLine } from "./failure";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";

/**
 * Claude via the locally installed Claude Code CLI (`claude -p`) instead of
 * the metered API. Uses whatever auth the CLI holds — for Pro/Max subscribers
 * that's the subscription, so producing a video consumes plan usage rather
 * than pay-per-token API credits.
 *
 * Unlike the API path there is no server-enforced structured output, so the
 * schema is stated in the prompt and enforced here with zod, with one
 * self-repair retry before throwing (the caller adds its own fallback on top).
 *
 * Requirements: `claude` on PATH (or OSSCLIP_CLAUDE_BIN) and a logged-in
 * Claude Code (`claude` → /login). Each call pays ~1-2s of CLI startup.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli";
  readonly usage: LlmUsage[] = [];

  constructor(
    private model?: string,
    private bin: string = process.env.OSSCLIP_CLAUDE_BIN ?? "claude",
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
    /** Wall time of every failed attempt — see `claudeCliFailureMessage`. */
    const attemptMs: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? base
          : `${base}\n\nYour previous reply failed validation:\n${lastError}\nReturn ONLY the corrected JSON.`;
      const args = ["-p", "--output-format", "json", "--max-turns", "1"];
      if (this.model) args.push("--model", this.model);
      const started = Date.now();
      let stdout = "";
      try {
        ({ stdout } = await run(this.bin, args, { stdin: prompt }));
      } catch (err) {
        attemptMs.push(Date.now() - started);
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      // Recorded per ATTEMPT, before validation: a reply that failed the
      // schema still spent the tokens, and a retry is exactly the cost a user
      // would want to see rather than have quietly absorbed.
      const envelope = parseCliEnvelope(stdout);
      this.usage.push({
        provider: this.name,
        model: envelope.model ?? this.model,
        schemaName: req.schemaName,
        inputTokens: envelope.inputTokens ?? estimateTokens(prompt),
        outputTokens: envelope.outputTokens ?? estimateTokens(envelope.result ?? stdout),
        cachedInputTokens: envelope.cachedInputTokens,
        reportedCostUsd: envelope.costUsd,
        exact: envelope.inputTokens !== undefined,
        // The whole point of this provider: Pro/Max auth means the plan pays,
        // not a card. The cost is still reported, as what the same tokens
        // would have cost on the API.
        billed: false,
        ms: Date.now() - started,
      });
      try {
        return req.schema.parse(JSON.parse(extractJsonObject(unwrapCliEnvelope(stdout))));
      } catch (err) {
        attemptMs.push(Date.now() - started);
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(
      claudeCliFailureMessage({ bin: this.bin, schemaName: req.schemaName, lastError, attemptMs }),
    );
  }
}

/** What the failure text says went wrong. See `classifyClaudeCliFailure`. */
export type ClaudeCliFailureClass = "auth" | "model" | "timeout" | "schema" | "unknown";

/**
 * Classify a `claude -p` failure. Pure, and exported so each class is
 * assertable without spawning the CLI.
 *
 * Same disease as agy's (FINDINGS §132): the sign-in hint below used to be
 * appended to EVERY failure, so a bad model slug or a schema-repair loop told
 * the user to check a login that was fine. Same cure — classify, print the
 * attempt facts unconditionally, gate the advice.
 *
 * The surfaces are NOT the same, and this one was measured too (Claude Code,
 * 2026-08-22, a bad `--model` slug): exit 1, a machine-readable
 * `[claude-code:unrecognized_model] {…}` on STDERR, and a human sentence in
 * the stdout envelope's `result`. Because it uses stderr — and because the
 * prompt rides STDIN here, so `run()`'s rejection echoes a short argv rather
 * than the whole transcript — the rejection message this receives already
 * carries the reason, and no `allowNonZero` change is needed to see it.
 *
 * `auth` is inferred, not measured: establishing it would mean signing the
 * user out. Its patterns are widened only to things that cannot mean anything
 * else, so a real auth failure still gets the hint it always got.
 */
export function classifyClaudeCliFailure(message: string): ClaudeCliFailureClass {
  if (/invalid api key|authentication|not logged in|\/login|unauthorized|oauth/i.test(message))
    return "auth";
  if (/unrecognized_model|unknown model|invalid model|model .* not (found|recognized)/i.test(message))
    return "model";
  if (/timed? ?out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(message)) return "timeout";
  const schemaish = /no JSON object in reply|is not valid JSON|Unexpected (token|end of)|"code":\s*"/i;
  if (schemaish.test(message)) return "schema";
  return "unknown";
}

/**
 * The error thrown when both attempts failed. The attempt facts print for
 * every class because they self-diagnose regardless of the classification
 * (§132); the sign-in hint is gated to `auth`, and a model failure points at
 * the flag that actually caused it.
 */
export function claudeCliFailureMessage(parts: {
  bin: string;
  schemaName: string;
  lastError: string;
  attemptMs: readonly number[];
}): string {
  const cls = classifyClaudeCliFailure(parts.lastError);
  const headline =
    cls === "timeout"
      ? " — the call timed out"
      : cls === "schema"
        ? " — the reply never matched the schema"
        : "";
  const lines = [
    `claude CLI ('${parts.bin}') did not produce valid ${parts.schemaName} JSON${headline}: ` +
      (parts.lastError.trim().slice(0, 400) || "claude printed nothing"),
    attemptFactsLine(parts.attemptMs),
  ];
  if (cls === "auth") {
    lines.push(
      `Is Claude Code installed and logged in? (npm i -g @anthropic-ai/claude-code; run 'claude' once to /login)`,
    );
  }
  if (cls === "model") {
    lines.push(`Check the --llm-model slug, or drop it to use the CLI's own default model.`);
  }
  if (cls === "timeout") {
    lines.push(
      `Use --llm antigravity (a logged-in Antigravity subscription) or --llm gemini (needs GEMINI_API_KEY), ` +
        `or drop --produce to cut and caption without a planner.`,
    );
  }
  return lines.join("\n");
}

/**
 * The accounting half of the same envelope: tokens, cost and model, all
 * optional because the CLI's envelope shape is not ours to depend on. Every
 * field absent is a valid outcome — the caller falls back to estimates and
 * says so — so this never throws on a shape it doesn't recognise.
 */
export function parseCliEnvelope(stdout: string): {
  result?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
} {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!env || typeof env !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const u = (env.usage ?? {}) as Record<string, unknown>;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(u.cache_creation_input_tokens) ?? 0;
  const plainInput = num(u.input_tokens);
  // `modelUsage` is keyed by the model id actually served — more reliable than
  // the alias passed in with --model ("opus" resolves to a dated id).
  const modelUsage = (env.modelUsage ?? {}) as Record<string, unknown>;
  return {
    result: typeof env.result === "string" ? env.result : undefined,
    model: Object.keys(modelUsage)[0],
    inputTokens: plainInput === undefined ? undefined : plainInput + cacheRead + cacheWrite,
    outputTokens: num(u.output_tokens),
    cachedInputTokens: cacheRead + cacheWrite || undefined,
    costUsd: num(env.total_cost_usd),
  };
}

/** `claude -p --output-format json` wraps the reply in a result envelope. */
export function unwrapCliEnvelope(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const envelope = JSON.parse(trimmed) as { result?: unknown; is_error?: boolean };
    if (envelope && typeof envelope.result === "string") {
      if (envelope.is_error) throw new Error(`claude CLI errored: ${envelope.result.slice(0, 300)}`);
      return envelope.result;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("claude CLI errored")) throw err;
    // Not an envelope — fall through and treat stdout as the reply itself.
  }
  return trimmed;
}

/** Tolerate markdown fences / prose around the JSON object. */
export function extractJsonObject(text: string): string {
  const unfenced = text.replace(/```(?:json)?/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  return unfenced.slice(start, end + 1);
}
