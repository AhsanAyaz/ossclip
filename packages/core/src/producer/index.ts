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
import { buildFramingBrief, repairMomentLayouts, type FramingContext } from "../framing";

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
  gemini: "gemini-3.5-flash-lite",
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
 * Default provider when --llm isn't given, in preference order.
 *
 * Gemini leads on measured evidence, not vendor preference: on the same clip
 * it ran 3,540 input tokens against the Claude CLI's 83,378 — the CLI re-sends
 * its whole harness prefix per invocation — for ~$0.05 against ~$0.85 and 27s
 * against 171s, with editorial output that held up. Both models recovered the
 * mishearing that matters ("coach and" → "code churn"); Claude is stronger only
 * at recovering a mangled PROPER NOUN, which `--speaker` addresses directly.
 *
 * Falling back to the Claude Code CLI last keeps the no-keys-configured path
 * working on a Pro/Max subscription rather than failing.
 */
export function defaultProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.ANTHROPIC_API_KEY) return "claude";
  return "claude-cli";
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
    /** Who is on camera — see `--speaker`. */
    speaker?: string;
    /**
     * Debug: render every graphic moment with this component instead of the
     * one the producer picked. Exists because a component the producer never
     * chooses is a component never tested on real copy — FlowDiagram went
     * three rounds unexercised (FINDINGS §20).
     */
    forceComponent?: SceneComponentId;
    /**
     * Camera-framing constraints (PLAN Tasks A+B), present when the source
     * went through normalization. Feeds the beat-sheet prompt (the brief) AND
     * the repair pass that enforces it — ship both, trust neither alone.
     */
    framing?: FramingContext;
  },
): Promise<ProduceScenesResult> {
  const framingBrief = args.framing
    ? buildFramingBrief(args.framing, args.transcript)
    : undefined;
  const { sheet, issues } = await generateBeatSheet(
    provider,
    args.transcript,
    args.outputDuration,
    args.intent,
    args.speaker,
    framingBrief || undefined,
  );
  // Applied AFTER normalization: the coverage budget and variety passes may
  // demote moments to "none", and forcing before them can leave nothing to
  // render — the flag would appear to work and produce no scenes at all.
  // The forced component drops the producer's layout too: it was chosen for
  // a different component and may not even be in the forced one's repertoire.
  let moments = args.forceComponent
    ? sheet.moments.map((m) =>
        m.sceneKind === "none" ? m : { ...m, sceneKind: args.forceComponent!, layout: undefined },
      )
    : sheet.moments;
  // The safety net (Task B): whatever the prompt did, no moment leaves here
  // with a layout that would crop the head at its own moment's framing.
  if (args.framing) {
    const repaired = repairMomentLayouts(moments, args.transcript, args.framing);
    moments = repaired.moments;
    issues.push(...repaired.issues);
  }
  const { scenes, failures } = await generateScenes(provider, moments, args.transcript, {
    framing: args.framing,
  });
  return { beatSheet: { ...sheet, moments }, beatIssues: issues, scenes, failures };
}
