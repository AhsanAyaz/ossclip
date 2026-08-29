import type { Transcript } from "../schema";
import type { Scene, SceneComponentId } from "../scene-schema";
import type { LlmProvider, ProviderName } from "./provider";
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
import { AntigravityProvider, type LlmEffort } from "./antigravity";
import { ClaudeCliProvider } from "./claude-cli";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
import { MockProvider } from "./mock";
import { TieredProvider } from "./tiered";
import { FallbackProvider, type FallbackInfo } from "./fallback";
import {
  generateBeatSheet,
  normalizeBeatSheet,
  type BeatSheet,
  type BeatsValidationIssue,
} from "./beats";
import { generateScenes, type ScenePropsFailure } from "./scene-props";
import { buildFramingBrief, repairMomentLayouts, type FramingContext } from "../framing";
import {
  resolveClipWindow,
  sliceMoments,
  sliceTranscript,
  type ClipWindow,
} from "../clip";

export * from "./provider";
export * from "./usage";
export * from "./beats";
export * from "./youtube";
export * from "./caption-regen";
export * from "./scene-props";
export * from "./repair";
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from "./anthropic";
// AGY_PRINT_TIMEOUT is public because the CLI SAYS it: a slow agy call looks
// identical to a working one on screen, so the spinner names the budget it is
// waiting out rather than letting the wait read as a freeze (§149). Exported
// rather than restated in the CLI so the number cannot drift from the flag.
export { AntigravityProvider, AGY_PRINT_TIMEOUT, type LlmEffort } from "./antigravity";
export { ClaudeCliProvider } from "./claude-cli";
export { GeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
export { MockProvider } from "./mock";
export { TieredProvider } from "./tiered";
export { FallbackProvider, type FallbackInfo } from "./fallback";

export function createProvider(
  name: ProviderName,
  model?: string,
  // A trailing bag, not a third positional per knob: every existing
  // (name, model) call site keeps compiling. Only antigravity reads `effort`
  // today (§143) — the other providers have no such flag, and inventing a
  // mapping for them would be a coercion of intent.
  opts: { effort?: LlmEffort } = {},
): LlmProvider {
  switch (name) {
    case "claude":
      return new AnthropicProvider(model ?? DEFAULT_CLAUDE_MODEL);
    case "claude-cli":
      // Rides the Claude Code subscription (Pro/Max) — no API key involved.
      return new ClaudeCliProvider(model);
    case "gemini":
      return new GeminiProvider(model ?? DEFAULT_GEMINI_MODEL);
    case "antigravity":
      // Rides agy's cached subscription sign-in. No default model on purpose:
      // the editorial tier runs whatever the user configured agy itself to
      // use (FINDINGS §132, antigravity provider).
      return new AntigravityProvider(model, undefined, { effort: opts.effort });
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
  // Substring-matches the `gemini-3.7-flash` pricing family, so mechanical
  // calls price from the existing table with no changes; the editorial tier
  // (agy's own default, reported as "antigravity-default") matches nothing and
  // reports "cost unknown" — the house honesty rule, not an oversight.
  antigravity: "gemini-3.7-flash-low",
};

export interface TieringOptions {
  /** Model for the editorial call (the beat sheet). */
  model?: string;
  /**
   * Model for mechanical calls (repair, scene props). `"same"` disables
   * tiering and sends everything to the editorial model.
   */
  fastModel?: string;
  /**
   * Provider to fall back to when the editorial call TIMES OUT (2026-08-22,
   * FINDINGS §143). Honored only when the primary is antigravity — the one
   * provider measured to hang on the real beat-sheet call. See
   * `fallbackProviderName` for who is eligible.
   */
  fallback?: ProviderName;
  /**
   * Fired once, before the fallback call — the caller announces it out loud.
   * Silent substitution is the failure mode the fallback exists to avoid.
   */
  onFallback?: (info: FallbackInfo) => void;
  /**
   * `agy --effort` for the EDITORIAL antigravity call only (§143: exposed
   * after the hang incident — the knob existed and we passed nothing). The
   * mechanical tier keeps agy's default (its small calls never hung), and the
   * §143 fallback never sees it — it is a different provider, and the
   * primary's effort level means nothing to it.
   */
  effort?: LlmEffort;
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
  // The §143 effort knob rides the editorial call only — see TieringOptions.
  let editorial = createProvider(name, opts.model, { effort: opts.effort });
  // Timeout fallback (2026-08-22, FINDINGS §143): only the editorial tier
  // wraps — the beat-sheet call is the one measured to outrun agy's print
  // timeout; mechanical calls are small enough to finish. The fallback gets
  // NO model override: the primary's model name means nothing to a different
  // provider, so the fallback runs its own default.
  if (name === "antigravity" && opts.fallback) {
    editorial = new FallbackProvider(editorial, createProvider(opts.fallback), opts.onFallback);
  }
  const fast = opts.fastModel === "same" ? undefined : opts.fastModel ?? DEFAULT_FAST_MODEL[name];
  if (!fast || fast === opts.model) return editorial;
  return new TieredProvider(editorial, createProvider(name, fast));
}

/**
 * Default provider when --llm isn't given, in preference order.
 *
 * Subscription CLIs beat ambient env keys (2026-08 decision, FINDINGS §132,
 * antigravity provider): a logged-in `agy` or `claude` is an explicit,
 * already-paid choice the user made on this machine, while an API key in the
 * environment may just be lying around — and picking the key spends real
 * per-token money the subscription would have covered. agy carries the same
 * ~24k-token harness baseline per call that claude-cli does, but it is
 * subscription-covered, so the weight costs nothing.
 *
 * Among the keys, Gemini leads on measured evidence, not vendor preference: on
 * the same clip it ran 3,540 input tokens against the Claude CLI's 83,378 —
 * the CLI re-sends its whole harness prefix per invocation — for ~$0.05
 * against ~$0.85 and 27s against 171s, with editorial output that held up.
 * Both models recovered the mishearing that matters ("coach and" → "code
 * churn"); Claude is stronger only at recovering a mangled PROPER NOUN, which
 * `--speaker` addresses directly.
 *
 * Falling back to the Claude Code CLI last keeps the nothing-configured path
 * failing with install guidance rather than silence. The `hasBin` default of
 * `() => false` keeps this pure — callers that can see a filesystem (the CLI)
 * inject a real checker; everyone else gets the key-order behavior unchanged.
 */
export function defaultProviderName(
  env: NodeJS.ProcessEnv = process.env,
  hasBin: (bin: string) => boolean = () => false,
): ProviderName {
  if (hasBin(env.OSSCLIP_AGY_BIN ?? "agy")) return "antigravity";
  if (hasBin(env.OSSCLIP_CLAUDE_BIN ?? "claude")) return "claude-cli";
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.ANTHROPIC_API_KEY) return "claude";
  return "claude-cli";
}

/**
 * Where a timed-out antigravity run falls back to (2026-08-22, FINDINGS
 * §143). Only antigravity gets one: it is the sole provider measured to hang
 * persistently on the real beat-sheet call, and handing every provider a
 * second choice would turn one measured incident into a general substitution
 * policy. The order is `defaultProviderName`'s with agy removed — a logged-in
 * claude CLI beats the gemini key for the same §132 subscription-first
 * reasons — and the `hasBin` default of `() => false` keeps this pure the
 * same way: callers that can see a filesystem inject a real checker.
 */
export function fallbackProviderName(
  primary: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
  hasBin: (bin: string) => boolean = () => false,
): ProviderName | undefined {
  if (primary !== "antigravity") return undefined;
  if (hasBin(env.OSSCLIP_CLAUDE_BIN ?? "claude")) return "claude-cli";
  if (env.GEMINI_API_KEY) return "gemini";
  return undefined;
}

export interface ProduceScenesResult {
  beatSheet: BeatSheet;
  beatIssues: BeatsValidationIssue[];
  /**
   * The graphics accounting (§118b): how many the prompt asked for and how
   * many survived planning. `delivered` equals the scene count — layout
   * repair never demotes, and a failed props call falls back to a TitleCard
   * rather than dropping the scene.
   */
  graphics: { asked: number; delivered: number };
  scenes: Scene[];
  failures: ScenePropsFailure[];
  /**
   * Present on a `--clip` run (R19 §93): the resolved window (pre-slice index
   * space + source seconds), the transcript sliced to it — which is the space
   * the returned moments and scenes live in — and what resolution changed
   * about the model's raw pick.
   */
  clip?: { window: ClipWindow; transcript: Transcript; notes: string[] };
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
    /**
     * `--clip` (R19 §93): select ONE ~targetSec window and plan only inside
     * it. The window request rides the beat-sheet call (§93d); the returned
     * moments/scenes are re-anchored to the sliced transcript, and the caller
     * slices the rest of its pipeline state to `clip.window`.
     */
    clip?: { targetSec: number };
    /** Output frame shape (R21 §101) — landscape gets layout-variety
     * guidance in the beat prompt. Omitted = portrait, no extra text. */
    aspect?: "9:16" | "16:9";
  },
): Promise<ProduceScenesResult> {
  const framingBrief = args.framing
    ? buildFramingBrief(args.framing, args.transcript)
    : undefined;
  const { sheet, issues, asked, highlight } = await generateBeatSheet(
    provider,
    args.transcript,
    args.outputDuration,
    args.intent,
    args.speaker,
    framingBrief || undefined,
    args.clip,
    args.aspect,
  );

  // ---- Clip window (R19 §93) ----------------------------------------------
  // Resolve (validate + sentence-snap) the highlight, slice the transcript,
  // and re-anchor the moments into the slice. Then re-run normalization
  // against the SLICED transcript: the coverage budget and variety passes
  // were computed against the full take's runtime above, and a 60s window
  // deserves a 60s window's graphics schedule.
  let transcript = args.transcript;
  let workingSheet = sheet;
  let clip: ProduceScenesResult["clip"];
  if (args.clip) {
    const resolved = resolveClipWindow(args.transcript, highlight, args.clip.targetSec);
    transcript = sliceTranscript(args.transcript, resolved.window);
    const anchored = sliceMoments(sheet.moments, resolved.window);
    if (anchored.length === 0) {
      issues.push({
        moment: -1,
        issue: "no moments inside the highlight — the clip renders as a plain captioned take",
      });
    }
    const renorm = normalizeBeatSheet(
      { hook: sheet.hook, coverText: sheet.coverText, moments: anchored },
      transcript,
      // The ask the prompt stated — NOT re-derived from the slice, which
      // would compare the model against a number it was never given (§118b).
      asked,
    );
    workingSheet = renorm.sheet;
    issues.push(...renorm.issues);
    clip = { window: resolved.window, transcript, notes: resolved.notes };
  }

  // Applied AFTER normalization: the coverage budget and variety passes may
  // demote moments to "none", and forcing before them can leave nothing to
  // render — the flag would appear to work and produce no scenes at all.
  // The forced component drops the producer's layout too: it was chosen for
  // a different component and may not even be in the forced one's repertoire.
  let moments = args.forceComponent
    ? workingSheet.moments.map((m) =>
        m.sceneKind === "none" ? m : { ...m, sceneKind: args.forceComponent!, layout: undefined },
      )
    : workingSheet.moments;
  // The safety net (Task B): whatever the prompt did, no moment leaves here
  // with a layout that would crop the head at its own moment's framing.
  if (args.framing) {
    const repaired = repairMomentLayouts(moments, transcript, args.framing);
    moments = repaired.moments;
    issues.push(...repaired.issues);
  }
  const { scenes, failures } = await generateScenes(provider, moments, transcript, {
    framing: args.framing,
  });
  const delivered = moments.filter((m) => m.sceneKind !== "none").length;
  return {
    beatSheet: { ...workingSheet, moments },
    beatIssues: issues,
    graphics: { asked, delivered },
    scenes,
    failures,
    clip,
  };
}
