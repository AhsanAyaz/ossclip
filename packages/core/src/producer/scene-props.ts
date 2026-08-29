import { z } from "zod/v4";
import type { Transcript } from "../schema";
import type { Layout, Scene, SceneComponentId } from "../scene-schema";
import { SCENE_REGISTRY } from "../scene-registry";
import type { LlmProvider } from "./provider";
import type { Moment } from "./beats";
import {
  layoutFeasible,
  momentSourceWindow,
  worstFaceFrac,
  type FramingContext,
} from "../framing";

/**
 * The id `generateScenes` mints for the scene a moment becomes.
 *
 * Exported because a SECOND caller depends on the formula now (2026-08-29):
 * the SFX placement prompt offers these ids to the model so a whoosh can
 * anchor to a graphic's ENTRANCE (`buildSfxUserPrompt`), and
 * `normalizeSfxPlan` checks the ids that come back against them. Two copies
 * of `scene-${i}` is exactly §154's two-copies failure — the prompt would
 * offer ids the plan never mints, and every scene link would strip on
 * arrival.
 *
 * The index is the MOMENT's, not a running scene counter: talking-head
 * moments mint no scene, so scene ids are sparse by design.
 */
export function momentSceneId(momentIndex: number): string {
  return `scene-${momentIndex}`;
}

export interface ScenePropsFailure {
  momentIndex: number;
  component: SceneComponentId;
  error: string;
  fellBackTo: "TitleCard" | "dropped";
}

const PROPS_SYSTEM = `You fill the props for ONE scene component of a short-form video, from the transcript slice it accompanies. Copy is SHORT and punchy: numbers over adjectives, ALL-CAPS reads fine for labels/kickers, never full sentences. Output only what the schema asks for.

GROUNDING — hard rules:
- Every label, noun and claim must be supported by the transcript slice. NEVER introduce an entity, metric name or brand the slice does not contain — a number gets the noun the speaker attached to it, not a plausible-sounding one. If the slice offers no supporting noun, use the number alone or fall back to the suggested copy verbatim.
- The transcript is automatic speech recognition output and may contain mishearings. An unfamiliar proper noun is more likely a mistranscription of a common phrase than a real company or product — prefer the common-sense reading ("code churn", not "CodeChun") and never promote a suspected mishearing into a name or label.`;

function buildPropsPrompt(moment: Moment, transcript: Transcript): string {
  const slice = transcript.words
    .slice(moment.startWord, moment.endWord + 1)
    .map((w) => w.text)
    .join(" ");
  return (
    `Component: ${moment.sceneKind}\n` +
    `Purpose of this moment: ${moment.purpose}\n` +
    `Suggested on-screen copy: ${moment.onScreenCopy}\n` +
    `Transcript slice: "${slice}"`
  );
}

/**
 * One call for ALL the graphic moments, returning props keyed by moment index.
 *
 * Call count is the only cost lever that matters here. Measured against the
 * Claude Code CLI: every invocation carries ~25-45k tokens of harness prefix
 * before ossclip's own prompt (~1-2k) is even considered, and that prefix is
 * re-sent per call rather than reused across separate CLI sessions. A 32s clip
 * spent 6 calls / 270k tokens, of which the content was a rounding error.
 *
 * Isolation is preserved by validating each item SEPARATELY on the way out:
 * anything malformed simply isn't returned, and the caller retries that moment
 * on its own. So the batch is a fast path, never a new failure mode.
 */
async function generateScenePropsBatch(
  provider: LlmProvider,
  moments: readonly Moment[],
  indices: readonly number[],
  transcript: Transcript,
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  if (indices.length < 2) return out; // nothing to amortise
  const schema = z.object({
    scenes: z.array(z.object({ index: z.number().int(), props: z.record(z.string(), z.unknown()) })),
  });
  const blocks = indices.map((i) => {
    const moment = moments[i]!;
    const meta = SCENE_REGISTRY[moment.sceneKind as SceneComponentId];
    return (
      `--- moment ${i} ---\n` +
      `${buildPropsPrompt(moment, transcript)}\n` +
      `Props schema: ${JSON.stringify(z.toJSONSchema(meta.propsSchema as z.ZodType))}`
    );
  });
  let raw: z.infer<typeof schema>;
  try {
    raw = await provider.complete({
      system: PROPS_SYSTEM,
      user:
        `Fill the props for EACH moment below. Reply with one entry per moment, ` +
        `echoing its index. Each entry's props must satisfy that moment's own schema.\n\n` +
        blocks.join("\n\n"),
      schema,
      schemaName: "scene_props_batch",
      // Mechanical: filling a schema from a transcript slice, with every
      // field validated on the way out.
      tier: "mechanical",
    });
  } catch {
    return out; // the per-moment path takes over
  }
  for (const entry of raw.scenes) {
    const moment = moments[entry.index];
    if (!moment || !indices.includes(entry.index)) continue;
    const meta = SCENE_REGISTRY[moment.sceneKind as SceneComponentId];
    const parsed = (meta.propsSchema as z.ZodType<Record<string, unknown>>).safeParse(entry.props);
    if (parsed.success) out.set(entry.index, parsed.data);
  }
  return out;
}

/**
 * Call 2 — scene props (PHASE1 §4). One batched call covers the moments that
 * behave; anything it fails to produce falls back to a per-moment call, so one
 * bad scene still can't poison the rest. Validation loop per moment: schema
 * parse → one retry with the error appended → TitleCard fallback with the
 * moment's onScreenCopy. Bounded retries, accepted residuals — the Opus-log
 * policy.
 */
export async function generateScenes(
  provider: LlmProvider,
  moments: readonly Moment[],
  transcript: Transcript,
  opts: { framing?: FramingContext } = {},
): Promise<{ scenes: Scene[]; failures: ScenePropsFailure[] }> {
  const scenes: Scene[] = [];
  const failures: ScenePropsFailure[] = [];
  /**
   * Layout resolution, in priority order (PLAN Task B):
   *
   *   1. The PRODUCER's explicit choice — that is the point of Task B, and it
   *      arrives already checked by `repairMomentLayouts`.
   *   2. The §20 variety rotation: repeats of a component get an alternate
   *      layout, because two identical card treatments read as a template.
   *   3. Feasibility outranks variety (Task B4): a rotation candidate that
   *      would crop the head at this moment's framing is skipped for the
   *      next feasible candidate — variety picks among what is left, and
   *      with nothing left the least-bad candidate stands (the same verdict
   *      `repairMomentLayouts` would reach).
   */
  const seen = new Map<SceneComponentId, number>();
  const layoutFor = (component: SceneComponentId, moment: Moment): Layout => {
    const meta = SCENE_REGISTRY[component];
    const n = seen.get(component) ?? 0;
    seen.set(component, n + 1);
    if (moment.layout) return moment.layout;
    const rotation =
      n === 0 || meta.altLayouts.length === 0
        ? [meta.defaultLayout, ...meta.altLayouts]
        : [
            meta.altLayouts[(n - 1) % meta.altLayouts.length]!,
            meta.defaultLayout,
            ...meta.altLayouts,
          ];
    const framing = opts.framing;
    if (!framing) return rotation[0]!;
    const window = momentSourceWindow(transcript, moment.startWord, moment.endWord);
    const faceFrac = window
      ? worstFaceFrac(framing.windows, window.startSec, window.endSec)
      : 0;
    return rotation.find((l) => layoutFeasible(framing, l, faceFrac)) ?? rotation[0]!;
  };

  const graphicIndices = moments.flatMap((m, i) => (m.sceneKind === "none" ? [] : [i]));
  const batched = await generateScenePropsBatch(provider, moments, graphicIndices, transcript);

  for (let i = 0; i < moments.length; i++) {
    const moment = moments[i]!;
    if (moment.sceneKind === "none") continue;
    const component = moment.sceneKind;
    const meta = SCENE_REGISTRY[component];
    const schema = meta.propsSchema as z.ZodType<Record<string, unknown>>;
    const layout = layoutFor(component, moment);

    let props: Record<string, unknown> | null = batched.get(i) ?? null;
    let lastError = "";
    const basePrompt = buildPropsPrompt(moment, transcript);
    for (let attempt = 0; attempt < 2 && props === null; attempt++) {
      const user =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nYour previous attempt failed validation:\n${lastError}\nFix it.`;
      try {
        props = await provider.complete({
          system: PROPS_SYSTEM,
          user,
          schema,
          schemaName: `${component}_props`,
          tier: "mechanical",
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (props === null) {
      // Degrade, don't fail the render (PHASE1 acceptance #4).
      const fallbackTitle = moment.onScreenCopy.slice(0, 48) || "—";
      failures.push({ momentIndex: i, component, error: lastError, fellBackTo: "TitleCard" });
      scenes.push({
        id: momentSceneId(i),
        anchor: { startWord: moment.startWord, endWord: moment.endWord },
        layout: SCENE_REGISTRY.TitleCard.defaultLayout,
        component: "TitleCard",
        props: { title: fallbackTitle },
        overrides: {},
        rationale: `fallback after ${component} props failed: ${lastError.slice(0, 120)}`,
      });
      continue;
    }

    scenes.push({
      id: momentSceneId(i),
      anchor: { startWord: moment.startWord, endWord: moment.endWord },
      layout,
      component,
      props,
      overrides: {},
      rationale: moment.rationale ?? moment.purpose,
    });
  }

  return { scenes, failures };
}
