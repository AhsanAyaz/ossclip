import { z } from "zod/v4";
import type { Transcript } from "../schema";
import { SceneComponentIdSchema } from "../scene-schema";
import { SCENE_REGISTRY } from "../scene-registry";
import { MAX_SCENE_SEC } from "../assemble";
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
  /**
   * Banner text for the cover image (FINDINGS §31). Written here rather than
   * by a second LLM call, because the producer is already choosing the hook —
   * this is the same editorial judgement, shortened for a thumbnail.
   */
  coverText: z
    .string()
    .max(60)
    .optional()
    .describe("cover banner: at most 9 words, the hook compressed to a thumbnail headline"),
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
- COVERAGE: graphics should be on screen for roughly 40-50% of the runtime. Each graphic holds at most ~5 seconds, then hands the frame back — so MOST moments can carry one. Spread them evenly: never leave a stretch longer than ~10 seconds with no graphic.
- VARIETY: never the same component twice in a row, and prefer a component you have NOT used yet in this video — reuse a treatment only when the beat genuinely calls for it. A repeat reads as a template.
- Keep the face LARGE: prefer StatCard/RuleCard/ScreenshotFrame (they sit under a big face) over TitleCard (face becomes a small bubble); use FlowDiagram/TerminalMock sparingly — they remove the face entirely and only earn that when the graphic IS the point.
- The transcript is ASR output and may contain mishearings: an unfamiliar proper noun is more likely a mistranscription of a common phrase than a real entity — write on-screen copy with the common-sense reading, never a suspected mishearing.
- COVER: also write \`coverText\` — the hook compressed to a thumbnail headline, AT MOST 9 WORDS. It is read at a glance in a profile grid, so it must stand alone without the video: the claim or the number, no lead-in, no ellipsis.`;

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

/** Fraction of the runtime that should show a graphic (FINDINGS §7). */
export const GRAPHICS_COVERAGE_TARGET = 0.45;
/**
 * Below this runtime the percentage budget starves the video (FINDINGS §29):
 * 45% of a 32s take is 14s, which at the 5s per-scene cap buys only three
 * graphics — and short-form is exactly where density matters most. Under this
 * threshold the scene COUNT floor wins over the percentage.
 */
export const SHORT_TAKE_SEC = 45;
export const SHORT_TAKE_MIN_GRAPHICS = 4;

/** A moment's approximate seconds of speech, from the transcript word stamps. */
function momentDuration(m: Moment, transcript: Transcript): number {
  const first = transcript.words[m.startWord];
  const last = transcript.words[m.endWord];
  return first && last ? Math.max(0, last.end - first.start) : 0;
}

function momentMidpoint(m: Moment, transcript: Transcript): number {
  const first = transcript.words[m.startWord];
  const last = transcript.words[m.endWord];
  return first && last ? (first.start + last.end) / 2 : 0;
}

/** Semantic validation beyond the schema; repairs what it can, reports the rest. */
export function normalizeBeatSheet(
  sheet: BeatSheet,
  transcript: Transcript,
): { sheet: BeatSheet; issues: BeatsValidationIssue[] } {
  const wordCount = transcript.words.length;
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

  // ---- Graphics scheduling (FINDINGS §7/§8/§9) -----------------------------
  // One coverage budget in SECONDS instead of a moment-count cap, so the
  // per-scene time cap and the demotion can't stack multiplicatively (§7).
  // Demotion order is by clustering + same-kind adjacency, so survivors stay
  // spread across the timeline (§8) and varied (§9); hook and payoff are
  // always spared.
  const surviving = () => moments.flatMap((m, i) => (m.sceneKind !== "none" ? [i] : []));
  const estShow = (i: number) =>
    Math.min(momentDuration(moments[i]!, transcript), MAX_SCENE_SEC);
  const runtime =
    transcript.words.length > 0
      ? transcript.words[transcript.words.length - 1]!.end - transcript.words[0]!.start
      : 0;
  const budget = GRAPHICS_COVERAGE_TARGET * runtime;

  const demote = (i: number, why: string) => {
    issues.push({ moment: i, issue: `demoted ${moments[i]!.sceneKind} to "none" (${why})` });
    moments[i] = { ...moments[i]!, sceneKind: "none" };
  };

  // On a short take the count floor outranks the percentage — never demote
  // below it, whatever the coverage budget says (§29).
  const minGraphics = runtime < SHORT_TAKE_SEC ? SHORT_TAKE_MIN_GRAPHICS : 0;

  for (;;) {
    const graphics = surviving();
    const shown = graphics.reduce((acc, i) => acc + estShow(i), 0);
    if (shown <= budget + 1e-6) break;
    if (graphics.length <= minGraphics) {
      issues.push({
        moment: 0,
        issue:
          `short take (${runtime.toFixed(0)}s): keeping ${graphics.length} graphics ` +
          `over the ${(GRAPHICS_COVERAGE_TARGET * 100).toFixed(0)}% budget`,
      });
      break;
    }
    // Hook and payoff stay. Among the rest, demote whichever removal opens
    // the SMALLEST gap between its surviving neighbours — the survivors stay
    // spread instead of the tail (or middle) getting hollowed out (§8).
    // Same-kind neighbours make a candidate maximally demotable (§9).
    const candidates = graphics.slice(1, -1);
    if (candidates.length === 0) break;
    let pick = candidates[0]!;
    let pickCost = Infinity;
    for (const i of candidates) {
      const pos = graphics.indexOf(i);
      const prev = moments[graphics[pos - 1]!]!;
      const next = moments[graphics[pos + 1]!]!;
      const openedGap =
        momentMidpoint(next, transcript) - momentMidpoint(prev, transcript);
      const sameKind =
        prev.sceneKind === moments[i]!.sceneKind || next.sceneKind === moments[i]!.sceneKind;
      const cost = openedGap - (sameKind ? 1e6 : 0);
      if (cost < pickCost) {
        pickCost = cost;
        pick = i;
      }
    }
    demote(pick, `coverage ${(GRAPHICS_COVERAGE_TARGET * 100).toFixed(0)}%`);
  }

  // Variety pass independent of budget (§9): adjacent survivors must differ in
  // kind — demote the later of a same-kind pair (the earlier if the later is
  // the payoff; never the hook).
  for (;;) {
    const graphics = surviving();
    if (graphics.length <= minGraphics) break; // §29 floor outranks variety too
    const pair = graphics.findIndex(
      (idx, p) => p > 0 && moments[idx]!.sceneKind === moments[graphics[p - 1]!]!.sceneKind,
    );
    if (pair === -1) break;
    const later = graphics[pair]!;
    const earlier = graphics[pair - 1]!;
    const isPayoff = pair === graphics.length - 1;
    const target = isPayoff ? (pair - 1 === 0 ? -1 : earlier) : later;
    if (target === -1) break; // both hook and payoff — leave the repeat alone
    demote(target, `duplicate adjacent ${moments[target]!.sceneKind}`);
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
  return normalizeBeatSheet(raw, transcript);
}
