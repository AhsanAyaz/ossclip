import { z } from "zod/v4";
import type { Transcript } from "../schema";
import { LayoutSchema, SceneComponentIdSchema } from "../scene-schema";
import { SCENE_REGISTRY } from "../scene-registry";
import { MAX_SCENE_SEC } from "../assemble";
import { COVER_MAX_WORDS, coverHeadline } from "../cover";
import type { LlmProvider } from "./provider";

/**
 * Free text from the model, capped rather than refused (R27 §123).
 *
 * The standing doctrine (§112) is that LLM output is untrusted input,
 * "validated where the pipeline can still degrade instead of at the point
 * where it can only die". A bare `.max(n)` is the second kind: on two of three
 * real runs the editorial call came back with a 61-character `onScreenCopy`
 * and the whole produce died at the Zod boundary — transcription, analysis and
 * the cut all discarded over one character of a headline.
 *
 * `preprocess` keeps `maxLength: n` in the JSON schema the provider is handed,
 * so the model is still ASKED for the limit; it just no longer costs a run
 * when the model misses by a word. Truncation prefers the last word boundary,
 * and adds no ellipsis — the prompt explicitly forbids one on cover text.
 */
export function cappedText(max: number): z.ZodType<string> {
  return z.preprocess((v) => {
    if (typeof v !== "string" || v.length <= max) return v;
    const cut = v.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    // Only honour a word boundary that keeps most of the budget; a single very
    // long word would otherwise collapse to nothing.
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }, z.string().max(max)) as z.ZodType<string>;
}

/** Call 1 — the editorial call (PHASE1 §4): moments, copy, component picks. */
export const MomentSchema = z.object({
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
  purpose: cappedText(100),
  /** Short on-screen copy for this beat — the fallback TitleCard title. */
  onScreenCopy: cappedText(60),
  /** "none" = plain talking head with captions; otherwise a library component. */
  sceneKind: z.union([SceneComponentIdSchema, z.literal("none")]),
  /**
   * Stage layout for this scene (PLAN Task B). Optional so an older cached
   * beat sheet still parses; omitted means the component's registry default.
   * Feasibility is enforced by `repairMomentLayouts` either way — the schema
   * carries the request, the repair pass is the constraint (§35's lesson).
   */
  layout: LayoutSchema.optional().describe(
    "stage layout for this scene; omit for the component default. NEVER a layout the framing brief marks UNAVAILABLE for these words",
  ),
  rationale: cappedText(120).optional(),
});
export type Moment = z.infer<typeof MomentSchema>;

export const BeatSheetSchema = z.object({
  hook: cappedText(120),
  /**
   * Banner text for the cover image (FINDINGS §31). Written here rather than
   * by a second LLM call, because the producer is already choosing the hook —
   * this is the same editorial judgement, shortened for a thumbnail.
   */
  coverText: cappedText(60)
    .optional()
    .describe(
      `cover banner: at most ${COVER_MAX_WORDS} words, the hook compressed to a thumbnail headline`,
    ),
  /**
   * Raised from 12 to 24 (§118): with the alternation policy above, a cap of
   * 12 moments is a ceiling of ~6 graphics however long the take is. A 64s
   * take enumerating five features needs seven graphic beats — hook, five
   * features, payoff — and therefore ~14 moments to alternate between them.
   * The cap was binding before the coverage budget ever was.
   */
  moments: z.array(MomentSchema).min(1).max(24),
});
export type BeatSheet = z.infer<typeof BeatSheetSchema>;

/**
 * The `--clip` highlight request (R19 §93d): asked for IN THE SAME editorial
 * call as the beat sheet — the producer is already reading the whole
 * transcript and ranking moments, so the window costs approximately nothing
 * here, and a second call would let two editorial judgements disagree.
 */
export const ClipHighlightSchema = z.object({
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
  reason: z
    .string()
    .max(200)
    .describe("one line: why THIS window is the strongest stretch of the take"),
});
export type ClipHighlight = z.infer<typeof ClipHighlightSchema>;

export const ClipBeatSheetSchema = BeatSheetSchema.extend({
  highlight: ClipHighlightSchema.describe(
    "the single contiguous window to produce — every moment above must lie inside it",
  ),
});

export const PRODUCER_SYSTEM = `You are the producer for a short-form vertical video (Reels/Shorts/TikTok). You receive a word-indexed transcript of a talking-head take that has already been cut. Your job is EDITORIAL: segment the take into moments, pick which moments deserve a graphic scene, and write the on-screen copy.

Virality grammar — follow these as hard policies:
- The first moment is the hook: the strongest claim or number anywhere in the take, on screen within 2 seconds.
- Pattern interrupts: alternate graphic moments with plain talking-head moments ("none") — never a wall of back-to-back graphics.
- On-screen copy is SHORT: numbers over adjectives, verbs over descriptions, never full sentences.
- Use contrast/negation beats (StrikethroughReveal, RuleCard with struck alternatives) when the speaker rejects an idea.
- End with a payoff or takeaway moment.
- A moment spans the FULL stretch of speech about its beat — typically 5-15 seconds — in transcript order, non-overlapping. The graphic stays on screen for the ENTIRE moment, so the word range must cover everything the graphic refers to: a stat card leaves when the speaker moves on, not before.
- COUNT: the user prompt states how many graphic moments this take should get. That number is a TARGET, not a maximum — hit it. Planning under it is the most common failure: a take that makes five distinct points and gets two graphics has been under-produced, whatever the coverage percentage says.
- COVERAGE: graphics should be on screen for roughly 40-50% of the runtime. A graphic spends its whole moment against that budget, so when the target implies many graphics, make each moment SHORTER rather than dropping moments — more, tighter graphics beats fewer, longer ones. Spread them evenly: never leave a stretch longer than ~10 seconds with no graphic.
- VARIETY: never the same component twice in a row, and prefer a component you have NOT used yet in this video — reuse a treatment only when the beat genuinely calls for it. A repeat reads as a template.
- Keep the face LARGE: prefer StatCard/RuleCard/ScreenshotFrame (they sit under a big face) over TitleCard (face becomes a small bubble); use FlowDiagram/TerminalMock sparingly — they remove the face entirely and only earn that when the graphic IS the point.
- The transcript is ASR output and may contain mishearings: an unfamiliar proper noun is more likely a mistranscription of a common phrase than a real entity — write on-screen copy with the common-sense reading, never a suspected mishearing.
- FRAMING: when the prompt carries a "Camera framing" brief, it is measured from the footage and is a HARD constraint: on words marked CLOSE, never choose a layout listed as UNAVAILABLE there — pick a \`layout\` that keeps the whole head in frame (pip-bubble, graphic-only, full-bleed) or leave the moment as "none". You may set \`layout\` on any moment; omit it to accept the component's default.
- COVER: also write \`coverText\` — the hook compressed to a thumbnail headline, AT MOST ${COVER_MAX_WORDS} WORDS. It is read at a glance in a profile grid, so it must stand alone without the video: the claim or the number, no lead-in, no ellipsis.`;

/**
 * The `--clip` request, appended to the USER prompt (R19 §93d). The tuned
 * PRODUCER_SYSTEM stays untouched — this adds the window request without
 * rewriting the editorial instructions the beat sheet already follows.
 */
export function buildClipAddendum(targetSec: number): string {
  return (
    `\n\nCLIP SELECTION: the source is long-form, and only ONE window of roughly ` +
    `${targetSec.toFixed(0)} seconds will be produced.\n` +
    `1. First choose the strongest contiguous ~${targetSec.toFixed(0)}s of speech — the highlight: ` +
    `self-contained, hook-worthy at its start, resolving by its end. Return it as \`highlight\` ` +
    `(word range + a one-line reason).\n` +
    `2. Prefer a window that starts at a sentence start and ends at a sentence end — a boundary ` +
    `mid-sentence will be snapped to the nearest sentence afterwards.\n` +
    `3. Then write the beat sheet AS IF the highlight were the whole take: the hook and EVERY ` +
    `moment must lie inside the highlight's word range. Plan nothing outside it.`
  );
}

export function buildBeatsUserPrompt(
  transcript: Transcript,
  duration: number,
  intent: string | undefined,
  framingBrief?: string,
  clip?: { targetSec: number },
  aspect?: "9:16" | "16:9",
): string {
  const words = transcript.words
    .map((w, i) => `[${i}]${w.text}`)
    .join(" ");
  const menu = Object.entries(SCENE_REGISTRY)
    .map(([id, meta]) => `- ${id}: ${meta.whenToUse}`)
    .join("\n");
  // §118: state the graphic COUNT explicitly. Everything else in this prompt
  // describes what a good graphic is; nothing said how many to plan, and the
  // coverage budget downstream only ever removes.
  const enumerated = countEnumeratedBeats(transcript);
  const target = graphicsTarget(clip?.targetSec ?? duration, enumerated);
  const targetLine =
    `Graphic moments to plan: ${target}` +
    (enumerated > 0
      ? ` — the speaker enumerates ${enumerated} points out loud, so each one earns its own graphic, plus a hook and a payoff.\n`
      : ` (about one per ${SEC_PER_GRAPHIC}s of runtime). Plan this many unless the take genuinely cannot carry them.\n`);
  return (
    `Intent: ${intent ?? "make this clear, punchy and viral-worthy"}\n` +
    (clip
      ? `Target clip length: ~${clip.targetSec.toFixed(0)}s (see CLIP SELECTION below)\n`
      : `Output duration after the cut: ${duration.toFixed(1)}s\n`) +
    targetLine +
    "\n" +
    // Landscape layout guidance (R21 §101): without it the first real 16:9
    // run put nearly every graphic in a lower third. A deterministic variety
    // pass downstream is the guarantee; this is the steer.
    (aspect === "16:9"
      ? `Output frame: LANDSCAPE 16:9. Vary the \`layout\` deliberately — lower-third, ` +
        `split-left, split-right and blurred-behind are all available; never the same ` +
        `layout twice in a row, and never a list/terminal/chat component in a lower-third ` +
        `(the band is too shallow for a stack).\n\n`
      : "") +
    `Scene components available (sceneKind values; "none" = talking head only):\n${menu}\n\n` +
    // The framing brief sits ABOVE the transcript so the constraint is read
    // before the content it constrains (Task A).
    (framingBrief ? `${framingBrief}\n\n` : "") +
    `Word-indexed transcript (word indices refer to THIS list):\n${words}` +
    (clip ? buildClipAddendum(clip.targetSec) : "")
  );
}

export interface BeatsValidationIssue {
  /** Index of the offending moment, or -1 for a sheet-wide issue. */
  moment: number;
  issue: string;
}

/**
 * How many graphics a take of this length should be asked for (§118).
 *
 * The failure this exists for: nothing ever told the producer how many
 * graphics to plan. `GRAPHICS_COVERAGE_TARGET` reads like a target and is
 * only a ceiling — the demote loop below runs when the model plans too MANY
 * and does nothing at all when it plans too few. On one 64s take the model
 * planned three graphics against a budget that allowed roughly twenty-nine
 * seconds of them; the loop never executed once, so no existing mechanism
 * had an opinion.
 *
 * One graphic per ~9s of runtime, which is the density the prompt's own
 * "never leave a stretch longer than ~10 seconds with no graphic" rule
 * implies, floored at the §29 short-take count.
 */
export const SEC_PER_GRAPHIC = 9;

/**
 * Ordinal cues a speaker uses to enumerate. A take that counts its own
 * points out loud is telling us how many graphics it wants, and that signal
 * is free, deterministic, and better than any runtime heuristic.
 */
const ORDINAL_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
];
const ORDINAL_ADJECTIVES = [
  "first", "second", "third", "fourth", "fifth",
  "sixth", "seventh", "eighth", "ninth", "tenth",
];

/**
 * How many distinct enumerated beats the speaker announces — "number one …
 * number two", "first … second", "step 3". Counts DISTINCT ordinals so a
 * speaker who says "number two" twice doesn't inflate the target, and
 * requires at least two so a passing "first of all" isn't read as a list.
 */
export function countEnumeratedBeats(transcript: Transcript): number {
  const words = transcript.words.map((w) =>
    w.text.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  const seen = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const adj = ORDINAL_ADJECTIVES.indexOf(w);
    if (adj !== -1) {
      seen.add(adj + 1);
      continue;
    }
    // "number one" / "step 2" / "point three" — the ordinal must FOLLOW a
    // counting noun, or every stray "one" in the take counts as a beat.
    if (w !== "number" && w !== "step" && w !== "point" && w !== "tip") continue;
    const next = words[i + 1];
    if (!next) continue;
    const spelled = ORDINAL_WORDS.indexOf(next);
    if (spelled !== -1) {
      seen.add(spelled + 1);
      continue;
    }
    const digit = Number.parseInt(next, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 10) seen.add(digit);
  }
  return seen.size >= 2 ? seen.size : 0;
}

/**
 * The number of graphics to ASK for — whichever of structure and runtime is
 * larger. An enumerated take earns its own count plus a hook and a payoff
 * (the virality grammar demands both anyway), but a long take that happens
 * to enumerate three points still has everything else in it, so runtime
 * density is a floor rather than a loser.
 */
export function graphicsTarget(runtimeSec: number, enumerated: number): number {
  const byRuntime = Math.max(
    SHORT_TAKE_MIN_GRAPHICS,
    Math.round(runtimeSec / SEC_PER_GRAPHIC),
  );
  const byStructure = enumerated > 0 ? enumerated + 2 : 0;
  // Never more than the moment schema can carry once alternation is counted.
  return Math.min(Math.max(byRuntime, byStructure), 12);
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

/** Why the target was what it was, when the take enumerated itself. */
function enumeratedNote(transcript: Transcript): string | null {
  const n = countEnumeratedBeats(transcript);
  return n > 0 ? ` — the take enumerates ${n} points` : null;
}

/**
 * The one-line graphics accounting (§118b): delivered vs asked, and why the
 * ask was what it was. One formatter for the console issue and `report.txt`,
 * so the two can never say different things about the same run.
 */
export function formatGraphicsAccounting(
  delivered: number,
  asked: number,
  transcript: Transcript,
): string {
  return (
    `graphics: ${delivered} of ${asked} planned` +
    (enumeratedNote(transcript) ?? ` (target is ~1 per ${SEC_PER_GRAPHIC}s)`)
  );
}

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

/**
 * Semantic validation beyond the schema; repairs what it can, reports the rest.
 *
 * `askedGraphics` is the count the PROMPT stated (§118b): pass it so the
 * shortfall check measures against what was actually asked for — on a clip
 * run the internal fallback would measure against the full take's runtime,
 * not the clip target the prompt named. `null` skips the check entirely (the
 * pre-slice pass of a clip run, whose sheet is renormalized after slicing —
 * two passes reporting the same shortfall would say it twice). Omitted, the
 * ask is derived from the transcript's own span.
 */
export function normalizeBeatSheet(
  sheet: BeatSheet,
  transcript: Transcript,
  askedGraphics?: number | null,
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
  //
  // §118 decided NOT to extend this floor above 45s, and the reason matters:
  // a floor that outranks the ceiling at every length would fight §114's
  // full-span pricing — more graphics × whole moments blows past 45%, the
  // loop below starts removing what the floor just required, and the two
  // rules oscillate. It would also be treating the wrong failure. When the
  // producer UNDER-plans, this loop never runs at all, so no floor here
  // could have helped; the fix is the target in the prompt. What this layer
  // owes the user instead is to SAY so — see the shortfall issue below.
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

  // The cover banner (FINDINGS §35). Two things went wrong at once: this
  // function used to drop `coverText` on the floor, so the CLI fell back to
  // the full hook — and nothing enforced the nine-word cap the prompt asks
  // for. Both are fixed here, where every path to a beat sheet passes.
  const requested = sheet.coverText?.trim() || sheet.hook;
  const coverText = coverHeadline(requested);
  if (coverText !== requested) {
    issues.push({ moment: -1, issue: `coverText shortened to "${coverText}"` });
  }

  // §118b: a run that under-delivers must say so. The producer was asked for
  // a specific number of graphics; if fewer survive, that is a fact about
  // this render the report should carry, exactly as every cut is justified.
  // Silence is what let three graphics on a five-point take look normal.
  const delivered = surviving().length;
  const asked =
    askedGraphics === undefined
      ? graphicsTarget(runtime, countEnumeratedBeats(transcript))
      : askedGraphics;
  if (asked !== null && delivered < asked) {
    issues.push({
      moment: -1,
      issue: formatGraphicsAccounting(delivered, asked, transcript),
    });
  }

  return { sheet: { hook: sheet.hook, coverText, moments }, issues };
}

export async function generateBeatSheet(
  provider: LlmProvider,
  transcript: Transcript,
  duration: number,
  intent: string | undefined,
  speaker?: string,
  framingBrief?: string,
  clip?: { targetSec: number },
  aspect?: "9:16" | "16:9",
): Promise<{
  sheet: BeatSheet;
  issues: BeatsValidationIssue[];
  /** The graphic count the prompt asked for (§118b) — what "asked" means everywhere downstream. */
  asked: number;
  highlight?: ClipHighlight;
}> {
  const user =
    (speaker ? `The speaker: ${speaker}\n\n` : "") +
    buildBeatsUserPrompt(transcript, duration, intent, framingBrief, clip, aspect);
  // The same number `buildBeatsUserPrompt` states — computed from the same
  // inputs by the same pure functions, so the check and the ask agree.
  const asked = graphicsTarget(
    clip?.targetSec ?? duration,
    countEnumeratedBeats(transcript),
  );
  if (clip) {
    // Same editorial call, extended schema (R19 §93d) — the highlight and the
    // beat sheet come from ONE judgement, so they cannot disagree.
    const raw = await provider.complete({
      system: PRODUCER_SYSTEM,
      user,
      schema: ClipBeatSheetSchema,
      schemaName: "clip_beat_sheet",
    });
    // `null`: the post-slice renormalization owns the shortfall check.
    return { ...normalizeBeatSheet(raw, transcript, null), asked, highlight: raw.highlight };
  }
  const raw = await provider.complete({
    system: PRODUCER_SYSTEM,
    user,
    schema: BeatSheetSchema,
    schemaName: "beat_sheet",
  });
  return { ...normalizeBeatSheet(raw, transcript, asked), asked };
}
