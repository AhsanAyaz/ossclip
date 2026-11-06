/**
 * Logo suggestions (logo-finder spec §Stored shape): the stable id a flagged
 * name is stored under, which suggestion chips the editor's overlay lane
 * should draw, and the mention walk both those chips and produce's
 * validator use.
 *
 * Pure and browser-safe on purpose: the editor computes chip visibility in
 * the browser, so the only runtime import is ./overlay-match (which has no
 * imports at all); ./schema and ./overrides are type imports.
 */
import { normalizeMatchToken } from "./overlay-match";
import type { OverrideDoc } from "./overrides";
import type { LogoSuggestion } from "./schema";

/** A suggestion as the lane draws it: `atWord` is where the chip sits NOW. */
export type VisibleSuggestion = LogoSuggestion & { atWord: number };

type SuggestionWord = { readonly text: string };

/**
 * The suggestion id is the slug of the NAME, never of the word (logo-finder
 * spec §Stored shape): `skippedSuggestions` is keyed by it, and a skip must
 * survive a recut that moves the first kept mention. Re-planning the same
 * name therefore mints the same id. "logo" is the floor so a name with
 * nothing sluggable still yields an id `LogoSuggestionSchema` accepts.
 */
export function suggestionIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "logo" : slug;
}

/**
 * Which suggestion chips to draw, and at which word (logo-finder spec
 * §Stored shape, "What hides a chip").
 *
 * A chip is hidden when its id is skipped, or when a LIVE placement carries
 * `fromSuggestion` equal to it. Only `layer.added` is checked: a pick is
 * always a user add (controller ruling R2), so a matched plan placement
 * never carries the field. Live means not tombstoned by
 * `edits[id].removed`, which is how undo of a pick brings the chip back.
 * Deliberately no name check, so a pick saved under an edited name still
 * hides its chip.
 *
 * `layer` undefined is a project that never touched an overlay (the slot is
 * optional with no default): nothing is skipped or picked.
 *
 * When the suggestion's word was cut, the chip falls FORWARD to the next
 * kept mention of the name (`mentionSpan`, suffix-anchored per R10), the
 * resolver's fall-forward posture (`resolveOverlayCues`); with no later
 * mention it hides rather than sit on a word the viewer never hears.
 */
export function visibleSuggestions(
  suggestions: readonly LogoSuggestion[],
  layer: OverrideDoc["overlays"] | undefined,
  words: readonly SuggestionWord[],
  kept: (i: number) => boolean,
): VisibleSuggestion[] {
  const skipped = new Set(layer?.skippedSuggestions ?? []);
  const picked = new Set(
    (layer?.added ?? [])
      .filter((p) => p.fromSuggestion !== undefined && layer?.edits[p.id]?.removed !== true)
      .map((p) => p.fromSuggestion!),
  );
  const out: VisibleSuggestion[] = [];
  for (const s of suggestions) {
    if (skipped.has(s.id) || picked.has(s.id)) continue;
    const atWord = kept(s.word) ? s.word : nextKeptMention(words, s.name, s.word, kept);
    if (atWord !== null) out.push({ ...s, atWord });
  }
  return out;
}

/** The matcher's tokenizer, lowercased: the spec compares names case-insensitively. */
export function nameTokens(name: string): string[] {
  return name
    .split(/\s+/)
    .map(normalizeMatchToken)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * The words a flag's mention covers, as an inclusive [first, last] range, or
 * null when `word` is not a right word (logo-finder spec §Step 1,
 * Validation; ruling R10). `word` must be kept, and the spoken words from it
 * must continue the name to its LAST token: for some k with
 * `tokens[k] === spoken[word]`, the following kept words consume
 * `tokens[k..end]` contiguously. A mention may therefore start mid-name (a
 * lone "Gemini" for "Google Gemini"), but it may not stop short: "on" alone
 * is not "Ruby on Rails". Every matching k is tried, since a name can repeat
 * a token. Cut and punctuation-only words are skipped, as overlay-match's
 * `prepareSpoken` does.
 *
 * Accepted (R10): the last token alone passes, so a lone "Code" passes for
 * "Visual Studio Code". The LLM chose the name at this word, and the
 * alternative (requiring the first token) would refuse every legitimate
 * short form a speaker uses.
 *
 * Lives here, not in producer/logo-finder.ts, so the chip's fall-forward
 * (`nextKeptMention`, browser-side) and produce's validator share ONE walk
 * (final review Minor 3): this module must stay browser-safe, and the
 * finder imports node:crypto.
 */
export function mentionSpan(
  tokens: readonly string[],
  words: readonly SuggestionWord[],
  word: number,
  kept: (i: number) => boolean,
): [number, number] | null {
  if (word >= words.length || !kept(word)) return null;
  const at = normalizeMatchToken(words[word]!.text).toLowerCase();
  if (at === "") return null;
  // The kept, non-punctuation words after `word`, as far as the longest
  // possible walk (tokens.length - 1) could need.
  const after: { i: number; t: string }[] = [];
  for (let i = word + 1; i < words.length && after.length < tokens.length - 1; i++) {
    if (!kept(i)) continue;
    const t = normalizeMatchToken(words[i]!.text).toLowerCase();
    if (t) after.push({ i, t });
  }
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k] !== at) continue;
    const rest = tokens.length - 1 - k;
    if (rest > after.length) continue;
    if (after.slice(0, rest).every((w, n) => w.t === tokens[k + 1 + n])) {
      return [word, rest === 0 ? word : after[rest - 1]!.i];
    }
  }
  return null;
}

/**
 * The first word strictly after `after` where a kept mention of `name`
 * starts, by `mentionSpan`: the same rule `validateLogoFlags` used to accept
 * the flag. Final review Minor 3: this used to demand the full name's tokens
 * in a row, so a flag R10 let sit on a suffix ("Gemini" for "Google Gemini")
 * hid its chip once cut, even with later lone "Gemini" mentions kept.
 * Compared case-insensitively: the LLM already chose this name at this spot,
 * so the short-name exact-case rule that guards AUTO-matching does not apply
 * here.
 */
function nextKeptMention(
  words: readonly SuggestionWord[],
  name: string,
  after: number,
  kept: (i: number) => boolean,
): number | null {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;
  for (let i = after + 1; i < words.length; i++) {
    if (mentionSpan(tokens, words, i, kept) !== null) return i;
  }
  return null;
}
