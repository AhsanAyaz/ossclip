import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { defaultProviderName, type ProviderName } from "@ossclip/core";
import { binOnPath, detectionLine, fallbackLine } from "../src/llm-detect";

/**
 * Field report 2026-08-07: `--llm`'s help promised "claude if
 * ANTHROPIC_API_KEY is set, else claude-cli" — omitting the GEMINI-first
 * branch `defaultProviderName` actually implemented, so a user with both keys
 * set was told the wrong model would run. This pins BOTH sides: the
 * resolver's real order, and that the help text names the checks in that
 * same order (the drift guard the comment in program.ts points at).
 *
 * The order itself changed 2026-08 (FINDINGS §132, antigravity provider):
 * subscription CLIs now beat ambient env keys — a logged-in agy/claude is an
 * explicit, already-paid choice; a key in the environment may just be lying
 * around, and picking it spends per-token money the subscription covers.
 */
describe("--llm help text vs. defaultProviderName (field report 2026-08-07, §132 order)", () => {
  const hasOnly =
    (...bins: string[]) =>
    (bin: string) =>
      bins.includes(bin);

  it("resolver ground truth: agy beats claude beats gemini key beats anthropic key", () => {
    expect(defaultProviderName({}, hasOnly("agy", "claude"))).toBe("antigravity");
    expect(defaultProviderName({}, hasOnly("claude"))).toBe("claude-cli");
    expect(defaultProviderName({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }, hasOnly())).toBe(
      "gemini",
    );
    expect(defaultProviderName({ ANTHROPIC_API_KEY: "a" }, hasOnly())).toBe("claude");
    expect(defaultProviderName({}, hasOnly())).toBe("claude-cli");
  });

  // The load-bearing half of the §132 change, pinned on its own: a machine
  // with an installed CLI AND a key must pick the CLI — the whole point of
  // the reorder is that the subscription pays instead of the key.
  it("bins beat keys: agy bin + GEMINI_API_KEY resolves to antigravity", () => {
    expect(defaultProviderName({ GEMINI_API_KEY: "g" }, hasOnly("agy"))).toBe("antigravity");
  });

  // The pure default (`() => false`) keeps every pre-§132 result: callers
  // with no filesystem in sight still get the key-order behavior.
  it("without an injected bin checker the key order is unchanged", () => {
    expect(defaultProviderName({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" })).toBe("gemini");
    expect(defaultProviderName({ ANTHROPIC_API_KEY: "a" })).toBe("claude");
    expect(defaultProviderName({})).toBe("claude-cli");
  });

  it("OSSCLIP_AGY_BIN / OSSCLIP_CLAUDE_BIN overrides are what reaches the checker", () => {
    const asked: string[] = [];
    const spy = (bin: string) => {
      asked.push(bin);
      return false;
    };
    defaultProviderName({ OSSCLIP_AGY_BIN: "/custom/agy", OSSCLIP_CLAUDE_BIN: "/custom/claude" }, spy);
    expect(asked).toEqual(["/custom/agy", "/custom/claude"]);
  });

  it("the help text states that exact order", async () => {
    const { buildProgram } = await import("../src/program");
    const produceCmd = buildProgram().commands.find((c) => c.name() === "produce");
    const llm = produceCmd?.options.find((o) => o.long === "--llm");
    expect(llm).toBeDefined();
    const d = llm!.description;
    const agy = d.indexOf("antigravity if the agy");
    const cli = d.indexOf("claude-cli if the claude CLI");
    const gemini = d.indexOf("gemini if GEMINI_API_KEY");
    const claude = d.indexOf("claude if ANTHROPIC_API_KEY");
    // Each branch present, and in the resolver's order: antigravity →
    // claude-cli → gemini → claude. An index of -1 fails the ordering
    // checks below on its own.
    expect(agy).toBeGreaterThanOrEqual(0);
    expect(cli).toBeGreaterThan(agy);
    expect(gemini).toBeGreaterThan(cli);
    expect(claude).toBeGreaterThan(gemini);
  });
});

/**
 * The auto-detection announcement, total over every provider. The bug this
 * pins: produce.ts used an inline two-way ternary, so a gemini-detected run
 * printed "ANTHROPIC_API_KEY found — using the Claude API". Each line must
 * name its own trigger so a surprised user can see which check won.
 */
describe("detectionLine names each provider's trigger", () => {
  const triggers: Record<ProviderName, RegExp> = {
    antigravity: /agy CLI found.*Antigravity/,
    "claude-cli": /Claude Code/,
    gemini: /GEMINI_API_KEY/,
    claude: /ANTHROPIC_API_KEY/,
    mock: /mock/,
  };

  for (const [name, trigger] of Object.entries(triggers) as Array<[ProviderName, RegExp]>) {
    it(`${name} → its own line`, () => {
      const line = detectionLine(name);
      expect(line).toMatch(/^▸ /);
      expect(line).toMatch(trigger);
    });
  }

  it("no two providers share a line", () => {
    const lines = (Object.keys(triggers) as ProviderName[]).map(detectionLine);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

/**
 * The §143 fallback announcement (2026-08-22): agy timed out on the editorial
 * call and another provider answered it. Pinned exactly — the line is the
 * user's only in-run notice that a different model planned the video.
 */
describe("fallbackLine names who failed, on what, and who took over", () => {
  it("renders the exact hand-off sentence", () => {
    expect(fallbackLine("antigravity", "claude-cli", "clip_beat_sheet")).toBe(
      "⚠ antigravity timed out on clip_beat_sheet — falling back to claude-cli",
    );
  });
});

/**
 * binOnPath is the `hasBin` produce injects — an existsSync PATH scan, not a
 * spawn, because it runs on every startup (llm-detect.ts). Exercised against
 * a real temp dir: the file system IS the contract here.
 */
describe("binOnPath", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-bin-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("finds a bare name in a PATH entry and misses an absent one", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "agy"), "#!/bin/sh\n");
      const env = { PATH: ["/nowhere", dir].join(delimiter) };
      expect(binOnPath("agy", env, "linux")).toBe(true);
      expect(binOnPath("claude", env, "linux")).toBe(false);
    });
  });

  it("a path-ish value is checked verbatim, never resolved through PATH", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "agy"), "");
      // The override names a file — PATH must not be consulted at all.
      expect(binOnPath(join(dir, "agy"), { PATH: "/nowhere" }, "linux")).toBe(true);
      expect(binOnPath(join(dir, "missing"), { PATH: dir }, "linux")).toBe(false);
    });
  });

  it("win32 resolves a bare name through PATHEXT", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "agy.CMD"), "");
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(binOnPath("agy", env, "win32")).toBe(true);
      // Same file, posix rules: no PATHEXT, so the bare name misses.
      expect(binOnPath("agy", env, "linux")).toBe(false);
    });
  });

  it("an empty PATH finds nothing rather than throwing", () => {
    expect(binOnPath("agy", {}, "linux")).toBe(false);
  });
});
