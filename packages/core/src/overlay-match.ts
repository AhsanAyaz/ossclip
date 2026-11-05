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

/**
 * Edge punctuation is an explicit list of real sentence punctuation, NOT
 * "anything that isn't a letter or digit" (task-2 review): that wider class
 * reduced `C++` / `C#` / `F#` to a bare `C` / `F` and `.NET` to `NET`, so a
 * "C#" logo popped on "C++" and on a spelled-out letter "C", which is the
 * wrong-word pop the spec's §Matching exists to prevent. `+`, `#` and the
 * like are part of a name. A LEADING `.` survives (`.NET`); a TRAILING one
 * is sentence-final and strips (`GDE.` becomes `GDE`).
 */
const LEADING_PUNCTUATION = /^[\s,!?;:"'“”‘’()[\]{}…—–-]+/u;
const TRAILING_PUNCTUATION = /[\s.,!?;:"'“”‘’()[\]{}…—–-]+$/u;
const POSSESSIVE = /['’][sS]$/u;

/**
 * Trim, strip edge punctuation, strip a trailing `'s` / `’s`. Case is KEPT:
 * the short-name rule needs it, and longer names lowercase at compare time.
 * Edge punctuation is stripped again after the possessive so `"GDE's,"` and
 * `“GDE’s”` both land on `GDE`. A plural "GDEs" stays "GDEs" — no stemming.
 */
export function normalizeMatchToken(text: string): string {
  const stripEdges = (t: string): string => t.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "");
  return stripEdges(stripEdges(text.trim()).replace(POSSESSIVE, ""));
}

/**
 * Can this library name auto-place at all (ruling R18)? A single-token name
 * of ≤3 characters with no uppercase letter cannot: the exact-case rule
 * above only protects a name that HAS capitals to be exact about, and an
 * unindexed `go.png` is named by its lowercase stem — so it popped on
 * "let's go" (final review I2), the wrong-word pop §Matching exists to
 * prevent. Whisper writes the acronyms worth a logo in caps; a name that
 * really is lowercase gets its capitals (or a longer name) in library.json.
 * Manual placement is unaffected — the user chose the word.
 */
export function autoMatchableName(name: string): boolean {
  const tokens = name.split(/\s+/).map(normalizeMatchToken).filter(Boolean);
  if (tokens.length !== 1) return tokens.length > 0;
  const t = tokens[0]!;
  return t.length > SHORT_NAME_MAX_LETTERS || t !== t.toLowerCase();
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
  // Dropped here, not in `matchLibrary` alone, so `mentionsOf` (the
  // fall-forward) agrees: it may only land where a fresh match could.
  if (tokens.length === 0 || !autoMatchableName(name)) return null;
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
    // A punctuation-only word (a standalone "—") normalizes to "" and is
    // skipped, the same way empty NAME tokens are dropped in compileName. If
    // it stayed in the sequence, "Google - Cloud" could never match a spoken
    // "Google — Cloud" (task-2 review). Original word indices are kept.
    if (!token) return;
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
 * Every claimed mention, in spoken order: at each kept position, names are
 * tried longest first — token count, then characters — and the winner claims
 * its words. ONE walk shared by `matchLibrary` and `mentionsOf` (ruling R10):
 * a fall-forward that claimed differently from the matcher could land on a
 * word a fresh match never would.
 */
function claimWalk(spoken: Spoken, entries: readonly MatchEntry[]): { p: number; entryIndex: number }[] {
  const names = entries
    .flatMap((e, ei) => e.names.map((n) => compileName(n, ei)))
    .filter((n): n is CompiledName => n !== null)
    // Array.prototype.sort is stable, so equal-length names keep library order.
    .sort((a, b) => b.tokens.length - a.tokens.length || b.chars - a.chars);
  const claimed = new Set<number>();
  const hits: { p: number; entryIndex: number }[] = [];
  for (let p = 0; p < spoken.index.length; p++) {
    if (claimed.has(p)) continue;
    const winner = names.find((n) => matchesAt(spoken, p, n, claimed));
    if (!winner) continue;
    for (let k = 0; k < winner.tokens.length; k++) claimed.add(p + k);
    hits.push({ p, entryIndex: winner.entryIndex });
  }
  return hits;
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
 *
 * `occupiedStarts` are the OUTPUT-time starts of overlays already on the
 * timeline (the edit server's re-match, Task 6 review): the same overlap
 * rule against them, so "Find library matches" cannot stack a logo onto one
 * the user already has. A candidate dropped for it is reported like any
 * overlap and does NOT advance the gap walk — it never reached the screen,
 * so it must not push a later new match off it.
 */
export function matchLibrary(
  words: readonly MatchWord[],
  entries: readonly MatchEntry[],
  opts: {
    kept?: (wordIndex: number) => boolean;
    minGapSec?: number;
    skipEntryIds?: ReadonlySet<string>;
    occupiedStarts?: readonly number[];
  } = {},
): { placements: MatchablePlacement[]; dropped: MatchDrop[] } {
  const spoken = prepareSpoken(words, opts.kept);
  const firstAt = new Map<number, number>(); // entryIndex → kept position
  for (const { p, entryIndex } of claimWalk(spoken, entries)) {
    if (!firstAt.has(entryIndex)) firstAt.set(entryIndex, p);
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
    const occupied = opts.occupiedStarts?.some((t) => Math.abs(start - t) < minGap) ?? false;
    if (occupied || start - lastStart < minGap) {
      dropped.push({ entryId, word, reason: "overlap" });
      continue;
    }
    lastStart = start;
    placements.push({ id: `${entryId}@${word}`, entryId, word, source: "match" });
  }
  return { placements, dropped };
}

/**
 * Every kept word index where one entry is mentioned, ascending — the
 * resolver's fall-forward when the user cut the matched mention (spec
 * §Matching, review focus 3). Same normalization, short-name rule AND
 * claiming walk as `matchLibrary`, so fall-forward can only land where a
 * fresh match could.
 *
 * `others` are the OTHER entries competing for the same words (ruling R10):
 * without them, a "Google" placement whose mention was cut would fall forward
 * onto the "Google" inside a later "Google Developers Expert" — the exact
 * wrong-word pop longest-name-wins exists to prevent. The asked-about entry
 * goes first, so on an equal-length tie it keeps the word (library order is
 * `matchLibrary`'s tie-break, and here the placement already exists).
 */
export function mentionsOf(
  words: readonly MatchWord[],
  names: readonly string[],
  kept?: (i: number) => boolean,
  others: readonly { readonly names: readonly string[] }[] = [],
): number[] {
  const spoken = prepareSpoken(words, kept);
  const entries: MatchEntry[] = [{ id: "", names }, ...others.map((o) => ({ id: "", names: o.names }))];
  return claimWalk(spoken, entries)
    .filter((h) => h.entryIndex === 0)
    .map((h) => spoken.index[h.p]!);
}
