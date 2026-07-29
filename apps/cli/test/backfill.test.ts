import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backfill, backfillWorkdir } from "../src/backfill";

const workdir = (
  root: string,
  name: string,
  files: Record<string, unknown>,
): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(dir, file), JSON.stringify(body, null, 2));
  }
  return dir;
};

const root = (): string => mkdtempSync(join(tmpdir(), "ossclip-backfill-"));

/** The state the two real Agents workdirs were in. */
const EMPTIED = {
  "command.json": { args: ["produce", "in.mp4", "--produce", "--llm", "gemini"] },
  "usage.json": { records: [], totals: { calls: 0 } },
  "production.json": { version: 1, scenes: [] },
};

describe("ossclip backfill (R16 §79)", () => {
  it("recovers the provider into usage.json and production.json", async () => {
    const dir = workdir(root(), "Agents-a2a1997e", EMPTIED);
    const res = await backfillWorkdir(dir);
    expect(res).toMatchObject({ status: "backfilled", provider: "gemini" });

    const log = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
    expect(log.runs[0].provider).toBe("gemini");
    expect(log.runs[0].backfilled).toBe(true);
    const production = JSON.parse(readFileSync(join(dir, "production.json"), "utf8"));
    expect(production.producer).toMatchObject({ provider: "gemini", cached: true });
    // Originals are recoverable.
    expect(existsSync(join(dir, "usage.json.pre-backfill"))).toBe(true);
    expect(existsSync(join(dir, "production.json.pre-backfill"))).toBe(true);
  });

  it("--dry-run writes nothing", async () => {
    const dir = workdir(root(), "Agents-a2a1997e", EMPTIED);
    const before = readFileSync(join(dir, "usage.json"), "utf8");
    const res = await backfillWorkdir(dir, { dryRun: true });
    expect(res.status).toBe("backfilled"); // what WOULD happen
    expect(readFileSync(join(dir, "usage.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "usage.json.pre-backfill"))).toBe(false);
  });

  it("never overwrites a real record", async () => {
    const r = root();
    const withHistory = workdir(r, "has-history", {
      ...EMPTIED,
      "usage.json": { runs: [{ provider: "claude-cli", records: [], models: [], cached: false }] },
    });
    const stamped = workdir(r, "has-stamp", {
      ...EMPTIED,
      "production.json": { version: 1, producer: { provider: "claude-cli", models: [] } },
    });

    expect((await backfillWorkdir(withHistory)).status).toBe("skipped");
    await backfillWorkdir(stamped);
    const production = JSON.parse(readFileSync(join(stamped, "production.json"), "utf8"));
    expect(production.producer.provider).toBe("claude-cli"); // not clobbered by the argv
  });

  it("skips what it cannot know, and says why", async () => {
    const r = root();
    const noCommand = workdir(r, "old", { "usage.json": { records: [] } });
    const noFlag = workdir(r, "no-flag", {
      ...EMPTIED,
      "command.json": { args: ["produce", "in.mp4"] },
    });
    expect(await backfillWorkdir(noCommand)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("command.json"),
    });
    expect(await backfillWorkdir(noFlag)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("--llm"),
    });
  });

  it("takes a ROOT of workdirs, the way `.ossclip/` actually looks", async () => {
    const r = root();
    workdir(r, "one-a1b2c3d4", EMPTIED);
    workdir(r, "two-e5f6a7b8", EMPTIED);
    const results = await backfill([r], { backup: false });
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.status === "backfilled")).toBe(true);
    expect(existsSync(join(r, "one-a1b2c3d4", "usage.json.pre-backfill"))).toBe(false);
  });

  it("a path that does not exist is reported, not thrown", async () => {
    const results = await backfill([join(tmpdir(), "ossclip-nope-9d8c7b")]);
    expect(results[0]).toMatchObject({ status: "skipped", reason: "not found" });
  });
});
