import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  AGY_PRINT_TIMEOUT,
  AntigravityProvider,
  buildAgyArgs,
  isNonRetryableAgyFailure,
  parseAgyEnvelope,
} from "../src/producer/antigravity";

const schema = z.object({ title: z.string().min(1) });

interface Stub {
  bin: string;
  prompts: string;
  calls: string;
}

// agy takes the prompt on argv ("-p" is $1, the prompt is $2), so the stub
// appends "$2" to a file per call — that is what makes argv delivery, and the
// content of the self-repair retry prompt, assertable.
const PROMPT_END = "<<<PROMPT-END>>>";

/** Writes an executable `agy` stub that plays the given stdout scripts call-by-call. */
function stubAgy(...stdoutPerCall: string[]): Stub {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-stub-"));
  const prompts = join(dir, "prompts");
  const calls = join(dir, "calls");
  const script = [
    "#!/usr/bin/env bash",
    `printf '%s\\n${PROMPT_END}\\n' "$2" >> "${prompts}"`,
    `n=$(cat "${calls}" 2>/dev/null || echo 0)`,
    `echo $((n+1)) > "${calls}"`,
    ...stdoutPerCall.map(
      (out, i) => `if [ "$n" -eq ${i} ]; then cat <<'EOF'\n${out}\nEOF\nexit 0; fi`,
    ),
    "exit 1",
  ].join("\n");
  const bin = join(dir, "agy");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, prompts, calls };
}

/** An `agy` stub that always exits 1 with the given stderr — the fail-fast cases. */
function stubAgyFailing(stderrLine: string): Stub {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-stub-"));
  const prompts = join(dir, "prompts");
  const calls = join(dir, "calls");
  const script = [
    "#!/usr/bin/env bash",
    `printf '%s\\n${PROMPT_END}\\n' "$2" >> "${prompts}"`,
    `n=$(cat "${calls}" 2>/dev/null || echo 0)`,
    `echo $((n+1)) > "${calls}"`,
    `echo "${stderrLine}" >&2`,
    "exit 1",
  ].join("\n");
  const bin = join(dir, "agy");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin, prompts, calls };
}

const promptsOf = (s: Stub): string[] =>
  readFileSync(s.prompts, "utf8").split(`\n${PROMPT_END}\n`).filter(Boolean);
const callsOf = (s: Stub): number =>
  existsSync(s.calls) ? Number(readFileSync(s.calls, "utf8").trim()) : 0;

const envelope = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    conversation_id: "c1",
    status: "SUCCESS",
    duration_seconds: 1,
    num_turns: 1,
    ...fields,
  });

describe("AntigravityProvider", () => {
  it("prefers structured_output over the prose response", async () => {
    const stub = stubAgy(
      envelope({
        response: 'Here you go: {"title": "FROM THE PROSE"}',
        structured_output: { title: "FROM THE SERVER" },
      }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FROM THE SERVER" });
  });

  it("falls back to fenced JSON in the response when structured_output is absent", async () => {
    const stub = stubAgy(
      envelope({ response: 'Sure! Here it is:\n```json\n{"title": "FENCED"}\n```' }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FENCED" });
  });

  it("self-repairs once when the first reply fails validation", async () => {
    const stub = stubAgy(
      envelope({ structured_output: { title: "" } }),
      envelope({ structured_output: { title: "FIXED" } }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FIXED" });
    // The retry spent tokens too — both attempts are on the record.
    expect(provider.usage).toHaveLength(2);
    const prompts = promptsOf(stub);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("failed validation");
  });

  it("retries a non-SUCCESS status, then throws sign-in guidance", async () => {
    const stub = stubAgy(
      envelope({ status: "ERROR", error: "server exploded" }),
      envelope({ status: "ERROR", error: "server exploded again" }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/Antigravity.*sign in/s);
    expect(callsOf(stub)).toBe(2);
  });

  it("fails fast on an authentication failure — one call, no retry", async () => {
    const stub = stubAgyFailing("authentication required: run agy to sign in");
    const provider = new AntigravityProvider(undefined, stub.bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/sign in/);
    expect(callsOf(stub)).toBe(1);
  });

  it("fails fast on an unknown model slug — one call, no retry", async () => {
    const stub = stubAgyFailing("Error: unknown model gemini-9-ultra");
    const provider = new AntigravityProvider("gemini-9-ultra", stub.bin);
    // run()'s rejection embeds the whole argv (the prompt rides argv) before
    // the stderr tail, so the sliced message may not show the slug — the
    // fail-fast proof is the call count.
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/Antigravity/);
    expect(callsOf(stub)).toBe(1);
  });

  it("maps the usage block into unbilled subscription usage", async () => {
    const stub = stubAgy(
      envelope({
        structured_output: { title: "COUNTED" },
        usage: {
          input_tokens: 900,
          output_tokens: 200,
          thinking_tokens: 50,
          cache_read_tokens: 100,
          total_tokens: 1250,
        },
      }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    await provider.complete({ system: "s", user: "u", schema, schemaName: "beat_sheet" });
    expect(provider.usage).toHaveLength(1);
    expect(provider.usage[0]).toMatchObject({
      schemaName: "beat_sheet",
      // The envelope names no model, so the record says what we know.
      model: "antigravity-default",
      inputTokens: 1000, // 900 + 100 cache reads: the total says input excludes them
      outputTokens: 250, // thinking folded into output-side spend
      cachedInputTokens: 100,
      exact: true,
      billed: false,
    });
  });

  it("does not double-count cache reads when input_tokens is cache-inclusive", () => {
    // input + output + thinking + cache_read (1350) exceeds the total (1250),
    // so input_tokens already contains the cache reads — use it alone.
    const parsed = parseAgyEnvelope(
      envelope({
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          thinking_tokens: 50,
          cache_read_tokens: 100,
          total_tokens: 1250,
        },
      }),
    );
    expect(parsed.inputTokens).toBe(1000);
    expect(parsed.cachedInputTokens).toBe(100);
  });

  it("estimates tokens when the envelope reports none, and says so", async () => {
    const stub = stubAgy(envelope({ response: '{"title": "NO USAGE BLOCK"}' }));
    const provider = new AntigravityProvider(undefined, stub.bin);
    await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(provider.usage[0]!.exact).toBe(false);
    expect(provider.usage[0]!.inputTokens).toBeGreaterThan(0);
  });

  it("buildAgyArgs carries the schema and adds --model only when given", () => {
    expect(buildAgyArgs("PROMPT", { schemaJson: '{"type":"object"}' })).toEqual([
      "-p",
      "PROMPT",
      "--output-format",
      "json",
      "--disable-slash-commands",
      "--json-schema",
      '{"type":"object"}',
      "--print-timeout",
      AGY_PRINT_TIMEOUT,
    ]);
    const withModel = buildAgyArgs("PROMPT", { model: "gemini-3.6-flash-low", schemaJson: "{}" });
    expect(withModel.slice(-2)).toEqual(["--model", "gemini-3.6-flash-low"]);
  });

  it("refuses an oversized prompt before spawning, naming the alternatives", async () => {
    const stub = stubAgy(envelope({ structured_output: { title: "NEVER REACHED" } }));
    const provider = new AntigravityProvider(undefined, stub.bin);
    await expect(
      provider.complete({
        system: "s",
        user: "x".repeat(800_000),
        schema,
        schemaName: "t",
      }),
    ).rejects.toThrow(/--llm claude-cli.*--llm gemini/s);
    // The guard is the whole point: the stub must never have been spawned.
    expect(callsOf(stub)).toBe(0);
  });

  it("parseAgyEnvelope never throws on a shape it does not recognise", () => {
    expect(parseAgyEnvelope("not json at all")).toEqual({});
    expect(parseAgyEnvelope("null")).toEqual({});
    expect(parseAgyEnvelope("[]")).toEqual({
      status: undefined,
      response: undefined,
      error: undefined,
      structuredOutput: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
    });
  });

  it("isNonRetryableAgyFailure matches the deterministic failures only", () => {
    expect(isNonRetryableAgyFailure("agy failed (exit 1):\nauthentication required")).toBe(true);
    expect(isNonRetryableAgyFailure("Error: unknown model gemini-9")).toBe(true);
    expect(isNonRetryableAgyFailure("print timeout exceeded")).toBe(false);
  });
});
