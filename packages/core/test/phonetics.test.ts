import { describe, expect, it } from "vitest";
import { SOUNDS_LIKE_FLOOR, phoneticKey, soundsLike, soundsSimilar } from "../src/phonetics";

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
