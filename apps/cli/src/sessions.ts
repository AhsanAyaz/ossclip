import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOssclipClaudeSession } from "@ossclip/core";

/**
 * `ossclip sessions`: find and remove the sessions older ossclip versions
 * left in the user's own Claude Code history (FINDINGS §157). New calls no
 * longer leave any; this clears the backlog.
 *
 * Claude only. agy keeps no record that identifies an older ossclip call:
 * print-mode prompts never reach `history.jsonl`, and the conversation files
 * do not carry the prompt as plain text (measured 2026-11-16). Guessing from
 * a title or a preview would risk a person's own conversation, so the agy
 * backlog is left alone; new agy calls are deleted by exact id as they run.
 *
 * Detection is deliberately narrow — ossclip's exact prompt marker, plus
 * print mode for Claude — because a false positive deletes a person's real
 * chat, and a false negative only leaves clutter.
 */

export interface ClaudeSessionHit {
  /** The session transcript. */
  file: string;
  /** Its sibling `<sessionId>/` dir (subagents, tool results), when present. */
  dir?: string;
  bytes: number;
}

export interface SessionsScan {
  claude: ClaudeSessionHit[];
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
}

async function sizeOf(path: string): Promise<number> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return s.size;
    let total = 0;
    for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
    return total;
  } catch {
    return 0;
  }
}

export async function scanClaudeSessions(projectsDir: string): Promise<ClaudeSessionHit[]> {
  if (!existsSync(projectsDir)) return [];
  const hits: ClaudeSessionHit[] = [];
  for (const project of await readdir(projectsDir)) {
    const projectDir = join(projectsDir, project);
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      continue; // not a directory
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(projectDir, name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (!isOssclipClaudeSession(text)) continue;
      const dir = join(projectDir, name.slice(0, -".jsonl".length));
      const hasDir = existsSync(dir);
      hits.push({
        file,
        dir: hasDir ? dir : undefined,
        bytes: Buffer.byteLength(text) + (hasDir ? await sizeOf(dir) : 0),
      });
    }
  }
  return hits;
}

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** The report printed before anything is deleted. Pure. */
export function formatSessionsScan(scan: SessionsScan): string {
  const sum = (xs: { bytes: number }[]): number => xs.reduce((n, x) => n + x.bytes, 0);
  if (scan.claude.length === 0) return "▸ no saved Claude Code sessions from ossclip found";
  return `▸ Claude Code: ${scan.claude.length} session(s) from ossclip, ${mb(sum(scan.claude))}`;
}

export async function deleteClaudeSessions(hits: readonly ClaudeSessionHit[]): Promise<number> {
  let n = 0;
  for (const hit of hits) {
    try {
      await rm(hit.file, { force: true });
      if (hit.dir) await rm(hit.dir, { recursive: true, force: true });
      n++;
    } catch {
      // Leave it; the count says what happened.
    }
  }
  return n;
}

export async function runSessions(
  flags: { delete?: boolean; yes?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const projectsDir = claudeProjectsDir(env);
  const scan: SessionsScan = { claude: await scanClaudeSessions(projectsDir) };
  console.log(formatSessionsScan(scan));
  if (scan.claude.length === 0) return;
  if (flags.delete !== true) {
    console.log("▸ run `ossclip sessions --delete` to remove them. Your own chats are not touched.");
    return;
  }
  if (flags.yes !== true) {
    const { isInteractive } = await import("./interactive/tty");
    if (!isInteractive()) {
      throw new Error("not a TTY — pass --yes to delete without the confirmation prompt");
    }
    const { confirm, unwrap } = await import("./interactive/prompts");
    const go = unwrap(await confirm({ message: "Delete these sessions?" }));
    if (go !== true) {
      console.log("▸ cancelled — nothing deleted");
      return;
    }
  }
  const claudeDeleted = await deleteClaudeSessions(scan.claude);
  console.log(`▸ Claude Code: deleted ${claudeDeleted} of ${scan.claude.length}`);
}
