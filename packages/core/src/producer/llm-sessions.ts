import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

/**
 * The subscription CLIs (`claude -p`, `agy -p`) save every call as a full
 * session in the USER's own history — their `claude --resume` list, their agy
 * conversation list — and ossclip never reads one back: each call is a
 * one-shot JSON request. One produce run is a dozen of them, so a week of use
 * buried the user's real chats (2026-11-14: 106 agy conversations, ~378MB,
 * and 13 Claude sessions on one machine). FINDINGS §157.
 */

/**
 * A phrase every ossclip planner prompt carries and a person's own chat
 * almost never does. Both providers build their prompt from this constant, so
 * the Claude backlog detector (`ossclip sessions`) cannot drift from what the
 * providers actually send.
 */
export const OSSCLIP_PROMPT_MARKER = "No markdown fences, no commentary, no tool use";

/**
 * `OSSCLIP_KEEP_LLM_SESSIONS=1` keeps the sessions, for debugging a planner
 * call in the CLI's own UI. Parsed, not coerced: anything other than an
 * explicit yes keeps the default (clean up), because a typo must not silently
 * re-enable the clutter this exists to stop.
 */
export function keepLlmSessions(env: NodeJS.ProcessEnv): boolean {
  return z.enum(["1", "true"]).safeParse(env.OSSCLIP_KEEP_LLM_SESSIONS?.trim().toLowerCase())
    .success;
}

/** agy's per-user store. Measured on agy 1.1.x, 2026-11-14 (§157). */
export function agyStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".gemini", "antigravity-cli");
}

/**
 * agy's conversation ids are UUIDs. Anything else is refused before it
 * becomes a path: the id comes out of a CLI's stdout, and `../` in it must
 * never reach `rm -r`.
 */
const AGY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAgyConversationId(id: string): boolean {
  return AGY_ID.test(id);
}

/**
 * Every file and directory agy keeps for one conversation, as measured
 * (§157). Pure, and empty for anything that is not a UUID.
 */
export function agyConversationPaths(storeDir: string, id: string): string[] {
  if (!isAgyConversationId(id)) return [];
  return [
    join(storeDir, "conversations", `${id}.db`),
    join(storeDir, "brain", id),
    join(storeDir, "annotations", `${id}.pbtxt`),
    join(storeDir, "presence", `${id}.lock`),
    join(storeDir, "implicit", `${id}.pb`),
  ];
}

/** The index tables that name a conversation, all keyed by `conversation_id`. */
const AGY_INDEX_TABLES = ["conversation_summaries", "conversations_fts", "conversation_parents"];

/**
 * `history.jsonl` without the lines that belong to `ids`. Pure. A line that
 * is not JSON is kept: it is not ours to judge.
 */
export function dropAgyHistoryLines(text: string, ids: ReadonlySet<string>): string {
  return text
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return true;
      try {
        const row = JSON.parse(line) as { conversationId?: unknown };
        return !(typeof row.conversationId === "string" && ids.has(row.conversationId));
      } catch {
        return true;
      }
    })
    .join("\n");
}

function readVarint(buf: Uint8Array, at: number): [value: number, next: number] | null {
  let value = 0;
  let shift = 0;
  for (let i = at; i < buf.length && shift < 35; i++) {
    const byte = buf[i]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, i + 1];
    shift += 7;
  }
  return null;
}

/**
 * `jetbox_summaries_proto.pb` without the entries for `ids`, or null when the
 * bytes are not the shape measured in §157. Pure.
 *
 * The file is agy's second copy of the conversation list, and the one that
 * matters: on start agy re-inserts every summary it holds here into
 * `conversation_summaries.db`, so deleting only the DB rows put them back on
 * the next `agy` run, pointing at deleted files (measured 2026-11-16). Its
 * wire shape is a protobuf `map<string, Summary>` at field 1: the top level
 * is nothing but field-1 length-delimited entries, and each entry starts with
 * its key, field 1, the conversation id. Anything else, including a key that
 * does not parse, returns null, and the caller deletes nothing.
 */
export function dropAgySummaryEntries(
  buf: Uint8Array,
  ids: ReadonlySet<string>,
): Uint8Array | null {
  const keep: Uint8Array[] = [];
  let at = 0;
  while (at < buf.length) {
    const tag = readVarint(buf, at);
    if (!tag || tag[0] !== ((1 << 3) | 2)) return null;
    const len = readVarint(buf, tag[1]);
    if (!len) return null;
    const start = len[1];
    const end = start + len[0];
    if (end > buf.length) return null;
    const entry = buf.subarray(start, end);
    const keyTag = readVarint(entry, 0);
    if (!keyTag || keyTag[0] !== ((1 << 3) | 2)) return null;
    const keyLen = readVarint(entry, keyTag[1]);
    if (!keyLen || keyLen[1] + keyLen[0] > entry.length) return null;
    const key = Buffer.from(entry.subarray(keyLen[1], keyLen[1] + keyLen[0])).toString("utf8");
    if (!isAgyConversationId(key)) return null;
    if (!ids.has(key)) keep.push(buf.subarray(at, end));
    at = end;
  }
  return Buffer.concat(keep);
}

export type AgyDeleteResult = { deleted: string[] } | { skipped: string };

/**
 * Delete conversations agy saved for ossclip's own calls. Best effort: it
 * never throws, and it touches nothing unless the store looks exactly like
 * the layout measured in §157.
 *
 * This is agy's private, undocumented storage — agy has no delete command
 * and no flag to skip saving (unlike claude's `--no-session-persistence`).
 * So the delete is ALL-OR-NOTHING around the index. The summary file is
 * parsed first, the rows go next in one transaction, then the summary file is
 * rewritten, and the files go only after both. If the index cannot be
 * edited — `node:sqlite` missing (Node < 22.13), the DB locked by a running
 * agy, a table renamed by an update — nothing is removed, because an index
 * row pointing at a deleted file is a broken entry in the user's own list,
 * which is worse than the clutter.
 */
export async function deleteAgyConversations(
  storeDir: string,
  ids: readonly string[],
): Promise<AgyDeleteResult> {
  try {
    const valid = [...new Set(ids)].filter(isAgyConversationId);
    if (valid.length === 0) return { skipped: "no conversation ids" };
    const dbPath = join(storeDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return { skipped: "unknown agy store layout (no index DB)" };

    // Parsed BEFORE anything is touched: an unrecognised summary file means
    // the DB rows would come back on the next agy start, so it is a skip.
    const summariesPath = join(storeDir, "jetbox_summaries_proto.pb");
    let summaries: { before: Uint8Array; after: Uint8Array } | undefined;
    if (existsSync(summariesPath)) {
      const before = await readFile(summariesPath);
      const after = dropAgySummaryEntries(before, new Set(valid));
      if (!after) return { skipped: "unknown agy store layout (summary file)" };
      summaries = { before, after };
    }

    // getBuiltinModule, not `import()`: a bundler or vite-node rewrites
    // "node:sqlite" to a bare "sqlite" it cannot resolve, and on Node 22.0-22.12
    // the module is missing or flag-gated — either way, a skip.
    let sqlite: typeof import("node:sqlite") | undefined;
    try {
      sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    } catch {
      sqlite = undefined;
    }
    if (!sqlite?.DatabaseSync) {
      return { skipped: "node:sqlite is unavailable (needs Node 22.13+)" };
    }
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      if (!tables.has("conversation_summaries")) {
        return { skipped: "unknown agy store layout (no conversation_summaries table)" };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of AGY_INDEX_TABLES) {
          if (!tables.has(table)) continue;
          const del = db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`);
          for (const id of valid) del.run(id);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db.close();
    }

    if (summaries && summaries.after.length !== summaries.before.length) {
      const tmp = `${summariesPath}.ossclip-${process.pid}.tmp`;
      await writeFile(tmp, summaries.after, { mode: 0o600 });
      await rename(tmp, summariesPath);
    }

    for (const id of valid) {
      for (const p of agyConversationPaths(storeDir, id)) {
        await rm(p, { recursive: true, force: true });
      }
    }

    const historyPath = join(storeDir, "history.jsonl");
    if (existsSync(historyPath)) {
      const before = await readFile(historyPath, "utf8");
      const after = dropAgyHistoryLines(before, new Set(valid));
      if (after !== before) {
        // Temp file + rename, so a crash mid-write never truncates the
        // user's prompt history.
        const tmp = `${historyPath}.ossclip-${process.pid}.tmp`;
        await writeFile(tmp, after, { mode: 0o600 });
        await rename(tmp, historyPath);
      }
    }
    return { deleted: valid };
  } catch (err) {
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether a Claude Code session file is one of ossclip's calls. Pure. Both
 * conditions are required: `sdk-cli` alone is every `claude -p` the user ever
 * ran, and the marker alone could be a person pasting an ossclip prompt into
 * a real chat.
 */
export function isOssclipClaudeSession(jsonl: string): boolean {
  if (!jsonl.includes('"entrypoint":"sdk-cli"')) return false;
  for (const line of jsonl.split("\n")) {
    if (!line.includes(OSSCLIP_PROMPT_MARKER)) continue;
    try {
      const row = JSON.parse(line) as {
        type?: unknown;
        entrypoint?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      if (row.type !== "user" || row.entrypoint !== "sdk-cli") continue;
      const content = row.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
                .join("")
            : "";
      if (text.includes(OSSCLIP_PROMPT_MARKER)) return true;
    } catch {
      // Not a transcript row.
    }
  }
  return false;
}
