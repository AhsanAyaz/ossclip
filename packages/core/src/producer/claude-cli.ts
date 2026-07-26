import { z } from "zod/v4";
import { run } from "../exec";
import type { LlmProvider } from "./provider";

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
      try {
        const { stdout } = await run(this.bin, args, { stdin: prompt });
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
