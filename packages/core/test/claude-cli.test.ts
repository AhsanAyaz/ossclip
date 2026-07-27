import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  ClaudeCliProvider,
  extractJsonObject,
  parseCliEnvelope,
  unwrapCliEnvelope,
} from "../src/producer/claude-cli";

const schema = z.object({ title: z.string().min(1) });

/** Writes an executable stub that plays the given stdout scripts call-by-call. */
function stubClaude(...stdoutPerCall: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-claude-stub-"));
  const counter = join(dir, "calls");
  const script = [
    "#!/usr/bin/env bash",
    "cat > /dev/null", // consume the prompt on stdin
    `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
    `echo $((n+1)) > "${counter}"`,
    ...stdoutPerCall.map(
      (out, i) => `if [ "$n" -eq ${i} ]; then cat <<'EOF'\n${out}\nEOF\nexit 0; fi`,
    ),
    "exit 1",
  ].join("\n");
  const bin = join(dir, "claude");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

const envelope = (result: string): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

describe("ClaudeCliProvider", () => {
  it("parses a clean envelope reply", async () => {
    const bin = stubClaude(envelope('{"title": "FROM THE CLI"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FROM THE CLI" });
  });

  it("tolerates markdown fences and prose around the JSON", async () => {
    const bin = stubClaude(envelope('Sure! Here it is:\n```json\n{"title": "FENCED"}\n```'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FENCED" });
  });

  it("self-repairs once when the first reply fails validation", async () => {
    const bin = stubClaude(envelope('{"title": ""}'), envelope('{"title": "FIXED"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FIXED" });
  });

  it("throws with install/login guidance after two bad replies", async () => {
    const bin = stubClaude(envelope("not json at all"), envelope("still not json"));
    const provider = new ClaudeCliProvider(undefined, bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/logged in/);
  });

  it("surfaces CLI-side errors from the envelope", () => {
    expect(() =>
      unwrapCliEnvelope(JSON.stringify({ is_error: true, result: "usage limit reached" })),
    ).toThrow(/usage limit/);
  });

  it("extractJsonObject rejects reply with no object", () => {
    expect(() => extractJsonObject("no braces here")).toThrow(/no JSON object/);
  });

  it("records tokens and the CLI's own cost as unbilled subscription usage", async () => {
    // What a Claude Max run actually looks like: the plan pays, but the tokens
    // still say how much work the generation was (FINDINGS §36).
    const bin = stubClaude(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '{"title": "PAID BY THE PLAN"}',
        total_cost_usd: 0.1234,
        usage: {
          input_tokens: 900,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 220,
        },
        modelUsage: { "claude-opus-5-20260101": {} },
      }),
    );
    const provider = new ClaudeCliProvider(undefined, bin);
    await provider.complete({ system: "s", user: "u", schema, schemaName: "beat_sheet" });
    expect(provider.usage).toHaveLength(1);
    expect(provider.usage[0]).toMatchObject({
      schemaName: "beat_sheet",
      model: "claude-opus-5-20260101",
      inputTokens: 1000, // cached tokens folded in, and reported separately
      cachedInputTokens: 100,
      outputTokens: 220,
      reportedCostUsd: 0.1234,
      exact: true,
      billed: false,
    });
  });

  it("counts a self-repair retry as a second call — the tokens were spent", async () => {
    const bin = stubClaude(envelope('{"title": ""}'), envelope('{"title": "FIXED"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(provider.usage).toHaveLength(2);
  });

  it("estimates tokens when the envelope reports none, and says so", async () => {
    const bin = stubClaude(envelope('{"title": "NO USAGE BLOCK"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(provider.usage[0]!.exact).toBe(false);
    expect(provider.usage[0]!.inputTokens).toBeGreaterThan(0);
  });

  it("parseCliEnvelope never throws on a shape it does not recognise", () => {
    expect(parseCliEnvelope("not json")).toEqual({});
    expect(parseCliEnvelope("[]")).toEqual({
      result: undefined,
      model: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
      costUsd: undefined,
    });
  });
});
