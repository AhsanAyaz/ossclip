import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agyConversationPaths,
  deleteAgyConversations,
  dropAgyHistoryLines,
  dropAgySummaryEntries,
  isOssclipClaudeSession,
  keepLlmSessions,
  OSSCLIP_PROMPT_MARKER,
} from "../src/producer/llm-sessions";

// Not `import "node:sqlite"`: vite-node strips the prefix and fails to resolve it.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-8888-4777-8666-555555555555";

/** One length-delimited protobuf field. Lengths here stay under 128. */
const ld = (field: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([(field << 3) | 2, payload.length]), payload]);

/** agy's `map<string, Summary>` summary file, as measured (§157). */
const summaryFile = (ids: string[]): Buffer =>
  Buffer.concat(ids.map((id) => ld(1, Buffer.concat([ld(1, Buffer.from(id)), ld(2, ld(1, Buffer.from("preview")))]))));

/** A fixture shaped like agy 1.1.x's store, as measured (§157). */
function fixtureStore(ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-store-"));
  for (const sub of ["conversations", "brain", "annotations", "presence", "implicit"]) {
    mkdirSync(join(dir, sub));
  }
  const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text, PRIMARY KEY (conversation_id));
    CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, title);
    CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) WITHOUT ROWID;`);
  const history: string[] = [];
  for (const id of ids) {
    writeFileSync(join(dir, "conversations", `${id}.db`), "x");
    mkdirSync(join(dir, "brain", id));
    writeFileSync(join(dir, "brain", id, "scratch"), "x");
    writeFileSync(join(dir, "annotations", `${id}.pbtxt`), "x");
    writeFileSync(join(dir, "presence", `${id}.lock`), "");
    writeFileSync(join(dir, "implicit", `${id}.pb`), "x");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(id, "t");
    db.prepare("INSERT INTO conversations_fts VALUES (?, ?)").run(id, "t");
    db.prepare("INSERT INTO conversation_parents VALUES (?, ?)").run(id, "p");
    history.push(JSON.stringify({ display: "hi", conversationId: id }));
  }
  db.close();
  writeFileSync(join(dir, "jetbox_summaries_proto.pb"), summaryFile(ids));
  history.push(JSON.stringify({ display: "/model", type: "slash_command" }));
  writeFileSync(join(dir, "history.jsonl"), `${history.join("\n")}\n`);
  return dir;
}

const count = (dir: string, table: string, id: string): number => {
  const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id = ?`).get(id) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
};

describe("agy conversation cleanup (§157)", () => {
  it("agyConversationPaths lists the measured layout, and nothing for a non-UUID", () => {
    expect(agyConversationPaths("/s", A)).toEqual([
      `/s/conversations/${A}.db`,
      `/s/brain/${A}`,
      `/s/annotations/${A}.pbtxt`,
      `/s/presence/${A}.lock`,
      `/s/implicit/${A}.pb`,
    ]);
    expect(agyConversationPaths("/s", "../../etc")).toEqual([]);
    expect(agyConversationPaths("/s", "c1")).toEqual([]);
  });

  it("deletes one conversation's rows, files and history lines, and nothing else", async () => {
    const dir = fixtureStore([A, B]);
    const result = await deleteAgyConversations(dir, [A]);
    expect(result).toEqual({ deleted: [A] });
    for (const t of ["conversation_summaries", "conversations_fts", "conversation_parents"]) {
      expect(count(dir, t, A)).toBe(0);
      expect(count(dir, t, B)).toBe(1);
    }
    for (const p of agyConversationPaths(dir, A)) expect(existsSync(p)).toBe(false);
    for (const p of agyConversationPaths(dir, B)) expect(existsSync(p)).toBe(true);
    expect(readFileSync(join(dir, "jetbox_summaries_proto.pb"))).toEqual(summaryFile([B]));
    const history = readFileSync(join(dir, "history.jsonl"), "utf8");
    expect(history).not.toContain(A);
    expect(history).toContain(B);
    expect(history).toContain("/model");
  });

  it("touches nothing when the store does not look like the measured layout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-odd-"));
    mkdirSync(join(dir, "conversations"));
    writeFileSync(join(dir, "conversations", `${A}.db`), "x");
    const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
    db.exec("CREATE TABLE renamed_by_an_update (conversation_id text)");
    db.close();
    const result = await deleteAgyConversations(dir, [A]);
    expect(result).toHaveProperty("skipped");
    expect(existsSync(join(dir, "conversations", `${A}.db`))).toBe(true);
  });

  it("skips without an index DB, and on ids that are not UUIDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-agy-empty-"));
    expect(await deleteAgyConversations(dir, [A])).toHaveProperty("skipped");
    expect(await deleteAgyConversations(fixtureStore([A]), ["c1"])).toEqual({
      skipped: "no conversation ids",
    });
  });

  it("dropAgySummaryEntries drops by key, and refuses bytes of any other shape", () => {
    expect(dropAgySummaryEntries(summaryFile([A, B]), new Set([A]))).toEqual(summaryFile([B]));
    expect(dropAgySummaryEntries(summaryFile([A]), new Set([B]))).toEqual(summaryFile([A]));
    // A second top-level field, a key that is not an id, a truncated entry.
    expect(dropAgySummaryEntries(Buffer.concat([summaryFile([A]), ld(2, Buffer.from("x"))]), new Set([A]))).toBeNull();
    expect(dropAgySummaryEntries(ld(1, ld(1, Buffer.from("not-an-id"))), new Set([A]))).toBeNull();
    expect(dropAgySummaryEntries(summaryFile([A]).subarray(0, 20), new Set([A]))).toBeNull();
  });

  it("an unrecognised summary file means nothing is deleted", async () => {
    const dir = fixtureStore([A]);
    writeFileSync(join(dir, "jetbox_summaries_proto.pb"), "a format from some future agy");
    expect(await deleteAgyConversations(dir, [A])).toHaveProperty("skipped");
    expect(count(dir, "conversation_summaries", A)).toBe(1);
    expect(existsSync(join(dir, "conversations", `${A}.db`))).toBe(true);
  });

  it("dropAgyHistoryLines keeps lines that are not JSON", () => {
    expect(dropAgyHistoryLines(`not json\n{"conversationId":"${A}"}\n`, new Set([A]))).toBe(
      "not json\n",
    );
  });

});

describe("isOssclipClaudeSession (§157)", () => {
  const row = (fields: Record<string, unknown>): string => JSON.stringify(fields);

  it("matches a print-mode session whose user prompt carries the marker", () => {
    const jsonl = [
      row({ type: "queue-operation", content: OSSCLIP_PROMPT_MARKER }),
      row({
        type: "user",
        entrypoint: "sdk-cli",
        message: { role: "user", content: `prompt… ${OSSCLIP_PROMPT_MARKER} — just the JSON` },
      }),
    ].join("\n");
    expect(isOssclipClaudeSession(jsonl)).toBe(true);
  });

  it("rejects an interactive chat that quotes the marker", () => {
    const jsonl = row({
      type: "user",
      entrypoint: "cli",
      message: { role: "user", content: `why does ossclip say "${OSSCLIP_PROMPT_MARKER}"?` },
    });
    expect(isOssclipClaudeSession(jsonl)).toBe(false);
  });

  it("rejects the user's own claude -p calls", () => {
    const jsonl = row({
      type: "user",
      entrypoint: "sdk-cli",
      message: { role: "user", content: "return JSON for this list" },
    });
    expect(isOssclipClaudeSession(jsonl)).toBe(false);
  });
});

describe("keepLlmSessions", () => {
  it("is an explicit yes only", () => {
    expect(keepLlmSessions({ OSSCLIP_KEEP_LLM_SESSIONS: "1" })).toBe(true);
    expect(keepLlmSessions({ OSSCLIP_KEEP_LLM_SESSIONS: "TRUE" })).toBe(true);
    expect(keepLlmSessions({ OSSCLIP_KEEP_LLM_SESSIONS: "yes please" })).toBe(false);
    expect(keepLlmSessions({})).toBe(false);
  });
});
