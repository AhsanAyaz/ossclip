import type { YoutubePack } from "../producer/youtube";

/**
 * Per-platform caption resolution for `ossclip publish`.
 *
 * The pack is the author: prompt v3 writes `platformCaptions` (and v2 already
 * wrote `linkedinPost`) with the transcript and audience in context. This
 * module only PICKS from the pack — and, for a pre-v3 pack that never carried
 * a platform's caption, derives one deterministically from the fields every
 * pack has. No LLM call at publish time: publishing must work offline-from-LLM
 * and produce the same caption every run.
 */

/** Platform caption caps, by the provider identifier the backend reports. */
export const CAPTION_CAPS: Record<string, number> = {
  x: 280,
  linkedin: 1500,
  // A company page is the same network with the same limit — Postiz reports
  // it as its own provider (`linkedin-page`), so it needs its own entry or it
  // silently takes DEFAULT_CAPTION_CAP (2026-08-27 live E2E).
  "linkedin-page": 1500,
  // Threads' own hard limit, well under the generic default it used to
  // inherit (2026-08-28).
  threads: 500,
  instagram: 2200,
  tiktok: 2200,
  facebook: 2200,
  youtube: 5000,
};

/** The cap for an unknown provider — the smallest common long-form cap. */
export const DEFAULT_CAPTION_CAP = 1500;

export function captionCap(provider: string): number {
  return CAPTION_CAPS[provider] ?? DEFAULT_CAPTION_CAP;
}

/**
 * Code points Threads counts by their UTF-8 bytes: anything that is not a
 * letter, digit, punctuation, separator or combining mark — emoji and symbols
 * such as → — plus the emoji variation selector. Meta's Threads docs: "emojis
 * are counted as the number of UTF-8 bytes". Their boundary of "emoji" is not
 * spelled out, so symbols are counted the same way: an over-count trims a word
 * early, an under-count is a 400 AFTER the upload (2026-11-13: a 496-char
 * caption with a 👇 and three → was refused as "post is too long"). Letters of
 * any script stay 1, or a non-Latin caption would lose half its allowance.
 */
const THREADS_BYTE_COUNTED = /[^\p{L}\p{N}\p{P}\p{Z}\p{M}\s]|\uFE0F/u;

function utf8Bytes(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/**
 * How a platform counts a caption against its cap. Threads is the one that
 * differs (above); everything else is the plain `.length` this module has
 * always measured with. Browser-safe — the editor panel's counter uses this
 * exact function, so the number the user watches is the one publish checks.
 */
export function captionLength(provider: string, text: string): number {
  if (provider !== "threads") return text.length;
  let n = 0;
  for (const ch of text) n += THREADS_BYTE_COUNTED.test(ch) ? utf8Bytes(ch.codePointAt(0)!) : 1;
  return n;
}

/**
 * Word-boundary truncation to `max`: never slice mid-word, drop the partial
 * word instead. A caption a few words shorter beats one ending "communi".
 * `measure` is the platform's count (`captionLength`); words keep dropping
 * until the text fits it.
 */
export function truncateAtWordBoundary(
  text: string,
  max: number,
  measure: (s: string) => number = (s) => s.length,
): string {
  const trimmed = text.trim();
  if (measure(trimmed) <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  let out = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  while (out.length > 0 && measure(out) > max) {
    const i = out.lastIndexOf(" ");
    out = (i > 0 ? out.slice(0, i) : [...out].slice(0, -1).join("")).trimEnd();
  }
  return out;
}

/** `truncateAtWordBoundary` against one platform's own cap and count. */
function fitCaption(text: string, provider: string): string {
  return truncateAtWordBoundary(text, captionCap(provider), (s) => captionLength(provider, s));
}

/**
 * Fallback caption when the pack carries none for this provider: the first
 * title (the strongest line the pack has) plus the hashtags, capped. This is
 * deliberately the floor, not the ceiling — the prompt-v3 `platformCaptions`
 * exist because title-plus-hashtags is what every paste-tool ships.
 */
export function deriveCaption(pack: YoutubePack, provider: string): string {
  const title = pack.titles[0] ?? "";
  const hashtags = pack.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const joined = hashtags.length > 0 ? `${title}\n\n${hashtags}` : title;
  return fitCaption(joined, provider);
}

/**
 * The caption `publish` uses for a target: the pack's own field for that
 * platform when present (still capped — an approved pack is user data, and
 * user data gets validated, not trusted), else the derived fallback.
 */
export function captionForProvider(pack: YoutubePack, provider: string): string {
  const captions = pack.platformCaptions;
  const authored =
    // `linkedin-page` (a company page) reads the SAME authored field: same
    // network, same idiom, same cap. Without this arm a page fell through to
    // the title-plus-hashtags floor while the personal feed published the
    // authored post — the shape the 2026-08-27 live E2E caught in its dry run.
    // YouTube's caption is the DESCRIPTION box, and `description` is the one
    // pack field written for exactly it (the title rides `settings.title`,
    // set by `buildPublishPosts`). Without this arm a pack carrying a full
    // description published the title-plus-hashtags floor — 94 characters of
    // it — which the 2026-08-28 channel connection showed in its dry run.
    provider === "youtube"
      ? pack.description
      : provider === "linkedin" || provider === "linkedin-page"
      ? pack.linkedinPost
      : // Threads has no field of its own, and this module never invents
      // copy — so it borrows the closest idiom the pack DOES write. Same
      // company, same audience, same short-video framing; the 500-char cap
      // above trims it at a word boundary rather than letting Threads
      // reject it (2026-08-28, a real connected account).
      provider === "instagram" || provider === "threads"
        ? captions?.instagram
        : provider === "tiktok"
          ? captions?.tiktok
          : provider === "x"
            ? captions?.x
            : provider === "facebook"
              ? captions?.facebook
              : undefined;
  if (authored !== undefined && authored.trim().length > 0) {
    return fitCaption(authored, provider);
  }
  return deriveCaption(pack, provider);
}
