/**
 * Which comment-CTA asks the keyword mechanic is allowed to fire on.
 *
 * `ChatMock`'s keyword path (FINDINGS §16/§28b) implements exactly one shape of
 * ask: **"comment AGENTS and I'll send it"** — a distinctive word the viewer
 * literally types, given the whole frame because the ask IS the message, with
 * the same word quoted in the caption while it is on screen.
 *
 * A **"reply with a number"** ask is a different shape wearing the same clothes.
 * The author's clip says "which one did you not know? Type in the comments the
 * number of it"; the producer read `number` as the keyword, so the render showed
 * a `"NUMBER"` pill and the caption read `comments the "NUMBER"`. Nobody is
 * meant to type the word "number" — they are meant to reply with a digit the
 * producer cannot know in advance. The mechanic has nothing to render, so it
 * must not fire at all.
 *
 * The discriminator is lexical and deliberately narrow: the words below are
 * REFERENTIAL — they point at the reply rather than being it. A content noun
 * ("guide", "template", "agents") stays usable, because rejecting those would
 * break the very CTA the feature exists for. A rejection is always reported;
 * silently dropping a CTA the author wrote is worse than rendering a wrong one,
 * because only one of those is visible.
 */

/**
 * Words that name the reply instead of being it. Not a stopword list — several
 * of these are perfectly good nouns elsewhere; they are unusable only in the
 * one position "the word you type in the comments".
 */
const REFERENTIAL = new Set([
  "number", "numbers", "digit", "answer", "answers", "reply", "replies",
  "comment", "comments", "response", "responses", "word", "words",
  "below", "above", "thing", "something", "anything", "option", "choice",
  "yours", "mine", "same", "which",
]);

/**
 * Function words. A CTA keyword is a thing the viewer types on purpose, so a
 * pronoun or determiner is always a misread of the sentence around it.
 */
const FUNCTION_WORDS = new Set([
  "it", "this", "that", "these", "those", "one", "ones", "them", "they",
  "me", "you", "your", "my", "our", "their", "his", "her", "its",
  "a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or",
  "is", "are", "was", "be", "do", "did", "does", "here", "there", "what",
  "who", "how", "why", "when", "where", "if", "so", "but", "yes", "no",
]);

/**
 * Why this keyword cannot drive the CTA mechanic, or `null` when it can.
 *
 * Returns a human-readable reason rather than a boolean so the caller can log
 * WHICH rule fired — a silent suppression here would look identical to a take
 * that simply had no CTA.
 */
export function rejectCtaKeyword(keyword: string | undefined | null): string | null {
  const word = (keyword ?? "").trim().toLowerCase();
  if (!word) return "empty";
  // A digit is the reply itself, never the word naming it.
  if (/^\d+$/.test(word)) return `"${word}" is a digit, not a word to type`;
  if (word.length < 3) return `"${word}" is too short to be a comment keyword`;
  if (REFERENTIAL.has(word)) {
    return `"${word}" names the reply rather than being it — this is a ` +
      `"reply with a number" ask, not a comment-a-keyword ask`;
  }
  if (FUNCTION_WORDS.has(word)) return `"${word}" is a function word`;
  return null;
}
