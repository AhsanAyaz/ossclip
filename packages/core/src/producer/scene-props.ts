import { z } from "zod/v4";
import type { Transcript } from "../schema";
import type { Layout, Scene, SceneComponentId } from "../scene-schema";
import { SCENE_REGISTRY } from "../scene-registry";
import type { LlmProvider } from "./provider";
import type { Moment } from "./beats";

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
 * Call 2 — per-moment scene props (PHASE1 §4). Batched per moment so one bad
 * scene can't poison the rest. Validation loop: schema parse → one retry with
 * the error appended → TitleCard fallback with the moment's onScreenCopy.
 * Bounded retries, accepted residuals — the Opus-log policy.
 */
export async function generateScenes(
  provider: LlmProvider,
  moments: readonly Moment[],
  transcript: Transcript,
): Promise<{ scenes: Scene[]; failures: ScenePropsFailure[] }> {
  const scenes: Scene[] = [];
  const failures: ScenePropsFailure[] = [];
  /**
   * Repeats of a component get an alternate layout (FINDINGS §20): two
   * identical card treatments in one video read as a template even when
   * they're far apart, and re-framing is the variety that costs nothing —
   * no coverage lost, no editorial judgement made on the LLM's behalf.
   */
  const seen = new Map<SceneComponentId, number>();
  const layoutFor = (component: SceneComponentId): Layout => {
    const meta = SCENE_REGISTRY[component];
    const n = seen.get(component) ?? 0;
    seen.set(component, n + 1);
    if (n === 0 || meta.altLayouts.length === 0) return meta.defaultLayout;
    return meta.altLayouts[(n - 1) % meta.altLayouts.length]!;
  };

  for (let i = 0; i < moments.length; i++) {
    const moment = moments[i]!;
    if (moment.sceneKind === "none") continue;
    const component = moment.sceneKind;
    const meta = SCENE_REGISTRY[component];
    const schema = meta.propsSchema as z.ZodType<Record<string, unknown>>;
    const layout = layoutFor(component);

    let props: Record<string, unknown> | null = null;
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
        id: `scene-${i}`,
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
      id: `scene-${i}`,
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
