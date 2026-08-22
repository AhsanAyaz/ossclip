import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  AGY_PRINT_TIMEOUT,
  AgyError,
  agyErrorText,
  agyFailureMessage,
  AntigravityProvider,
  buildAgyArgs,
  classifyAgyFailure,
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

/**
 * An `agy` stub that fails the way real agy fails: the reason in the STDOUT
 * envelope, exit 1, NOTHING on stderr.
 *
 * Measured against agy 1.1.18 on 2026-08-22, and it is the correction of this
 * stub that exposed the bug — the old version wrote the reason to stderr,
 * which agy does not do, so the suite was green against a provider that could
 * not fail this way and blind to a failure path that never worked (§132).
 */
function stubAgyEnvelopeError(error: string): Stub {
  const out = JSON.stringify({
    conversation_id: "c1",
    status: "ERROR",
    response: "",
    error,
    duration_seconds: 0,
    num_turns: 1,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
  });
  return writeStub([
    `cat <<'EOF'\n${out}\nEOF`,
    "exit 1",
  ]);
}

/**
 * The OTHER surface: a process-level failure (a bad flag) exits 2 with usage
 * text on stderr and an empty stdout — measured the same day. Both surfaces
 * stay covered because a reader of only one is blind to half the failures.
 */
function stubAgyUsageError(stderrLine: string): Stub {
  return writeStub([`echo "${stderrLine}" >&2`, "exit 2"]);
}

/** Shared preamble: record the argv prompt and count the call, then act. */
function writeStub(body: string[]): Stub {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-stub-"));
  const prompts = join(dir, "prompts");
  const calls = join(dir, "calls");
  const script = [
    "#!/usr/bin/env bash",
    `printf '%s\\n${PROMPT_END}\\n' "$2" >> "${prompts}"`,
    `n=$(cat "${calls}" 2>/dev/null || echo 0)`,
    `echo $((n+1)) > "${calls}"`,
    ...body,
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

  it("retries a non-SUCCESS status, then reports the attempts — not a login guess", async () => {
    const stub = stubAgy(
      envelope({ status: "ERROR", error: "server exploded" }),
      envelope({ status: "ERROR", error: "server exploded again" }),
    );
    const provider = new AntigravityProvider(undefined, stub.bin);
    const err = await provider
      .complete({ system: "s", user: "u", schema, schemaName: "t" })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/server exploded again/);
    expect(err?.message).toMatch(/2 attempts/);
    // A server-side error says nothing about auth. Before 2026-08-22 this
    // message ended in "Is Antigravity installed and logged in?" regardless.
    expect(err?.message).not.toMatch(/logged in/);
    expect(callsOf(stub)).toBe(2);
  });

  it("fails fast on an authentication failure — one call, no retry", async () => {
    // The auth WORDING is inferred, not measured: establishing it would mean
    // signing the user out. The envelope SURFACE is measured, and both
    // measured failures use it, so this is where auth is expected to speak.
    const stub = stubAgyEnvelopeError("authentication required: run agy to sign in");
    const provider = new AntigravityProvider(undefined, stub.bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/sign in/);
    expect(callsOf(stub)).toBe(1);
  });

  it("fails fast on an unknown model slug — one call, no retry", async () => {
    // agy 1.1.18's real text, measured 2026-08-22. This is the case the old
    // stub got wrong: agy puts it in the envelope, not on stderr, so run()'s
    // rejection never carried the words "invalid model" and the documented
    // fail-fast had never actually fired — the retry burned a second
    // ~24k-token call every time (§132).
    const stub = stubAgyEnvelopeError(
      'invalid model selection (--model "gemini-9-ultra" --effort ""): ' +
        "model gemini-9-ultra is not recognized as a known model or custom model in settings",
    );
    const provider = new AntigravityProvider("gemini-9-ultra", stub.bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/invalid model selection.*gemini-9-ultra/s);
    expect(callsOf(stub)).toBe(1);
  });

  it("reads the OTHER surface too: exit 2 with usage text on stderr", async () => {
    // A bad flag never reaches the model, so there is no envelope to read —
    // measured as exit 2, empty stdout, usage text on stderr. Retryable (it
    // is not auth or a slug), and the text still has to reach the user.
    const stub = stubAgyUsageError("flags provided but not defined: -nonexistent-flag");
    const provider = new AntigravityProvider(undefined, stub.bin);
    const err = await provider
      .complete({ system: "s", user: "u", schema, schemaName: "t" })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/flags provided but not defined/);
    expect(callsOf(stub)).toBe(2);
    // Nothing was spent: a call that printed no envelope must not be booked
    // as an estimated ~24k-token call.
    expect(provider.usage).toHaveLength(0);
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

  it("buildAgyArgs adds --effort only when given — unset keeps agy's default (§143)", () => {
    // Exposed after the §143 hang incident: untested at real scale whether a
    // lower effort moves the hang, but the knob existed and we passed nothing.
    const withEffort = buildAgyArgs("PROMPT", { effort: "high", schemaJson: "{}" });
    expect(withEffort.slice(-2)).toEqual(["--effort", "high"]);
    // Omitted ENTIRELY when unset — not `--effort ""`, which agy would have
    // to interpret; the pre-knob argv must stay byte-identical.
    expect(buildAgyArgs("PROMPT", { schemaJson: "{}" })).not.toContain("--effort");
  });

  it("the constructor's effort reaches the spawned argv (§143)", async () => {
    // End-to-end through the ctor's options bag, not just buildAgyArgs: the
    // knob is only real if the spawn actually carries it. This stub records
    // the WHOLE argv — the shared ones keep only the prompt ($2).
    const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-stub-"));
    const argvFile = join(dir, "argv");
    const out = envelope({ structured_output: { title: "OK" } });
    const bin = join(dir, "agy");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvFile}"\ncat <<'EOF'\n${out}\nEOF`,
    );
    chmodSync(bin, 0o755);
    const provider = new AntigravityProvider(undefined, bin, { effort: "low" });
    await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    const argv = readFileSync(argvFile, "utf8").split("\n");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
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
    expect(isNonRetryableAgyFailure("authentication required: run agy to sign in")).toBe(true);
    // agy 1.1.18's measured wording — it matches the shipped patterns as-is.
    // The patterns were never the bug; the input was (§132).
    expect(isNonRetryableAgyFailure('invalid model selection (--model "gemini-9")')).toBe(true);
    expect(isNonRetryableAgyFailure("timeout waiting for response")).toBe(false);
  });

  it("reports a timeout as a timeout — attempts and clock, no login hint", async () => {
    // agy 1.1.18's real text when --print-timeout fires, measured 2026-08-22
    // by running agy with --print-timeout 2s: exit 1, this string in the
    // stdout envelope's `error`, stderr empty.
    const stub = stubAgyEnvelopeError("timeout waiting for response");
    const provider = new AntigravityProvider(undefined, stub.bin);
    const err = await provider
      .complete({ system: "s", user: "u", schema, schemaName: "beat_sheet" })
      .then(() => null)
      .catch((e: Error) => e);
    // The 2026-08-22 incident in one assertion: 25 minutes of hanging, then
    // "Is Antigravity installed and logged in?" on a working, logged-in agy.
    expect(err?.message).not.toMatch(/logged in/);
    expect(err?.message).toMatch(/timed out/);
    expect(err?.message).toMatch(new RegExp(`--print-timeout ${AGY_PRINT_TIMEOUT}`));
    // The escape hatch is another provider, or no planner at all.
    expect(err?.message).toMatch(/--llm claude-cli[\s\S]*--llm gemini[\s\S]*--produce/);
    // A timed-out call never succeeds on retry at this call size (measured
    // 2026-08-22: two 10m expiries, 20 minutes of wall clock for nothing), so
    // the second attempt no longer runs.
    expect(callsOf(stub)).toBe(1);
  });

  it("throws AgyError carrying the failure class as data, not prose", async () => {
    // The fallback decorator branches on `failureClass`; re-parsing the
    // message would couple it to wording that is free to change.
    const fail = async (stub: Stub, model?: string): Promise<unknown> =>
      new AntigravityProvider(model, stub.bin)
        .complete({ system: "s", user: "u", schema, schemaName: "t" })
        .then(() => null)
        .catch((e: unknown) => e);
    const timeout = await fail(stubAgyEnvelopeError("timeout waiting for response"));
    expect(timeout).toBeInstanceOf(AgyError);
    expect((timeout as AgyError).failureClass).toBe("timeout");
    const auth = await fail(stubAgyEnvelopeError("authentication required: run agy to sign in"));
    expect(auth).toBeInstanceOf(AgyError);
    expect((auth as AgyError).failureClass).toBe("auth");
  });
});

/**
 * Honest failure text (2026-08-22): a `--produce --aspect 16:9` run on an
 * 11-minute take timed out twice at AGY_PRINT_TIMEOUT, burned 25 minutes, and
 * died telling the user to check a login that was fine the whole time — the
 * sign-in hint was appended to every failure. Pure, so each class is
 * assertable without spawning agy.
 */
describe("agy failure classification", () => {
  // agy 1.1.18's own words, measured 2026-08-22 — see `agyErrorText`.
  const MEASURED_TIMEOUT = "timeout waiting for response";
  const MEASURED_BAD_MODEL =
    'invalid model selection (--model "definitely-not-a-real-model" --effort ""): ' +
    "model definitely-not-a-real-model is not recognized as a known model or custom model in settings";
  const errEnvelope = (error: string): string =>
    JSON.stringify({ conversation_id: "c1", status: "ERROR", response: "", error });

  it("reads the reason out of whichever surface agy used", () => {
    // Operational failures: the envelope, with stderr empty.
    expect(agyErrorText(errEnvelope(MEASURED_TIMEOUT), "")).toBe(MEASURED_TIMEOUT);
    expect(agyErrorText(errEnvelope(MEASURED_BAD_MODEL), "")).toBe(MEASURED_BAD_MODEL);
    // Process-level failures: stderr, with stdout empty (exit 2, bad flag).
    expect(agyErrorText("", "flags provided but not defined: -nope\nUsage of agy:")).toMatch(
      /flags provided but not defined/,
    );
    // A status with no error of its own still names itself.
    expect(agyErrorText(JSON.stringify({ status: "CANCELED" }), "")).toBe(
      "agy reported status CANCELED",
    );
    // Neither surface said anything: say THAT, rather than inventing a reason.
    expect(agyErrorText("", "")).toBe("agy printed nothing");
    expect(agyErrorText("<html>gateway error</html>", "")).toMatch(/no envelope/);
  });

  it("classifies each failure it can name", () => {
    // Measured.
    expect(classifyAgyFailure(MEASURED_TIMEOUT)).toBe("timeout");
    expect(classifyAgyFailure(MEASURED_BAD_MODEL)).toBe("model");
    // Inferred — the auth wording is not measurable without signing the user
    // out, so the patterns are the ones fail-fast has always used.
    expect(classifyAgyFailure("authentication required: run agy to sign in")).toBe("auth");
    // Best-effort alternatives: agy's wording is not a contract we control,
    // and an externally killed agy never speaks through the envelope at all.
    expect(classifyAgyFailure("the operation timed out")).toBe("timeout");
    expect(classifyAgyFailure("killed by SIGKILL")).toBe("timeout");
    // Ours: zod, and extractJsonObject.
    expect(classifyAgyFailure('[{"code":"invalid_type","path":["beats"]}]')).toBe("schema");
    expect(classifyAgyFailure("no JSON object in reply: sorry, I can't")).toBe("schema");
    // Everything else stays honestly unnamed rather than guessing.
    expect(classifyAgyFailure("server exploded")).toBe("unknown");
    expect(classifyAgyFailure("agy printed nothing")).toBe("unknown");
  });

  it("prints the attempt facts for every class, because they self-diagnose", () => {
    const facts = { bin: "agy", schemaName: "beat_sheet", attemptMs: [600_000, 600_000] };
    for (const lastError of [
      "authentication required",
      MEASURED_TIMEOUT,
      "server exploded",
      '[{"code":"too_small"}]',
    ]) {
      expect(
        agyFailureMessage({ ...facts, lastError, printTimeout: AGY_PRINT_TIMEOUT }),
      ).toContain("2 attempts, 10m0s and 10m0s, --print-timeout 10m.");
    }
  });

  it("gives the sign-in hint to an auth failure and to nothing else", () => {
    const facts = {
      bin: "agy",
      schemaName: "beat_sheet",
      attemptMs: [1_200],
      printTimeout: AGY_PRINT_TIMEOUT,
    };
    const auth = agyFailureMessage({ ...facts, lastError: "authentication required" });
    expect(auth).toContain("Is Antigravity installed and logged in?");
    expect(auth).toContain("1 attempt, 1.2s");
    for (const lastError of [MEASURED_TIMEOUT, "server exploded", MEASURED_BAD_MODEL]) {
      expect(agyFailureMessage({ ...facts, lastError })).not.toContain("logged in");
    }
  });

  it("points a timeout at the providers that can take the call instead", () => {
    const msg = agyFailureMessage({
      bin: "agy",
      schemaName: "beat_sheet",
      lastError: MEASURED_TIMEOUT,
      attemptMs: [600_000, 600_000],
      printTimeout: AGY_PRINT_TIMEOUT,
    });
    expect(msg).toMatch(/timed out/);
    // Same voice as the oversized-prompt refusal: name the way out.
    expect(msg).toContain("--llm claude-cli");
    expect(msg).toContain("GEMINI_API_KEY");
    expect(msg).toContain("--produce");
  });
});
