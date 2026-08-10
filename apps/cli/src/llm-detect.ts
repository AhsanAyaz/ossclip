import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderName } from "@ossclip/core";

/**
 * Provider auto-detection helpers (FINDINGS §132, antigravity provider):
 * `binOnPath` is the real `hasBin` the CLI injects into core's
 * `defaultProviderName`, and `detectionLine` is the one place the "which
 * provider and why" message lives — pure, total over every ProviderName, so
 * the drift test can pin all five lines. The old inline ternary in produce.ts
 * covered only two providers and printed the ANTHROPIC line for a
 * gemini-detected run.
 */

/**
 * Is this binary reachable? Sync, and a PATH scan with `existsSync` rather
 * than a `spawnSync(bin, ["--version"])` probe: this runs on produce's
 * startup path, and spawning agy + claude just to detect them costs
 * ~100ms × 2 on every run. Existence-not-runnability is the same trade
 * doctor's `binRuns` makes in the other direction — doctor is diagnostics
 * and can afford the spawn; startup can't.
 */
export function binOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // A path-ish override (OSSCLIP_AGY_BIN=/opt/agy) names a file, not a PATH
  // entry — check it verbatim. `\` counts on win32 only; it is a legal
  // filename character on posix.
  if (bin.includes("/") || (platform === "win32" && bin.includes("\\"))) {
    return existsSync(bin);
  }
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // On Windows a bare `agy` resolves through PATHEXT (agy.cmd, agy.exe…);
  // the extensionless name is still tried first for shims that have none.
  const suffixes =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  return pathEntries.some((dir) => suffixes.some((ext) => existsSync(join(dir, bin + ext))));
}

/**
 * The "▸ which provider and why" line for an auto-detected run. Each line
 * names its own trigger so a surprised user can see exactly which check won
 * — the point of the §132 order change is visible, not silent.
 */
export function detectionLine(name: ProviderName): string {
  switch (name) {
    case "antigravity":
      return "▸ agy CLI found — using Google Antigravity (subscription auth)";
    case "claude-cli":
      return "▸ using the Claude Code CLI (subscription auth)";
    case "gemini":
      return "▸ GEMINI_API_KEY found — using the Gemini API";
    case "claude":
      return "▸ ANTHROPIC_API_KEY found — using the Claude API";
    case "mock":
      return "▸ using the mock provider (no LLM)";
  }
}
