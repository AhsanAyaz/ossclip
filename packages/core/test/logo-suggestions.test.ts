import { describe, expect, it } from "vitest";
import { suggestionIdFor, visibleSuggestions } from "../src/logo-suggestions";
import { OverrideDocSchema } from "../src/overrides";
import { LogoCandidateSchema, LogoSuggestionSchema, OverlayPlacementSchema, ProductionOverlaysSchema, type LogoSuggestion } from "../src/schema";

const say = (texts: string[]): { text: string; start: number; end: number }[] =>
  texts.map((text, i) => ({ text, start: i * 2, end: i * 2 + 0.4 }));

const words = say(["I", "use", "Google", "Gemini", "daily"]);
const words5 = say(["I", "use", "Kimi", "and", "Kimi"]);

const sug = (id: string, word: number, name = id): LogoSuggestion => ({ id, name, word, candidates: [] });
const emptyLayer = { edits: {}, added: [], entries: [], skippedSuggestions: [] };

describe("suggestionIdFor", () => {
  it("ids are the name's slug, so they survive a recut", () => {
    expect(suggestionIdFor("Google Gemini")).toBe("google-gemini");
    expect(suggestionIdFor("  Kimi!! ")).toBe("kimi");
  });

  it("a name with nothing sluggable still yields a valid id", () => {
    expect(suggestionIdFor("!!!")).toBe("logo");
    expect(suggestionIdFor("")).toBe("logo");
    expect(LogoSuggestionSchema.shape.id.safeParse(suggestionIdFor("Ünïcode")).success).toBe(true);
  });
});

describe("visibleSuggestions", () => {
  it("a skipped suggestion is hidden", () => {
    const out = visibleSuggestions([sug("kimi", 3)], { ...emptyLayer, skippedSuggestions: ["kimi"] }, words, () => true);
    expect(out).toEqual([]);
  });

  it("a live placement fromSuggestion hides its chip, a removed one does not", () => {
    const added = [{ id: "u1", entryId: "gemini", word: 2, source: "user" as const, fromSuggestion: "google-gemini" }];
    expect(visibleSuggestions([sug("google-gemini", 2)], { ...emptyLayer, added }, words, () => true)).toEqual([]);
    const removed = { ...emptyLayer, added, edits: { u1: { removed: true } } };
    expect(visibleSuggestions([sug("google-gemini", 2)], removed, words, () => true)).toHaveLength(1);
  });

  it("no overrides layer at all hides nothing and shows the chip at its own word", () => {
    expect(visibleSuggestions([sug("google-gemini", 2, "Google Gemini")], undefined, words, () => true)).toEqual([
      { ...sug("google-gemini", 2, "Google Gemini"), atWord: 2 },
    ]);
  });

  it("a cut word falls forward to the next kept mention of the name, else hides", () => {
    // words: ["I", "use", "Kimi", "and", "Kimi"]; word 2 cut
    expect(visibleSuggestions([sug("kimi", 2, "Kimi")], emptyLayer, words5, (i) => i !== 2)[0]!.atWord).toBe(4);
    expect(visibleSuggestions([sug("kimi", 2, "Kimi")], emptyLayer, words5, (i) => i < 2)).toEqual([]);
  });

  it("fall-forward matches a multi-word name contiguously over kept words, forgiving edge punctuation", () => {
    const w = say(["Google", "Gemini", "and", "Google", "is", "Gemini", "then", "google", "gemini's,"]);
    const out = visibleSuggestions([sug("google-gemini", 0, "Google Gemini")], undefined, w, (i) => i !== 0);
    // 3–5 is broken by "is"; 7–8 is the next contiguous mention.
    expect(out.map((s) => s.atWord)).toEqual([7]);
    // A cut word between two kept tokens makes them contiguous in the kept sequence.
    const out2 = visibleSuggestions([sug("google-gemini", 0, "Google Gemini")], undefined, w, (i) => i !== 0 && i !== 4);
    expect(out2.map((s) => s.atWord)).toEqual([3]);
  });
});

describe("schemas", () => {
  it("old production.json and overrides.json still parse unchanged", () => {
    expect(ProductionOverlaysSchema.parse({ entries: [], placements: [] }).suggestions).toBeUndefined();
    const oldOverlays = { edits: {}, added: [], entries: [] };
    expect(OverrideDocSchema.parse({ overlays: oldOverlays }).overlays).toEqual(oldOverlays);
    expect(OverlayPlacementSchema.parse({ id: "a@1", entryId: "a", word: 1, source: "match" })).not.toHaveProperty(
      "fromSuggestion",
    );
  });

  it("candidate files are confined to the workdir's logo-candidates tree", () => {
    expect(LogoCandidateSchema.safeParse({ file: "logo-candidates/kimi/0.png", source: "icon" }).success).toBe(true);
    expect(LogoCandidateSchema.safeParse({ file: "logo-candidates/../x/0.png", source: "icon" }).success).toBe(false);
    expect(LogoCandidateSchema.safeParse({ file: "/etc/passwd", source: "og" }).success).toBe(false);
    expect(LogoCandidateSchema.safeParse({ file: "logo-candidates/kimi/0.exe", source: "og" }).success).toBe(false);
  });

  it("caps candidates at 4 and suggestions at 8", () => {
    const c = { file: "logo-candidates/kimi/0.png", source: "icon" as const };
    expect(LogoSuggestionSchema.safeParse({ ...sug("kimi", 0), candidates: [c, c, c, c] }).success).toBe(true);
    expect(LogoSuggestionSchema.safeParse({ ...sug("kimi", 0), candidates: [c, c, c, c, c] }).success).toBe(false);
    const eight = Array.from({ length: 8 }, (_, i) => sug(`s${i}`, i));
    expect(ProductionOverlaysSchema.safeParse({ entries: [], placements: [], suggestions: eight }).success).toBe(true);
    expect(
      ProductionOverlaysSchema.safeParse({ entries: [], placements: [], suggestions: [...eight, sug("s8", 8)] }).success,
    ).toBe(false);
  });
});
