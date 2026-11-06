import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockProvider, type LogoFlag, type LogoSuggestion } from "@ossclip/core";
import { formatLogoFinderLine, reusableSuggestion } from "../src/overlays";
import { produce } from "../src/produce";

/**
 * The logo finder inside `produce` (logo-finder spec §When the finder runs,
 * §Report): when it runs, what it caches, what it carries forward, and the
 * one line it prints.
 */

const suggestion = (name: string, over: Partial<LogoSuggestion> = {}): LogoSuggestion => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  word: 0,
  candidates: [{ file: `logo-candidates/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/0.png`, source: "header" }],
  ...over,
});

describe("formatLogoFinderLine (logo-finder spec §Report, ruling R13)", () => {
  it("says why it skipped", () => {
    expect(formatLogoFinderLine({ skipped: "no LLM provider" })).toBe("logo finder: skipped (no LLM provider)");
    expect(formatLogoFinderLine({ skipped: "the LLM call failed: timed out" })).toBe(
      "logo finder: skipped (the LLM call failed: timed out)",
    );
  });

  it("says no new names when the run found none", () => {
    expect(formatLogoFinderLine({ suggestions: [] })).toBe("logo finder: no new names");
    expect(formatLogoFinderLine({})).toBe("logo finder: no new names");
  });

  it("names every chip and each logo-less one with its note", () => {
    const line = formatLogoFinderLine({
      suggestions: [
        suggestion("Firebase"),
        suggestion("Google Gemini"),
        suggestion("Claude"),
        suggestion("Kimi", { candidates: [], note: "site timed out" }),
      ],
    });
    expect(line).toBe(
      "logo finder: 4 names (Firebase, Google Gemini, Claude, Kimi) — 3 with logos, 1 without (Kimi — site timed out)",
    );
  });

  it("drops the without-part when every name has a logo, and joins several notes with ;", () => {
    expect(formatLogoFinderLine({ suggestions: [suggestion("Firebase")] })).toBe(
      "logo finder: 1 name (Firebase) — 1 with logos",
    );
    expect(
      formatLogoFinderLine({
        suggestions: [
          suggestion("Kimi", { candidates: [], note: "site timed out" }),
          suggestion("Acme", { candidates: [], note: "acme.io answered 503" }),
        ],
      }),
    ).toBe("logo finder: 2 names (Kimi, Acme) — 0 with logos, 2 without (Kimi — site timed out; Acme — acme.io answered 503)");
  });
});

describe("reusableSuggestion (ruling R4)", () => {
  const flag: LogoFlag = { id: "firebase", name: "Firebase", word: 7, domain: "firebase.google.com" };
  const prior = [suggestion("Firebase", { word: 2, domain: "firebase.google.com" })];
  const all = () => true;

  it("reuses a prior with the same id and domain whose files all exist, at the flag's word", () => {
    expect(reusableSuggestion(flag, prior, all)).toEqual({ ...prior[0], word: 7 });
  });

  it("refetches when the domain changed, a file is gone, there is no prior, or the prior had no logos", () => {
    expect(reusableSuggestion({ ...flag, domain: "firebase.com" }, prior, all)).toBeUndefined();
    expect(reusableSuggestion(flag, prior, () => false)).toBeUndefined();
    expect(reusableSuggestion(flag, undefined, all)).toBeUndefined();
    expect(reusableSuggestion(flag, [], all)).toBeUndefined();
    const timedOut = [suggestion("Firebase", { domain: "firebase.google.com", candidates: [], note: "site timed out" })];
    expect(reusableSuggestion(flag, timedOut, all)).toBeUndefined();
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A PNG signature plus an IHDR chunk: enough for `sniffImageFormat` and `imageSize`. */
const png = (w: number, h: number): Uint8Array => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
};

const HOME = "https://firebase.google.com/";
/** The word the fixture transcript says "firebase" on. */
const FIREBASE_WORD = 3;

interface Artefacts {
  workdir: string;
  suggestions?: LogoSuggestion[];
  report: string;
  logs: string;
  flagCalls: number;
  /** The user prompt of each `logo_flags` call. */
  prompts: string[];
  fetches: string[];
}

describe.skipIf(!hasFfmpeg)("the logo finder in produce", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-logo-finder-produce-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    const texts = ["today", "I", "used", "firebase", "for", "the", "whole", "backend", "of", "it"];
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: texts.map((text, i) => ({ text, start: 0.4 + i * 1.1, end: 0.4 + i * 1.1 + 0.8 })),
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * The offline provider, with its `logo_flags` answer replaced: the mock
   * itself flags nothing (so the default offline path never fetches), and
   * produce has no provider seam, so the class is spied on. Every other
   * schema still gets the mock's own answer.
   */
  const run = async (
    opts: { produce?: boolean; scenes?: string; flags?: "firebase" | "throw"; libraryDir?: string },
    workdir: string,
  ): Promise<Artefacts> => {
    const logs: string[] = [];
    let flagCalls = 0;
    const prompts: string[] = [];
    const fetches: string[] = [];
    const original = MockProvider.prototype.complete;
    const complete = vi.spyOn(MockProvider.prototype, "complete").mockImplementation(async function (
      this: MockProvider,
      req,
    ) {
      if (req.schemaName === "logo_flags") {
        flagCalls++;
        prompts.push(req.user);
        if (opts.flags === "throw") throw new Error("provider exploded\nwith a stack");
        return req.schema.parse({ names: [{ name: "Firebase", word: FIREBASE_WORD, domain: "firebase.google.com" }] });
      }
      return original.call(this, req) as never;
    });
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    const logoFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      if (url === HOME) return new Response(`<header><img class="logo" src="/logo.png"></header>`);
      if (url === `${HOME}logo.png`) return new Response(png(200, 100));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const { flags: _flags, ...rest } = opts;
      const result = await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        // Hermetic (ruling R20): never the real ~/.ossclip/library.
        libraryDir: mkdtempSync(join(tmpdir(), "ossclip-empty-library-")),
        render: false,
        mezzanine: false,
        transcript: join(dir, "transcript.json"),
        workdir: join(dir, workdir),
        produce: true,
        provider: "mock",
        logoFetch,
        ...rest,
      });
      const read = (name: string) => readFileSync(join(result.workdir, name), "utf8");
      const production = JSON.parse(read("production.json")) as { overlays?: { suggestions?: LogoSuggestion[] } };
      return {
        workdir: result.workdir,
        suggestions: production.overlays?.suggestions,
        report: read("report.txt"),
        logs: logs.join("\n"),
        flagCalls,
        prompts,
        fetches,
      };
    } finally {
      spy.mockRestore();
      complete.mockRestore();
    }
  };

  const LINE = "logo finder: 1 name (Firebase) — 1 with logos";

  it(
    "flags, fetches and stores a suggestion, then answers a re-run from the caches with no call and no fetch",
    async () => {
      const first = await run({ flags: "firebase" }, "work-fresh");
      expect(first.flagCalls).toBe(1);
      expect(first.suggestions).toEqual([
        {
          id: "firebase",
          name: "Firebase",
          word: FIREBASE_WORD,
          domain: "firebase.google.com",
          candidates: [{ file: "logo-candidates/firebase/0.png", source: "header", width: 200, height: 100 }],
        },
      ]);
      expect(existsSync(join(first.workdir, "logo-candidates", "firebase", "0.png"))).toBe(true);
      expect(first.report).toContain(`\n${LINE}\n`);
      expect(first.logs).toContain(`▸ ${LINE}`);
      expect(readdirSync(first.workdir).filter((f) => /^logo-flags-[0-9a-f]{8}\.json$/.test(f))).toHaveLength(1);

      // R4 + the flags cache: nothing changed, so the re-run is offline.
      const again = await run({ flags: "firebase" }, "work-fresh");
      expect(again.flagCalls).toBe(0);
      expect(again.fetches).toEqual([]);
      expect(again.suggestions).toEqual(first.suggestions);
      expect(again.report).toContain(`\n${LINE}\n`);
    },
    180_000,
  );

  it(
    "asks again when the cached answer is malformed",
    async () => {
      const first = await run({ flags: "firebase" }, "work-malformed");
      const cache = readdirSync(first.workdir).find((f) => f.startsWith("logo-flags-"))!;
      writeFileSync(join(first.workdir, cache), '{"names": "not a list"}');
      const again = await run({ flags: "firebase" }, "work-malformed");
      expect(again.flagCalls).toBe(1);
      expect(again.suggestions).toEqual(first.suggestions);
    },
    180_000,
  );

  it(
    "carries the suggestions through a --scenes replay and a run without --produce, with no call and no fetch",
    async () => {
      const first = await run({ flags: "firebase" }, "work-carry");
      const scenesPath = join(dir, "scenes-reviewed.json");
      writeFileSync(scenesPath, "[]");

      const replay = await run({ flags: "firebase", scenes: scenesPath, produce: false }, "work-carry");
      expect(replay.flagCalls).toBe(0);
      expect(replay.fetches).toEqual([]);
      expect(replay.suggestions).toEqual(first.suggestions);
      // R5: a carry-forward reports what it carried.
      expect(replay.report).toContain(`\n${LINE}\n`);

      const plain = await run({ flags: "firebase", produce: false }, "work-carry");
      expect(plain.flagCalls).toBe(0);
      expect(plain.fetches).toEqual([]);
      expect(plain.suggestions).toEqual(first.suggestions);
      expect(plain.report).toContain(`\n${LINE}\n`);
    },
    180_000,
  );

  it(
    "says it skipped on a fresh run without --produce, and writes no overlays",
    async () => {
      const out = await run({ flags: "firebase", produce: false }, "work-plain");
      expect(out.flagCalls).toBe(0);
      expect(out.suggestions).toBeUndefined();
      expect(out.report).toContain("\nlogo finder: skipped (no LLM provider)\n");
      const production = JSON.parse(readFileSync(join(out.workdir, "production.json"), "utf8")) as object;
      expect(production).not.toHaveProperty("overlays");
    },
    180_000,
  );

  it(
    "finishes when the flags call throws, and keeps the prior suggestions (R17)",
    async () => {
      const fresh = await run({ flags: "throw" }, "work-throw");
      expect(fresh.flagCalls).toBe(1);
      expect(fresh.suggestions).toBeUndefined();
      expect(fresh.report).toContain("\nlogo finder: skipped (the LLM call failed: provider exploded)\n");

      // A workdir that already has a chip: the cache is gone, the call fails,
      // and the chip must survive.
      const first = await run({ flags: "firebase" }, "work-throw-prior");
      for (const f of readdirSync(first.workdir).filter((n) => n.startsWith("logo-flags-"))) {
        rmSync(join(first.workdir, f));
      }
      const failed = await run({ flags: "throw" }, "work-throw-prior");
      expect(failed.flagCalls).toBe(1);
      expect(failed.suggestions).toEqual(first.suggestions);
      expect(failed.report).toContain("\nlogo finder: skipped (the LLM call failed: provider exploded)\n");
    },
    180_000,
  );

  it(
    "does not suggest a name a live library placement already covers (R9)",
    async () => {
      const lib = mkdtempSync(join(tmpdir(), "ossclip-firebase-library-"));
      writeFileSync(join(lib, "firebase.png"), png(200, 100));
      writeFileSync(
        join(lib, "library.json"),
        JSON.stringify({ entries: [{ id: "firebase", file: "firebase.png", names: ["Firebase"], kind: "logo" }] }),
      );
      const out = await run({ flags: "firebase", libraryDir: lib }, "work-covered");
      // The library's names shape the prompt; the live placement decides the drop.
      expect(out.prompts[0]).toContain("- Firebase");
      expect(out.fetches).toEqual([]);
      expect(out.report).toContain("\nlogo finder: no new names\n");
      const production = JSON.parse(readFileSync(join(out.workdir, "production.json"), "utf8")) as {
        overlays?: { placements: unknown[]; suggestions?: unknown };
      };
      expect(production.overlays?.placements).toHaveLength(1);
      expect(production.overlays).not.toHaveProperty("suggestions");
    },
    180_000,
  );
});
