import type { SceneComponentId } from "./scene-schema";

/**
 * The reveal matcher (reveal-timing spec §1): where, inside a moment's own
 * word window, is a graphic's text actually spoken? Plan time stores the
 * answer on the scene; assembly turns it into an on-cue start and per-item
 * entrance times. Pure and browser-safe on purpose — type imports only, no
 * node built-ins — because the scenes package applies the SAME
 * `syncDecision` rule to author-chosen reveal modes, and a second copy of the
 * threshold is how the plan and the render would disagree about "synced".
 *
 * The bar is the spec's anti-goal, not recall: "framework" matching an
 * unrelated "framework" 8s earlier is worse than no match, because an
 * unmatched item is simply paced. So every looseness here is small and
 * symmetric (both sides normalized the same way), and nothing is fuzzy.
 */

/**
 * Synced needs at least two thirds of the items on their words (spec §1,
 * "my call — a constant to tune on real takes"). Below it a scene is paced:
 * two chips on cue and one guessed reads as a bug (anti-goal: half-synced).
 */
export const SYNC_MIN_SHARE = 2 / 3;

/**
 * Function words: they carry no position. A chip "THE LOOP" must be located
 * by "loop", and a chip that is ONLY function words ("IT") must never match —
 * it would land on whichever "it" came first. Deliberately NOT grounding.ts's
 * STOPWORDS: that list serves "is this copy invented?" and so drops "no",
 * "not", "still", "one", "rule"… — words that are real evidence of WHERE a
 * phrase is said ("NO CODE" must not match a bare "code").
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "of", "to", "in", "on",
  "at", "for", "with", "by", "from", "as", "into", "than", "then",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
  "has", "have", "had", "will", "would", "can", "could", "should",
  "i", "im", "me", "my", "you", "your", "we", "our", "us", "he", "she",
  "him", "her", "his", "they", "them", "their", "it", "its", "this", "that",
  "these", "those", "there", "here", "what", "which", "who",
  "just", "very", "really", "some", "like", "um", "uh",
]);

/**
 * Lowercase, drop apostrophes (so "I'm" is one token, not "i" + "m"), split
 * on anything that is not a letter or digit. Unicode-aware: takes are not
 * only English (the Urdu field test, 2026-08-05).
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Collapse plural / -ed / -ing (spec §1: "idea/ideas, block/blocked"). Not a
 * real stemmer — just enough that the speaker's inflection and the chip's
 * agree. Applied to BOTH sides, so an over-eager strip ("speed" → "spe") is
 * harmless: it only ever compares equal to its own inflections. The ≥3-letter
 * floors keep short words ("thing", "need", "bus") intact.
 */
function stem(token: string): string {
  let s = token;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length - 3 >= 3) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length - 2 >= 3) s = s.slice(0, -2);
  // "stopping"/"stopped" → "stopp" → "stop"; l and s excluded ("call", "pass").
  if (s.length > 3 && /([^aeiouls])\1$/.test(s)) s = s.slice(0, -1);
  // "create"/"creating"/"created" all meet at "creat".
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** An item's searchable tokens, stemmed; empty means "can never match". */
function contentTokens(item: string): string[] {
  const content = tokens(item).filter((t) => !STOP_WORDS.has(t));
  // A lone short token ("AI", "UI", "5x") occurs everywhere, so its first
  // occurrence says nothing about where the chip is meant (plan review focus 2).
  if (content.length === 1 && content[0]!.length < 3) return [];
  return content.map(stem);
}

/**
 * One staggered item's text. Usually a single string; a list is ALTERNATIVES —
 * the item counts as spoken where any one of them first is (a TerminalMock
 * window "matches on its title or any of its lines", spec §1). Alternatives
 * rather than one joined string because a joined title-plus-lines item has so
 * many tokens it can never fit inside the `tokens + 2` span.
 */
export type RevealItem = string | readonly string[];

/**
 * Per item, the source word index where it is first spoken inside
 * `window` (inclusive both ends, the `SceneAnchor` convention), or null.
 *
 * An item matches where its content tokens appear in order within a span of
 * `tokens + 2` (multi-word chips are said with a filler between: "new… idea").
 * Matches are STRICTLY monotonic: an item's word must come after the previous
 * MATCHED item's word, so a repeated label takes the later occurrence and an
 * out-of-order hit is no match at all (spec §1). Strict, not "at or after":
 * two chips "CODE", "CODE" over "code … code" would otherwise both land on
 * the first "code" — a confident wrong match for the second (spec
 * anti-goal). An unmatched item leaves the floor where it was.
 */
export function locateSpoken(
  items: readonly RevealItem[],
  words: readonly { text: string }[],
  window: { startWord: number; endWord: number },
): (number | null)[] {
  // One flat token stream for the window, each token tagged with its source
  // word. A transcript word can carry several tokens ("project-a"), and span
  // is measured on this stream so punctuation-joined words are not penalized.
  const stream: { stem: string; word: number }[] = [];
  const first = Math.max(0, window.startWord);
  const last = Math.min(words.length - 1, window.endWord);
  for (let w = first; w <= last; w++) {
    for (const t of tokens(words[w]!.text)) stream.push({ stem: stem(t), word: w });
  }

  const out: (number | null)[] = [];
  let floor = 0; // stream position the next item may not start before
  for (const item of items) {
    const alternatives = typeof item === "string" ? [item] : item;
    let hit: number | null = null;
    for (const alt of alternatives) {
      const want = contentTokens(alt);
      if (want.length === 0) continue;
      const at = findFrom(stream, want, floor);
      if (at !== null && (hit === null || at < hit)) hit = at;
    }
    if (hit === null) {
      out.push(null);
    } else {
      const word = stream[hit]!.word;
      out.push(word);
      // Past every token of the matched WORD, not just the matched token:
      // a "project-a" word is two stream tokens but one word index, and the
      // next item must land on a later word.
      floor = hit;
      while (floor < stream.length && stream[floor]!.word === word) floor++;
    }
  }
  return out;
}

/** Stream position where `want` first matches at or after `from`, or null. */
function findFrom(
  stream: readonly { stem: string }[],
  want: readonly string[],
  from: number,
): number | null {
  const span = want.length + 2;
  for (let start = from; start < stream.length; start++) {
    if (stream[start]!.stem !== want[0]) continue;
    // Greedy earliest occurrence of each next token: with a fixed end bound,
    // taking the earliest never rules out a match a later choice would allow.
    const limit = Math.min(stream.length, start + span);
    let pos = start;
    let ok = true;
    for (let k = 1; k < want.length && ok; k++) {
      let next = pos + 1;
      while (next < limit && stream[next]!.stem !== want[k]) next++;
      if (next >= limit) ok = false;
      else pos = next;
    }
    if (ok) return start;
  }
  return null;
}

/**
 * Synced iff the FIRST item is on its word and at least `SYNC_MIN_SHARE` of
 * items are. The first item is required because the scene's entrance keys to
 * it; a synced diagram whose opening chip is guessed opens on a guess.
 */
export function syncDecision(matches: readonly (number | null)[]): "synced" | "paced" {
  if (matches.length === 0 || matches[0] === null) return "paced";
  const matched = matches.filter((m) => m !== null).length;
  return matched / matches.length >= SYNC_MIN_SHARE ? "synced" : "paced";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const textOf = (v: unknown): string =>
  v && typeof v === "object" ? str((v as Record<string, unknown>).text) : "";

/**
 * The texts of a component's staggered items, one per rendered item, or null
 * for components that do not stagger (spec: the four, through one helper).
 * Index i must BE rendered item i, so a malformed entry becomes "" (never
 * matches) rather than being dropped — dropping would shift every later
 * item's timing onto its neighbour.
 */
export function revealItemTexts(
  component: SceneComponentId,
  props: Record<string, unknown>,
): RevealItem[] | null {
  switch (component) {
    case "FlowDiagram":
      return arr(props.nodes).map(str);
    case "ChatMock": {
      // A keyword collapses the scene to ONE bubble carrying it (FINDINGS
      // §28b) — the same `if (keyword)` test as scenes' `chatBubbles`, so the
      // item list is the bubble list the render lays out.
      const keyword = str(props.keyword);
      if (keyword) return [keyword];
      return arr(props.messages).map(textOf);
    }
    case "TerminalMock":
      // One item per window — the window is what staggers in — matching on
      // its title OR any one line (spec §1), as alternatives.
      return arr(props.windows).map((w) => {
        const win = w && typeof w === "object" ? (w as Record<string, unknown>) : {};
        return [str(win.title), ...arr(win.lines).map(str)];
      });
    case "StrikethroughReveal":
      return arr(props.lines).map(textOf);
    default:
      return null;
  }
}

/**
 * The texts whose first spoken occurrence defines the scene's entrance (spec
 * §2: for list components the items, for single-text components the key
 * phrase). Unlike `revealItemTexts` positions do not matter here, so missing
 * or empty fields are simply skipped.
 */
export function entryTexts(component: SceneComponentId, props: Record<string, unknown>): string[] {
  const fields = (...keys: string[]): string[] => keys.map((k) => str(props[k]));
  let texts: string[];
  switch (component) {
    case "FlowDiagram":
    case "TerminalMock":
    case "StrikethroughReveal":
    case "ChatMock":
      // A TerminalMock window's alternatives are each an entry text; ChatMock's
      // keyword arrives through revealItemTexts' single-bubble case.
      texts = (revealItemTexts(component, props) ?? []).flatMap((item) =>
        typeof item === "string" ? [item] : [...item],
      );
      break;
    case "TitleCard":
      texts = fields("title", "emphasis");
      break;
    case "ScreenshotFrame":
      texts = fields("label");
      break;
    case "StatCard":
      texts = fields("label", "value");
      break;
    case "RuleCard":
      texts = fields("kicker", "text");
      break;
    case "BulletList":
      texts = arr(props.items).map(str);
      break;
  }
  return texts.filter((t) => t.length > 0);
}
