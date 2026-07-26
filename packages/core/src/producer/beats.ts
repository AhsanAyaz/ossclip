import { z } from "zod/v4";
import type { Transcript } from "../schema";
import { SceneComponentIdSchema } from "../scene-schema";
import { SCENE_REGISTRY } from "../scene-registry";
import type { LlmProvider } from "./provider";

/** Call 1 — the editorial call (PHASE1 §4): moments, copy, component picks. */
export const MomentSchema = z.object({
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
  purpose: z.string().max(100),
  /** Short on-screen copy for this beat — the fallback TitleCard title. */
  onScreenCopy: z.string().max(60),
  /** "none" = plain talking head with captions; otherwise a library component. */
  sceneKind: z.union([SceneComponentIdSchema, z.literal("none")]),
  rationale: z.string().max(120).optional(),
});
export type Moment = z.infer<typeof MomentSchema>;

export const BeatSheetSchema = z.object({
  hook: z.string().max(120),
  moments: z.array(MomentSchema).min(1).max(12),
});
export type BeatSheet = z.infer<typeof BeatSheetSchema>;

export const PRODUCER_SYSTEM = `You are the producer for a short-form vertical video (Reels/Shorts/TikTok). You receive a word-indexed transcript of a talking-head take that has already been cut. Your job is EDITORIAL: segment the take into moments, pick which moments deserve a graphic scene, and write the on-screen copy.

Virality grammar — follow these as hard policies:
- The first moment is the hook: the strongest claim or number anywhere in the take, on screen within 2 seconds.
- A pattern interrupt every 3-6 seconds: alternate graphic moments with plain talking-head moments ("none").
- On-screen copy is SHORT: numbers over adjectives, verbs over descriptions, never full sentences.
- Use contrast/negation beats (StrikethroughReveal, RuleCard with struck alternatives) when the speaker rejects an idea.
- End with a payoff or takeaway moment.
- Moments must be contiguous-ish spans of the transcript, 5-10 seconds of speech each, in transcript order, non-overlapping.
- HARD CAP: with N moments, at most floor(N/2) may have a sceneKind other than "none". Count them before you answer; if over, demote the weakest graphics to "none". The speaker's face is the product.
- Keep the face LARGE: prefer StatCard/RuleCard/ScreenshotFrame (they sit under a big face) over TitleCard (face becomes a small bubble); use FlowDiagram/TerminalMock sparingly — they remove the face entirely and only earn that when the graphic IS the point.
- Graphics punch in for a few seconds and hand the frame back; they never need to span their whole moment.`;

export function buildBeatsUserPrompt(
  transcript: Transcript,
  duration: number,
  intent: string | undefined,
): string {
  const words = transcript.words
    .map((w, i) => `[${i}]${w.text}`)
    .join(" ");
  const menu = Object.entries(SCENE_REGISTRY)
    .map(([id, meta]) => `- ${id}: ${meta.whenToUse}`)
    .join("\n");
  return (
    `Intent: ${intent ?? "make this clear, punchy and viral-worthy"}\n` +
    `Output duration after the cut: ${duration.toFixed(1)}s\n\n` +
    `Scene components available (sceneKind values; "none" = talking head only):\n${menu}\n\n` +
    `Word-indexed transcript (word indices refer to THIS list):\n${words}`
  );
}

export interface BeatsValidationIssue {
  moment: number;
  issue: string;
}

/** Semantic validation beyond the schema; repairs what it can, reports the rest. */
export function normalizeBeatSheet(
  sheet: BeatSheet,
  wordCount: number,
): { sheet: BeatSheet; issues: BeatsValidationIssue[] } {
  const issues: BeatsValidationIssue[] = [];
  const moments: Moment[] = [];
  const maxIndex = Math.max(0, wordCount - 1);
  for (let i = 0; i < sheet.moments.length; i++) {
    const m = { ...sheet.moments[i]! };
    if (m.startWord > maxIndex) {
      issues.push({ moment: i, issue: `startWord ${m.startWord} beyond transcript (${maxIndex})` });
      continue;
    }
    m.endWord = Math.min(m.endWord, maxIndex);
    if (m.endWord < m.startWord) {
      issues.push({ moment: i, issue: "endWord before startWord" });
      continue;
    }
    const prev = moments[moments.length - 1];
    if (prev && m.startWord <= prev.endWord) {
      const shifted = prev.endWord + 1;
      if (shifted > m.endWord) {
        issues.push({ moment: i, issue: "fully overlaps previous moment" });
        continue;
      }
      issues.push({ moment: i, issue: `overlapped previous; startWord ${m.startWord} → ${shifted}` });
      m.startWord = shifted;
    }
    moments.push(m);
  }

  // Deterministic enforcement of the at-most-half graphics cap (FINDINGS §4):
  // the prompt states it, but the model overshoots — demote the latest
  // graphics to "none", sparing the hook (first) and the payoff (last).
  const cap = Math.max(1, Math.floor(moments.length / 2));
  const graphicIndices = moments.flatMap((m, i) => (m.sceneKind !== "none" ? [i] : []));
  if (graphicIndices.length > cap) {
    const protectedIdx = new Set([graphicIndices[0], graphicIndices[graphicIndices.length - 1]]);
    const demotable = graphicIndices.filter((i) => !protectedIdx.has(i)).reverse();
    for (const i of demotable) {
      if (moments.filter((m) => m.sceneKind !== "none").length <= cap) break;
      issues.push({ moment: i, issue: `demoted ${moments[i]!.sceneKind} to "none" (graphics cap ${cap})` });
      moments[i] = { ...moments[i]!, sceneKind: "none" };
    }
  }

  return { sheet: { hook: sheet.hook, moments }, issues };
}

export async function generateBeatSheet(
  provider: LlmProvider,
  transcript: Transcript,
  duration: number,
  intent: string | undefined,
): Promise<{ sheet: BeatSheet; issues: BeatsValidationIssue[] }> {
  const raw = await provider.complete({
    system: PRODUCER_SYSTEM,
    user: buildBeatsUserPrompt(transcript, duration, intent),
    schema: BeatSheetSchema,
    schemaName: "beat_sheet",
  });
  return normalizeBeatSheet(raw, transcript.words.length);
}
