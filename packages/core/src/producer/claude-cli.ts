import { z } from "zod/v4";
import { run } from "../exec";
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
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(
      `claude CLI ('${this.bin}') did not produce valid ${req.schemaName} JSON: ${lastError.slice(0, 400)}\n` +
        `Is Claude Code installed and logged in? (npm i -g @anthropic-ai/claude-code; run 'claude' once to /login)`,
    );
  }
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
