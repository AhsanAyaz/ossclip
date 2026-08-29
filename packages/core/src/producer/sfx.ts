import { z } from "zod/v4";
import type { Transcript } from "../schema";
import { SFX_MEME_TAG, type LoadedSfxSound } from "../sfx-pack";
import { cappedText, type BeatSheet } from "./beats";
import type { LlmProvider } from "./provider";

/**
 * Call 3 — sound-effect placement (SFX plan, Approach A): a SEPARATE call
 * after the beat sheet, with the graphics plan in context, so a whoosh can
 * land on a graphic entrance. Mirrors beats.ts on purpose — schema, prompt
 * builder, deterministic normalize pass, generate wrapper — because the
 * deterministic pass, not the model, is what makes the output shippable.
 *
 * Nothing in this module touches the filesystem: the library arrives already
 * loaded (`loadSfxLibrary`, the only fs toucher), so the prompt/normalize
 * matrix is testable with a hand-written array of sounds.
 */

export const SfxLevelSchema = z.enum(["subtle", "normal", "meme"]);
export type SfxLevel = z.infer<typeof SfxLevelSchema>;

/**
 * One sound at one instant. A single `word` anchor and no `endWord`: an SFX
 * is an instant, not a span — it plays for its own duration wherever it is
 * triggered, so a range would be a number the renderer has to ignore.
 */
export const SfxPlacementSchema = z.object({
  soundId: z.string(),
  word: z.number().int().nonnegative(),
  /** Per-placement trim, multiplied by the sound's own gain at render time. */
  gain: z.number().min(0).max(2).optional(),
  rationale: cappedText(120).optional(),
});
export type SfxPlacement = z.infer<typeof SfxPlacementSchema>;

/**
 * 64 is a ceiling on the RESPONSE, not the policy: the density budget below
 * is what actually decides how many survive. It exists so a runaway
 * generation cannot hand the normalize pass thousands of entries.
 */
export const SfxPlanSchema = z.object({
  placements: z.array(SfxPlacementSchema).max(64),
});
export type SfxPlan = z.infer<typeof SfxPlanSchema>;

/**
 * Bump whenever `SFX_SYSTEM`/`buildSfxUserPrompt` change what they ask for —
 * the placement cache key carries it, the same §78 posture as
 * PRODUCER_PROMPT_VERSION and YOUTUBE_PROMPT_VERSION. An old cached plan must
 * not survive a new prompt.
 */
export const SFX_PROMPT_VERSION = 1;

/** Placements per minute of runtime, by level. */
export const SFX_PER_MIN: Record<SfxLevel, number> = { subtle: 2, normal: 4, meme: 8 };

/**
 * Floors, so a 20-second take is not silently sound-designed to zero. Same
 * shape as the §29 short-take graphics floor: under a threshold, a COUNT
 * beats a rate — a per-minute budget on a short take rounds to nothing, and
 * short is exactly where the user asked for sound design.
 */
export const SFX_MIN_PLACEMENTS: Record<SfxLevel, number> = { subtle: 1, normal: 2, meme: 3 };

/**
 * Two effects inside 1.5s read as one glitch rather than two beats, and the
 * tails overlap for most of the starter pack (durations run 0.2–1.6s).
 * Enforced here rather than asked for, because spacing is arithmetic.
 */
export const SFX_MIN_SPACING_SEC = 1.5;

/**
 * Why a placement is not in the final plan.
 *
 * A zod enum rather than a bare TS union because these reasons come BACK from
 * disk: produce caches the accounting beside the plan (`sfx-<key>.json`) so a
 * cached re-run can print the same line, and a value read from a file is
 * parsed, never coerced (CLAUDE.md). The last two are the RESOLVER's
 * (`resolveSfxCues`), emitted long after planning — named here so
 * `formatSfxAccounting`, shared by the console and report.txt, counts them
 * alongside the planning drops:
 *  - "cut word": the anchor word was removed by the cut.
 *  - "missing file": the library still knows the sound, but its file is gone
 *    (a user pack deleted between planning and a re-render) — distinct from
 *    "unknown sound", which is an id the library no longer has at all.
 */
export const SfxDropReasonSchema = z.enum([
  "unknown sound",
  "meme level",
  "outside transcript",
  "too close",
  "over budget",
  "invalid",
  "cut word",
  "missing file",
]);
export type SfxDropReason = z.infer<typeof SfxDropReasonSchema>;

/** Fixed print order, so the accounting line is stable run to run. */
const DROP_REASONS: SfxDropReason[] = [
  "cut word",
  "missing file",
  "unknown sound",
  "meme level",
  "outside transcript",
  "too close",
  "over budget",
  "invalid",
];

export const SfxValidationIssueSchema = z.object({
  /** Index of the offending placement in the model's plan, or -1 plan-wide. */
  placement: z.number().int(),
  reason: SfxDropReasonSchema,
  issue: z.string(),
});
export type SfxValidationIssue = z.infer<typeof SfxValidationIssueSchema>;

/**
 * The sounds a level may use. Meme-tagged sounds are omitted from the menu
 * entirely below `meme`, rather than asked-not-to-use: a sound the model
 * cannot see is a sound it cannot pick, and `normalizeSfxPlan` re-checks
 * anyway (a cached plan or a hallucinated id never passed through this menu).
 */
export function eligibleSfxSounds(
  sounds: readonly LoadedSfxSound[],
  level: SfxLevel,
): LoadedSfxSound[] {
  if (level === "meme") return [...sounds];
  return sounds.filter((s) => !s.tags.includes(SFX_MEME_TAG));
}

/** Runtime in seconds, measured like beats.ts: first word start → last word end. */
function transcriptRuntime(transcript: Transcript): number {
  const words = transcript.words;
  if (words.length === 0) return 0;
  return Math.max(0, words[words.length - 1]!.end - words[0]!.start);
}

/**
 * How many placements this take may carry. ONE implementation, called by both
 * the prompt (which states the number) and the normalize pass (which enforces
 * it) — two copies of this arithmetic is how the model gets asked for a
 * budget the deterministic pass then contradicts (§154's two-copies lesson).
 */
export function sfxBudget(
  transcript: Transcript,
  level: SfxLevel,
): { max: number; runtimeSec: number } {
  const runtimeSec = transcriptRuntime(transcript);
  // The epsilon is beats.ts's float posture: a runtime that is 60s to the
  // eye can be 59.999999s in the stamps, and the boundary case is exactly
  // the one a user counts.
  const byRate = Math.floor((SFX_PER_MIN[level] * runtimeSec) / 60 + 1e-6);
  return { max: Math.max(SFX_MIN_PLACEMENTS[level], byRate), runtimeSec };
}

/** How much sound design each level wants, in the model's own terms. */
const LEVEL_GUIDANCE: Record<SfxLevel, string> = {
  subtle:
    "SUBTLE: sound design you notice only if you look for it. Transitions and the single " +
    "biggest payoff, nothing more. When in doubt, place nothing.",
  normal:
    "NORMAL: tasteful punctuation. Graphic entrances, list items landing, the key takeaway. " +
    "Silence is still the default — an effect earns its place or it is noise.",
  meme:
    "MEME: comedic timing is allowed and meme sounds are on the menu. Still one effect per " +
    "beat, never a stack — a meme sound lands because the moment before it was quiet.",
};

export const SFX_SYSTEM = `You are the sound designer for a short video that has already been cut and storyboarded. You receive the sound library you may use, the graphics plan, and a word-indexed transcript.

Your job is PLACEMENT, not authorship: choose sounds FROM THE LIBRARY and anchor each one to the transcript word it should fire on.

Rules:
- Only ids from the library below. Never invent a sound.
- One anchor word per placement. The effect fires at that word and plays for its own length.
- Effects punctuate; they do not score. Long stretches with no effect are correct.
- Never two effects on top of each other — leave at least ${SFX_MIN_SPACING_SEC} seconds of speech between placements.
- Sync with the graphics plan where it helps: a whoosh on the word a graphic enters on reads as one gesture.
- Match the sound to what is being SAID, using its "when to use" line. A confirmation sound on a failure is worse than silence.
- Respect the placement budget stated in the prompt. Fewer, better-placed effects beat hitting the number.`;

/**
 * The user half of the placement call.
 *
 * The transcript numbering is beats.ts's `[i]word` shape (beats.ts:198-200),
 * restated rather than imported because the two prompts must agree on what a
 * "word index" means — every downstream index in this pipeline is a position
 * in THIS list.
 */
export function buildSfxUserPrompt(
  transcript: Transcript,
  sheet: BeatSheet,
  sounds: readonly LoadedSfxSound[],
  level: SfxLevel,
): string {
  const eligible = eligibleSfxSounds(sounds, level);
  // The scene-registry menu shape (beats.ts:201-203): the library is a list of
  // items with a whenToUse line, which is the format the producer prompt has
  // already been tuned against.
  const menu = eligible.map((s) => `- ${s.id}: ${s.whenToUse}`).join("\n");
  const words = transcript.words.map((w, i) => `[${i}]${w.text}`).join(" ");
  const { max, runtimeSec } = sfxBudget(transcript, level);
  const moments = sheet.moments
    .map(
      (m) =>
        `- words [${m.startWord}..${m.endWord}] ${m.sceneKind === "none" ? "talking head" : m.sceneKind}` +
        (m.sceneKind === "none" ? "" : `: "${m.onScreenCopy}"`) +
        ` — ${m.purpose}`,
    )
    .join("\n");
  return (
    `Level: ${level}\n${LEVEL_GUIDANCE[level]}\n\n` +
    `Runtime: ${runtimeSec.toFixed(1)}s. Place AT MOST ${max} sound effects.\n\n` +
    `Sound library (use these ids and nothing else):\n${menu}\n\n` +
    // The graphics plan sits above the transcript for the same reason the
    // framing brief does in beats.ts: the constraint is read before the
    // content it constrains.
    `Graphics plan (hook: "${sheet.hook}") — a graphic ENTERS at its first word:\n${moments}\n\n` +
    `Word-indexed transcript (word indices refer to THIS list):\n${words}`
  );
}

/**
 * Everything between the model and the render. Passes run in a fixed order,
 * each dropping rather than repairing, because a placement is one sound at
 * one word: there is nothing to salvage in a wrong one, unlike a beat-sheet
 * moment whose end can be clamped back into range.
 *
 * Order matters: identity first (unknown id, meme gate), then position, then
 * the relational passes (spacing, budget) which only make sense once the
 * survivors are known and sorted.
 */
export function normalizeSfxPlan(
  plan: SfxPlan,
  transcript: Transcript,
  sounds: readonly LoadedSfxSound[],
  level: SfxLevel,
): { plan: SfxPlan; issues: SfxValidationIssue[] } {
  const issues: SfxValidationIssue[] = [];
  const byId = new Map(sounds.map((s) => [s.id, s]));
  const maxIndex = transcript.words.length - 1;
  const drop = (placement: number, reason: SfxDropReason, issue: string): void => {
    issues.push({ placement, reason, issue });
  };

  // Carries the model's own index so every issue names the placement the
  // model wrote, not a position in some intermediate array.
  let kept: Array<{ index: number; placement: SfxPlacement }> = [];
  for (let i = 0; i < plan.placements.length; i++) {
    const p = plan.placements[i]!;
    const sound = byId.get(p.soundId);
    if (!sound) {
      drop(i, "unknown sound", `unknown soundId "${p.soundId}"`);
      continue;
    }
    // Belt and braces over the menu gate in `buildSfxUserPrompt`: a plan
    // restored from cache was built against a different level, and a model
    // can name a sound it was never shown.
    if (level !== "meme" && sound.tags.includes(SFX_MEME_TAG)) {
      drop(i, "meme level", `"${p.soundId}" is meme-tagged; level is ${level}`);
      continue;
    }
    // beats.ts:394's posture for the START anchor: out of range is a DROP,
    // never a clamp. beats clamps `endWord` because the moment survives with
    // a shorter span; an SFX anchor IS the placement, so clamping it would
    // fire a sound on a word nobody chose.
    if (!Number.isInteger(p.word) || p.word < 0 || p.word > maxIndex) {
      drop(i, "outside transcript", `word ${p.word} beyond transcript (${Math.max(0, maxIndex)})`);
      continue;
    }
    kept.push({ index: i, placement: p });
  }

  // Stable sort by anchor: two placements on the same word keep the model's
  // order, so the spacing pass drops the LATER-written one deterministically.
  kept.sort((a, b) => a.placement.word - b.placement.word || a.index - b.index);

  const at = (p: SfxPlacement): number => transcript.words[p.word]!.start;
  const spaced: typeof kept = [];
  for (const entry of kept) {
    const prev = spaced[spaced.length - 1];
    if (prev && at(entry.placement) - at(prev.placement) < SFX_MIN_SPACING_SEC - 1e-6) {
      drop(
        entry.index,
        "too close",
        `"${entry.placement.soundId}" at word ${entry.placement.word} is ` +
          `${(at(entry.placement) - at(prev.placement)).toFixed(2)}s after "${prev.placement.soundId}" ` +
          `(min ${SFX_MIN_SPACING_SEC}s)`,
      );
      continue;
    }
    spaced.push(entry);
  }

  // Keep the EARLIEST N. Not "the best N": nothing here can rank placements,
  // and dropping from the front would strip the hook — the one moment the
  // whole grammar says must land.
  const { max } = sfxBudget(transcript, level);
  for (const over of spaced.slice(max)) {
    drop(
      over.index,
      "over budget",
      `"${over.placement.soundId}" at word ${over.placement.word} over the ${max} placement budget (level ${level})`,
    );
  }
  kept = spaced.slice(0, max);

  // Last gate, fail-soft per entry (the scene-props batch posture): callers
  // hand us plans reloaded from a cache file as well as fresh model output,
  // and one malformed entry must cost that entry only. It also applies the
  // schema's defaults to whatever survives.
  const placements: SfxPlacement[] = [];
  for (const entry of kept) {
    const parsed = SfxPlacementSchema.safeParse(entry.placement);
    if (!parsed.success) {
      drop(entry.index, "invalid", `placement failed validation: ${parsed.error.message}`);
      continue;
    }
    placements.push(parsed.data);
  }

  return { plan: { placements }, issues };
}

/**
 * The one-line SFX accounting, shared by the console and report.txt so the
 * two can never say different things about the same run (the
 * `formatGraphicsAccounting` contract, §118b).
 *
 * `issues` may include the resolver's "cut word" drops, which happen after
 * planning — this formatter is the only place the two sets are counted
 * together.
 */
export function formatSfxAccounting(
  placed: number,
  planned: number,
  level: SfxLevel,
  issues: readonly SfxValidationIssue[],
): string {
  const counts = new Map<SfxDropReason, number>();
  for (const i of issues) counts.set(i.reason, (counts.get(i.reason) ?? 0) + 1);
  const breakdown = DROP_REASONS.filter((r) => counts.has(r))
    .map((r) => `${counts.get(r)} ${r}`)
    .join(", ");
  const dropped = Math.max(0, planned - placed);
  return (
    `sfx: ${placed} of ${planned} planned placed (level ${level}` +
    (dropped > 0 ? `, ${dropped} dropped${breakdown ? `: ${breakdown}` : ""}` : "") +
    ")"
  );
}

/**
 * The placement call. `planned` is the count the MODEL returned, before the
 * deterministic passes — what "of N planned" means in the accounting line.
 */
export async function generateSfxPlan(
  provider: LlmProvider,
  transcript: Transcript,
  sheet: BeatSheet,
  sounds: readonly LoadedSfxSound[],
  level: SfxLevel,
): Promise<{ plan: SfxPlan; issues: SfxValidationIssue[]; planned: number }> {
  const raw = await provider.complete({
    system: SFX_SYSTEM,
    user: buildSfxUserPrompt(transcript, sheet, sounds, level),
    schema: SfxPlanSchema,
    schemaName: "sfx_plan",
    // Mechanical, not editorial (the §37 tiering rule): the editorial
    // judgement — what this video is about, where its beats are — was already
    // bought by the beat sheet, and this call picks from a fixed menu against
    // it. `normalizeSfxPlan` is the real gate on the answer, so a small model
    // getting it wrong costs a dropped placement, not a bad video.
    tier: "mechanical",
  });
  return { ...normalizeSfxPlan(raw, transcript, sounds, level), planned: raw.placements.length };
}
