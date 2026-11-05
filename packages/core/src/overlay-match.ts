/**
 * The library matcher (overlay-library spec §Matching): which transcript word
 * is the first spoken mention of each library entry? Deterministic, no LLM.
 *
 * Pure and browser-safe on purpose — no imports at all, not even a type from
 * ./overlay-library (that module is node-only, fs all the way down). The
 * entry and word shapes are re-declared structurally instead, so the edit
 * server's "Find library matches" and the resolver's fall-forward (which
 * calls `mentionsOf`) can both run this in either runtime.
 *
 * Deliberately STRICTER than reveal-match.ts and sharing nothing with it
 * (spec: "my call; wrong-word pops are the main anti-goal"): a logo popping
 * on the wrong word is worse than no logo, because the editor can add a
 * missed one but a wrong one reads as a bug. So: no stemming, no stop words,
 * no minimum token length — only edge punctuation and a possessive are
 * forgiven, symmetrically on both sides.
 */

export interface MatchablePlacement {
  /** `${entryId}@${word}` — the stable matched-placement id (plan Global Constraints). */
  id: string;
  entryId: string;
  word: number;
  source: "match";
}

export interface MatchDrop {
  entryId: string;
  word: number;
  reason: "overlap";
}

type MatchWord = { readonly text: string; readonly start: number; readonly end: number };
type MatchEntry = { readonly id: string; readonly names: readonly string[] };

/**
 * One overlay duration (plan Global Constraints, overlay default 1.5s): two
 * logos starting closer than this would stack on screen.
 */
const DEFAULT_MIN_GAP_SEC = 1.5;

/**
 * Spec §Matching, short-name rule: a single-word name this short ("GDE",
 * "Go", "AI") is too likely to be an ordinary word ("go" the verb), so it
 * must match case-exactly. Whisper writes acronyms in caps, so "GDE" still
 * hits.
 */
const SHORT_NAME_MAX_LETTERS = 3;

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const POSSESSIVE = /['’][sS]$/u;

/**
 * Trim, strip edge punctuation, strip a trailing `'s` / `’s`. Case is KEPT:
 * the short-name rule needs it, and longer names lowercase at compare time.
 * Edge punctuation is stripped again after the possessive so `"GDE's,"` and
 * `“GDE’s”` both land on `GDE`. A plural "GDEs" stays "GDEs" — no stemming.
 */
export function normalizeMatchToken(text: string): string {
  const bare = text.trim().replace(EDGE_PUNCTUATION, "");
  return bare.replace(POSSESSIVE, "").replace(EDGE_PUNCTUATION, "");
}

interface CompiledName {
  entryIndex: number;
  tokens: string[];
  /** Characters across all tokens — the tie-break after token count. */
  chars: number;
  exactCase: boolean;
}

function compileName(name: string, entryIndex: number): CompiledName | null {
  const tokens = name.split(/\s+/).map(normalizeMatchToken).filter(Boolean);
  if (tokens.length === 0) return null;
  const exactCase = tokens.length === 1 && tokens[0]!.length <= SHORT_NAME_MAX_LETTERS;
  return {
    entryIndex,
    tokens: exactCase ? tokens : tokens.map((t) => t.toLowerCase()),
    chars: tokens.reduce((n, t) => n + t.length, 0),
    exactCase,
  };
}

/**
 * The spoken side, prepared once: indices of the kept words in order, with
 * each word's normalized token (as-is for exact-case names, lowercased for
 * the rest). Matching walks this KEPT sequence — spec: the matcher "runs on
 * the kept words" — so a cut word is invisible, never a match site.
 */
interface Spoken {
  index: number[];
  exact: string[];
  lower: string[];
}

function prepareSpoken(words: readonly MatchWord[], kept?: (i: number) => boolean): Spoken {
  const spoken: Spoken = { index: [], exact: [], lower: [] };
  words.forEach((w, i) => {
    if (kept && !kept(i)) return;
    const token = normalizeMatchToken(w.text);
    spoken.index.push(i);
    spoken.exact.push(token);
    spoken.lower.push(token.toLowerCase());
  });
  return spoken;
}

/** Does `name` occur starting at kept position `p`, with none of its words already claimed? */
function matchesAt(spoken: Spoken, p: number, name: CompiledName, claimed?: ReadonlySet<number>): boolean {
  const side = name.exactCase ? spoken.exact : spoken.lower;
  if (p + name.tokens.length > side.length) return false;
  return name.tokens.every((t, k) => side[p + k] === t && !claimed?.has(p + k));
}

/**
 * First mention per entry (spec §Matching). At each kept position, names are
 * tried longest first — token count, then characters — and the winner claims
 * its words, so "Google" can never pop on the "Google" inside "Google
 * Developers Expert". A phrase claims its words even when its entry already
 * placed (or is skipped): a SECOND "Google Developers Expert" is still not a
 * standalone "Google".
 *
 * `skipEntryIds` serves the edit server's "Find library matches": entries
 * already placed or removed by the user. They still compete for words (same
 * reason as above) but never yield a placement.
 *
 * Overlap (spec §Matching): placements whose word STARTS fall within
 * `minGapSec` of the last surviving placement are dropped and reported, the
 * sfx normaliser's posture — the earlier mention keeps the screen.
 */
export function matchLibrary(
  words: readonly MatchWord[],
  entries: readonly MatchEntry[],
  opts: { kept?: (wordIndex: number) => boolean; minGapSec?: number; skipEntryIds?: ReadonlySet<string> } = {},
): { placements: MatchablePlacement[]; dropped: MatchDrop[] } {
  const names = entries
    .flatMap((e, ei) => e.names.map((n) => compileName(n, ei)))
    .filter((n): n is CompiledName => n !== null)
    // Array.prototype.sort is stable, so equal-length names keep library order.
    .sort((a, b) => b.tokens.length - a.tokens.length || b.chars - a.chars);
  const spoken = prepareSpoken(words, opts.kept);
  const claimed = new Set<number>();
  const firstAt = new Map<number, number>(); // entryIndex → kept position

  for (let p = 0; p < spoken.index.length; p++) {
    if (claimed.has(p)) continue;
    const winner = names.find((n) => matchesAt(spoken, p, n, claimed));
    if (!winner) continue;
    for (let k = 0; k < winner.tokens.length; k++) claimed.add(p + k);
    if (!firstAt.has(winner.entryIndex)) firstAt.set(winner.entryIndex, p);
  }

  const minGap = opts.minGapSec ?? DEFAULT_MIN_GAP_SEC;
  const placements: MatchablePlacement[] = [];
  const dropped: MatchDrop[] = [];
  let lastStart = -Infinity;
  const ordered = [...firstAt.entries()]
    .filter(([ei]) => !opts.skipEntryIds?.has(entries[ei]!.id))
    .sort((a, b) => a[1] - b[1]);
  for (const [ei, p] of ordered) {
    const entryId = entries[ei]!.id;
    const word = spoken.index[p]!;
    const start = words[word]!.start;
    if (start - lastStart < minGap) {
      dropped.push({ entryId, word, reason: "overlap" });
      continue;
    }
    lastStart = start;
    placements.push({ id: `${entryId}@${word}`, entryId, word, source: "match" });
  }
  return { placements, dropped };
}

/**
 * Every kept word index where any of one entry's names starts, ascending —
 * the resolver's fall-forward when the user cut the matched mention (spec
 * §Matching, review focus 3). Same normalization and short-name rule as
 * `matchLibrary`, so fall-forward can only land where a fresh match could.
 * No cross-entry claiming: the caller asks about one entry in isolation.
 */
export function mentionsOf(
  words: readonly MatchWord[],
  names: readonly string[],
  kept?: (i: number) => boolean,
): number[] {
  const compiled = names.map((n) => compileName(n, 0)).filter((n): n is CompiledName => n !== null);
  const spoken = prepareSpoken(words, kept);
  const out: number[] = [];
  for (let p = 0; p < spoken.index.length; p++) {
    if (compiled.some((n) => matchesAt(spoken, p, n))) out.push(spoken.index[p]!);
  }
  return out;
}
