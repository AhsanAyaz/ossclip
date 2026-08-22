/**
 * The cover banner's word cap, and nothing else.
 *
 * Split out of `./cover` (2026-08-19) for the reason `content-rect` is split
 * from `content-rect-detect`: the EDITOR's cover panel shows the trimmed
 * headline live as you type, so it needs this function at RUNTIME — and it
 * imports `@ossclip/core/browser`, whose whole contract is "no node built-ins
 * anywhere in this module graph". `./cover` is node all the way down
 * (`node:fs`, `./exec`'s child_process), so re-exporting `coverHeadline` from
 * there would have put ffmpeg's process runner in the Vite bundle.
 *
 * Restating the trimming rules in the editor was the alternative and is
 * strictly worse: the server re-caps whatever the panel sends, so a second
 * copy would drift into showing a preview the render disagrees with.
 *
 * `./cover` re-exports this file, so `@ossclip/core`'s surface is unchanged.
 */

/**
 * A cover banner is a headline, not a sentence (FINDINGS §35). The producer
 * shipped 13 words across five lines by reusing the video's hook verbatim; at
 * grid-tile size that is unreadable. The reference covers run 4-9 words.
 *
 * Stated in the schema AND enforced here, because a `.describe()` is a request
 * and this is a constraint — the same reason `normalizeBeatSheet` exists.
 */
export const COVER_MAX_WORDS = 9;

/**
 * Trailing words that cannot end a headline — the truncation reads as broken.
 * Auxiliaries dangle exactly like prepositions: a real run (2026-08-22)
 * truncated to "AI Gave Me Too Many Ideas. I Had" because the set had none.
 * "i" is here for the same incident: popping "Had" alone leaves "…Ideas. I",
 * a subject with its sentence cut off.
 */
const DANGLING = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "the", "to", "with", "that", "this", "my", "your", "so",
  "had", "has", "have", "was", "were", "will", "can", "should", "i",
]);

/**
 * Cut a headline down to `maxWords`, preferring a natural break.
 *
 * A dash or colon usually separates a complete claim from its elaboration, so
 * the first clause is a real headline rather than a sentence with its end
 * lopped off. Only when that is still too long does this truncate — and then
 * it refuses to stop on a preposition or article, which is what makes a
 * truncation look like a bug instead of an edit.
 */
export function coverHeadline(text: string, maxWords = COVER_MAX_WORDS): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return clean;
  const words = (s: string): string[] => s.split(" ").filter(Boolean);
  if (words(clean).length <= maxWords) return clean;

  // First clause, if it stands on its own — never a two-word fragment. Even
  // when the clause is itself too long it is the better thing to cut down,
  // since truncating it can never wander past the dash into the elaboration.
  const clause = clean.split(/\s*[—–:]\s*|\s+-\s+/)[0]!.trim();
  const base = words(clause).length >= 3 ? clause : clean;
  const out = words(base).slice(0, maxWords);
  while (out.length > 3 && DANGLING.has(out[out.length - 1]!.toLowerCase().replace(/\W/g, ""))) {
    out.pop();
  }
  // A clause that ended on its own punctuation keeps it; a cut does not.
  return out.join(" ").replace(/[,;:—–-]+$/, "");
}
