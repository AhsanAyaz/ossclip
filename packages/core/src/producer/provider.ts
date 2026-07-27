import type { z } from "zod/v4";
import type { LlmUsage } from "./usage";

/**
 * The one seam between ossclip and any LLM. Implementations must return a
 * value that already validates against `schema` (they may use native
 * structured output or parse-and-validate); on failure they throw.
 * No provider types leak past this interface (PHASE1 §4).
 */
/**
 * Which kind of thinking a call needs.
 *
 * `editorial` is the beat sheet — picking the hook, segmenting the take,
 * writing the copy. That is the judgement the whole product rests on.
 * `mechanical` is everything else: repairing a mishearing, filling props
 * against a schema. Both are cheap to check and expensive to over-buy — on the
 * CLI path a call costs ~$0.26 on the top model and ~$0.04 on the small one,
 * and the harness prefix dominates either way (FINDINGS §37).
 */
export type CallTier = "editorial" | "mechanical";

export interface LlmProvider {
  readonly name: string;
  /**
   * One record per completed call, in call order — tokens and timing, never
   * money (pricing lives in `usage.ts`). Producing a video is a repair pass, a
   * beat sheet and one call per scene, so this is how a run answers "what did
   * that cost". Providers append; nobody else writes to it.
   */
  readonly usage: readonly LlmUsage[];
  complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens?: number;
    /** Defaults to `editorial` — a caller that says nothing gets the good model. */
    tier?: CallTier;
  }): Promise<T>;
}

export type ProviderName = "claude" | "claude-cli" | "gemini" | "mock";
