import type { z } from "zod/v4";
import type { CallTier, LlmProvider } from "./provider";
import type { LlmUsage } from "./usage";

/**
 * Routes each call to a model sized for the thinking it needs (FINDINGS §37).
 *
 * Producing a video is one editorial call — the beat sheet, where the hook and
 * the segmentation are decided — and a handful of mechanical ones that fill a
 * schema or repair a mishearing. Measured on the CLI path, a call costs ~$0.26
 * on the top model against ~$0.04 on the small one, and since the harness
 * prefix dominates the token count either way, the model is the only per-call
 * lever left once the calls themselves have been batched down.
 *
 * A wrapper rather than a flag inside each provider: the providers stay dumb
 * about policy, and any two of them compose — including two of DIFFERENT kinds,
 * which is what lets a subscription CLI do the editorial call while a metered
 * flash model does the mechanical ones.
 */
export class TieredProvider implements LlmProvider {
  readonly name: string;
  private readonly records: LlmUsage[] = [];

  constructor(
    private readonly editorial: LlmProvider,
    private readonly mechanical: LlmProvider,
  ) {
    this.name =
      editorial === mechanical ? editorial.name : `${editorial.name}+${mechanical.name}`;
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
    const target = req.tier === "mechanical" ? this.mechanical : this.editorial;
    const before = target.usage.length;
    try {
      return await target.complete(req);
    } finally {
      // Drain whatever the sub-provider logged, including for a call that
      // threw: a failed attempt still spent the tokens, and §37's whole point
      // is that the bill is visible rather than quietly absorbed.
      this.records.push(...target.usage.slice(before));
    }
  }
}
