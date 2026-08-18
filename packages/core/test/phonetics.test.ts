import { describe, expect, it } from "vitest";
import {
  SOUNDS_LIKE_FLOOR,
  TEXT_SIMILARITY_FLOOR,
  normalizeForCompare,
  phoneticKey,
  soundsLike,
  soundsSimilar,
  textSimilarity,
} from "../src/phonetics";

describe("normalizeForCompare", () => {
  /** The Latin-only expression this replaced, kept to prove no perturbation. */
  const legacy = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");

  it("is byte-identical to the old implementation on pure ASCII", () => {
    const corpus = [
      "coach and",
      "CodeChun",
      "Orchestration Tax!",
      "  we   shipped   it  ",
      "861%",
      "code with SM — which is the channel",
      "JSON, ossclip; v2.0",
      "",
      "   ",
      "a_b-c",
      "Ahsan, host of Code with Ahsan",
    ];
    for (const s of corpus) {
      expect(normalizeForCompare(s), `ASCII must not move: ${JSON.stringify(s)}`).toBe(legacy(s));
    }
  });

  it("KEEPS accented Latin the old expression deleted — same bug in miniature", () => {
    // "café" used to normalize to "caf" and "über" to "ber", which made a
    // French or German transcript compare wrong in exactly the way the Urdu
    // one did, only less visibly. Fix, not regression.
    expect(normalizeForCompare("Café")).toBe("café");
    expect(normalizeForCompare("Über")).toBe("über");
    expect(legacy("Café")).toBe("caf"); // what it used to do
  });

  it("keeps letters and digits of any script and still strips punctuation", () => {
    expect(normalizeForCompare("پرسٹ")).toBe("پرسٹ");
    expect(normalizeForCompare("«ہیک اٹان»؟")).toBe("ہیک اٹان");
    expect(normalizeForCompare("پرسٹ 861%")).toBe("پرسٹ 861");
  });

  it("strips the Arabic marks ASR and an LLM disagree about", () => {
    // Escaped on purpose: harakat, tatweel and the zero-width joiners are
    // invisible in an editor, and a test nobody can read is not a test.
    const bare = "\u06C1\u06CC\u06A9\u0627\u062A\u06BE\u0648\u0646"; // ہیکاتھون
    const marks = ["\u064E", "\u0650", "\u0670", "\u0640", "\u200C", "\u200D"];
    for (const m of marks) {
      const marked = bare.slice(0, 4) + m + bare.slice(4);
      const code = m.codePointAt(0)!.toString(16).toUpperCase();
      expect(normalizeForCompare(marked), `U+${code} must not change the word`).toBe(bare);
    }
  });

  it("composes to NFC so a decomposed correction compares equal", () => {
    // The same word typed two ways: precomposed \u00E9 vs e + combining acute.
    expect(normalizeForCompare("caf\u00E9")).toBe(normalizeForCompare("cafe\u0301"));
  });
});

describe("phoneticKey", () => {
  it("drops vowels and folds digraphs", () => {
    expect(phoneticKey("code")).toBe("kd");
    expect(phoneticKey("phone")).toBe("fn");
    // ch/sh share one sound, and it must survive the single-letter pass
    // rather than being re-expanded into "ks".
    expect(phoneticKey("coach")).toBe(phoneticKey("koash"));
    expect(phoneticKey("churn")).toBe(phoneticKey("shurn"));
    expect(phoneticKey("coach")).not.toContain("ks");
  });
  it("keeps a first letter for all-vowel words", () => {
    expect(phoneticKey("a")).toBe("a");
    expect(phoneticKey("I")).toBe("i");
  });
  it("ignores case and punctuation", () => {
    expect(phoneticKey("Churn,")).toBe(phoneticKey("churn"));
    expect(phoneticKey("CodeChun")).toBe(phoneticKey("codechun"));
  });
  it("collapses doubled sounds", () => {
    expect(phoneticKey("miller")).toBe(phoneticKey("miler"));
  });
  it("is empty for non-alphabetic input", () => {
    expect(phoneticKey("861%")).toBe("");
    expect(phoneticKey("—")).toBe("");
  });
});

describe("soundsLike — the real mishearings must read as repairs", () => {
  // Every case below came off an actual produced render (FINDINGS §17/§21).
  it("small.en's 'coach and' vs the true 'code churn'", () => {
    expect(soundsSimilar("coach and", "code churn")).toBe(true);
  });
  it("base.en's 'CodeChun' vs 'code churn'", () => {
    expect(soundsSimilar("CodeChun", "code churn")).toBe(true);
  });
  it("'text' vs 'tax' (the Orchestration Tax caption)", () => {
    expect(soundsSimilar("text", "tax")).toBe(true);
  });
  it("identical text is a perfect match", () => {
    expect(soundsLike("churn", "churn")).toBe(1);
  });
});

describe("soundsLike — inventions must NOT read as repairs", () => {
  it("the hallucinated 'revenue' label is not a mishearing of 'churn'", () => {
    expect(soundsSimilar("revenue", "churn")).toBe(false);
  });
  it("'monetization' is not a mishearing of 'agents'", () => {
    expect(soundsSimilar("monetization", "agents")).toBe(false);
  });
  it("a paraphrase is not a repair", () => {
    expect(soundsSimilar("we shipped it fast", "the team moved quickly")).toBe(false);
  });
  it("scores stay within 0..1", () => {
    for (const [a, b] of [["a", "b"], ["", "x"], ["", ""], ["long phrase here", "x"]]) {
      const s = soundsLike(a!, b!);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
  it("the ratio alone barely separates the populations — the onset test is what holds", () => {
    // Resegmentation ("code churn" → "coach and" moves the /tʃ/ across a word
    // boundary) drags a GENUINE repair down to ~0.4, which is uncomfortably
    // close to an unrelated noun at ~0.33. The floor cannot carry this alone.
    const repair = soundsLike("coach and", "code churn");
    const invention = soundsLike("revenue", "churn");
    expect(repair).toBeGreaterThanOrEqual(SOUNDS_LIKE_FLOOR);
    expect(repair - invention).toBeLessThan(0.15); // the bands nearly touch
    // The onset is the robust signal: a word starting with a different sound
    // is a rewrite regardless of how well the rest happens to line up.
    expect(soundsLike("burn", "churn")).toBeGreaterThan(SOUNDS_LIKE_FLOOR);
    expect(soundsSimilar("burn", "churn")).toBe(false);
  });

  it("is symmetric", () => {
    expect(soundsSimilar("tax", "text")).toBe(soundsSimilar("text", "tax"));
    expect(soundsSimilar("churn", "revenue")).toBe(soundsSimilar("revenue", "churn"));
  });
});

describe("non-Latin fallback (2026-08-18 Urdu field case)", () => {
  // `phoneticKey` is defined over a-z, so an Urdu word keys to "" and the
  // phonetic path has nothing to compare. `soundsSimilar` used to answer
  // `ka === kb` there — `"" === ""` — which said YES to any two Urdu strings
  // however unrelated, i.e. no gate at all once the norm() fix let proposals
  // reach it. These cases pin the replacement.
  const REPAIRS: Array<[string, string, number]> = [
    ["پرسٹ", "فرسٹ", 0.75],
    ["ہیک اٹان", "ہیکاتھون", 0.5],
    ["کوڈ بیدائیسن", "کوڈ ود احسن", 0.583],
    ["حقیقہ ٹون", "ہیکاتھون", 0.333],
    ["ویڈس", "ود دس", 0.4],
    ["کول بیدائسن", "کوڈ ود احسن", 0.545],
    ["ٹرس", "ٹرسٹ", 0.75],
    ["ای سی", "آئی سے", 0.5],
    ["گروت", "گروتھ", 0.8],
    ["نیکس", "نیکسٹ", 0.8],
    ["انڈا پیچیرز", "ان دا پکچرز", 0.636],
  ];

  it("scores every recorded field repair where the measured comment says it does", () => {
    // The floor is justified by these numbers, so they are pinned: if the
    // normalizer changes and the scores move, the floor must be re-derived.
    for (const [heard, correction, expected] of REPAIRS) {
      expect(textSimilarity(heard, correction), `${heard} → ${correction}`).toBeCloseTo(expected, 3);
    }
  });

  it("admits all 11 genuine repairs", () => {
    for (const [heard, correction] of REPAIRS) {
      expect(soundsSimilar(heard, correction), `${heard} → ${correction}`).toBe(true);
    }
  });

  it("the worst genuine repair is what sets the floor", () => {
    // "حقیقہ ٹون" → "ہیکاتھون" (hackathon) scores 0.333: the recognizer split
    // the word AND changed its opening letter. Nothing genuine scored lower,
    // and the floor sits just under it.
    const worst = Math.min(...REPAIRS.map(([h, c]) => textSimilarity(h, c)));
    expect(worst).toBeGreaterThan(TEXT_SIMILARITY_FLOOR);
    expect(TEXT_SIMILARITY_FLOOR).toBeGreaterThan(0.25); // still above the unrelated band
  });

  it("rejects unrelated Urdu phrases from the same take", () => {
    const unrelated: Array<[string, string]> = [
      ["کراچی اور جنہیں نہیں", "پہ کھڑے ہیں اور"],
      ["ہم اگوگلڈیویلپرز ایکسپرٹ ان اے آئی", "میں جو کہ گوگل کے اسٹاک ہوم آفس"],
      ["کے لیے", "ہوں اس کھڑے اس"],
    ];
    for (const [a, b] of unrelated) {
      expect(textSimilarity(a, b), `${a} | ${b}`).toBeLessThan(TEXT_SIMILARITY_FLOOR);
      expect(soundsSimilar(a, b)).toBe(false);
    }
  });

  it("identical non-Latin text scores 1", () => {
    expect(textSimilarity("ہیکاتھون", "ہیکاتھون")).toBe(1);
    expect(soundsSimilar("ہیکاتھون", "ہیکاتھون")).toBe(true);
  });

  it("is symmetric, like the Latin path", () => {
    expect(textSimilarity("پرسٹ", "فرسٹ")).toBe(textSimilarity("فرسٹ", "پرسٹ"));
    expect(soundsSimilar("پرسٹ", "کے لیے")).toBe(soundsSimilar("کے لیے", "پرسٹ"));
  });

  it("scores 0 across scripts — an Urdu word is not a mishearing of a Latin one", () => {
    expect(textSimilarity("ہیکاتھون", "hackathon")).toBe(0);
    expect(soundsSimilar("ہیکاتھون", "hackathon")).toBe(false);
  });
});
