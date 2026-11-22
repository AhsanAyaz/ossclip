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

/**
 * How far a pin's stored source second may be from its word's source start
 * and still find it (graphic-editor-modal §3, row 1). A pin stores the chosen
 * word's exact start, so on the same transcript the distance is 0; the
 * tolerance only absorbs a re-transcribe nudging starts by a few
 * hundredths. Past it the word "moved", and guessing a neighbour would land
 * the item on a word the author did not choose (AG2).
 */
const PIN_TOLERANCE_SEC = 0.05;

/**
 * One item's resolved word (graphic-editor-modal Terms, item states). A word
 * index is into the caller's whole transcript list. "cut" is a pin whose word
 * has no time on the live clock: no time of its own, but it still bounds its
 * neighbours (§3 row 4). "unmatched" is left to the renderer to place.
 */
export type ItemWordState =
  | { word: number; state: "pinned" | "auto" }
  | { word: null; state: "cut" | "unmatched" };

/**
 * Every item's word for one block, from the author's pins and the matcher
 * (graphic-editor-modal §3). `allWords` is the WHOLE transcript list, so a pin
 * can be found even when it has slid out of the block (row 2 then names why);
 * `window` is the block window in source seconds, half-open like an added
 * entry's span (`addedSceneToScene`); `isSpoken(i)` says whether word i has a
 * word time on the live clock.
 *
 * Pins are checked in item order against the §3 table's rows in its order,
 * first match wins. The pin's `text` is not looked at here: the stale-text
 * check is `resolveItemTimings`'s (§3 step 2), which hands this a null for a
 * pin whose item changed. A missing entry (fewer pins than items) is null.
 *
 * Auto items are then matched one segment at a time, each segment searching
 * only the spoken window words strictly between its two bounding pins'
 * words. That is what keeps G4 and AG2 without a second check: an auto item
 * can neither cross a pin nor take a pinned (or cut-pinned) word, and
 * `locateSpoken`'s strict monotonicity keeps two auto items off one word.
 * Spoken words only, compacted: the matcher sees the words as the cut video
 * says them, so a cut word can never be an auto item's answer.
 */
export function resolveItemWords(
  texts: RevealItem[],
  allWords: readonly { text: string; srcStart: number }[],
  window: { srcStart: number; srcEnd: number },
  isSpoken: (i: number) => boolean,
  pins: readonly ({ src: number; text: string } | null)[],
): { items: ItemWordState[]; notes: string[] } {
  const inWindow = (i: number): boolean => {
    const s = allWords[i]!.srcStart;
    return s >= window.srcStart && s < window.srcEnd;
  };
  const items: (ItemWordState | undefined)[] = texts.map(() => undefined);
  const notes: string[] = [];
  // Item numbers are 1-based: the notes are read by the author, in the
  // produce console and beside the modal's rows (§4).
  const note = (k: number, why: string): void => {
    notes.push(`item ${k + 1}: ${why}`);
  };
  // Pinned and cut pins, in item order and (by row 3) strictly increasing word.
  const bounds: { item: number; word: number }[] = [];

  texts.forEach((_, k) => {
    const pin = pins[k] ?? null;
    if (pin === null) return;
    const word = nearestWord(allWords, pin.src);
    if (word === null) return note(k, "its word moved");
    if (!inWindow(word)) return note(k, "its word is outside this block");
    // Against the previous BOUNDING pin, not the previous pin: a pin already
    // turned auto above holds no word, so it cannot order anything.
    const prev = bounds[bounds.length - 1];
    if (prev !== undefined && word <= prev.word) return note(k, "out of order");
    // Checked after order on purpose: a cut pin still bounds its neighbours,
    // so an out-of-order one must not be let in as a bound by being cut.
    bounds.push({ item: k, word });
    if (!isSpoken(word)) {
      items[k] = { word: null, state: "cut" };
      return note(k, "its word was cut");
    }
    items[k] = { word, state: "pinned" };
  });

  const spokenWindow: number[] = [];
  for (let i = 0; i < allWords.length; i++) if (inWindow(i) && isSpoken(i)) spokenWindow.push(i);

  let lowWord = -1;
  let firstItem = 0;
  for (const bound of [...bounds, { item: texts.length, word: Infinity }]) {
    const auto: number[] = [];
    for (let k = firstItem; k < bound.item; k++) auto.push(k);
    if (auto.length > 0) {
      const pool = spokenWindow.filter((i) => i > lowWord && i < bound.word);
      const hits = locateSpoken(
        auto.map((k) => texts[k]!),
        pool.map((i) => allWords[i]!),
        { startWord: 0, endWord: pool.length - 1 },
      );
      auto.forEach((k, j) => {
        const hit = hits[j];
        items[k] =
          hit === null || hit === undefined
            ? { word: null, state: "unmatched" }
            : { word: pool[hit]!, state: "auto" };
      });
    }
    lowWord = bound.word;
    firstItem = bound.item + 1;
  }
  return { items: items as ItemWordState[], notes };
}

/**
 * The word whose source start is nearest `src` within `PIN_TOLERANCE_SEC`,
 * or null. On a tie the earlier word (§3 row 1): only a strictly nearer word
 * replaces the one found first.
 */
function nearestWord(words: readonly { srcStart: number }[], src: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  words.forEach((w, i) => {
    const dist = Math.abs(w.srcStart - src);
    if (dist <= PIN_TOLERANCE_SEC && dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
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
    case "BulletList":
      // One item per bullet row (graphic-editor-modal §1). Its stored cues
      // carry no item times, so two guards keep them on the 7-frame stagger
      // (AG1): `plannedCue` emits `reveal` for a BulletList only from
      // `itemWords`, and `withSwappedReveal` drops it on a swap to one.
      return arr(props.items).map(str);
    case "CardRow":
      // One item per card — the card is what pops in — matching on its
      // title OR its sub-line, as alternatives (TerminalMock's shape). An
      // absent sub is left out rather than kept as "": an empty alternative
      // never matches, but it is also not a text the card shows.
      return arr(props.cards).map((c) => {
        const card = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
        const sub = str(card.sub);
        return sub ? [str(card.text), sub] : [str(card.text)];
      });
    case "PhoneDemo":
      // One item per pill — the pill is what pops in (plan Task 7), in
      // CardRow's alternatives shape with the one text a pill shows. The
      // caption is not an item: it is on the phone from the entrance.
      return arr(props.pills).map((p) => [textOf(p)]);
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
    case "CardRow":
      // A TerminalMock window's (or a CardRow card's) alternatives are each an
      // entry text; ChatMock's keyword arrives through revealItemTexts'
      // single-bubble case.
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
    case "CtaCard":
      // One card, no reveal items: it enters on the headline or the
      // asked-for word, whichever is spoken first (plan Task 5). `channel`
      // is left out — a channel name is said, if at all, as an aside.
      texts = fields("text", "keyword");
      break;
    case "PhoneDemo":
      // The caption is one phrase on screen, so its words are located as
      // the phrase they are, joined; then each pill's text (plan Task 7).
      // The scene enters on whichever is spoken first.
      texts = [
        arr(props.caption).map(textOf).filter((t) => t.length > 0).join(" "),
        ...(revealItemTexts(component, props) ?? []).flatMap((item) =>
          typeof item === "string" ? [item] : [...item],
        ),
      ];
      break;
    case "BugCard":
      // One card on its own timeline, no reveal items (plan Task 6): it
      // enters on the headline or its consequence, whichever is spoken
      // first. The sticker is a closing aside, and the mock's words are the
      // failure shown, so neither marks where the card starts.
      texts = fields("headline", "sub");
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
    case "ClipScene":
      // No text to locate: a clip enters on its cue's first matched word,
      // which is already the scene's start (spec 1.4).
      texts = [];
      break;
  }
  return texts.filter((t) => t.length > 0);
}
