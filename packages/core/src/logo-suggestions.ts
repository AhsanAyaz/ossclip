/**
 * Logo suggestions (logo-finder spec §Stored shape): the stable id a flagged
 * name is stored under, and which suggestion chips the editor's overlay lane
 * should draw.
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
 * kept contiguous mention of the name, the resolver's fall-forward posture
 * (`resolveOverlayCues`); with no later mention it hides rather than sit on
 * a word the viewer never hears.
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

/**
 * The first kept contiguous mention of `name` strictly after `after`, using
 * the matcher's tokenizer (`normalizeMatchToken`) so edge punctuation and a
 * possessive are forgiven the same way a library match forgives them.
 * Punctuation-only words drop out of the kept sequence, as in
 * overlay-match's `prepareSpoken`. Compared case-insensitively: the LLM
 * already chose this name at this spot, so the short-name exact-case rule
 * that guards AUTO-matching does not apply here.
 */
function nextKeptMention(
  words: readonly SuggestionWord[],
  name: string,
  after: number,
  kept: (i: number) => boolean,
): number | null {
  const tokens = name.split(/\s+/).map(normalizeMatchToken).filter(Boolean).map((t) => t.toLowerCase());
  if (tokens.length === 0) return null;
  const index: number[] = [];
  const spoken: string[] = [];
  for (let i = after + 1; i < words.length; i++) {
    if (!kept(i)) continue;
    const token = normalizeMatchToken(words[i]!.text).toLowerCase();
    if (!token) continue;
    index.push(i);
    spoken.push(token);
  }
  for (let p = 0; p + tokens.length <= spoken.length; p++) {
    if (tokens.every((t, k) => spoken[p + k] === t)) return index[p]!;
  }
  return null;
}
