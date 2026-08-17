import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApprovedYoutubePack } from "../src/produce";

/**
 * The Y2 approval-file honor (editor SEO panel, 2026-08-17), tested at the
 * helper that carries the decision — the thumbnail-step suite's temp-dir
 * shape, without an LLM or a server. The orchestration consequence (approved
 * pack → no cache lookup, no provider needed) follows from the Y2 block
 * checking this FIRST and only entering the generate path on undefined.
 */

const pack = {
  titles: ["How agents actually work", "5 agent mistakes", "Agents in 8 minutes"],
  description: "The one agent pattern nobody explains.\n\n#agents",
  hashtags: ["#agents", "#llm"],
  tags: ["ai agents", "llm tutorial"],
};

describe("readApprovedYoutubePack", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-yt-approved-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a valid approved pack is returned VERBATIM, with no warning", async () => {
    writeFileSync(join(dir, "youtube-pack-approved.json"), JSON.stringify(pack));
    const lines: string[] = [];
    expect(await readApprovedYoutubePack(dir, (l) => lines.push(l))).toEqual(pack);
    expect(lines).toEqual([]);
  });

  it("no file means undefined, silently — the generate path is not a degradation", async () => {
    const lines: string[] = [];
    expect(await readApprovedYoutubePack(dir, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("invalid JSON warns (naming the file) and falls through — read-side leniency", async () => {
    writeFileSync(join(dir, "youtube-pack-approved.json"), "{not json");
    const lines: string[] = [];
    expect(await readApprovedYoutubePack(dir, (l) => lines.push(l))).toBeUndefined();
    expect(lines.join("\n")).toContain("youtube-pack-approved.json");
    expect(lines.join("\n")).toContain("regenerating");
  });

  it("valid JSON that is not a pack warns and falls through the same way", async () => {
    writeFileSync(
      join(dir, "youtube-pack-approved.json"),
      JSON.stringify({ ...pack, titles: ["only one"] }),
    );
    const lines: string[] = [];
    expect(await readApprovedYoutubePack(dir, (l) => lines.push(l))).toBeUndefined();
    expect(lines.join("\n")).toContain("not a valid pack");
  });
});
