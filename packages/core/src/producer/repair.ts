import { z } from "zod/v4";
import type { Transcript, Word } from "../schema";
import type { Scene } from "../scene-schema";
import { soundsSimilar } from "../phonetics";
import type { LlmProvider } from "./provider";

/**
 * Transcript repair (FINDINGS §17/§21).
 *
 * ASR mishearings used to reach the screen twice over: once in the captions
 * (raw ASR), and once as pressure on the producer, which was told to repair
 * mishearings in its copy and then had `checkGrounding` report the repair as
 * an invention. Worse, the two halves disagreed *in the same frame* — a
 * graphic reading "Orchestration Tax" over a caption reading "Orchestration
 * text".
 *
 * The fix is to repair ONCE, up front, and let one transcript feed captions,
 * the producer and the grounding check. Everything downstream then agrees by
 * construction rather than by luck.
 *
 * The pass is deliberately narrow: it may only swap words for words that
 * SOUND THE SAME. These words end up on screen, so an LLM must not be able to
 * paraphrase, censor, or tidy up what the speaker actually said.
 */

export const TranscriptRepairSchema = z.object({
  repairs: z
    .array(
      z.object({
        startWord: z.number().int().nonnegative(),
        endWord: z.number().int().nonnegative(),
        /** The ASR text being replaced — quoted back as the anchor we verify. */
        heard: z.string().max(80),
        correction: z.string().max(80),
      }),
    )
    // A ceiling, not a target: rewriting a large fraction of a take under a
    // guard that cannot hear the audio is not repair, it is redrafting.
    .max(12),
});

/** A repair may not restructure a sentence — these bound "swapped a word". */
const MAX_SPAN_WORDS = 4;
const MAX_TOKEN_DELTA = 1;
const MAX_LENGTH_RATIO = 2;
/** Words shorter than this get dropped by TimeMap.mapWord — never emit them. */
const MIN_WORD_SEC = 0.04;
/** How far from the claimed index to look for the quoted text. */
const INDEX_SEARCH_RADIUS = 3;
export type TranscriptRepair = z.infer<typeof TranscriptRepairSchema>["repairs"][number];

export interface AppliedRepair {
  startWord: number;
  endWord: number;
  heard: string;
  correction: string;
  applied: boolean;
  /** Why a proposal was refused — surfaced, never swallowed. */
  rejected?: string;
}

export const REPAIR_SYSTEM = `You correct speech-recognition errors in a transcript. The corrected words are shown on screen as captions, so this job is narrow and literal.

Fix ONLY mishearings: places where the recognizer produced words that sound like what was said but are the wrong words. Typical cases: a common phrase turned into an unfamiliar proper noun ("code churn" heard as "CodeChun" or "coach and"), or a word swapped for a near-homophone ("tax" heard as "text").

You MUST NOT:
- paraphrase, reword, shorten or improve anything;
- fix grammar, punctuation or capitalisation;
- remove filler words, stutters or repetition — they are part of the take;
- censor or soften anything;
- "correct" a word that is merely unusual but plausible as spoken.

A correction must sound essentially identical to what was heard. If a span is not clearly a mishearing, leave it alone. Returning an empty list is the correct answer for a clean transcript.

For each fix give the word-index span, the exact text you are replacing (\`heard\`), and the corrected text.`;

export function buildRepairUserPrompt(transcript: Transcript): string {
  const words = transcript.words.map((w, i) => `[${i}]${w.text}`).join(" ");
  return (
    `Word-indexed transcript (indices refer to THIS list):\n${words}\n\n` +
    `Report only spans that are clearly mishearings.`
  );
}

/** Comparable form: case- and punctuation-insensitive. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function spanText(transcript: Transcript, startWord: number, endWord: number): string {
  return transcript.words
    .slice(startWord, endWord + 1)
    .map((w) => w.text)
    .join(" ");
}

/**
 * Re-time a correction over the span it replaces.
 *
 * When the token count is unchanged — the common case, "coach and" → "code
 * churn" — the ASR's own word boundaries are MEASURED onsets, so they are
 * kept and only the text changes. Guessing new boundaries there would throw
 * away real information. Only a count change forces a split, and then the
 * span is divided proportionally to token length.
 *
 * Either way timings stay inside the original span and strictly increasing,
 * which is what `TimeMap.mapWord` and `buildCaptionLines` rely on.
 */
function retime(tokens: string[], originals: readonly Word[]): Word[] {
  if (tokens.length === originals.length) {
    return tokens.map((text, i) => ({ ...originals[i]!, text }));
  }
  const start = originals[0]!.start;
  const end = originals[originals.length - 1]!.end;
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Word[] = [];
  let cursor = start;
  for (let i = 0; i < tokens.length; i++) {
    const share = ((end - start) * weights[i]!) / total;
    const wordEnd = i === tokens.length - 1 ? end : cursor + share;
    out.push({ text: tokens[i]!, start: cursor, end: wordEnd });
    cursor = wordEnd;
  }
  return out;
}

/** Would a split produce words too short to survive the TimeMap? */
function tooShort(tokens: string[], originals: readonly Word[]): boolean {
  if (tokens.length === originals.length) return false;
  const span = originals[originals.length - 1]!.end - originals[0]!.start;
  return span / tokens.length < MIN_WORD_SEC;
}

/**
 * Apply proposed repairs, refusing anything that isn't demonstrably a
 * mishearing of the span it claims to fix. Pure — the LLM is only a source of
 * proposals; every guard below is deterministic and testable.
 */
export interface ApplyRepairsOptions {
  /**
   * True when the given source-time span contains a cut. A repair straddling
   * a removal would merge words across the cut, so it is refused.
   */
  isCut?: (startSec: number, endSec: number) => boolean;
}

export function applyRepairs(
  transcript: Transcript,
  repairs: readonly TranscriptRepair[],
  opts: ApplyRepairsOptions = {},
): { transcript: Transcript; applied: AppliedRepair[] } {
  const maxIndex = transcript.words.length - 1;
  const results: AppliedRepair[] = [];
  const accepted: Array<{ startWord: number; endWord: number; tokens: string[] }> = [];
  const claimed: Array<[number, number]> = [];

  /**
   * The model quoted `heard` by copying from the prompt, so it is reliable;
   * what it gets wrong is index arithmetic over hundreds of `[i]word` tokens.
   * So trust the text and re-derive the index: look for the quoted words near
   * the claimed position and use where they actually are.
   */
  const locate = (r: TranscriptRepair): { startWord: number; endWord: number } | null => {
    const want = norm(r.heard);
    const width = r.endWord - r.startWord;
    for (let delta = 0; delta <= INDEX_SEARCH_RADIUS; delta++) {
      for (const start of delta === 0 ? [r.startWord] : [r.startWord - delta, r.startWord + delta]) {
        const end = start + width;
        if (start < 0 || end > maxIndex) continue;
        if (norm(spanText(transcript, start, end)) === want) return { startWord: start, endWord: end };
      }
    }
    return null;
  };

  for (const r of repairs) {
    let located: { startWord: number; endWord: number } | null = null;
    const record = (rejected?: string): void => {
      results.push({
        startWord: located?.startWord ?? r.startWord,
        endWord: located?.endWord ?? r.endWord,
        heard: r.heard,
        correction: r.correction,
        applied: rejected === undefined,
        ...(rejected === undefined ? {} : { rejected }),
      });
    };

    if (r.endWord < r.startWord) {
      record("span ends before it starts");
      continue;
    }
    if (r.endWord - r.startWord + 1 > MAX_SPAN_WORDS) {
      record(`span of ${r.endWord - r.startWord + 1} words is a rewrite, not a mishearing`);
      continue;
    }
    located = locate(r);
    if (located === null) {
      record(`quoted "${r.heard}" but no span near ${r.startWord} matches it`);
      continue;
    }
    if (claimed.some(([s, e]) => located!.startWord <= e && located!.endWord >= s)) {
      record("span overlaps an earlier repair");
      continue;
    }

    const originals = transcript.words.slice(located.startWord, located.endWord + 1);
    const actual = originals.map((w) => w.text).join(" ");
    const tokens = r.correction.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      record("empty correction");
      continue;
    }
    if (norm(actual) === norm(r.correction)) {
      record("correction is identical to what was heard");
      continue;
    }
    if (Math.abs(tokens.length - originals.length) > MAX_TOKEN_DELTA) {
      record(`${originals.length} words → ${tokens.length} restructures the sentence`);
      continue;
    }
    const ratio = r.correction.length / Math.max(1, actual.length);
    if (ratio > MAX_LENGTH_RATIO || ratio < 1 / MAX_LENGTH_RATIO) {
      record(`"${r.correction}" is too different in length from "${actual}"`);
      continue;
    }
    if (!soundsSimilar(actual, r.correction)) {
      // The gate that keeps this a repair pass and not a rewrite pass.
      record(`"${r.correction}" does not sound like "${actual}" — rewrite, not a repair`);
      continue;
    }
    if (tooShort(tokens, originals)) {
      record("split would produce words too short to survive the time map");
      continue;
    }
    if (opts.isCut?.(originals[0]!.start, originals[originals.length - 1]!.end)) {
      record("span straddles a cut");
      continue;
    }

    claimed.push([located.startWord, located.endWord]);
    accepted.push({ ...located, tokens });
    record();
  }

  // Back to front: a repair may change the word count, and every span index
  // ahead of the edit point must stay valid while the rest are applied.
  const words = [...transcript.words];
  for (const r of [...accepted].sort((a, b) => b.startWord - a.startWord)) {
    const originals = words.slice(r.startWord, r.endWord + 1);
    words.splice(r.startWord, originals.length, ...retime(r.tokens, originals));
  }

  return { transcript: { ...transcript, words }, applied: results };
}

/**
 * One LLM call, then the deterministic guards. Fail-soft: a provider that
 * throws (or returns nothing usable) yields zero repairs and the raw
 * transcript, never a failed render — the same degrade-don't-fail policy the
 * scene-props call follows.
 */
export async function repairTranscript(
  provider: LlmProvider,
  transcript: Transcript,
  opts: ApplyRepairsOptions = {},
): Promise<{ transcript: Transcript; applied: AppliedRepair[]; error?: string }> {
  if (transcript.words.length === 0) return { transcript, applied: [] };
  try {
    const result = await provider.complete({
      system: REPAIR_SYSTEM,
      user: buildRepairUserPrompt(transcript),
      schema: TranscriptRepairSchema,
      schemaName: "transcript_repair",
      maxTokens: 4000,
    });
    return applyRepairs(transcript, result.repairs, opts);
  } catch (err) {
    return {
      transcript,
      applied: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- §21: the producer's copy and the captions must spell words the same ---

/** Props whose text is lifted from what the speaker said (not stylised copy). */
const COPY_FIELDS: Record<string, string[]> = {
  TitleCard: ["eyebrow", "title", "sub"],
  StatCard: ["label", "caption"],
  RuleCard: ["kicker", "text", "struck"],
  StrikethroughReveal: ["lines"],
  FlowDiagram: ["nodes"],
  ScreenshotFrame: ["label"],
};

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/**
 * Same word, different inflection — "SHIP" for "shipped", "AGENTS" for
 * "agent". These sound alike by construction, but the producer shortening a
 * word for the screen is EDITING, not a recognizer error, and rewriting the
 * caption to match would put words in the speaker's mouth.
 */
function isInflection(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return false;
  return long.length - short.length <= 3;
}

/**
 * Copy the original word's capitalisation onto the replacement, so a caption
 * corrected from an ALL-CAPS on-screen label still reads as speech.
 */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) return replacement.toUpperCase();
  if (/^[A-Z]/.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement.toLowerCase();
}

/**
 * Reconciliation demands a closer match than the repair pass: this is a
 * single-word swap with no resegmentation to excuse a low score.
 */
const RECONCILE_FLOOR = 0.6;

/**
 * Reconcile caption text with the on-screen copy (FINDINGS §21).
 *
 * The repair pass runs before the producer, so normally both sides already
 * agree. This catches the residue: where a scene's copy contains a word that
 * SOUNDS LIKE — but isn't spelled like — a word the speaker says underneath
 * it, the producer's spelling wins and the caption is corrected to match.
 * That is the "Orchestration Tax" / "Orchestration text" case.
 *
 * Strictly a 1:1 word substitution: word count and all timings are untouched,
 * so scene anchors stay valid and this is safe to run after the producer.
 */
export function reconcileCopy(
  transcript: Transcript,
  scenes: readonly Scene[],
): { transcript: Transcript; applied: AppliedRepair[] } {
  const words = [...transcript.words];
  const applied: AppliedRepair[] = [];
  const spokenExactly = new Set(words.map((w) => norm(w.text)).filter(Boolean));

  for (const scene of scenes) {
    const fields = COPY_FIELDS[scene.component] ?? [];
    const merged = { ...scene.props, ...scene.overrides };
    const copyTokens = fields
      .flatMap((f) => stringsOf(merged[f]))
      .flatMap((s) => s.split(/\s+/))
      .map((t) => t.replace(/[^A-Za-z]/g, ""))
      .filter((t) => t.length >= 3);

    for (let i = scene.anchor.startWord; i <= Math.min(scene.anchor.endWord, words.length - 1); i++) {
      const spoken = words[i]!;
      const key = norm(spoken.text);
      if (!key || key.length < 3) continue;
      for (const token of copyTokens) {
        const candidate = norm(token);
        if (candidate === key) break; // already agrees
        // Only correct toward a word the take never says: if the copy's word
        // appears verbatim elsewhere in the transcript, the speaker used both
        // and this is not a mishearing.
        if (spokenExactly.has(candidate)) continue;
        // "SHIP" for "shipped" is the producer editing for the screen, not
        // the recognizer erring — the caption keeps what was actually said.
        if (isInflection(candidate, key)) continue;
        if (!soundsSimilar(spoken.text, token, RECONCILE_FLOOR)) continue;
        const correction = matchCase(spoken.text, token);
        applied.push({
          startWord: i,
          endWord: i,
          heard: spoken.text,
          correction,
          applied: true,
        });
        words[i] = { ...spoken, text: correction };
        break;
      }
    }
  }

  return { transcript: { ...transcript, words }, applied };
}
