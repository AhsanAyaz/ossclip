/**
 * Sound-alike comparison (FINDINGS §17/§21). ASR errors are *phonetic*: the
 * recognizer heard the right sounds and picked the wrong words ("code churn"
 * → "coach and", "tax" → "text"). Three places need to tell a repair from an
 * invention:
 *   - the repair pass, gating what an LLM may rewrite into the captions;
 *   - the grounding check, so a repaired label isn't reported as a fabrication;
 *   - copy reconciliation, matching a scene's on-screen word to a spoken one.
 *
 * Deliberately small: a consonant-skeleton key plus an edit-distance ratio.
 * Not a full Metaphone — this only has to separate "sounds like" from
 * "unrelated", and it must stay dependency-free and deterministic.
 */

/**
 * Digraphs collapsed before single letters, longest first. The ch/sh and th
 * sounds get DIGIT placeholders on purpose: a letter placeholder would be
 * rewritten again by the SINGLES pass below (mapping them to "x" made "coach"
 * expand back out to "ks" via x→ks, which quietly destroyed every score).
 */
const DIGRAPHS: Array<[RegExp, string]> = [
  [/ph/g, "f"],
  [/gh/g, "f"],
  [/ck/g, "k"],
  [/[cs]h/g, "5"],
  [/th/g, "0"],
  [/wh/g, "w"],
  [/qu/g, "kw"],
];

const SINGLES: Array<[RegExp, string]> = [
  [/[cq]/g, "k"],
  [/z/g, "s"],
  [/v/g, "f"],
  [/j/g, "g"],
  [/y/g, "i"],
  [/x/g, "ks"],
];

const VOWELS = /[aeiou]/g;

/**
 * A word's consonant skeleton: lowercase, letters only, digraphs folded to
 * single sounds, voiced/unvoiced pairs merged, vowels dropped (vowels are what
 * ASR gets wrong most), runs collapsed.
 *
 *   "coach"  → "kx"     "code"  → "kd"
 *   "churn"  → "xrn"    "chun"  → "xn"
 *   "tax"    → "tks"    "text"  → "tkst"
 *
 * A word that is all vowels keeps its first letter rather than vanishing.
 */
export function phoneticKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z]/g, "");
  if (s.length === 0) return "";
  for (const [re, to] of DIGRAPHS) s = s.replace(re, to);
  for (const [re, to] of SINGLES) s = s.replace(re, to);
  const skeleton = s.replace(VOWELS, "") || s[0]!;
  // Collapse doubled sounds ("ll" → "l"): ASR never distinguishes them.
  return skeleton.replace(/(.)\1+/g, "$1");
}

/** Phrase key — per-word keys joined, so word-count changes still compare. */
function phraseKey(text: string): string {
  return text
    .split(/\s+/)
    .map(phoneticKey)
    .filter(Boolean)
    .join("");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * 0..1 similarity of two words or phrases by sound. 1 = identical skeletons.
 * Compares the phonetic keys, so spelling and vowels don't dominate.
 */
export function soundsLike(a: string, b: string): number {
  const ka = phraseKey(a);
  const kb = phraseKey(b);
  if (ka.length === 0 && kb.length === 0) return 1;
  if (ka.length === 0 || kb.length === 0) return 0;
  const dist = levenshtein(ka, kb);
  return Math.max(0, 1 - dist / Math.max(ka.length, kb.length));
}

/**
 * Default floor for "this is a repair, not a rewrite". Deliberately low,
 * because a real mishearing can move word boundaries ("code churn" → "coach
 * and" re-segments the /tʃ/), which wrecks a pure edit-distance score. The
 * onset test below does most of the discriminating.
 */
export const SOUNDS_LIKE_FLOOR = 0.34;

/**
 * Whether `b` is plausibly a mishearing of `a` (in either direction).
 *
 * Two conditions, because neither alone separates the real populations:
 *  - the skeletons must be close ENOUGH — resegmentation keeps genuine pairs
 *    around 0.4, so the floor sits under that;
 *  - **the first sound must match.** Recognizers mangle the middle and end of
 *    a phrase, essentially never its onset. This is what rejects a rewrite:
 *    "revenue" for "churn" and "monetization" for "agents" both score in the
 *    same range as a true repair, and both fail the onset test.
 */
export function soundsSimilar(a: string, b: string, floor = SOUNDS_LIKE_FLOOR): boolean {
  const ka = phraseKey(a);
  const kb = phraseKey(b);
  if (ka.length === 0 || kb.length === 0) return ka === kb;
  if (ka[0] !== kb[0]) return false;
  return soundsLike(a, b) >= floor;
}
