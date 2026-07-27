import type { Transcript } from "../schema";
import type { Scene, SceneComponentId } from "../scene-schema";
import type { LlmProvider, ProviderName } from "./provider";
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
import { ClaudeCliProvider } from "./claude-cli";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
import { MockProvider } from "./mock";
import { TieredProvider } from "./tiered";
import { generateBeatSheet, type BeatSheet, type BeatsValidationIssue } from "./beats";
import { generateScenes, type ScenePropsFailure } from "./scene-props";

export * from "./provider";
export * from "./usage";
export * from "./beats";
export * from "./scene-props";
export * from "./repair";
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
export { ClaudeCliProvider } from "./claude-cli";
export { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
export { MockProvider } from "./mock";
export { TieredProvider } from "./tiered";

export function createProvider(name: ProviderName, model?: string): LlmProvider {
  switch (name) {
    case "claude":
      return new AnthropicProvider(model ?? DEFAULT_CLAUDE_MODEL);
    case "claude-cli":
      // Rides the Claude Code subscription (Pro/Max) — no API key involved.
      return new ClaudeCliProvider(model);
    case "gemini":
      return new GeminiProvider(model ?? DEFAULT_GEMINI_MODEL);
    case "mock":
      return new MockProvider();
  }
}

/**
 * The small model each provider reaches for on mechanical calls. Deliberately
 * a same-family sibling of the default rather than a cross-vendor pick, so
 * tiering changes cost without also changing who you are talking to. Override
 * with `--llm-fast-model` (or `fastModel` in the config) — for a model this
 * code has never heard of, that flag is the whole interface.
 */
export const DEFAULT_FAST_MODEL: Partial<Record<ProviderName, string>> = {
  claude: "claude-haiku-4-5-20251001",
  "claude-cli": "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash",
};

export interface TieringOptions {
  /** Model for the editorial call (the beat sheet). */
  model?: string;
  /**
   * Model for mechanical calls (repair, scene props). `"same"` disables
   * tiering and sends everything to the editorial model.
   */
  fastModel?: string;
}

/**
 * A provider that sizes the model to the call (FINDINGS §37). Falls back to a
 * single un-tiered provider when the two models resolve to the same thing, so
 * `usage` stays a plain log and nothing wraps for no reason.
 */
export function createTieredProvider(
  name: ProviderName,
  opts: TieringOptions = {},
): LlmProvider {
  const editorial = createProvider(name, opts.model);
  const fast = opts.fastModel === "same" ? undefined : opts.fastModel ?? DEFAULT_FAST_MODEL[name];
  if (!fast || fast === opts.model) return editorial;
  return new TieredProvider(editorial, createProvider(name, fast));
}

/**
 * Default provider when --llm isn't given: the metered API only if a key is
 * actually configured, otherwise the Claude Code CLI (subscription auth) —
 * so Pro/Max users never accidentally rack up API charges.
 */
export function defaultProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  return env.ANTHROPIC_API_KEY ? "claude" : "claude-cli";
}

export interface ProduceScenesResult {
  beatSheet: BeatSheet;
  beatIssues: BeatsValidationIssue[];
  scenes: Scene[];
  failures: ScenePropsFailure[];
}

/** The full producer-brain pipeline: beat sheet → per-moment scene props. */
export async function produceScenes(
  provider: LlmProvider,
  args: {
    transcript: Transcript;
    outputDuration: number;
    intent?: string;
    /**
     * Debug: render every graphic moment with this component instead of the
     * one the producer picked. Exists because a component the producer never
     * chooses is a component never tested on real copy — FlowDiagram went
     * three rounds unexercised (FINDINGS §20).
     */
    forceComponent?: SceneComponentId;
  },
): Promise<ProduceScenesResult> {
  const { sheet, issues } = await generateBeatSheet(
    provider,
    args.transcript,
    args.outputDuration,
    args.intent,
  );
  // Applied AFTER normalization: the coverage budget and variety passes may
  // demote moments to "none", and forcing before them can leave nothing to
  // render — the flag would appear to work and produce no scenes at all.
  const moments = args.forceComponent
    ? sheet.moments.map((m) =>
        m.sceneKind === "none" ? m : { ...m, sceneKind: args.forceComponent! },
      )
    : sheet.moments;
  const { scenes, failures } = await generateScenes(provider, moments, args.transcript);
  return { beatSheet: { ...sheet, moments }, beatIssues: issues, scenes, failures };
}
