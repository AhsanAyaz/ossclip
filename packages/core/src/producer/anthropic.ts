import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import type { LlmProvider } from "./provider";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

/**
 * Claude via the official SDK with schema-constrained structured output.
 * Auth: ANTHROPIC_API_KEY env (SDK default resolution).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "claude";
  private client: Anthropic;

  constructor(
    private model: string = DEFAULT_CLAUDE_MODEL,
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens?: number;
  }): Promise<T> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { format: zodOutputFormat(req.schema) },
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`claude declined the request (${response.stop_details?.category ?? "unspecified"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("claude output truncated at max_tokens");
    }
    if (response.parsed_output == null) {
      throw new Error("claude returned no parseable structured output");
    }
    return response.parsed_output as T;
  }
}
