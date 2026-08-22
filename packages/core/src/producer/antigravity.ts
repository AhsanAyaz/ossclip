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
 * agy's own print timeout defaults to 5m, which a beat-sheet call on a long
 * transcript can exceed. Core's `run()` has no timeout of its own, so this
 * flag is the ONLY clock on the spawn — without it a stuck call is a hang,
 * with it a timeout surfaces as retry-then-throw (FINDINGS §132, antigravity
 * provider).
 */
export const AGY_PRINT_TIMEOUT = "10m";

/**
 * agy takes the prompt as an argv argument only — no stdin — and macOS caps
 * ARG_MAX around 1MB. Refuse before the OS does: a pre-spawn check turns
 * E2BIG into a directed error naming providers that can take the prompt
 * (FINDINGS §132, antigravity provider).
 */
export const MAX_AGY_PROMPT_BYTES = 700_000;

/**
 * The argv for one `agy` print-mode call. Pure so the flag set is testable
 * without spawning anything. `--disable-slash-commands` because a transcript
 * prompt that happens to start with `/` must not expand as a skill.
 */
export function buildAgyArgs(
  prompt: string,
  opts: { model?: string; schemaJson: string },
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

  constructor(
    private model?: string,
    private bin: string = process.env.OSSCLIP_AGY_BIN ?? "agy",
  ) {}

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    const schemaText = JSON.stringify(z.toJSONSchema(req.schema));
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
          buildAgyArgs(prompt, { model: this.model, schemaJson: schemaText }),
          { allowNonZero: true },
        ));
      } catch (err) {
        // Only a spawn failure reaches here now: agy not on PATH, or not
        // executable. Nothing was spent, and no retry can install it.
        attemptMs.push(Date.now() - started);
        lastError = err instanceof Error ? err.message : String(err);
        if (isNonRetryableAgyFailure(lastError)) break;
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
        });
      }
      // SUCCESS is the envelope's own word for "this worked" (§132 lists the
      // status enum), and with non-zero exits resolving it is now the ONLY
      // success test — an exit code we no longer see cannot be one.
      if (envelope.status !== "SUCCESS") {
        attemptMs.push(elapsed);
        lastError = agyErrorText(stdout, stderr);
        if (isNonRetryableAgyFailure(lastError)) break;
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
    throw new Error(
      agyFailureMessage({
        bin: this.bin,
        schemaName: req.schemaName,
        lastError,
        attemptMs,
        printTimeout: AGY_PRINT_TIMEOUT,
      }),
    );
  }
}
