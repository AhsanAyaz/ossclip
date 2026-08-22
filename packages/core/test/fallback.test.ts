import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import { AgyError, type AgyFailureClass } from "../src/producer/antigravity";
import { FallbackProvider, type FallbackInfo } from "../src/producer/fallback";
import type { LlmProvider } from "../src/producer/provider";
import type { LlmUsage } from "../src/producer/usage";
import { TieredProvider } from "../src/producer/tiered";
import { createTieredProvider, fallbackProviderName } from "../src/producer/index";

/**
 * The §143 timeout fallback (2026-08-22): agy is healthy at small scale and
 * hangs persistently on the real beat-sheet call — 10-minute --print-timeout
 * expiries while claude-cli planned the same video. The decorator must fall
 * back on exactly that class and nothing else, out loud, with usage records
 * that say who really made each call.
 */

/** Provider that records what it was asked and logs usage like a real one. */
class Spy implements LlmProvider {
  readonly usage: LlmUsage[] = [];
  readonly seen: string[] = [];
  constructor(
    readonly name: string,
    private readonly failWith?: Error,
  ) {}
  async complete<T>(req: { schema: z.ZodType<T>; schemaName: string }): Promise<T> {
    this.seen.push(req.schemaName);
    this.usage.push({
      provider: this.name,
      model: this.name,
      schemaName: req.schemaName,
      inputTokens: 10,
      outputTokens: 1,
      exact: true,
      billed: false,
      ms: 1,
    });
    if (this.failWith) throw this.failWith;
    return req.schema.parse({ by: this.name }) as T;
  }
}

const anySchema = { parse: (v: unknown) => v } as unknown as z.ZodType<unknown>;
const call = (p: LlmProvider, schemaName: string) =>
  p.complete({ system: "s", user: "u", schema: anySchema, schemaName });

const timeoutError = () =>
  new AgyError(
    "agy CLI ('agy') did not produce valid clip_beat_sheet JSON — the call timed out: timeout waiting for response\n1 attempt: 10m0s (--print-timeout 10m)",
    "timeout",
  );

describe("FallbackProvider (2026-08-22, FINDINGS §143)", () => {
  it("a primary timeout falls back once, out loud, and returns the fallback's answer", async () => {
    const primary = new Spy("antigravity", timeoutError());
    const backup = new Spy("claude-cli");
    const infos: FallbackInfo[] = [];
    const p = new FallbackProvider(primary, backup, (i) => infos.push(i));
    await expect(call(p, "clip_beat_sheet")).resolves.toEqual({ by: "claude-cli" });
    expect(backup.seen).toEqual(["clip_beat_sheet"]);
    expect(infos).toEqual([
      {
        from: "antigravity",
        to: "claude-cli",
        schemaName: "clip_beat_sheet",
        // First line only — the announcement wants the sentence, not the
        // multi-line guidance agyFailureMessage appends.
        detail:
          "agy CLI ('agy') did not produce valid clip_beat_sheet JSON — the call timed out: timeout waiting for response",
      },
    ]);
  });

  it("auth/model/schema/unknown classes keep failing fast — no fallback call", async () => {
    for (const cls of ["auth", "model", "schema", "unknown"] as AgyFailureClass[]) {
      const backup = new Spy("claude-cli");
      const infos: FallbackInfo[] = [];
      const p = new FallbackProvider(
        new Spy("antigravity", new AgyError("nope", cls)),
        backup,
        (i) => infos.push(i),
      );
      // Propagates UNCHANGED — the class-gated guidance in the message is
      // exactly what the user must still see.
      await expect(call(p, "beat_sheet")).rejects.toMatchObject({
        name: "AgyError",
        message: "nope",
        failureClass: cls,
      });
      expect(backup.seen).toEqual([]);
      expect(infos).toEqual([]);
    }
  });

  it("a plain Error is not a timeout — rethrown, no fallback", async () => {
    const backup = new Spy("claude-cli");
    const p = new FallbackProvider(new Spy("antigravity", new Error("boom")), backup);
    await expect(call(p, "beat_sheet")).rejects.toThrow("boom");
    expect(backup.seen).toEqual([]);
  });

  it("usage keeps both providers' records, each attributed to who really called", async () => {
    const p = new FallbackProvider(new Spy("antigravity", timeoutError()), new Spy("claude-cli"));
    await call(p, "clip_beat_sheet");
    expect(p.usage.map((u) => u.provider)).toEqual(["antigravity", "claude-cli"]);
  });

  it("exactly one fallback attempt — a failing fallback propagates", async () => {
    const primary = new Spy("antigravity", timeoutError());
    const backup = new Spy("claude-cli", new Error("backup down"));
    const p = new FallbackProvider(primary, backup);
    await expect(call(p, "clip_beat_sheet")).rejects.toThrow("backup down");
    expect(primary.seen).toHaveLength(1);
    expect(backup.seen).toHaveLength(1);
    // The failed attempts still spent the tokens (same rule as tiered.ts).
    expect(p.usage.map((u) => u.provider)).toEqual(["antigravity", "claude-cli"]);
  });

  it("keeps the primary's name — the detection line already announced it", () => {
    const p = new FallbackProvider(new Spy("antigravity"), new Spy("claude-cli"));
    expect(p.name).toBe("antigravity");
  });
});

describe("fallbackProviderName (2026-08-22, FINDINGS §143)", () => {
  const hasOnly =
    (...bins: string[]) =>
    (bin: string) =>
      bins.includes(bin);

  it("antigravity with the claude CLI installed falls back to claude-cli", () => {
    expect(fallbackProviderName("antigravity", {}, hasOnly("claude"))).toBe("claude-cli");
  });

  it("the OSSCLIP_CLAUDE_BIN override is what reaches the checker", () => {
    expect(
      fallbackProviderName("antigravity", { OSSCLIP_CLAUDE_BIN: "/custom/claude" }, hasOnly("/custom/claude")),
    ).toBe("claude-cli");
  });

  it("no claude CLI + GEMINI_API_KEY falls back to gemini", () => {
    expect(fallbackProviderName("antigravity", { GEMINI_API_KEY: "g" }, hasOnly())).toBe("gemini");
  });

  it("neither escape hatch means no fallback — the agy error must surface", () => {
    expect(fallbackProviderName("antigravity", {}, hasOnly())).toBeUndefined();
  });

  it("only antigravity gets a fallback — the one provider measured to hang", () => {
    expect(fallbackProviderName("claude-cli", { GEMINI_API_KEY: "g" }, hasOnly("claude"))).toBeUndefined();
  });
});

describe("createTieredProvider fallback wiring (§143)", () => {
  // Structural, not behavioral — same pragmatism as the tiered wiring tests:
  // constructing an AntigravityProvider spawns nothing, so instanceof is a
  // spawn-free proof of who wraps whom.
  it("wraps the editorial antigravity provider when a fallback is named", () => {
    expect(
      createTieredProvider("antigravity", { fallback: "mock", fastModel: "same" }),
    ).toBeInstanceOf(FallbackProvider);
    // With tiering on, the fallback wrap sits inside the tiered one.
    expect(createTieredProvider("antigravity", { fallback: "mock" })).toBeInstanceOf(TieredProvider);
  });

  it("does not wrap without a fallback, or for a non-antigravity primary", () => {
    expect(createTieredProvider("antigravity", { fastModel: "same" })).not.toBeInstanceOf(
      FallbackProvider,
    );
    expect(
      createTieredProvider("claude-cli", { fallback: "mock", fastModel: "same" }),
    ).not.toBeInstanceOf(FallbackProvider);
  });
});
