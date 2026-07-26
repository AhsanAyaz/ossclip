import type { z } from "zod/v4";

/**
 * The one seam between ossclip and any LLM. Implementations must return a
 * value that already validates against `schema` (they may use native
 * structured output or parse-and-validate); on failure they throw.
 * No provider types leak past this interface (PHASE1 §4).
 */
export interface LlmProvider {
  readonly name: string;
  complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens?: number;
  }): Promise<T>;
}

export type ProviderName = "claude" | "claude-cli" | "gemini" | "mock";
