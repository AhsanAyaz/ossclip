import type { Segment, Transcript } from "../schema";
import type { PlannerComponentId, Scene } from "../scene-schema";
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
  type Moment,
  type ScriptMoment,
} from "./beats";
import { generateScenes, momentSceneId, type ScenePropsFailure } from "./scene-props";
import { planScriptMoments, type ScriptPlanInput } from "./script-plan";
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
export * from "./sfx";
export * from "./logo-finder";
export * from "./caption-regen";
export * from "./caption-choreography";
export * from "./scene-props";
export * from "./script-plan";
export * from "./repair";
export * from "./llm-sessions";
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
  // An alias, not a slug: resolved against `agy models` at call time to the
  // newest `gemini-X.Y-flash-low` (see `resolveAgyModelAlias`). The pinned
  // `gemini-3.7-flash-low` broke every mechanical call the day agy retired it
  // (2026-11-04). The resolved slug prices only if its family is in the usage
  // table; one that is not reports "cost unknown" — the house honesty rule.
  antigravity: "gemini-flash-low",
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

export interface ProduceScenesResult<M extends ScriptMoment = Moment> {
  /** `Moment`s outside script mode; a script run's may name a script-only card. */
  beatSheet: Omit<BeatSheet, "moments"> & { moments: M[] };
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

/** What `produceScenes` is asked to do — one bag for both modes. */
export interface ProduceScenesArgs {
  transcript: Transcript;
  outputDuration: number;
  intent?: string;
  /** Who is on camera — see `--speaker`. */
  speaker?: string;
  /**
   * Debug: render every graphic moment with this component instead of the
   * one the producer picked. Exists because a component the producer never
   * chooses is a component never tested on real copy — FlowDiagram went
   * three rounds unexercised (FINDINGS §20). A PLANNER id: the forced
   * component goes through the props call, which would otherwise show an
   * LLM the schema of a component no planner may offer (ClipScene, G6).
   */
  forceComponent?: PlannerComponentId;
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
  clip?: {
    targetSec: number;
    /** The take's cutlist, so the window's length is its CUT runtime
     * (`resolveClipWindow`). Omitted = source seconds, as before. */
    cutlist?: readonly Segment[];
  };
  /** Output frame shape (R21 §101) — landscape gets layout-variety
   * guidance in the beat prompt. Omitted = portrait, no extra text. */
  aspect?: "9:16" | "16:9";
  /**
   * Word indices (into `transcript`) the cutlist removes — `cutWordIndices`.
   * Every call that writes on-screen copy is told, so a cut retake never
   * comes back as a graphic (2026-11-08). Omitted = nothing marked.
   */
  cut?: ReadonlySet<number>;
  /**
   * `--script` (explainer spec §1.3): the moments come from the script's
   * aligned cues instead of the beat-sheet call, which is not made at all.
   * Everything after the moments — forceComponent, layout repair, the
   * props call — is the path every run takes.
   */
  script?: ScriptPlanInput;
}

/**
 * The full producer-brain pipeline: beat sheet → per-moment scene props.
 *
 * Overloaded on `script` so the TYPE carries G6: only a script run returns
 * moments that may name a script-only card (`ScriptMoment`); a run without
 * one gets `Moment`s, whose `sceneKind` is the frozen planner enum.
 */
export function produceScenes(
  provider: LlmProvider,
  args: ProduceScenesArgs & { script: ScriptPlanInput },
): Promise<ProduceScenesResult<ScriptMoment>>;
export function produceScenes(
  provider: LlmProvider,
  args: ProduceScenesArgs & { script?: undefined },
): Promise<ProduceScenesResult>;
/** A caller that does not know which mode it is in gets the wider answer. */
export function produceScenes(
  provider: LlmProvider,
  args: ProduceScenesArgs,
): Promise<ProduceScenesResult<ScriptMoment>>;
export async function produceScenes(
  provider: LlmProvider,
  args: ProduceScenesArgs,
): Promise<ProduceScenesResult<ScriptMoment>> {
  if (args.script) {
    // Exclusive: `--clip` picks its own window by asking the beat-sheet call
    // for one, and a script has already decided where every scene goes.
    if (args.clip) throw new Error("--clip and --script cannot be combined: a script plans the whole take");
    return produceScriptScenes(provider, { ...args, script: args.script });
  }
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
    args.cut,
  );

  // ---- Clip window (R19 §93) ----------------------------------------------
  // Resolve (validate + sentence-snap) the highlight, slice the transcript,
  // and re-anchor the moments into the slice. Then re-run normalization
  // against the SLICED transcript: the coverage budget and variety passes
  // were computed against the full take's runtime above, and a 60s window
  // deserves a 60s window's graphics schedule.
  let transcript = args.transcript;
  let workingSheet = sheet;
  let cut = args.cut;
  let clip: ProduceScenesResult["clip"];
  if (args.clip) {
    const resolved = resolveClipWindow(
      args.transcript,
      highlight,
      args.clip.targetSec,
      args.clip.cutlist,
    );
    transcript = sliceTranscript(args.transcript, resolved.window);
    // Into the slice's index space, the same shift `sliceMoments` applies.
    if (cut) {
      const { startWord, endWord } = resolved.window;
      cut = new Set([...cut].filter((i) => i >= startWord && i <= endWord).map((i) => i - startWord));
    }
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
      cut,
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
    cut,
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

/**
 * The script-mode half of `produceScenes` (explainer spec §1.3): moments from
 * the aligned cues, then the same downstream steps in the same order.
 */
async function produceScriptScenes(
  provider: LlmProvider,
  args: Omit<ProduceScenesArgs, "script" | "clip"> & { script: ScriptPlanInput },
): Promise<ProduceScenesResult<ScriptMoment>> {
  const { transcript, cut } = args;
  const planned = await planScriptMoments(provider, args.script, transcript);
  const issues: BeatsValidationIssue[] = [...planned.issues];
  const normalized = normalizeBeatSheet(
    // The hook is what the cover banner falls back to; a script has no
    // separate hook judgement, so its first cue's copy stands in.
    { hook: planned.moments[0]?.onScreenCopy ?? "", moments: planned.moments },
    transcript,
    // No shortfall line: its "~1 per 9s" target means nothing here, and
    // every cue that is not placed is reported per cue instead (Task 8).
    null,
    cut,
    "script",
  );
  issues.push(...normalized.issues);

  // Same order as the beat-sheet path, for the same reasons (see there).
  let moments = args.forceComponent
    ? normalized.sheet.moments.map((m) =>
        m.sceneKind === "none" ? m : { ...m, sceneKind: args.forceComponent!, layout: undefined },
      )
    : normalized.sheet.moments;
  if (args.framing) {
    const repaired = repairMomentLayouts(moments, transcript, args.framing);
    moments = repaired.moments;
    issues.push(...repaired.issues);
  }
  const { scenes, failures } = await generateScenes(provider, moments, transcript, {
    framing: args.framing,
    cut,
    // The one downstream difference: a script's props call is also offered
    // the script-only props of the frozen components (§161, plan Task 8).
    mode: "script",
  });

  // A clip scene follows its moment through normalization. Scene ids are
  // indices into the RETURNED moments (`momentSceneId`; the sfx prompt
  // relies on it), so a clip's id and anchor are re-read from where its
  // moment landed. The moment is found by `endWord`: normalization drops
  // moments and moves a `startWord` forward but never reorders or changes an
  // `endWord` inside the transcript, and aligned cues have strictly
  // increasing `endWord`s (cues cannot cross, §1.2), so the match is exact. A
  // clip whose moment was dropped has no words left to anchor to and goes too.
  const clipScenes = planned.clipScenes.flatMap((scene) => {
    const k = moments.findIndex((m) => m.endWord === scene.anchor.endWord);
    if (k === -1) return [];
    const m = moments[k]!;
    return [{ ...scene, id: momentSceneId(k), anchor: { startWord: m.startWord, endWord: m.endWord } }];
  });

  return {
    beatSheet: { ...normalized.sheet, moments },
    beatIssues: issues,
    graphics: {
      // Every placed cue was asked for something on screen; a clip counts
      // as delivered, a footage cue left as talking head does not.
      asked: args.script.aligned.length,
      delivered: moments.filter((m) => m.sceneKind !== "none").length + clipScenes.length,
    },
    scenes: [...scenes, ...clipScenes],
    failures,
  };
}
