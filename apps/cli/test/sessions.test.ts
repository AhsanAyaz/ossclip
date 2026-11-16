import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OSSCLIP_PROMPT_MARKER } from "@ossclip/core";
import { describe, expect, it } from "vitest";
import {
  claudeProjectsDir,
  deleteClaudeSessions,
  formatSessionsScan,
  scanClaudeSessions,
} from "../src/sessions";

const userRow = (entrypoint: string, content: string): string =>
  JSON.stringify({ type: "user", entrypoint, message: { role: "user", content } });

/** A Claude projects dir with one ossclip session and two of the user's own. */
function claudeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ossclip-claude-projects-"));
  const project = join(root, "-home-me-code-thing");
  mkdirSync(project);
  writeFileSync(join(project, "ours.jsonl"), userRow("sdk-cli", `plan… ${OSSCLIP_PROMPT_MARKER} — just`));
  mkdirSync(join(project, "ours"));
  writeFileSync(join(project, "ours", "tool-result.txt"), "x");
  writeFileSync(join(project, "their-chat.jsonl"), userRow("cli", `what is "${OSSCLIP_PROMPT_MARKER}"?`));
  writeFileSync(join(project, "their-print.jsonl"), userRow("sdk-cli", "summarise this file"));
  writeFileSync(join(root, "stray-file"), "not a project dir");
  return root;
}

describe("ossclip sessions (§157)", () => {
  it("finds only ossclip's print-mode sessions, and deletes the file with its dir", async () => {
    const root = claudeFixture();
    const hits = await scanClaudeSessions(root);
    expect(hits.map((h) => h.file.split("/").pop())).toEqual(["ours.jsonl"]);
    expect(hits[0]!.dir).toBe(join(root, "-home-me-code-thing", "ours"));
    expect(await deleteClaudeSessions(hits)).toBe(1);
    const project = join(root, "-home-me-code-thing");
    expect(existsSync(join(project, "ours.jsonl"))).toBe(false);
    expect(existsSync(join(project, "ours"))).toBe(false);
    expect(existsSync(join(project, "their-chat.jsonl"))).toBe(true);
    expect(existsSync(join(project, "their-print.jsonl"))).toBe(true);
  });

  it("missing stores scan as empty", async () => {
    expect(await scanClaudeSessions("/nonexistent/ossclip")).toEqual([]);
    expect(formatSessionsScan({ claude: [] })).toMatch(/no saved Claude Code sessions/);
  });

  it("claudeProjectsDir honours CLAUDE_CONFIG_DIR", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/projects");
    expect(claudeProjectsDir({ HOME: "/h" })).toBe("/h/.claude/projects");
  });
});
