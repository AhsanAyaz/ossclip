import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { CallTier, LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import {
  LOGO_FINDER_PROMPT_VERSION,
  LogoFlagsSchema,
  generateLogoFlags,
  logoFlagsCacheKey,
  normalizeDomain,
  validateLogoFlags,
} from "../src/producer/logo-finder";

const words = ["I", "built", "it", "on", "Firebase", "with", "Google", "Gemini"].map((text) => ({ text }));
const none = { words: new Set<number>(), names: [] as string[] };
const all = () => true;

describe("validateLogoFlags", () => {
  it("keeps a flag on its word and drops one on the wrong word", () => {
    const r = validateLogoFlags(
      {
        names: [
          { name: "Firebase", word: 4, domain: "firebase.google.com" },
          { name: "Gemini", word: 1, domain: "gemini.google.com" },
        ],
      },
      words,
      all,
      none,
    );
    expect(r.flags.map((f) => f.name)).toEqual(["Firebase"]);
    expect(r.flags[0]).toEqual({ id: "firebase", name: "Firebase", word: 4, domain: "firebase.google.com" });
    expect(r.dropped).toEqual([{ name: "Gemini", reason: "wrong-word" }]);
  });

  it("a multi-word name may start at its first word", () => {
    const r = validateLogoFlags({ names: [{ name: "Google Gemini", word: 6 }] }, words, all, none);
    expect(r.flags[0]).toMatchObject({ id: "google-gemini", word: 6 });
  });

  it("a mention must run through the name's last token (R10)", () => {
    const rails = ["we", "use", "Ruby", "on", "Rails", "and", "on", "Monday"].map((text) => ({ text }));
    const r = validateLogoFlags(
      { names: [{ name: "Ruby on Rails", word: 2 }, { name: "Ruby on Rails", word: 6 }] },
      rails,
      all,
      none,
    );
    expect(r.flags.map((f) => f.word)).toEqual([2]);
    expect(r.dropped).toEqual([{ name: "Ruby on Rails", reason: "wrong-word" }]);
  });

  it("a mid-name start that stops short is the wrong word (R10)", () => {
    const ws = ["the", "studio", "lights"].map((text) => ({ text }));
    const r = validateLogoFlags({ names: [{ name: "Visual Studio Code", word: 1 }] }, ws, all, none);
    expect(r.dropped).toEqual([{ name: "Visual Studio Code", reason: "wrong-word" }]);
  });

  it("the last token alone passes, even at the end of the transcript (R10, accepted)", () => {
    // Accepted on purpose: the model chose this name at this word, and a
    // speaker's short form ("Code" for Visual Studio Code) is legitimate.
    const ws = ["I", "live", "in", "Code"].map((text) => ({ text }));
    const r = validateLogoFlags({ names: [{ name: "Visual Studio Code", word: 3 }] }, ws, all, none);
    expect(r.flags.map((f) => f.word)).toEqual([3]);
  });

  it("an index past the transcript is the wrong word, not a crash", () => {
    const r = validateLogoFlags({ names: [{ name: "Firebase", word: 99 }] }, words, all, none);
    expect(r.dropped).toEqual([{ name: "Firebase", reason: "wrong-word" }]);
  });

  it("reports the trimmed name in dropped", () => {
    const r = validateLogoFlags({ names: [{ name: "  Gemini ", word: 1 }] }, words, all, none);
    expect(r.dropped).toEqual([{ name: "Gemini", reason: "wrong-word" }]);
  });

  it("drops a flag on a cut word", () => {
    const r = validateLogoFlags({ names: [{ name: "Firebase", word: 4 }] }, words, (i) => i !== 4, none);
    expect(r.flags).toEqual([]);
    expect(r.dropped).toEqual([{ name: "Firebase", reason: "wrong-word" }]);
  });

  it("drops a flag whose span overlaps a covered word (R9 a)", () => {
    // A placed library "Gemini" at word 7 covers the tail of "Google Gemini".
    const r = validateLogoFlags(
      { names: [{ name: "Google Gemini", word: 6 }] },
      words,
      all,
      { words: new Set([7]), names: [] },
    );
    expect(r.flags).toEqual([]);
    expect(r.dropped).toEqual([{ name: "Google Gemini", reason: "in-library" }]);
  });

  it("drops a flag whose name is a covered entry's name or alias (R9 b)", () => {
    const r = validateLogoFlags(
      { names: [{ name: "firebase's", word: 4 }] },
      words,
      all,
      { words: new Set(), names: ["Firebase"] },
    );
    expect(r.dropped).toEqual([{ name: "firebase's", reason: "in-library" }]);
  });

  it("keeps a flag for a library name nothing placed (R9 case 1)", () => {
    // An unindexed `go.png` never auto-places, so a chip is the only way the
    // viewer gets a Go logo; the library merely having the name is not cover.
    const goWords = ["I", "write", "Go"].map((text) => ({ text }));
    const r = validateLogoFlags({ names: [{ name: "Go", word: 2 }] }, goWords, all, none);
    expect(r.flags.map((f) => f.id)).toEqual(["go"]);
  });

  it("drops duplicates by name and by id, keeping the earliest word", () => {
    const ws = ["Firebase", "and", "firebase", "C++", "or", "C#"].map((text) => ({ text }));
    const r = validateLogoFlags(
      {
        names: [
          { name: "firebase", word: 2 },
          { name: "Firebase", word: 0 },
          { name: "C++", word: 3 },
          { name: "C#", word: 5 },
        ],
      },
      ws,
      all,
      none,
    );
    expect(r.flags.map((f) => [f.name, f.word])).toEqual([
      ["Firebase", 0],
      ["C++", 3],
    ]);
    expect(r.dropped).toEqual([
      { name: "firebase", reason: "duplicate" },
      { name: "C#", reason: "duplicate" },
    ]);
  });

  it("keeps the earliest 8 and drops the rest as over-cap", () => {
    const ws = Array.from({ length: 10 }, (_, i) => ({ text: `Tool${i}` }));
    const names = ws.map((w, i) => ({ name: w.text, word: i })).reverse();
    const r = validateLogoFlags({ names }, ws, all, none);
    expect(r.flags.map((f) => f.word)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(r.dropped).toEqual([
      { name: "Tool8", reason: "over-cap" },
      { name: "Tool9", reason: "over-cap" },
    ]);
  });

  it("a bad domain keeps the flag without one", () => {
    const r = validateLogoFlags({ names: [{ name: "Firebase", word: 4, domain: "localhost" }] }, words, all, none);
    expect(r.flags[0]!.domain).toBeUndefined();
    expect("domain" in r.flags[0]!).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("keeps a bare host and refuses ports, IPs, paths and dotless names", () => {
    expect(normalizeDomain("https://Claude.ai/")).toBe("claude.ai");
    expect(normalizeDomain("firebase.google.com")).toBe("firebase.google.com");
    expect(normalizeDomain("https://www.example.com/pricing?x=1")).toBe("www.example.com");
    expect(normalizeDomain("claude.ai:8080")).toBeUndefined();
    expect(normalizeDomain("10.0.0.1")).toBeUndefined();
    expect(normalizeDomain("[::1]")).toBeUndefined();
    expect(normalizeDomain("localhost")).toBeUndefined();
    expect(normalizeDomain("foo.localhost")).toBeUndefined();
    // Hex IPv4 spellings the WHATWG parser reads as 127.0.0.1 (fix round 1).
    expect(normalizeDomain("0x7f.0x1")).toBeUndefined();
    expect(normalizeDomain("0x7f.0x0.0x0.0x1")).toBeUndefined();
    expect(normalizeDomain("127.0.0.0x1")).toBeUndefined();
    expect(normalizeDomain("user@claude.ai")).toBeUndefined();
    expect(normalizeDomain("bad_host.com")).toBeUndefined();
    expect(normalizeDomain("")).toBeUndefined();
  });
});

/** Provider that records the one request it receives and answers with canned JSON. */
class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly usage = [];
  seen?: { system: string; user: string; schemaName: string; tier?: CallTier };
  constructor(private answer: unknown) {}
  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    tier?: CallTier;
  }): Promise<T> {
    this.seen = { system: req.system, user: req.user, schemaName: req.schemaName, tier: req.tier };
    return req.schema.parse(this.answer);
  }
}

describe("generateLogoFlags", () => {
  it("asks the mechanical tier and lists library names in the prompt", async () => {
    const answer = { names: [{ name: "Firebase", word: 4, domain: "firebase.google.com" }] };
    const provider = new ScriptedProvider(answer);
    const r = await generateLogoFlags(provider, words, (i) => i !== 2, ["Claude", "GDE"], none);
    expect(provider.seen?.schemaName).toBe("logo_flags");
    expect(provider.seen?.tier).toBe("mechanical");
    expect(provider.seen?.user).toContain("4: Firebase");
    // A cut word is never offered: the model must not anchor to it.
    expect(provider.seen?.user).not.toContain("2: it");
    expect(provider.seen?.user).toContain("Claude");
    expect(provider.seen?.user).toContain("GDE");
    expect(provider.seen?.system).toMatch(/prefer omitting/i);
    // The raw answer rides along so the caller caches IT, not the flags (R9).
    expect(r.raw).toEqual(answer);
    expect(r.flags.map((f) => f.id)).toEqual(["firebase"]);
  });

  it("the mock provider answers with no names", async () => {
    const r = await generateLogoFlags(new MockProvider(), words, all, [], none);
    expect(r).toEqual({ raw: { names: [] }, flags: [], dropped: [] });
  });

  it("LogoFlagsSchema refuses a name past 80 characters (R11)", () => {
    expect(LogoFlagsSchema.safeParse({ names: [{ name: "x".repeat(80), word: 0 }] }).success).toBe(true);
    expect(LogoFlagsSchema.safeParse({ names: [{ name: "x".repeat(81), word: 0 }] }).success).toBe(false);
  });

  it("LogoFlagsSchema refuses a negative word", () => {
    expect(LogoFlagsSchema.safeParse({ names: [{ name: "X", word: -1 }] }).success).toBe(false);
  });
});

describe("logoFlagsCacheKey", () => {
  const base = { promptVersion: LOGO_FINDER_PROMPT_VERSION, words: ["a", "b"], libraryNames: ["Claude"] };
  it("is 8 hex and changes with each input", () => {
    const k = logoFlagsCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(logoFlagsCacheKey({ ...base })).toBe(k);
    expect(logoFlagsCacheKey({ ...base, promptVersion: base.promptVersion + 1 })).not.toBe(k);
    expect(logoFlagsCacheKey({ ...base, words: ["a", "c"] })).not.toBe(k);
    expect(logoFlagsCacheKey({ ...base, libraryNames: ["Claude", "GDE"] })).not.toBe(k);
  });
});
