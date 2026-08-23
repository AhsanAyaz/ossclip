import { z } from "zod/v4";
import { run } from "../exec";
import { attemptFactsLine } from "./failure";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";
// Shared fence-stripper for replies that wrap the JSON in prose/markdown.
// A formatting concern, not a Claude dependency (FINDINGS §132, antigravity
// provider).
import { extractJsonObject } from "./claude-cli";

/**
 * Core's `run()` has no timeout of its own, so this flag is the ONLY clock on
 * the spawn — without it a stuck call is a hang, with it a timeout surfaces as
 * a fall back to the next provider (FINDINGS §132, §143).
 *
 * This is a RECOVERY DEADLINE, not a patience allowance (§149). It was 10m on
 * the theory that a big beat sheet might legitimately need it; the theory was
 * wrong twice over. agy's hang is intermittent and service-side — §143 probed
 * a 95,030-token call that answered in 17.6s — so a call that has said nothing
 * for 90s is not working slowly, it is hung. And what rescues it is the
 * fallback, which costs seconds. Waiting 10m to start a 5s recovery cost one
 * field run 605.9s of dead air on a 96-second video (2026-08-23: 692s total
 * for ~86s of real work).
 *
 * 90s is 2x the slowest healthy call ever measured (46s) and below agy's own
 * 5m default. Go duration format, verified against `agy --help` ("default
 * 5m0s"). Raise it only for a call measured to SUCCEED slower than this.
 */
export const AGY_PRINT_TIMEOUT = "90s";

/**
 * agy takes the prompt as an argv argument only — no stdin — and macOS caps
 * ARG_MAX around 1MB. Refuse before the OS does: a pre-spawn check turns
 * E2BIG into a directed error naming providers that can take the prompt
 * (FINDINGS §132, antigravity provider).
 */
export const MAX_AGY_PROMPT_BYTES = 700_000;

/**
 * Remove the constraints agy would REJECT a whole generation over and we can
 * absorb ourselves (§151).
 *
 * agy does not constrain decoding — it generates, validates server-side
 * against the schema we hand it, and on failure regenerates. Captured from a
 * real call:
 *
 *   "error": "invalid arguments:\n- at '/hook': maxLength: got 136, want 120"
 *
 * Sixteen characters over, and the whole attempt is discarded. `maxLength`
 * buys nothing there, because `cappedText` already truncates an overshoot at a
 * word boundary — so the cap on the wire could only ever cost a generation,
 * never save one.
 *
 * SCOPE, stated because the obvious guess is wrong: this is NOT why agy times
 * out. That was the theory this function was written under, and it was
 * refuted by replaying the exact failing beat-sheet request standalone — with
 * maxLength stripped it still timed out, and with `--json-schema` dropped
 * ENTIRELY it still timed out, agy's own error being "timeout waiting for
 * response" with an empty body. The hang is upstream and prompt-triggered
 * (§143, §149); this only removes one real-but-separate way a generation gets
 * thrown away.
 *
 * `maxItems`, `enum`, `const`, `type` and `required` all stay: a 25th moment
 * or an invented sceneKind is not something truncation can quietly repair, and
 * that is the part of the contract worth paying a retry for.
 *
 * Only agy needs this. claude-cli receives the schema as prompt text, and
 * gemini constrains during decoding, so neither turns a long string into a
 * discarded generation.
 */
export function stripAbsorbableCaps(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAbsorbableCaps);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema as Record<string, unknown>)
        .filter(([k]) => k !== "maxLength")
        .map(([k, v]) => [k, stripAbsorbableCaps(v)]),
    );
  }
  return schema;
}

/**
 * agy's `--effort` levels. Exposed after the §143 hang incident (2026-08-22):
 * untested at real scale whether a lower effort moves the hang, but the knob
 * existed and we passed nothing — every call ran at agy's default with no way
 * to try anything else.
 */
export type LlmEffort = "low" | "medium" | "high";

/**
 * The argv for one `agy` print-mode call. Pure so the flag set is testable
 * without spawning anything. `--disable-slash-commands` because a transcript
 * prompt that happens to start with `/` must not expand as a skill.
 */
export function buildAgyArgs(
  prompt: string,
  opts: { model?: string; effort?: LlmEffort; schemaJson: string },
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--json-schema",
    opts.schemaJson,
    "--print-timeout",
    AGY_PRINT_TIMEOUT,
    ...(opts.model ? ["--model", opts.model] : []),
    // Omitted entirely when unset — agy's own default stands, exactly as it
    // did before the knob existed (§143).
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];
}

/**
 * The agy JSON envelope, tolerated rather than trusted: every field absent is
 * a valid outcome — the caller falls back to estimates and says so — so this
 * never throws on a shape it doesn't recognise (same contract as
 * `parseCliEnvelope`).
 *
 * Token mapping into `LlmUsage` terms:
 *   - `outputTokens` folds `thinking_tokens` in: thinking is output-side
 *     spend and LlmUsage has no thinking field of its own.
 *   - Whether `input_tokens` already includes cache reads is not documented,
 *     so it is cross-checked against `total_tokens`: if
 *     input + output + thinking + cache_read exceeds the total, input is
 *     already cache-inclusive and stands alone; otherwise cache reads are
 *     added. Worst case is a conservative over-count — the safe direction
 *     for a number a user might budget against (FINDINGS §132, antigravity
 *     provider).
 */
export function parseAgyEnvelope(stdout: string): {
  status?: string;
  response?: string;
  error?: string;
  structuredOutput?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
} {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!env || typeof env !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const u = (env.usage ?? {}) as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const thinking = num(u.thinking_tokens) ?? 0;
  const cacheRead = num(u.cache_read_tokens) ?? 0;
  const total = num(u.total_tokens);
  const cacheInclusive =
    input !== undefined && total !== undefined
      ? input + (output ?? 0) + thinking + cacheRead > total
      : false;
  return {
    status: str(env.status),
    response: str(env.response),
    error: str(env.error),
    structuredOutput: env.structured_output,
    inputTokens: input === undefined ? undefined : cacheInclusive ? input : input + cacheRead,
    outputTokens: output === undefined ? undefined : output + thinking,
    cachedInputTokens: cacheRead || undefined,
  };
}

/**
 * Failures a retry cannot fix: missing auth and a bad model slug are
 * deterministic, and each retry burns another ~24k-token baseline call (agy's
 * own agent context) for nothing (FINDINGS §132, antigravity provider).
 *
 * The patterns were always right; the INPUT was wrong. Until 2026-08-22 this
 * was handed `run()`'s rejection, and the contract §132 claimed for it — "the
 * stderr tail is embedded, so auth/bad-slug are matchable here" — is false for
 * real agy: a bad slug exits 1 with `invalid model selection …` in the STDOUT
 * envelope and NOTHING on stderr (measured, 1.1.18). So the message this saw
 * was our own echoed argv, which contains the slug but never the words
 * "invalid model", and the documented fail-fast has never once fired in the
 * field. It is now given `agyErrorText()` — the envelope's own error — which
 * matches the shipped patterns as measured, with no pattern change at all.
 *
 * That is a real behaviour change (a bad slug now costs one call, not two),
 * taken deliberately: it makes the code do what this comment has always said
 * it does, rather than changing what it should do.
 */
export function isNonRetryableAgyFailure(message: string): boolean {
  return /authentication|not logged in|login|unknown model|invalid model/i.test(message);
}

/**
 * What actually went wrong, out of the two surfaces agy uses — measured
 * against agy 1.1.18 on 2026-08-22, because none of it is documented:
 *
 *   print timeout fires  exit 1  stdout `{"status":"ERROR","error":"timeout
 *                                waiting for response",…}`   stderr empty
 *   unknown model slug   exit 1  stdout `{"status":"ERROR","error":"invalid
 *                                model selection (--model …)…"}`  stderr empty
 *   bad flag / usage     exit 2  stdout empty                 stderr usage text
 *
 * So the operational failures speak through the ENVELOPE and the process-level
 * ones through stderr, and a reader of only one surface is blind to half of
 * them. Preference order follows that: the envelope's own `error` first (it is
 * agy's sentence about its own failure), then stderr for the exits that never
 * reached the envelope, then the bare status, then whatever stdout held.
 *
 * Pure, and exported so the surfaces are testable without spawning agy. agy's
 * wording is not a contract we control — only the two surfaces are — which is
 * why callers classify loosely and print the raw text either way.
 */
export function agyErrorText(stdout: string, stderr: string): string {
  const env = parseAgyEnvelope(stdout);
  if (env.error?.trim()) return env.error.trim();
  if (stderr.trim()) return stderr.trim().slice(-2000);
  if (env.status) return `agy reported status ${env.status}`;
  if (stdout.trim()) return `agy replied with no envelope: ${stdout.trim().slice(0, 300)}`;
  return "agy printed nothing";
}

/** What the failure text says actually went wrong. See `classifyAgyFailure`. */
export type AgyFailureClass = "auth" | "model" | "timeout" | "schema" | "unknown";

/**
 * Classify a failure so the error can say what happened instead of guessing.
 * Pure and exported so every class is assertable without spawning agy. The
 * input is `agyErrorText()` — agy's own sentence — not `run()`'s rejection.
 *
 * The incident (2026-08-22, FINDINGS §132): a `--produce --aspect 16:9` run on
 * an 11-minute take timed out twice at AGY_PRINT_TIMEOUT — 10m each, 25
 * minutes burned — and then died with "Is Antigravity installed and logged
 * in?", while agy was installed, logged in and working. The hint was appended
 * unconditionally, so every failure was reported as an auth failure and this
 * one sent the user to debug auth after a 25-minute wait.
 *
 * Anchors, and how much each is worth:
 *  - `timeout` and `model` are MEASURED (agy 1.1.18): "timeout waiting for
 *    response" and "invalid model selection (--model …)". The looser
 *    alternatives stay beside them because the exact strings are agy's to
 *    change without telling us — and because an externally killed agy (a
 *    signal, not agy's own clock) surfaces differently again.
 *  - `auth` is INFERRED, not measured: establishing it would mean signing the
 *    user out. Its patterns are exactly the ones `isNonRetryableAgyFailure`
 *    has always used, so an auth failure can never classify worse than it did
 *    before this change, and both measured samples put operational reasons in
 *    the same envelope field, so there is no reason to expect auth elsewhere.
 *  - `schema` matches what OUR OWN code leaves in `lastError` — `extractJson-
 *    Object`'s message, JSON.parse's, and zod's issue array.
 *
 * A miss costs the headline and the class-gated advice, never the facts: the
 * attempt line below prints for every class, and it is what actually
 * self-diagnoses a hang.
 */
export function classifyAgyFailure(message: string): AgyFailureClass {
  if (/authentication|not logged in|login/i.test(message)) return "auth";
  if (/unknown model|invalid model/i.test(message)) return "model";
  if (/timed? ?out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(message)) return "timeout";
  const schemaish = /no JSON object in reply|is not valid JSON|Unexpected (token|end of)|"code":\s*"/i;
  if (schemaish.test(message)) return "schema";
  return "unknown";
}

/**
 * The error thrown when every attempt failed. Pure so the wording is testable
 * without spawning agy, and built around one rule learned from the 2026-08-22
 * incident: the ATTEMPT FACTS print for every class, because they self-diagnose
 * regardless of what the classifier decided. "2 attempts, 10m0s and 10m0s,
 * --print-timeout 10m" tells a user the call hung better than any guess we
 * could make, and it stays true when the guess is wrong.
 *
 * Guidance, by contrast, is class-gated: the sign-in hint only for `auth`, and
 * for `timeout` the actual escape hatch — another provider, or no planner at
 * all — named the way the oversized-prompt error above names them.
 */
export function agyFailureMessage(parts: {
  bin: string;
  schemaName: string;
  lastError: string;
  /** Wall time of every attempt that ran, in order. */
  attemptMs: readonly number[];
  printTimeout: string;
}): string {
  const cls = classifyAgyFailure(parts.lastError);
  const headline =
    cls === "timeout"
      ? " — the call timed out"
      : cls === "schema"
        ? " — the reply never matched the schema"
        : "";
  const detail = parts.lastError.trim().slice(0, 400) || "agy printed nothing";
  const lines = [
    `agy CLI ('${parts.bin}') did not produce valid ${parts.schemaName} JSON${headline}: ${detail}`,
    attemptFactsLine(parts.attemptMs, `--print-timeout ${parts.printTimeout}`),
  ];
  if (cls === "auth") {
    lines.push(
      `Is Antigravity installed and logged in? (https://antigravity.google — run 'agy' once interactively to sign in)`,
    );
  }
  if (cls === "timeout") {
    lines.push(
      `A long take can outrun agy's ${parts.printTimeout} print timeout. ` +
        `Use --llm claude-cli (a logged-in Claude Code subscription) or --llm gemini (needs GEMINI_API_KEY), ` +
        `or drop --produce to cut and caption without a planner.`,
    );
  }
  return lines.join("\n");
}

/**
 * The provider's terminal error, carrying the failure class as DATA. The
 * message is written for humans and free to reword; a provider-fallback
 * decorator that branches on what failed must read `failureClass`, never
 * re-parse the prose.
 */
export class AgyError extends Error {
  constructor(
    message: string,
    readonly failureClass: AgyFailureClass,
  ) {
    super(message);
    this.name = "AgyError";
  }
}

/**
 * Google Antigravity via the locally installed `agy` CLI. Uses whatever auth
 * the CLI holds — a logged-in subscription, so producing a video consumes
 * plan usage rather than pay-per-token API credits (`billed: false`, and agy
 * reports no cost of its own).
 *
 * The schema rides twice: `--json-schema` for server-side enforcement AND
 * stated in the prompt — the prompt copy is what makes the self-repair retry
 * meaningful, and server enforcement is not our contract, so the reply is
 * still zod-validated here.
 *
 * Requirements: `agy` on PATH (or OSSCLIP_AGY_BIN) and a prior interactive
 * sign-in. The envelope carries no model id, so usage records the requested
 * model or "antigravity-default" (FINDINGS §132, antigravity provider).
 */
export class AntigravityProvider implements LlmProvider {
  readonly name = "antigravity";
  readonly usage: LlmUsage[] = [];

  // A trailing options bag rather than a fourth positional: every existing
  // `new AntigravityProvider(model, bin)` call site keeps compiling unchanged.
  constructor(
    private model?: string,
    private bin: string = process.env.OSSCLIP_AGY_BIN ?? "agy",
    private opts: { effort?: LlmEffort } = {},
  ) {}

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    // Stripped before it goes on the wire (§151) — agy validates against this
    // after generating, and a length overshoot costs the whole attempt.
    const schemaText = JSON.stringify(stripAbsorbableCaps(z.toJSONSchema(req.schema)));
    const base =
      `${req.system}\n\n${req.user}\n\n` +
      `Respond with ONLY a JSON object valid against this JSON Schema ("${req.schemaName}"). ` +
      `No markdown fences, no commentary, no tool use — just the JSON:\n${schemaText}`;

    let lastError = "";
    // Wall time of every attempt that FAILED, in order — the facts the final
    // error reports. Kept separately from `usage`, which only records attempts
    // that got as far as an envelope: a call killed by --print-timeout never
    // does, and a 10-minute hang is exactly the attempt a user needs to see.
    const attemptMs: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? base
          : `${base}\n\nYour previous reply failed validation:\n${lastError}\nReturn ONLY the corrected JSON.`;
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > MAX_AGY_PROMPT_BYTES) {
        throw new Error(
          `prompt is ${promptBytes.toLocaleString("en-US")} bytes, over the ${MAX_AGY_PROMPT_BYTES.toLocaleString("en-US")}-byte limit for agy — ` +
            `it accepts the prompt only as a command-line argument. ` +
            `Use --llm claude-cli or --llm gemini for a take this long.`,
        );
      }
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      try {
        // allowNonZero, and it is load-bearing: agy reports its operational
        // failures as exit 1 with the reason in the STDOUT envelope and
        // nothing on stderr (measured 1.1.18 — see `agyErrorText`). run()'s
        // default reject path keeps only the stderr tail, so it threw away
        // every one of those reasons and handed this loop our own echoed
        // argv instead. Resolving non-zero exits and reading the envelope is
        // what makes both the message AND the fail-fast work.
        ({ stdout, stderr } = await run(
          this.bin,
          buildAgyArgs(prompt, {
            model: this.model,
            effort: this.opts.effort,
            schemaJson: schemaText,
          }),
          { allowNonZero: true },
        ));
      } catch (err) {
        // Only a spawn failure reaches here now: agy not on PATH, or not
        // executable. Nothing was spent, and no retry can install it.
        attemptMs.push(Date.now() - started);
        lastError = err instanceof Error ? err.message : String(err);
        if (isNonRetryableAgyFailure(lastError)) break;
        // An externally killed spawn (SIGTERM/SIGKILL) classifies as timeout,
        // and is as persistent as an expired --print-timeout — same fail-fast
        // as the envelope path below.
        if (classifyAgyFailure(lastError) === "timeout") break;
        continue;
      }
      const elapsed = Date.now() - started;
      // Recorded per ATTEMPT, before validation: a reply that failed the
      // schema still spent the tokens, and a retry is exactly the cost a user
      // would want to see rather than have quietly absorbed.
      const envelope = parseAgyEnvelope(stdout);
      // Gated on stdout now that non-zero exits resolve: a call that printed
      // NOTHING never reached the model (exit 2, a usage error) and must not
      // be booked as an estimated ~24k-token call. Anything that did reply —
      // including an ERROR envelope reporting zeros — is still recorded.
      if (stdout.trim()) {
        this.usage.push({
          provider: this.name,
          // The envelope names no model, so record what was asked for — or the
          // honest placeholder, which the cost report declines to price.
          model: this.model ?? "antigravity-default",
          schemaName: req.schemaName,
          inputTokens: envelope.inputTokens ?? estimateTokens(prompt),
          outputTokens: envelope.outputTokens ?? estimateTokens(envelope.response ?? stdout),
          cachedInputTokens: envelope.cachedInputTokens,
          exact: envelope.inputTokens !== undefined,
          // The whole point of this provider: agy's cached sign-in means the
          // subscription pays, not a card, and agy reports no cost to forward.
          billed: false,
          ms: elapsed,
          // The envelope's own verdict (§143): a failed attempt's cost stays
          // visible, but attribution (the production.json stamp) skips it.
          failed: envelope.status !== "SUCCESS" || undefined,
        });
      }
      // SUCCESS is the envelope's own word for "this worked" (§132 lists the
      // status enum), and with non-zero exits resolving it is now the ONLY
      // success test — an exit code we no longer see cannot be one.
      if (envelope.status !== "SUCCESS") {
        attemptMs.push(elapsed);
        lastError = agyErrorText(stdout, stderr);
        if (isNonRetryableAgyFailure(lastError)) break;
        // A timed-out call never succeeds on retry at this call size —
        // measured 2026-08-22: a ~63k-token beat-sheet call expired at the
        // 10m --print-timeout twice in a row, so the second attempt only
        // doubled the wall clock to 20 minutes. Fail fast; the escape hatch
        // is another provider, not the same call again.
        if (classifyAgyFailure(lastError) === "timeout") break;
        continue;
      }
      try {
        // Prefer the server-parsed object, but still validate it — schema
        // enforcement on their side is not a contract on ours.
        if (envelope.structuredOutput !== undefined) {
          return req.schema.parse(envelope.structuredOutput);
        }
        return req.schema.parse(JSON.parse(extractJsonObject(envelope.response ?? stdout)));
      } catch (err) {
        attemptMs.push(elapsed);
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new AgyError(
      agyFailureMessage({
        bin: this.bin,
        schemaName: req.schemaName,
        lastError,
        attemptMs,
        printTimeout: AGY_PRINT_TIMEOUT,
      }),
      classifyAgyFailure(lastError),
    );
  }
}
