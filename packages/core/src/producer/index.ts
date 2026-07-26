import type { Transcript } from "../schema";
import type { Scene } from "../scene-schema";
import type { LlmProvider, ProviderName } from "./provider";
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
import { MockProvider } from "./mock";
import { generateBeatSheet, type BeatSheet, type BeatsValidationIssue } from "./beats";
import { generateScenes, type ScenePropsFailure } from "./scene-props";

export * from "./provider";
export * from "./beats";
export * from "./scene-props";
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
export { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
export { MockProvider } from "./mock";

export function createProvider(name: ProviderName, model?: string): LlmProvider {
  switch (name) {
    case "claude":
      return new AnthropicProvider(model ?? DEFAULT_CLAUDE_MODEL);
    case "gemini":
      return new GeminiProvider(model ?? DEFAULT_GEMINI_MODEL);
    case "mock":
      return new MockProvider();
  }
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
  args: { transcript: Transcript; outputDuration: number; intent?: string },
): Promise<ProduceScenesResult> {
  const { sheet, issues } = await generateBeatSheet(
    provider,
    args.transcript,
    args.outputDuration,
    args.intent,
  );
  const { scenes, failures } = await generateScenes(provider, sheet.moments, args.transcript);
  return { beatSheet: sheet, beatIssues: issues, scenes, failures };
}
