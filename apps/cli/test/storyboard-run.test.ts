import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, StoryboardSchema, planStoryboard, type LlmUsage, type PlannedShot } from "@ossclip/core";
import {
  STORYBOARD_FILE,
  StoryboardFileError,
  assertAssetsDir,
  loadStoryboard,
  readStoryboardPlanCache,
  saveStoryboard,
  storyboardPlanCacheKey,
  storyboardPlanCacheKeyCandidates,
  writeStoryboardPlanCache,
} from "../src/storyboard/storyboard-store";
import {
  AssetsFlagSchema,
  formatStoryboardReport,
  runStoryboardPlan,
  storyboardFlag,
  storyboardLine,
  type StoryboardRunArgs,
} from "../src/storyboard/storyboard-run";

/**
 * The planning step of a `--storyboard` run (plan Task 3; §168) on a temp
 * workdir, with the mock provider and an injected image probe: no ffprobe,
 * no LLM, no produce.
 */
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-storyboard-run-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// 160 words, one every 0.4 s, none cut: 64 s of output on an identity clock.
const WORDS = Array.from({ length: 160 }, (_, i) => ({ text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
const TIMES = WORDS.map((w) => ({ start: w.start, end: w.end }));

// The real attribution rule, restated so this file need not load produce.ts:
// the last record for the schema wins.
const answeredBy = (usage: readonly LlmUsage[], schemaName: string, fallback: string) =>
  [...usage].reverse().find((u) => u.schemaName === schemaName)?.provider ?? fallback;

function args(over: Partial<StoryboardRunArgs> = {}): StoryboardRunArgs {
  return {
    workdir: work,
    words: WORDS,
    cut: new Set(),
    wordTimes: TIMES,
    outputDurationSec: 64,
    frame: { width: 1080, height: 1920 },
    provider: new MockProvider(),
    providerName: "mock",
    ...over,
  };
}

const calls = (p: MockProvider) => p.usage.filter((u) => u.schemaName === "storyboard_plan").length;

describe("runStoryboardPlan", () => {
  it("plans once and writes the table: ids s1…, every shot kept, the planner's, untouched", async () => {
    const provider = new MockProvider();
    const r = await runStoryboardPlan(args({ provider, intent: "teach the idea" }), { answeredBy });

    expect(calls(provider)).toBe(1);
    expect(r.planned).toBe(true);
    // The mock plans one shot per 40 kept words, 12 words long: four, all inside the limits.
    expect(r.changes).toEqual([]);
    const onDisk = StoryboardSchema.parse(JSON.parse(readFileSync(join(work, STORYBOARD_FILE), "utf8")));
    expect(onDisk).toEqual(r.storyboard);
    expect(onDisk.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(onDisk.nextShot).toBe(5);
    expect(onDisk.intent).toBe("teach the idea");
    expect(onDisk.assetsDir).toBeUndefined();
    for (const s of onDisk.shots) {
      expect(s).toMatchObject({ kept: true, origin: "planner", touched: false });
    }
    expect(onDisk.shots.map((s) => [s.startWord, s.endWord])).toEqual([[0, 11], [40, 51], [80, 91], [120, 131]]);
    // The raw reply is cached under the provider that answered.
    expect(readdirSync(work).filter((f) => f.startsWith("storyboardplan-"))).toHaveLength(1);
  });

  it("returns the limits' changes and caches the reply as it was, before them", async () => {
    const reply: PlannedShot[] = [
      { startWord: 30, endWord: 10, idea: "reversed", why: "w", priority: 1, assets: [] },
      { startWord: 20, endWord: 40, idea: "overlaps the first", why: "w", priority: 2, assets: ["ghost.png"] },
    ];
    const plan = vi.fn(async () => reply);
    const r = await runStoryboardPlan(args(), { plan, answeredBy });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(r.storyboard.shots.map((s) => [s.id, s.startWord, s.endWord, s.assets])).toEqual([
      ["s1", 10, 30, []],
      ["s2", 31, 40, []],
    ]);
    expect(r.changes.map((c) => [c.index, c.kind])).toEqual([
      [0, "moved"],
      [1, "asset-removed"],
      [1, "moved"],
    ]);
    const [file] = readdirSync(work).filter((f) => f.startsWith("storyboardplan-"));
    expect(JSON.parse(readFileSync(join(work, file!), "utf8"))).toEqual({ shots: reply });
  });

  it("loads a stored table untouched and makes no call (Review Focus 2)", async () => {
    await runStoryboardPlan(args(), { answeredBy });
    // The author rewords a shot, as the editor would.
    const path = join(work, STORYBOARD_FILE);
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.shots[1].idea = "the author's own words";
    edited.shots[1].touched = true;
    writeFileSync(path, JSON.stringify(edited));
    const bytes = readFileSync(path);

    const provider = new MockProvider();
    const plan = vi.fn(planStoryboard);
    const r = await runStoryboardPlan(args({ provider, intent: "another intent" }), { plan, answeredBy });

    expect(plan).not.toHaveBeenCalled();
    expect(provider.usage).toHaveLength(0);
    expect(r.planned).toBe(false);
    expect(r.changes).toEqual([]);
    expect(r.storyboard.shots[1]!.idea).toBe("the author's own words");
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("stops on a table that fails its schema, naming the file and the problem, and leaves it as it is (Review Focus 4)", async () => {
    const path = join(work, STORYBOARD_FILE);
    const broken = { version: 1, nextShot: 2, shots: [{ id: "s1", startWord: 9, endWord: 3, idea: "x", why: "", priority: 1, assets: [], kept: true, origin: "planner", touched: false }] };
    writeFileSync(path, JSON.stringify(broken));
    const bytes = readFileSync(path);
    const plan = vi.fn(planStoryboard);

    const err = await runStoryboardPlan(args(), { plan, answeredBy }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardFileError);
    expect((err as Error).message).toBe(`${path}: shots.0.endWord: endWord is before startWord`);
    expect(plan).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(work)).toEqual([STORYBOARD_FILE]);
  });

  it("stops on a table that is not JSON, naming the file", async () => {
    const path = join(work, STORYBOARD_FILE);
    writeFileSync(path, "{ not json");
    expect(() => loadStoryboard(work)).toThrow(StoryboardFileError);
    expect(() => loadStoryboard(work)).toThrow(`${path}: not valid JSON`);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("with no table and a plan cache hit, makes no call and writes the table from the cache", async () => {
    const first = await runStoryboardPlan(args(), { answeredBy });
    rmSync(join(work, STORYBOARD_FILE));

    const provider = new MockProvider();
    const r = await runStoryboardPlan(args({ provider }), { answeredBy });
    expect(provider.usage).toHaveLength(0);
    expect(r.planned).toBe(true);
    expect(r.storyboard).toEqual(first.storyboard);
    expect(loadStoryboard(work)).toEqual(first.storyboard);
  });

  it("finds a plan the fallback provider wrote (§150), and a malformed cache means a fresh plan", async () => {
    // antigravity timed out and claude-cli answered: the write is keyed on claude-cli.
    await runStoryboardPlan(args({ providerName: "antigravity", fallbackName: "claude-cli" }), {
      answeredBy: () => "claude-cli",
    });
    const [file] = readdirSync(work).filter((f) => f.startsWith("storyboardplan-"));
    expect(file).toBe(`storyboardplan-${storyboardPlanCacheKey({
      promptVersion: "b1",
      keptWords: JSON.stringify(WORDS.map((w, i) => [i, w.text])),
      assets: "[]",
      frame: "1080x1920",
      providerName: "claude-cli",
    })}.json`);
    rmSync(join(work, STORYBOARD_FILE));
    const again = new MockProvider();
    await runStoryboardPlan(args({ provider: again, providerName: "antigravity", fallbackName: "claude-cli" }), { answeredBy });
    expect(again.usage).toHaveLength(0);

    // Every cache file corrupted: the next run plans again rather than crashing.
    rmSync(join(work, STORYBOARD_FILE));
    for (const f of readdirSync(work).filter((n) => n.startsWith("storyboardplan-"))) writeFileSync(join(work, f), "{\"shots\": 3}");
    const fresh = new MockProvider();
    await runStoryboardPlan(args({ provider: fresh, providerName: "antigravity", fallbackName: "claude-cli" }), { answeredBy });
    expect(calls(fresh)).toBe(1);
  });

  it("lists --assets at plan time without staging them: the absolute path is stored and the names reach the planner", async () => {
    const assets = join(work, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "logo.png"), "png");
    writeFileSync(join(assets, "assets.md"), "logo.png: the channel's logo\n");
    const plan = vi.fn(async (): Promise<PlannedShot[]> => [
      { startWord: 0, endWord: 11, idea: "the logo spins in", why: "w", priority: 1, assets: ["logo.png"] },
    ]);
    const before = readdirSync(work).sort();

    const r = await runStoryboardPlan(args({ assetsDir: assets }), {
      plan,
      probeImageSize: async () => ({ width: 512, height: 256 }),
      answeredBy,
    });

    expect(plan.mock.calls[0]![1]).toMatchObject({ assets: [{ name: "logo.png", width: 512, height: 256, note: "the channel's logo" }] });
    expect(r.storyboard.assetsDir).toBe(assets);
    expect(r.storyboard.shots[0]!.assets).toEqual(["logo.png"]);
    // Nothing staged: only the table and the plan cache are new.
    const added = readdirSync(work).filter((f) => !before.includes(f)).sort();
    expect(added).toHaveLength(2);
    expect(added[0]).toMatch(/^storyboard\.json$|^storyboardplan-/);
    expect(existsSync(join(work, "storyboard-assets"))).toBe(false);
  });

  it("a changed asset list is a different plan cache key (§78)", async () => {
    const assets = join(work, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "logo.png"), "png");
    const probe = async () => ({ width: 512, height: 256 });
    await runStoryboardPlan(args({ assetsDir: assets }), { probeImageSize: probe, answeredBy });
    rmSync(join(work, STORYBOARD_FILE));
    writeFileSync(join(assets, "assets.md"), "logo.png: now with a note\n");
    const provider = new MockProvider();
    await runStoryboardPlan(args({ provider, assetsDir: assets }), { probeImageSize: probe, answeredBy });
    expect(calls(provider)).toBe(1);
  });
});

describe("storyboard-store", () => {
  it("loadStoryboard is null without a file; saveStoryboard leaves no temp file and refuses a table it could not read back", () => {
    expect(loadStoryboard(work)).toBeNull();
    saveStoryboard(work, { version: 1, nextShot: 1, shots: [] });
    expect(readdirSync(work)).toEqual([STORYBOARD_FILE]);
    expect(() => saveStoryboard(work, { version: 1, nextShot: 0, shots: [] })).toThrow();
    expect(loadStoryboard(work)).toEqual({ version: 1, nextShot: 1, shots: [] });
  });

  it("a duplicate shot id is a StoryboardFileError naming the id", () => {
    const s = { id: "s1", startWord: 0, endWord: 1, idea: "x", why: "", priority: 1, assets: [], kept: true, origin: "planner", touched: false };
    writeFileSync(join(work, STORYBOARD_FILE), JSON.stringify({ version: 1, nextShot: 3, shots: [s, { ...s, startWord: 5, endWord: 6 }] }));
    expect(() => loadStoryboard(work)).toThrow(/shots\.1\.id: shot id "s1" is used by more than one shot/);
  });

  it("the cache key moves with each part, and the fallback is the second candidate", () => {
    const parts = { promptVersion: "b1", keptWords: "[[0,\"a\"]]", assets: "[]", frame: "1080x1920", providerName: "mock" };
    const base = storyboardPlanCacheKey(parts);
    expect(base).toMatch(/^[0-9a-f]{8}$/);
    for (const over of [
      { promptVersion: "b2" },
      { keptWords: "[[1,\"a\"]]" },
      { intent: "x" },
      { assets: "[[\"logo.png\",1,1,null]]" },
      { frame: "1920x1080" },
      { providerName: "gemini" },
      { llmModel: "m" },
    ]) {
      expect(storyboardPlanCacheKey({ ...parts, ...over })).not.toBe(base);
    }
    const { providerName: _p, ...rest } = parts;
    expect(storyboardPlanCacheKeyCandidates(rest, "antigravity", "claude-cli")).toEqual([
      storyboardPlanCacheKey({ ...rest, providerName: "antigravity" }),
      storyboardPlanCacheKey({ ...rest, providerName: "claude-cli" }),
    ]);
    expect(storyboardPlanCacheKeyCandidates(rest, "mock", undefined)).toHaveLength(1);
  });

  it("the plan cache round-trips and reads a malformed file as a miss", () => {
    const shots: PlannedShot[] = [{ startWord: 1, endWord: 2, idea: "i", why: "w", priority: 3, assets: [] }];
    writeStoryboardPlanCache(work, "abcd1234", shots);
    expect(readStoryboardPlanCache(work, "abcd1234")).toEqual(shots);
    expect(readStoryboardPlanCache(work, "ffff0000")).toBeNull();
    writeFileSync(join(work, "storyboardplan-bad00000.json"), "not json");
    expect(readStoryboardPlanCache(work, "bad00000")).toBeNull();
    writeFileSync(join(work, "storyboardplan-bad00001.json"), JSON.stringify({ shots: [{ ...shots[0], priority: 7 }] }));
    expect(readStoryboardPlanCache(work, "bad00001")).toBeNull();
  });

  it("assertAssetsDir refuses a missing path and a file", () => {
    expect(() => assertAssetsDir(join(work, "nope"))).toThrow(`--assets ${join(work, "nope")} is not a folder`);
    writeFileSync(join(work, "f.png"), "x");
    expect(() => assertAssetsDir(join(work, "f.png"))).toThrow(/is not a folder/);
    expect(() => assertAssetsDir(work)).not.toThrow();
  });
});

describe("storyboard console line and report block", () => {
  const sb = {
    version: 1 as const,
    nextShot: 4,
    shots: [
      { id: "s1", startWord: 0, endWord: 11, idea: "a bear carries pancakes", why: "", priority: 1 as const, assets: [], kept: true, origin: "planner" as const, touched: false },
      { id: "s2", startWord: 20, endWord: 30, idea: "dropped one", why: "", priority: 2 as const, assets: [], kept: false, origin: "planner" as const, touched: true },
      { id: "s3", startWord: 40, endWord: 50, idea: "three boxes", why: "", priority: 3 as const, assets: [], kept: true, origin: "author" as const, touched: true },
    ],
  };
  const timeOf = (i: number) => (i === 50 ? null : TIMES[i] ?? null);

  it("says planned with the shots changed, counted once per shot, or loaded", () => {
    const changes = [
      { index: 4, kind: "moved" as const, reason: "a" },
      { index: 4, kind: "trimmed" as const, reason: "b" },
      { index: 6, kind: "dropped" as const, reason: "c" },
    ];
    expect(storyboardLine({ storyboard: sb, planned: true, changes })).toBe("▸ storyboard: 3 shots planned (2 changed by limits)");
    expect(storyboardLine({ storyboard: sb, planned: false, changes: [] })).toBe("▸ storyboard: loaded 3 shots (not planned again)");
  });

  it("lists each kept shot with its output times and each limit change", () => {
    const text = formatStoryboardReport(
      { storyboard: sb, planned: true, changes: [{ index: 4, kind: "dropped", reason: "all its words are cut (3 to 5)" }] },
      timeOf,
    );
    expect(text).toBe(
      [
        "",
        "storyboard plan:",
        "  s1  0.0–4.7 s  p1  a bear carries pancakes",
        "  s3  cut away  p3  three boxes",
        "  planner shot 4: dropped, all its words are cut (3 to 5)",
        "",
      ].join("\n"),
    );
  });
});

describe("storyboardFlag", () => {
  it("leaves a run without --storyboard as reviewFlag resolved it", () => {
    for (const r of [{ render: true, openEditor: undefined }, { render: false, openEditor: false }, { render: true, openEditor: true }]) {
      expect(storyboardFlag(false, r)).toEqual(r);
    }
  });

  it("never renders and opens the editor, unless --no-open-editor was typed", () => {
    expect(storyboardFlag(true, { render: true, openEditor: undefined })).toEqual({ render: false, openEditor: true });
    expect(storyboardFlag(true, { render: true, openEditor: false })).toEqual({ render: false, openEditor: false });
    expect(storyboardFlag(true, { render: false, openEditor: true })).toEqual({ render: false, openEditor: true });
  });

  it("an empty --assets is refused by its schema", () => {
    expect(AssetsFlagSchema.safeParse("  ").success).toBe(false);
    expect(AssetsFlagSchema.safeParse("./art").success).toBe(true);
  });
});
