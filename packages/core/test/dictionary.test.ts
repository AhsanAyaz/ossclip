import { describe, expect, it } from "vitest";
import { canonicalizeDictionaryCasing } from "../src/dictionary";
import type { Transcript } from "../src/schema";

/** Contiguous stamps, exactly like whisper `-ml 1` output. */
function mk(words: string[], per = 0.5): Transcript {
  return {
    language: "en",
    words: words.map((text, i) => ({ text, start: i * per, end: (i + 1) * per })),
  };
}

describe("canonicalizeDictionaryCasing (F4, 2026-08-16)", () => {
  it("recases an exact token match to the dictionary's canonical spelling", () => {
    const out = canonicalizeDictionaryCasing(mk(["parse", "the", "json", "file"]), ["JSON"]);
    expect(out.words.map((w) => w.text)).toEqual(["parse", "the", "JSON", "file"]);
  });

  it("preserves leading and trailing punctuation around the recased core", () => {
    const out = canonicalizeDictionaryCasing(mk(["it's", "json.", '"json",', "(json)"]), ["JSON"]);
    expect(out.words.map((w) => w.text)).toEqual(["it's", "JSON.", '"JSON",', "(JSON)"]);
  });

  it("NEVER touches a different word — 'Jason' stays, phonetics is the repair pass's job", () => {
    const t = mk(["Jason", "wrote", "jsons"]);
    const out = canonicalizeDictionaryCasing(t, ["JSON"]);
    // Neither the near-homophone nor the inflection is an exact token match.
    expect(out.words.map((w) => w.text)).toEqual(["Jason", "wrote", "jsons"]);
  });

  it("applies every term of a multi-term dictionary independently", () => {
    const out = canonicalizeDictionaryCasing(mk(["Ossclip", "emits", "json", "via", "genkit."]), [
      "ossclip",
      "JSON",
      "Genkit",
    ]);
    expect(out.words.map((w) => w.text)).toEqual(["ossclip", "emits", "JSON", "via", "Genkit."]);
  });

  it("leaves timings and the rest of the word untouched — a casing pass, nothing more", () => {
    const t = mk(["json"]);
    const out = canonicalizeDictionaryCasing(t, ["JSON"]);
    expect(out.words[0]).toMatchObject({ start: 0, end: 0.5 });
    // The input transcript is not mutated: produce keeps rawTranscript as the
    // truth production.json stores.
    expect(t.words[0]!.text).toBe("json");
  });

  it("is the identity for an empty or blank-only dictionary", () => {
    const t = mk(["json"]);
    expect(canonicalizeDictionaryCasing(t, [])).toBe(t);
    expect(canonicalizeDictionaryCasing(t, ["  "])).toBe(t);
  });
});
