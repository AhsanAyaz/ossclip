import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { suggestionIdFor } from "../logo-suggestions";
import { normalizeMatchToken } from "../overlay-match";
import type { LlmProvider } from "./provider";

/**
 * Logo finder, step 1 (logo-finder spec §Step 1 — flag names): one small LLM
 * call that names the products, companies and tools the speaker mentions
 * which the overlay library does not already cover. A SEPARATE call from the
 * beat sheet on purpose, so a finder failure never costs the edit.
 *
 * The model's answer is a suggestion, never a placement: `validateLogoFlags`
 * is the gate, the sfx normaliser's posture. A flag on the wrong word is
 * dropped, because a logo on the wrong word is project 1's main anti-goal.
 */

/**
 * `.max(64)` is a runaway guard, the `SfxPlanSchema` posture. The cap of 8
 * lives in the validator, which reports what it cut; this only stops a
 * runaway generation from handing it thousands of entries.
 */
export const LogoFlagsSchema = z.object({
  names: z
    .array(
      z.object({
        name: z.string(),
        word: z.number().int().nonnegative(),
        domain: z.string().optional(),
      }),
    )
    .max(64),
});
export type LogoFlags = z.infer<typeof LogoFlagsSchema>;

export type LogoFlag = { id: string; name: string; word: number; domain?: string };

export type LogoFlagDrop = {
  name: string;
  reason: "wrong-word" | "in-library" | "duplicate" | "over-cap";
};

/**
 * Bump whenever `LOGO_FINDER_SYSTEM` or `buildLogoFinderUserPrompt` change
 * what they ask for. The cache key carries it, the same §78 posture as
 * SFX_PROMPT_VERSION: an old cached answer must not survive a new prompt.
 */
export const LOGO_FINDER_PROMPT_VERSION = 1;

/** logo-finder spec §Step 1, "Cap": at most 8 flags per video, earliest kept. */
const MAX_FLAGS = 8;

/**
 * What this run's live overlay placements already put on screen (controller
 * ruling R9). `words`: the word indices where live placements sit (matched
 * plus user-added, minus removed, after fall-forward). `names`: every name
 * and alias of the entries those placements use.
 *
 * Why not "every library name" (R9): the library HAVING a name does not mean
 * the viewer sees its logo. An unindexed `go.png` never auto-places (R18),
 * and a short name like `GDE` only matches case-exactly, so dropping a flag
 * because the library lists the name lost the logo entirely. Only what is
 * actually placed counts as covered.
 */
export type LogoFlagCover = { words: ReadonlySet<number>; names: readonly string[] };

type FinderWord = { readonly text: string };

/** The matcher's tokenizer, lowercased: the spec compares names case-insensitively. */
function nameTokens(name: string): string[] {
  return name
    .split(/\s+/)
    .map(normalizeMatchToken)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * The words a flag's mention covers, as an inclusive [first, last] range, or
 * null when `word` is not a right word (logo-finder spec §Step 1,
 * Validation): it must be kept, and its token must be one of the name's
 * tokens. A name may start mid-way ("Gemini" in "Google Gemini"), so the
 * walk resumes from that token and extends over the following kept words
 * while they continue the name. Cut and punctuation-only words are skipped,
 * as overlay-match's `prepareSpoken` does.
 */
function mentionSpan(
  tokens: readonly string[],
  words: readonly FinderWord[],
  word: number,
  kept: (i: number) => boolean,
): [number, number] | null {
  if (word >= words.length || !kept(word)) return null;
  const at = normalizeMatchToken(words[word]!.text).toLowerCase();
  const k = at === "" ? -1 : tokens.indexOf(at);
  if (k < 0) return null;
  let last = word;
  let next = k + 1;
  for (let i = word + 1; i < words.length && next < tokens.length; i++) {
    if (!kept(i)) continue;
    const t = normalizeMatchToken(words[i]!.text).toLowerCase();
    if (!t) continue;
    if (t !== tokens[next]) break;
    last = i;
    next++;
  }
  return [word, last];
}

/**
 * The official site's bare host, or undefined (logo-finder spec §Step 1,
 * Validation: "a hostname with a dot, no port and no IP literal"). A scheme
 * and a path are forgiven, since the model writes them often and the host
 * is unambiguous. Anything that would make step 2 fetch somewhere other
 * than a public named site is refused instead: a port, userinfo, an IP
 * literal, or a dotless name like `localhost`.
 */
export function normalizeDomain(raw: string): string | undefined {
  let host = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/, 1)[0]!.replace(/\.$/, "");
  if (host === "" || /[:@[\]]/.test(host)) return undefined;
  const labels = host.split(".");
  if (labels.length < 2) return undefined;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  // An all-digit last label is an IPv4 literal (or a mangled one); no real
  // TLD is numeric.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return undefined;
  return host;
}

/**
 * The deterministic gate on the model's answer (logo-finder spec §Step 1,
 * Validation). In order:
 * - wrong word: not a kept index whose word belongs to the name;
 * - in library (R9): the mention's span holds a covered word, or the name
 *   equals a covered entry's name or alias;
 * - duplicate: the same name case-insensitively, OR the same
 *   `suggestionIdFor` id (controller ruling: "C++" and "C#" both slug to
 *   "c", and ids must be unique). The earliest word wins;
 * - over cap: past the first 8 by word.
 * A bad domain does not drop the flag: the chip still appears, with the
 * paste box only.
 */
export function validateLogoFlags(
  raw: LogoFlags,
  words: readonly FinderWord[],
  kept: (i: number) => boolean,
  covered: LogoFlagCover,
): { flags: LogoFlag[]; dropped: LogoFlagDrop[] } {
  const dropped: LogoFlagDrop[] = [];
  const coveredNames = new Set(covered.names.map((n) => nameTokens(n).join(" ")).filter(Boolean));
  const passed: (LogoFlag & { key: string })[] = [];
  for (const f of raw.names) {
    const name = f.name.trim();
    const tokens = nameTokens(name);
    const span = mentionSpan(tokens, words, f.word, kept);
    if (!span) {
      dropped.push({ name: f.name, reason: "wrong-word" });
      continue;
    }
    const key = tokens.join(" ");
    let spanCovered = false;
    for (let i = span[0]; i <= span[1]; i++) if (covered.words.has(i)) spanCovered = true;
    if (spanCovered || coveredNames.has(key)) {
      dropped.push({ name: f.name, reason: "in-library" });
      continue;
    }
    const domain = f.domain === undefined ? undefined : normalizeDomain(f.domain);
    passed.push({ id: suggestionIdFor(name), name, word: f.word, ...(domain ? { domain } : {}), key });
  }

  // Stable sort, so the earliest word wins a duplicate and the cap keeps the
  // earliest mentions (spec: "keeping the earliest").
  passed.sort((a, b) => a.word - b.word);
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const flags: LogoFlag[] = [];
  const overCap: LogoFlagDrop[] = [];
  for (const { key, ...flag } of passed) {
    if (seenKeys.has(key) || seenIds.has(flag.id)) {
      dropped.push({ name: flag.name, reason: "duplicate" });
      continue;
    }
    seenKeys.add(key);
    seenIds.add(flag.id);
    if (flags.length >= MAX_FLAGS) overCap.push({ name: flag.name, reason: "over-cap" });
    else flags.push(flag);
  }
  return { flags, dropped: [...dropped, ...overCap] };
}

export const LOGO_FINDER_SYSTEM = `You find the brand names a speaker mentions in a short video, so that their logos can be shown on screen.

You receive the kept words of the transcript, one per line as "<index>: <word>", and the names the logo library already has.

Return every named product, company, tool, service, AI model or organisation the speaker mentions. Only those: never generic nouns ("database", "app"), never people, never places.

For each name:
- "name": the display name as it should be saved, properly capitalised ("Google Gemini").
- "word": the index of the first word of its FIRST mention, exactly as numbered in the transcript.
- "domain": the official website's bare host, with no scheme, port or path ("firebase.google.com", "claude.ai"). Leave it out if you are not sure.

Do not return a name the library already has. Prefer omitting a name over guessing: a logo on the wrong word, or the wrong logo, is worse than none.`;

/** The user prompt (logo-finder spec §Step 1, Input): kept words indexed, then the library names. */
export function buildLogoFinderUserPrompt(
  words: readonly FinderWord[],
  kept: (i: number) => boolean,
  libraryNames: readonly string[],
): string {
  // Cut words are never offered: the model must not anchor to a word the
  // viewer never hears. Original indices are kept so `word` needs no remap.
  const lines = words.flatMap((w, i) => (kept(i) ? [`${i}: ${w.text}`] : []));
  const library = libraryNames.length > 0 ? libraryNames.map((n) => `- ${n}`).join("\n") : "(none)";
  return `Transcript:\n${lines.join("\n")}\n\nNames the library already has:\n${library}\n`;
}

/**
 * The flagging call. Returns the RAW answer next to the validated result
 * (R9): the caller caches `raw` and re-validates every run, because `covered`
 * (what is placed right now) changes without the prompt changing, so
 * validated flags would go stale in the cache.
 *
 * `libraryNames` (every name and alias in the library) only shapes the
 * prompt, so the model does not re-flag them. Only `covered` decides drops.
 */
export async function generateLogoFlags(
  provider: LlmProvider,
  words: readonly FinderWord[],
  kept: (i: number) => boolean,
  libraryNames: readonly string[],
  covered: LogoFlagCover,
): Promise<{ raw: LogoFlags } & ReturnType<typeof validateLogoFlags>> {
  const raw = await provider.complete({
    system: LOGO_FINDER_SYSTEM,
    user: buildLogoFinderUserPrompt(words, kept, libraryNames),
    schema: LogoFlagsSchema,
    schemaName: "logo_flags",
    // Mechanical, not editorial (the §37 tiering rule): recognising a brand
    // name is a lookup, not a judgement, and `validateLogoFlags` is the real
    // gate, so a small model's mistake costs a dropped chip, not a bad video.
    tier: "mechanical",
  });
  return { raw, ...validateLogoFlags(raw, words, kept, covered) };
}

/**
 * Cache key for the RAW flagging answer (spec §Step 1, Cache), in the
 * `sfxCacheKey` style. Everything that changes the PROMPT is in it: the
 * prompt version, the transcript text, and the library names. `covered` is
 * deliberately not (R9): it only feeds the validator, which re-runs on the
 * cached answer every time.
 *
 * The prompt offers KEPT words only, so a recut changes it. `words` must
 * therefore reflect the cut, e.g. the prompt's `<index>: <word>` lines, not
 * the full transcript.
 */
export function logoFlagsCacheKey(parts: {
  promptVersion: number;
  words: readonly string[];
  libraryNames: readonly string[];
}): string {
  return createHash("sha1")
    .update(JSON.stringify([parts.promptVersion, parts.words, parts.libraryNames]))
    .digest("hex")
    .slice(0, 8);
}
