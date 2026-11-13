import { z } from "zod/v4";
import {
  captionKeyFor,
  CaptionPhraseRoleSchema,
  type CaptionChoreography,
  type CaptionChoreographyPhraseSchema,
  type CaptionPhraseRole,
} from "../captions";
import type { LlmProvider } from "./provider";

export const CAPTION_CHOREOGRAPHY_PROMPT_VERSION = 1;

export interface ChoreographyInputWord {
  text: string;
  /** Output clock start in seconds (starts near 0.0 even on --clip runs). */
  start: number;
  /** Output clock end in seconds. */
  end: number;
  /** Source clock start in seconds (stable across editor cuts). */
  srcStart: number;
}

export const RawChoreographyLlmSchema = z.object({
  phrases: z.array(
    z.object({
      startWord: z.number().int().nonnegative(),
      endWord: z.number().int().nonnegative(),
      role: CaptionPhraseRoleSchema.optional(),
    }),
  ),
  emphasis: z
    .array(
      z.object({
        word: z.number().int().nonnegative(),
        scale: z.number(),
      }),
    )
    .default([]),
});
export type RawChoreographyLlm = z.infer<typeof RawChoreographyLlmSchema>;

const SYSTEM_PROMPT = `You are a short-form and launch-video caption choreographer (inspired by high-retention builder launch videos).
Your job is to group spoken words into natural semantic phrases and select key metrics, numbers, or hook words for size emphasis.

Rules:
1. Cover every word index from 0 to N-1 in contiguous, non-overlapping [startWord, endWord] phrases.
2. Group by natural spoken syntax (clauses, prepositional phrases, metric + unit pairs like "in 48 hours"), never splitting a number from its noun.
3. Keep phrases within 1-5 words for 9:16 portrait or 2-7 words for 16:9 landscape.
4. Tag at most the first 1-2 phrases starting before 4.0s as role: "hook".
5. Tag rare 1-2 word punchlines or CTAs (at least 15s apart) as role: "impact". All other phrases use role: "body".
6. Emphasize at most 1-2 words per phrase (and < 25% of total words) with scale in [1.15, 1.35].`;

export function buildCaptionChoreographyPrompt(
  words: readonly ChoreographyInputWord[],
  aspect: "9:16" | "16:9",
): string {
  const lines = words.map((w, i) => `[${i}|${w.start.toFixed(2)}s] ${w.text}`);
  return [
    `Aspect ratio: ${aspect}`,
    `Total words: ${words.length}`,
    `Transcript words ([index|outputStartSec] word):`,
    lines.join("\n"),
  ].join("\n\n");
}

export interface ValidateChoreographyOptions {
  aspect?: "9:16" | "16:9";
  maxGap?: number;
}

const HOOK_MAX_START_SEC = 4.0;
const HOOK_MAX_PHRASES = 2;
const IMPACT_MIN_SPACING_SEC = 15.0;

/**
 * Deterministically validates and normalizes raw LLM choreography output into
 * a source-anchored `CaptionChoreography` artifact.
 *
 * Guarantees:
 * - Every word 0..N-1 is covered once in monotonically increasing order.
 * - Over-length phrases or phrases spanning speech pauses > maxGap are split.
 * - Per-word emphasisScale is clamped to [1.0, 1.4], capped at <= 2 words per
 *   phrase and <= 25% of total words (tie-broken by scale desc, word index asc).
 * - "hook" is restricted to the first 4.0s (max 2 phrases); "impact" is
 *   restricted to <= 2-word phrases with >= 1.15x emphasis spaced >= 15.0s apart.
 */
export function validateCaptionChoreography(
  raw: RawChoreographyLlm,
  words: readonly ChoreographyInputWord[],
  opts: ValidateChoreographyOptions = {},
): CaptionChoreography {
  if (words.length === 0) {
    return { phrases: [], words: {} };
  }

  const isLandscape = opts.aspect === "16:9";
  const defaultPackMax = isLandscape ? 6 : 3;
  const maxChoreoWords = isLandscape ? 8 : 5;
  const maxGap = opts.maxGap ?? 0.6;
  const n = words.length;

  interface IndexedSpan {
    startWord: number;
    endWord: number;
    role?: CaptionPhraseRole;
  }

  const pushGreedyFallback = (from: number, to: number, target: IndexedSpan[]) => {
    let chunkStart = from;
    for (let i = from; i <= to; i++) {
      const gap = i > chunkStart ? words[i]!.start - words[i - 1]!.end : 0;
      if (i - chunkStart >= defaultPackMax || gap > maxGap) {
        target.push({ startWord: chunkStart, endWord: i - 1 });
        chunkStart = i;
      }
    }
    if (chunkStart <= to) {
      target.push({ startWord: chunkStart, endWord: to });
    }
  };

  const pushSplitChoreoSpan = (
    from: number,
    to: number,
    role: CaptionPhraseRole | undefined,
    target: IndexedSpan[],
  ) => {
    let chunkStart = from;
    let firstSub = true;
    for (let i = from; i <= to; i++) {
      const gap = i > chunkStart ? words[i]!.start - words[i - 1]!.end : 0;
      if (i - chunkStart >= maxChoreoWords || gap > maxGap) {
        target.push({
          startWord: chunkStart,
          endWord: i - 1,
          role: firstSub && role === "hook" ? "hook" : undefined,
        });
        chunkStart = i;
        firstSub = false;
      }
    }
    if (chunkStart <= to) {
      const unsplit = firstSub;
      target.push({
        startWord: chunkStart,
        endWord: to,
        role: unsplit ? role : undefined,
      });
    }
  };

  const sortedRaw = [...raw.phrases]
    .filter((p) => Number.isInteger(p.startWord) && Number.isInteger(p.endWord))
    .sort((a, b) => a.startWord - b.startWord);

  const spans: IndexedSpan[] = [];
  let cursor = 0;

  for (const p of sortedRaw) {
    if (cursor >= n) break;
    const start = Math.max(cursor, Math.min(n - 1, p.startWord));
    const end = Math.min(n - 1, p.endWord);
    if (end < start) continue;
    if (start > cursor) {
      pushGreedyFallback(cursor, start - 1, spans);
    }
    pushSplitChoreoSpan(start, end, p.role, spans);
    cursor = end + 1;
  }

  if (cursor < n) {
    pushGreedyFallback(cursor, n - 1, spans);
  }

  // Resolve word emphasis budget: clamp to [1.0, 1.4], filter > 1.05, sort by scale desc then word index asc
  const maxTotalEmphasized = Math.max(1, Math.floor(n * 0.25));
  const spanForWord = new Int32Array(n).fill(-1);
  spans.forEach((s, idx) => {
    for (let w = s.startWord; w <= s.endWord; w++) {
      spanForWord[w] = idx;
    }
  });

  const dedupedEmphasis = new Map<number, number>();
  for (const item of raw.emphasis ?? []) {
    if (item.word < 0 || item.word >= n || !Number.isFinite(item.scale)) continue;
    const clamped = Math.round(Math.max(1.0, Math.min(1.4, item.scale)) * 100) / 100;
    if (clamped <= 1.05) continue;
    const prev = dedupedEmphasis.get(item.word) ?? 0;
    if (clamped > prev) dedupedEmphasis.set(item.word, clamped);
  }

  const rankedCandidates = [...dedupedEmphasis.entries()]
    .map(([word, scale]) => ({ word, scale }))
    .sort((a, b) => (b.scale !== a.scale ? b.scale - a.scale : a.word - b.word));

  const perSpanEmphasisCount = new Map<number, number>();
  const acceptedEmphasis = new Map<number, number>();

  for (const cand of rankedCandidates) {
    if (acceptedEmphasis.size >= maxTotalEmphasized) break;
    const sIdx = spanForWord[cand.word] ?? -1;
    const countInSpan = sIdx >= 0 ? (perSpanEmphasisCount.get(sIdx) ?? 0) : 0;
    if (countInSpan >= 2) continue;
    acceptedEmphasis.set(cand.word, cand.scale);
    if (sIdx >= 0) perSpanEmphasisCount.set(sIdx, countInSpan + 1);
  }

  // Enforce spatial stability budget on output clock
  let hookCount = 0;
  let lastImpactEndSec = -Infinity;

  const phrases: z.infer<typeof CaptionChoreographyPhraseSchema>[] = spans.map((s, idx) => {
    const firstWord = words[s.startWord]!;
    const lastWord = words[s.endWord]!;
    const wordCount = s.endWord - s.startWord + 1;
    let role: CaptionPhraseRole | undefined;

    if (s.role === "hook") {
      if (idx < HOOK_MAX_PHRASES && hookCount < HOOK_MAX_PHRASES && firstWord.start < HOOK_MAX_START_SEC) {
        role = "hook";
        hookCount++;
      }
    } else if (s.role === "impact") {
      let hasStrongEmphasis = false;
      for (let w = s.startWord; w <= s.endWord; w++) {
        if ((acceptedEmphasis.get(w) ?? 1) >= 1.15) {
          hasStrongEmphasis = true;
          break;
        }
      }
      if (
        wordCount <= 2 &&
        hasStrongEmphasis &&
        firstWord.start - lastImpactEndSec >= IMPACT_MIN_SPACING_SEC
      ) {
        role = "impact";
        lastImpactEndSec = lastWord.end;
      }
    }

    return {
      startSrcSec: firstWord.srcStart,
      endSrcSec: lastWord.srcStart,
      ...(role ? { role } : {}),
    };
  });

  const wordsMap: CaptionChoreography["words"] = {};
  for (const [wIdx, scale] of acceptedEmphasis.entries()) {
    const w = words[wIdx]!;
    wordsMap[captionKeyFor(w.srcStart)] = { emphasisScale: scale };
  }

  return {
    phrases,
    words: wordsMap,
  };
}

export async function generateCaptionChoreography(
  provider: LlmProvider,
  args: {
    words: readonly ChoreographyInputWord[];
    aspect: "9:16" | "16:9";
  },
): Promise<CaptionChoreography> {
  if (args.words.length === 0) {
    return { phrases: [], words: {} };
  }
  const userPrompt = buildCaptionChoreographyPrompt(args.words, args.aspect);
  const raw = await provider.complete({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    schema: RawChoreographyLlmSchema,
    schemaName: "caption_choreography",
    tier: "mechanical",
  });
  return validateCaptionChoreography(raw, args.words, { aspect: args.aspect });
}
