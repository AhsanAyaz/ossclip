import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import type { LlmUsage } from "../src/producer/usage";
import { TieredProvider } from "../src/producer/tiered";
import { createTieredProvider, DEFAULT_FAST_MODEL } from "../src/producer/index";

/** Provider that records what it was asked and logs usage like a real one. */
class Spy implements LlmProvider {
  readonly usage: LlmUsage[] = [];
  readonly seen: string[] = [];
  constructor(readonly name: string, private fail = false) {}
  async complete<T>(req: { schema: z.ZodType<T>; schemaName: string }): Promise<T> {
    this.seen.push(req.schemaName);
    this.usage.push({
      provider: this.name,
      model: this.name,
      schemaName: req.schemaName,
      inputTokens: 10,
      outputTokens: 1,
      exact: true,
      billed: true,
      ms: 1,
    });
    if (this.fail) throw new Error("boom");
    return req.schema.parse({}) as T;
  }
}

const anySchema = { parse: (v: unknown) => v } as unknown as z.ZodType<unknown>;
const call = (p: LlmProvider, schemaName: string, tier?: "editorial" | "mechanical") =>
  p.complete({ system: "s", user: "u", schema: anySchema, schemaName, tier });

describe("model tiering (FINDINGS §37)", () => {
  it("routes mechanical calls to the fast provider and editorial to the main one", async () => {
    const strong = new Spy("strong");
    const fast = new Spy("fast");
    const tiered = new TieredProvider(strong, fast);
    await call(tiered, "beat_sheet", "editorial");
    await call(tiered, "transcript_repair", "mechanical");
    await call(tiered, "scene_props_batch", "mechanical");
    expect(strong.seen).toEqual(["beat_sheet"]);
    expect(fast.seen).toEqual(["transcript_repair", "scene_props_batch"]);
  });

  it("defaults an untagged call to the editorial model", async () => {
    const strong = new Spy("strong");
    const fast = new Spy("fast");
    await call(new TieredProvider(strong, fast), "mystery");
    expect(strong.seen).toEqual(["mystery"]);
    expect(fast.seen).toEqual([]);
  });

  it("merges usage from both providers in call order", async () => {
    const tiered = new TieredProvider(new Spy("strong"), new Spy("fast"));
    await call(tiered, "beat_sheet", "editorial");
    await call(tiered, "props", "mechanical");
    expect(tiered.usage.map((u) => u.provider)).toEqual(["strong", "fast"]);
  });

  it("still records usage when a call throws — the tokens were spent", async () => {
    const fast = new Spy("fast", true);
    const tiered = new TieredProvider(new Spy("strong"), fast);
    await expect(call(tiered, "props", "mechanical")).rejects.toThrow("boom");
    expect(tiered.usage).toHaveLength(1);
  });

  it("does not wrap when tiering would be a no-op", () => {
    // "same" is the opt-out, and an explicit fast model equal to the main one
    // has nothing to route.
    expect(createTieredProvider("mock", { fastModel: "same" })).not.toBeInstanceOf(TieredProvider);
    expect(createTieredProvider("mock")).not.toBeInstanceOf(TieredProvider);
    expect(
      createTieredProvider("claude", { model: "m", fastModel: "m" }),
    ).not.toBeInstanceOf(TieredProvider);
  });

  it("wraps by default for providers that have a cheaper sibling", () => {
    expect(createTieredProvider("claude-cli")).toBeInstanceOf(TieredProvider);
    expect(DEFAULT_FAST_MODEL["claude-cli"]).toBeTruthy();
    expect(DEFAULT_FAST_MODEL.gemini).toBeTruthy();
  });
});
