import { describe, expect, it } from "vitest";
import { dictionaryFlag, validDictionary } from "../src/produce";

/**
 * The two pure halves of the dictionary's resolution (F4, 2026-08-16):
 * `dictionaryFlag` splits the typed `--dictionary` value, `validDictionary`
 * vets the config's hand-edited key. produce() then resolves once —
 * `opts.dictionary ?? validDictionary(cfg.dictionary) ?? []` — so
 * typed-beats-config with no merging, the watermark's precedence.
 */
describe("dictionaryFlag", () => {
  it("splits on commas, trims, and drops empties — a trailing comma is not a term", () => {
    expect(dictionaryFlag("JSON, ossclip ,,  Genkit ,")).toEqual(["JSON", "ossclip", "Genkit"]);
  });

  it("keeps 'not typed' as undefined so the config can supply the default", () => {
    expect(dictionaryFlag(undefined)).toBeUndefined();
  });

  it("an all-whitespace value becomes an empty list — a typed nothing beats the config", () => {
    // `[]` is distinct from undefined on purpose: `--dictionary " "` was
    // TYPED, so it resolves to no terms rather than falling to the config.
    expect(dictionaryFlag("  ")).toEqual([]);
  });
});

describe("validDictionary — the config key's consumer-side vetting", () => {
  it("accepts an array of non-empty strings, trimmed", () => {
    expect(validDictionary(["JSON", " ossclip "])).toEqual(["JSON", "ossclip"]);
  });

  it("rejects everything else all-or-nothing — no salvaging half a typo'd list", () => {
    expect(validDictionary("JSON, ossclip")).toBeUndefined(); // a string, not an array
    expect(validDictionary(["JSON", 42])).toBeUndefined(); // a non-string member
    expect(validDictionary(["JSON", "  "])).toBeUndefined(); // a blank term
    expect(validDictionary([])).toBeUndefined(); // empty = nothing to bias with
    expect(validDictionary(undefined)).toBeUndefined();
    expect(validDictionary(null)).toBeUndefined();
    expect(validDictionary({ terms: ["JSON"] })).toBeUndefined();
  });
});
