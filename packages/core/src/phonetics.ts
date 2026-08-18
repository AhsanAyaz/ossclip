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
 * Marks Arabic-script text carries that two transcribers disagree about
 * without disagreeing about the WORD: harakat/vowel diacritics
 * (U+064B–U+065F, U+0670), tatweel (U+0640, a pure typographic stretch), and
 * the zero-width joiners (U+200C/U+200D). Whisper emits them inconsistently
 * and an LLM writing a correction rarely reproduces them, so leaving them in
 * makes a correct repair either miss `locate()` outright or read as
 * "different from what was heard" purely on invisible marks. Only tatweel
 * survives the `\p{L}\p{N}` filter below (it is Lm, a letter); the rest are
 * stripped here so the intent is legible rather than an accident of Unicode
 * categories.
 */
// Escaped, not literal: three of these code points are invisible in an editor.
const ARABIC_NOISE = /[\u064B-\u065F\u0670\u0640\u200C\u200D]/g;

/**
 * Comparable form for two pieces of text: case-, punctuation- and
 * whitespace-insensitive, in ANY script.
 *
 * Shared by `phonetics.ts` and `producer/repair.ts` on purpose — they used to
 * hold two copies and the copy in `repair.ts` was `[^a-z0-9\s]`, i.e.
 * Latin-only. Field case (2026-08-18): every one of 11 recorded Urdu repairs
 * normalized to the empty string, so `norm(heard) === norm(correction)` was
 * `"" === ""` and ALL 11 were refused as "identical to what was heard" —
 * including `پرسٹ` → `فرسٹ`, which shares no letters with what it replaced.
 *
 * Keeping letters and digits of every script also KEEPS accented Latin
 * ("café", "über") where the old expression deleted it. That is the same bug
 * in miniature — a French word normalized to "caf" — so it is a fix, not a
 * regression. Pure-ASCII input is byte-identical to the old behaviour, which
 * is pinned by a test.
 */
export function normalizeForCompare(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(ARABIC_NOISE, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

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

// Exported: blooper.ts reuses this directly for the marker fuzzy-match arm
// (Task 3, editor-dogfood-fixes plan) instead of a second copy — plain edit
// distance on the raw normalized word, not the phonetic key `soundsLike`
// compares, because "blooper"/"looker" fails the onset test below yet is
// exactly the mishearing the marker match needs to catch.
export function levenshtein(a: string, b: string): number {
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
 * 0..1 similarity of the TEXT itself, for scripts the phonetic key cannot
 * represent (`phoneticKey` is defined over a-z, so anything non-Latin keys to
 * ""). Same shape as `soundsLike` — normalized edit distance over the longer
 * string — but run on the normalized text rather than a consonant skeleton.
 *
 * This is a weaker signal than a phonetic key and it is meant to be: an
 * Urdu-script mishearing differs from the truth by a letter or two of the same
 * script, so edit distance still separates it from an unrelated phrase. What
 * it cannot do is fold vowels, which is why the floor below is calibrated
 * against real data instead of borrowing SOUNDS_LIKE_FLOOR.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  return Math.max(0, 1 - levenshtein(na, nb) / Math.max(na.length, nb.length));
}

/**
 * Floor for the non-Latin fallback, MEASURED rather than guessed.
 *
 * The 11 Urdu repairs recorded in a real production.json (2026-08-18) score,
 * sorted: 0.333, 0.400, 0.500, 0.500, 0.545, 0.583, 0.636, 0.750, 0.750,
 * 0.800, 0.800. The 0.333 is `حقیقہ ٹون` → `ہیکاتھون` ("hackathon"), a genuine
 * repair and the worst of the set because the recognizer both re-segmented the
 * word and changed its opening letter. Admitting it sets the ceiling on the
 * floor; 0.33 is the largest value that does.
 *
 * Against that, unrelated four-word spans lifted from the same transcript
 * score 0.167–0.250 and are refused. The band is narrow, and it is narrow for
 * the same reason the Latin one is (see SOUNDS_LIKE_FLOOR): two SHORT
 * unrelated Urdu spans can still land above it — measured, `پرسٹ ہیک` vs
 * `ٹرس می` scores 0.500. There is no onset test here to catch that, because
 * two of the 11 genuine repairs change their first letter. So this gate is
 * real but shallow; the span, token-count and length guards in
 * `applyRepairs` are what keep it from being a rewrite licence.
 */
export const TEXT_SIMILARITY_FLOOR = 0.33;

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
 *
 * When either side has no Latin letters there is no key to compare, and this
 * used to answer `ka === kb` — `"" === ""`, i.e. YES for any two non-Latin
 * strings however unrelated. That is no gate at all for an Urdu transcript, so
 * those pairs route to `textSimilarity` instead (2026-08-18 field case).
 * Latin-to-Latin comparisons never reach that branch and are unchanged.
 */
export function soundsSimilar(a: string, b: string, floor = SOUNDS_LIKE_FLOOR): boolean {
  const ka = phraseKey(a);
  const kb = phraseKey(b);
  if (ka.length === 0 || kb.length === 0) {
    // `floor` is deliberately NOT reused here: it is calibrated against
    // consonant skeletons, which are shorter and coarser than the text this
    // branch compares, so the same number means something else. Taking the
    // larger of the two was tried and is wrong — the default 0.34 alone
    // rejects a measured genuine repair scoring 0.333. The only caller that
    // raises the floor (reconcileCopy, 0.6) cannot reach this branch anyway:
    // its candidate tokens are stripped to `[A-Za-z]`, so its key is never
    // empty and a non-Latin spoken word scores ~0 against it regardless.
    return textSimilarity(a, b) >= TEXT_SIMILARITY_FLOOR;
  }
  if (ka[0] !== kb[0]) return false;
  return soundsLike(a, b) >= floor;
}
