import { describe, expect, it } from "vitest";
import { matchLibrary, mentionsOf, normalizeMatchToken } from "../src/overlay-match";

/** Word i starts at 2*i seconds — far apart unless a test says otherwise. */
const say = (texts: string[], gap = 2): { text: string; start: number; end: number }[] =>
  texts.map((text, i) => ({ text, start: i * gap, end: i * gap + 0.4 }));

describe("normalizeMatchToken", () => {
  it("trims, strips edge punctuation and a trailing possessive, keeps case", () => {
    expect(normalizeMatchToken("  GDE, ")).toBe("GDE");
    expect(normalizeMatchToken("GDE.")).toBe("GDE");
    expect(normalizeMatchToken("GDE's")).toBe("GDE");
    expect(normalizeMatchToken("“Firebase’s”,")).toBe("Firebase");
    expect(normalizeMatchToken("GDEs")).toBe("GDEs");
    expect(normalizeMatchToken("—")).toBe("");
  });

  it("keeps symbols that are part of a name, and a leading dot", () => {
    expect(normalizeMatchToken("C++,")).toBe("C++");
    expect(normalizeMatchToken("C#.")).toBe("C#");
    expect(normalizeMatchToken(".NET")).toBe(".NET");
    expect(normalizeMatchToken("(.NET),")).toBe(".NET");
    expect(normalizeMatchToken("GDE.")).toBe("GDE");
  });
});

describe("matchLibrary", () => {
  it("first mention only", () => {
    const words = say(["so", "I", "became", "GDE", "and", "then", "a", "lot", "of", "GDE"]);
    const { placements, dropped } = matchLibrary(words, [{ id: "gde", names: ["GDE"] }]);
    expect(placements).toEqual([{ id: "gde@3", entryId: "gde", word: 3, source: "match" }]);
    expect(dropped).toEqual([]);
  });

  it("multi-word name as a contiguous sequence", () => {
    const entries = [{ id: "ce", names: ["clean edit"] }];
    expect(matchLibrary(say(["a", "clean,", "edit."]), entries).placements.map((p) => p.word)).toEqual([1]);
    expect(matchLibrary(say(["clean", "and", "edit"]), entries).placements).toEqual([]);
  });

  it("case-insensitive for longer names", () => {
    const { placements } = matchLibrary(say(["use", "firebase"]), [{ id: "fb", names: ["Firebase"] }]);
    expect(placements.map((p) => p.word)).toEqual([1]);
  });

  it("≤3-letter single word needs exact case", () => {
    const go = [{ id: "go", names: ["Go"] }];
    expect(matchLibrary(say(["let's", "go"]), go).placements).toEqual([]);
    expect(matchLibrary(say(["I", "write", "Go"]), go).placements.map((p) => p.word)).toEqual([2]);
    const gde = [{ id: "gde", names: ["GDE"] }];
    expect(matchLibrary(say(["GDE,"]), gde).placements).toHaveLength(1);
    expect(matchLibrary(say(["GDE's"]), gde).placements).toHaveLength(1);
    expect(matchLibrary(say(["GDEs"]), gde).placements).toEqual([]);
    expect(matchLibrary(say(["gde"]), gde).placements).toEqual([]);
  });

  it("symbol names never collapse to a bare letter", () => {
    const csharp = [{ id: "csharp", names: ["C#"] }];
    expect(matchLibrary(say(["I", "write", "C++"]), csharp).placements).toEqual([]);
    expect(matchLibrary(say(["plan", "C"]), csharp).placements).toEqual([]);
    expect(matchLibrary(say(["I", "write", "C#,"]), csharp).placements.map((p) => p.word)).toEqual([2]);
    const dotnet = [{ id: "dotnet", names: [".NET"] }];
    expect(matchLibrary(say(["the", "NET"]), dotnet).placements).toEqual([]);
    expect(matchLibrary(say(["on", ".NET."]), dotnet).placements.map((p) => p.word)).toEqual([1]);
  });

  it("punctuation-only spoken words are skipped, keeping original indices", () => {
    const entries = [{ id: "gc", names: ["Google - Cloud"] }];
    const { placements } = matchLibrary(say(["on", "Google", "—", "Cloud"]), entries);
    expect(placements).toEqual([{ id: "gc@1", entryId: "gc", word: 1, source: "match" }]);
    expect(mentionsOf(say(["—", "Google", "—", "Cloud"]), ["Google - Cloud"])).toEqual([1]);
  });

  it("no stemming", () => {
    const { placements } = matchLibrary(say(["Firebased"]), [{ id: "fb", names: ["Firebase"] }]);
    expect(placements).toEqual([]);
  });

  it("longest name wins on overlap", () => {
    const entries = [
      { id: "google", names: ["Google"] },
      { id: "gde", names: ["Google Developers Expert"] },
    ];
    const once = matchLibrary(say(["a", "Google", "Developers", "Expert"]), entries);
    expect(once.placements).toEqual([{ id: "gde@1", entryId: "gde", word: 1, source: "match" }]);
    const later = matchLibrary(
      say(["a", "Google", "Developers", "Expert", "at", "Google", "Developers", "Expert", "and", "Google"]),
      entries,
    );
    // The second full phrase still claims its words: "Google" inside it is not a standalone mention.
    expect(later.placements.map((p) => p.id)).toEqual(["gde@1", "google@9"]);
  });

  it("cut words ignored", () => {
    const words = say(["so", "I", "became", "GDE", "and", "a", "GDE"]);
    const { placements } = matchLibrary(words, [{ id: "gde", names: ["GDE"] }], { kept: (i) => i !== 3 });
    expect(placements.map((p) => p.word)).toEqual([6]);
  });

  it("overlap drop", () => {
    const words = [
      { text: "Firebase", start: 10, end: 10.5 },
      { text: "and", start: 10.5, end: 10.7 },
      { text: "Flutter", start: 11.2, end: 11.6 },
      { text: "Angular", start: 11.6, end: 12 },
    ];
    const entries = [
      { id: "fb", names: ["Firebase"] },
      { id: "fl", names: ["Flutter"] },
      { id: "ng", names: ["Angular"] },
    ];
    // Gap measured between word STARTS, against the last KEPT placement:
    // Flutter (1.2s after Firebase) drops, Angular (1.6s after) survives.
    expect(matchLibrary(words, entries)).toEqual({
      placements: [
        { id: "fb@0", entryId: "fb", word: 0, source: "match" },
        { id: "ng@3", entryId: "ng", word: 3, source: "match" },
      ],
      dropped: [{ entryId: "fl", word: 2, reason: "overlap" }],
    });
    expect(matchLibrary(words, entries, { minGapSec: 0.3 }).dropped).toEqual([]);
  });

  it("skipEntryIds honoured", () => {
    const entries = [
      { id: "google", names: ["Google"] },
      { id: "gde", names: ["Google Developers Expert"] },
    ];
    const words = say(["Google", "Developers", "Expert", "at", "Google"]);
    const { placements } = matchLibrary(words, entries, { skipEntryIds: new Set(["gde"]) });
    // A skipped entry still claims its words, so "Google" inside its phrase never pops.
    expect(placements).toEqual([{ id: "google@4", entryId: "google", word: 4, source: "match" }]);
  });

  it("occupiedStarts drops a match near an existing overlay without blocking the next one", () => {
    // say() spaces words 2s apart: alpha 0s, bravo 2s, charlie 4s.
    const words = say(["alpha", "bravo", "charlie"]);
    const entries = ["alpha", "bravo", "charlie"].map((n) => ({ id: n, names: [n] }));
    // An overlay the user already has at 2.5s: bravo (2s) is within 1.5s of
    // it, charlie (4s) is not. Bravo's drop must not advance the gap walk,
    // or charlie would wrongly be compared against it.
    const { placements, dropped } = matchLibrary(words, entries, { occupiedStarts: [2.5], minGapSec: 1.5 });
    expect(placements.map((p) => p.entryId)).toEqual(["alpha", "charlie"]);
    expect(dropped).toEqual([{ entryId: "bravo", word: 1, reason: "overlap" }]);
  });
});

describe("mentionsOf", () => {
  it("every kept start index of any name, ascending", () => {
    const words = say(["GDE", "and", "Google", "Developers", "Expert", "GDE", "gde"]);
    const names = ["Google Developers Expert", "GDE"];
    expect(mentionsOf(words, names)).toEqual([0, 2, 5]);
    expect(mentionsOf(words, names, (i) => i !== 0)).toEqual([2, 5]);
  });

  it("another entry's longer name claims its words (ruling R10)", () => {
    const words = say(["Google", "is", "a", "Google", "Developers", "Expert", "at", "Google"]);
    // In isolation every "Google" is a mention…
    expect(mentionsOf(words, ["Google"])).toEqual([0, 3, 7]);
    // …but with the GDE entry competing, the one inside the phrase is not.
    expect(mentionsOf(words, ["Google"], undefined, [{ names: ["Google Developers Expert"] }])).toEqual([0, 7]);
    // The phrase entry itself still sees its own mention.
    expect(mentionsOf(words, ["Google Developers Expert"], undefined, [{ names: ["Google"] }])).toEqual([3]);
  });
});
