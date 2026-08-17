import type { Transcript } from "./schema";

/**
 * Deterministic casing for the user's dictionary (F4, 2026-08-16).
 *
 * Whisper biasing and the LLM repair pass get a word's SPELLING right; what
 * neither guarantees is its CASE — a decoder nudged into "json" has still
 * lost the acronym. This pass is the deterministic last word: any token that
 * IS a dictionary term (exact case-insensitive match, punctuation aside)
 * takes the term's canonical casing.
 *
 * Deliberately exact-match only: "Jason" is NEVER touched, even with "JSON"
 * in the dictionary — deciding that a different word is a mishearing of a
 * term is phonetic judgement, and that is the LLM repair pass's job, behind
 * its guards. A deterministic pass that rewrote near-misses would be the
 * un-gated rewrite pass §17 exists to forbid.
 *
 * Not on the browser surface: only `produce` runs it, and keeping it out of
 * browser.ts keeps the Remotion bundle's import graph untouched.
 */

/**
 * The same leading/trailing bounds `normalizeToken` (analyze.ts) strips, but
 * keeping the pieces: the punctuation must survive the swap ("json." →
 * "JSON.", quotes and commas intact), so the strip is a split here, not a
 * deletion.
 */
const TOKEN_BOUNDS = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}-]*)$/u;

export function canonicalizeDictionaryCasing(
  transcript: Transcript,
  dictionary: readonly string[],
): Transcript {
  // Keyed on the term's own lowercase, valued with its typed casing. A later
  // duplicate (differing only in case) loses to the first — the user's list
  // order is the only precedence signal there is.
  const canonical = new Map<string, string>();
  for (const raw of dictionary) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term && !canonical.has(key)) canonical.set(key, term);
  }
  if (canonical.size === 0) return transcript;
  return {
    ...transcript,
    words: transcript.words.map((w) => {
      const [, lead = "", core = "", trail = ""] = TOKEN_BOUNDS.exec(w.text) ?? [];
      const want = canonical.get(core.toLowerCase());
      // `want !== core` also guards the degenerate empty core; strict
      // equality-of-lowercase above means this is a CASING change only —
      // never a respelling, never added punctuation.
      if (want === undefined || want === core) return w;
      return { ...w, text: `${lead}${want}${trail}` };
    }),
  };
}
