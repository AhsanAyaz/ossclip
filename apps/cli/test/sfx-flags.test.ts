import { describe, expect, it } from "vitest";
import { SFX_PROMPT_VERSION } from "@ossclip/core";
import { resolveSfx, resolveSfxLevel, sfxCacheKey, sfxFlag } from "../src/produce";

/**
 * `--sfx` / `--sfx-level`: the implication, the config precedence, and the
 * §78 cache key. Pure — no workdir, no commander, no LLM — except for the one
 * describe that parses argv against the REAL program, which is the only shape
 * where a renamed flag fails as a test instead of shipping.
 */

describe("sfxFlag — --sfx-level implies --sfx", () => {
  it("a typed level turns the switch on", () => {
    // Typing a level IS asking for sound effects; a run that quietly did
    // nothing because the boolean was missing is the worst reading of it.
    expect(sfxFlag(undefined, "meme")).toBe(true);
    expect(sfxFlag(true, "subtle")).toBe(true);
  });

  it("leaves the tri-state alone when no level was typed", () => {
    // undefined must SURVIVE, or the config's `sfx` key never gets its turn.
    expect(sfxFlag(undefined, undefined)).toBeUndefined();
    expect(sfxFlag(true, undefined)).toBe(true);
    expect(sfxFlag(false, undefined)).toBe(false);
  });
});

describe("resolveSfx", () => {
  it("typed beats config, in both directions", () => {
    expect(resolveSfx(true, false)).toBe(true);
    expect(resolveSfx(false, true)).toBe(false);
    expect(resolveSfx(undefined, true)).toBe(true);
    expect(resolveSfx(undefined, undefined)).toBe(false);
  });

  it("refuses a truthy config value — parse, never coerce", () => {
    // A hand-edited `"sfx": "yes"` must not add effects to every render.
    expect(resolveSfx(undefined, "yes")).toBe(false);
    expect(resolveSfx(undefined, 1)).toBe(false);
  });
});

describe("resolveSfxLevel", () => {
  it("defaults to normal and takes a typed flag over the config", () => {
    expect(resolveSfxLevel(undefined, undefined)).toEqual({ level: "normal" });
    expect(resolveSfxLevel("meme", "subtle")).toEqual({ level: "meme" });
    expect(resolveSfxLevel(undefined, "subtle")).toEqual({ level: "subtle" });
  });

  it("warns and falls back to normal on a malformed config level", () => {
    // Never UP into meme: that level unlocks the meme-tagged sounds, and a
    // typo must not put a vine boom in someone's video.
    const out = resolveSfxLevel(undefined, "loud");
    expect(out.level).toBe("normal");
    expect(out.warning).toContain("sfxLevel");
  });
});

describe("sfxCacheKey — §78: a change that changes the plan changes the key", () => {
  const base = {
    promptVersion: SFX_PROMPT_VERSION,
    beatKey: "abc123",
    level: "normal" as const,
    libraryHash: "hash-a",
    words: ["one", "two", "three"],
  };

  it("is stable for identical inputs — a re-run must hit its own cache", () => {
    expect(sfxCacheKey(base)).toBe(sfxCacheKey({ ...base }));
  });

  it("changes with the prompt version", () => {
    // The one regenerate lever: an edited SFX prompt must not keep serving
    // plans the old one asked for.
    expect(sfxCacheKey({ ...base, promptVersion: 2 })).not.toBe(sfxCacheKey(base));
  });

  it("changes with the beat sheet it was planned against", () => {
    // The graphics plan is IN the placement prompt — a re-planned sheet is a
    // different question about the same words.
    expect(sfxCacheKey({ ...base, beatKey: "def456" })).not.toBe(sfxCacheKey(base));
  });

  it("changes with the level", () => {
    expect(sfxCacheKey({ ...base, level: "meme" })).not.toBe(sfxCacheKey(base));
    expect(sfxCacheKey({ ...base, level: "subtle" })).not.toBe(sfxCacheKey(base));
  });

  it("changes with the library, so a dropped user pack re-plans", () => {
    expect(sfxCacheKey({ ...base, libraryHash: "hash-b" })).not.toBe(sfxCacheKey(base));
  });

  it("changes with the transcript's TEXT, not just its length", () => {
    // The beat key's rule, for the beat key's reason: a repair that swaps
    // "coach and" for "code churn" leaves the count identical.
    expect(sfxCacheKey({ ...base, words: ["one", "two", "four"] })).not.toBe(sfxCacheKey(base));
  });
});

/**
 * The flags against the real `buildProgram()` — the produce-argv-roundtrip
 * harness's argument verbatim: a replica of the option declarations would let
 * a rename pass here and break the shipped CLI.
 */
const parse = async (argv: string[]): Promise<Record<string, unknown>> => {
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr() {} });
  }
  let captured: Record<string, unknown> = {};
  const produce = program.commands.find((c) => c.name() === "produce");
  if (produce === undefined) throw new Error("the real program has no `produce` command");
  produce.action((input: string | undefined, opts: Record<string, unknown>) => {
    captured = { input, ...opts };
  });
  await program.parseAsync(["node", "ossclip", ...argv]);
  return captured;
};

describe("--sfx / --sfx-level through the real parse", () => {
  it("untyped stays undefined so the config can decide", async () => {
    const opts = await parse(["produce", "./take.mp4"]);
    expect(opts.sfx).toBeUndefined();
    expect(opts.sfxLevel).toBeUndefined();
  });

  it("--sfx alone is the switch; --sfx-level carries the zod-parsed level", async () => {
    expect((await parse(["produce", "./take.mp4", "--sfx"])).sfx).toBe(true);
    const level = await parse(["produce", "./take.mp4", "--sfx-level", "meme"]);
    expect(level.sfxLevel).toBe("meme");
    // The implication is the action's (sfxFlag) — commander itself leaves the
    // boolean untyped, which is exactly why that function exists.
    expect(sfxFlag(level.sfx as boolean | undefined, level.sfxLevel as "meme")).toBe(true);
  });

  it("refuses a level it does not know instead of falling back to normal", async () => {
    await expect(parse(["produce", "./take.mp4", "--sfx-level", "mem"])).rejects.toThrow(
      /--sfx-level/,
    );
  });
});
