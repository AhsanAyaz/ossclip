import { z } from "zod/v4";
import { defaultProviderName, providerOfLog, type ProviderName } from "@ossclip/core";
import { lastFlagValue } from "./thumbnail-panel";

/**
 * Which LLM provider the publish panel's caption regenerate should call
 * (2026-08-29), pure so the usage-log × pin × env matrix is a table test
 * with no server and no filesystem — the thumbnail-panel split. The I/O half
 * lives in edit.ts's /api/publish/regenerate handler, which reads usage.json
 * and command.json and hands them here.
 *
 * Resolution order: the provider usage.json says actually planned this
 * project (`providerOfLog` — truthful even after a §143 fallback, which is
 * why it beats the pin), then the `--llm` pin in command.json's recorded
 * args, then `defaultProviderName`'s detection. Every candidate is PARSED
 * against the provider enum, never coerced: a hand-edited usage.json saying
 * "geminni" falls through to the next rung instead of reaching
 * createProvider as garbage (CLAUDE.md's --source-fit rule).
 */

/** program.ts's `--llm` choices, restated as a schema — the same five names
 * core's ProviderName union spells. */
const ProviderNameSchema = z.enum(["antigravity", "claude", "claude-cli", "gemini", "mock"]);

export type CaptionRegenProviderState =
  | { status: "ready"; provider: ProviderName }
  | { status: "unavailable"; reason: string };

export interface CaptionRegenProviderInputs {
  /** usage.json parsed as-is, or null when absent/corrupt — read leniently
   * by the caller (the /api/usage posture). */
  usageLog: unknown;
  /** command.json's recorded args, or null when the workdir has none. */
  commandArgs: readonly string[] | null;
  env: NodeJS.ProcessEnv;
  /** Injected existence check (defaultProviderName's own seam) so the
   * matrix needs no PATH scan. */
  hasBin: (bin: string) => boolean;
}

export function captionRegenProvider(inputs: CaptionRegenProviderInputs): CaptionRegenProviderState {
  // The log's shape is user-editable JSON: pick out the two arrays
  // providerOfLog reads and let anything else read as an empty log.
  const log = (inputs.usageLog ?? {}) as { runs?: unknown; records?: unknown };
  const recorded = providerOfLog({
    runs: Array.isArray(log.runs) ? (log.runs as never[]) : [],
    records: Array.isArray(log.records) ? (log.records as never[]) : [],
  });
  const fromLog = ProviderNameSchema.safeParse(recorded);
  if (fromLog.success) return { status: "ready", provider: fromLog.data };
  const fromPin = ProviderNameSchema.safeParse(
    lastFlagValue(inputs.commandArgs ?? [], ["--llm"]),
  );
  if (fromPin.success) return { status: "ready", provider: fromPin.data };
  // defaultProviderName answers "claude-cli" even with nothing installed —
  // deliberate on the CLI, where the spawn failure carries install guidance.
  // A button in a panel deserves the sentence BEFORE the click, so this
  // restates its four detections as an availability gate and only then takes
  // its pick.
  const reachable =
    inputs.hasBin(inputs.env.OSSCLIP_AGY_BIN ?? "agy") ||
    inputs.hasBin(inputs.env.OSSCLIP_CLAUDE_BIN ?? "claude") ||
    Boolean(inputs.env.GEMINI_API_KEY) ||
    Boolean(inputs.env.ANTHROPIC_API_KEY);
  if (!reachable) {
    return {
      status: "unavailable",
      reason:
        "no LLM provider available — set GEMINI_API_KEY or ANTHROPIC_API_KEY in " +
        "~/.ossclip/.env, or install the claude or agy CLI, then try again",
    };
  }
  return { status: "ready", provider: defaultProviderName(inputs.env, inputs.hasBin) };
}
