import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapFromKeptSpans,
  type PlannedShot,
  type ShotHistory,
  type Storyboard,
  type StoryboardPlanInput,
  type StoryboardShot,
} from "@ossclip/core";
import { saveShot } from "../src/draw/shot-store";
import { STORYBOARD_FILE, saveStoryboard } from "../src/storyboard/storyboard-store";
import { drawnShots, liveCut, planAgain, type PlanAgainArgs } from "../src/storyboard/plan-again";

/**
 * "Plan again" (storyboard design §2 "Planning again"; plan Task 4; §168)
 * on a temp workdir, the planner injected: no server, no LLM.
 */
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-plan-again-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// 160 words, one every 0.4 s, none cut: 64 s of output on an identity clock.
const WORDS = Array.from({ length: 160 }, (_, i) => ({ text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
const TIMES = WORDS.map((w) => ({ start: w.start, end: w.end }));

const shot = (over: Partial<StoryboardShot> & Pick<StoryboardShot, "id" | "startWord" | "endWord">): StoryboardShot => ({
  idea: `the idea of ${over.id}`,
  why: "",
  priority: 2,
  assets: [],
  kept: true,
  origin: "planner",
  touched: false,
  ...over,
});

/**
 * s1 and s6 are untouched planner rows; s2 is reworded, s3 the author's, s4
 * drawn (a history with an ok version), s5 touched but dropped.
 */
const SB: Storyboard = {
  version: 1,
  intent: "teach the idea",
  nextShot: 7,
  shots: [
    shot({ id: "s1", startWord: 0, endWord: 9 }),
    shot({ id: "s2", startWord: 20, endWord: 34, touched: true, idea: "a reworded idea" }),
    shot({ id: "s3", startWord: 50, endWord: 64, origin: "author", touched: true, priority: 1 }),
    shot({ id: "s4", startWord: 80, endWord: 94 }),
    shot({ id: "s5", startWord: 100, endWord: 114, kept: false, touched: true }),
    shot({ id: "s6", startWord: 130, endWord: 140 }),
  ],
};

function drawn(id: string, versions: ShotHistory["versions"], draft: number | null): void {
  saveShot(work, {
    id,
    idea: "x",
    spokenLine: "x",
    durationSec: 4,
    versions,
    draft,
    nextVersion: versions.length + 1,
    notes: [],
    runs: [],
  });
}

const planned = (startWord: number, endWord: number, over: Partial<PlannedShot> = {}): PlannedShot => ({
  startWord,
  endWord,
  idea: `fresh ${startWord}`,
  why: "fresh",
  priority: 2,
  assets: [],
  ...over,
});

function args(over: Partial<PlanAgainArgs> = {}): PlanAgainArgs {
  return {
    workdir: work,
    storyboard: SB,
    words: WORDS,
    cut: new Set(),
    wordTimes: TIMES,
    outputDurationSec: 64,
    frame: { width: 1080, height: 1920 },
    provider: { name: "never", usage: [], complete: async () => Promise.reject(new Error("injected plan only")) },
    ...over,
  };
}

describe("liveCut", () => {
  // Kept source 0-1.0 s and 2.5-4.0 s.
  const map = mapFromKeptSpans([
    { srcIn: 0, srcOut: 1.0, outIn: 0, outOut: 1.0 },
    { srcIn: 2.5, srcOut: 4.0, outIn: 1.0, outOut: 2.5 },
  ]);

  it("keeps a word whose midpoint is inside a kept span, whatever its edges do (§168)", () => {
    const words = [
      { start: 0.1, end: 0.4 }, // inside
      { start: 0.9, end: 1.08 }, // straddles the edge, midpoint 0.99 kept
      { start: 0.95, end: 1.3 }, // straddles the edge, midpoint 1.125 cut
      { start: 1.5, end: 2.0 }, // wholly cut
      { start: 2.3, end: 2.9 }, // straddles in, midpoint 2.6 kept
      { start: 4.1, end: 4.5 }, // past the last span
    ];
    const r = liveCut(words, map);
    expect([...r.cut].sort()).toEqual([2, 3, 5]);
    // Kept words get the map's times, edges clamped; cut words have none.
    expect(r.wordTimes[0]).toEqual({ start: 0.1, end: 0.4 });
    expect(r.wordTimes[1]!.end).toBeCloseTo(1.0);
    expect(r.wordTimes[2]).toBeNull();
    expect(r.wordTimes[4]!.start).toBeCloseTo(1.0);
    expect(r.wordTimes[4]!.end).toBeCloseTo(1.4);
  });
});

describe("drawnShots", () => {
  it("counts versions with a result and reports the draft, for shots with a history only", () => {
    drawn("s4", [
      { n: 1, result: "ok", kitVersion: 1 },
      { n: 2, result: { failed: "type error" }, kitVersion: 1 },
      { n: 3, kitVersion: 1 },
    ], 1);
    expect(drawnShots(work, SB)).toEqual({ s4: { draft: 1, versions: 2 } });
  });
});

describe("planAgain", () => {
  it("keeps the protected shots, plans around the kept ones, replaces untouched rows with fresh ids", async () => {
    drawn("s4", [{ n: 1, result: "ok", kitVersion: 1 }], 1);
    saveStoryboard(work, SB);
    const inputs: StoryboardPlanInput[] = [];
    const r = await planAgain(args(), {
      plan: async (_p, input) => {
        inputs.push(input);
        // One on the dropped s5's words (free), one into s2 (moved past it), one late.
        return [planned(100, 114), planned(25, 40), planned(142, 152)];
      },
    });

    expect(inputs).toHaveLength(1);
    // "Already taken" is the protected KEPT shots: the dropped s5 does not block.
    expect(inputs[0]!.taken).toEqual([
      { startWord: 20, endWord: 34, idea: "a reworded idea" },
      { startWord: 50, endWord: 64, idea: "the idea of s3" },
      { startWord: 80, endWord: 94, idea: "the idea of s4" },
    ]);
    expect(inputs[0]!.intent).toBe("teach the idea");
    expect(inputs[0]!.assets).toEqual([]);

    const ids = r.storyboard.shots.map((s) => [s.id, s.startWord, s.endWord, s.kept]);
    expect(ids).toEqual([
      ["s2", 20, 34, true],
      ["s7", 35, 40, true], // moved off s2 by the limits (blocked), then a fresh id
      ["s3", 50, 64, true],
      ["s4", 80, 94, true],
      ["s5", 100, 114, false],
      ["s8", 100, 114, true],
      ["s9", 142, 152, true],
    ]);
    expect(r.storyboard.nextShot).toBe(10);
    expect(r.changes).toEqual([expect.objectContaining({ index: 1, kind: "moved" })]);
    // Saved, and no plan cache read or written: the author asked for a fresh plan.
    expect(JSON.parse(readFileSync(join(work, STORYBOARD_FILE), "utf8"))).toEqual(r.storyboard);
    expect(readdirSync(work).filter((n) => n.startsWith("storyboardplan-"))).toEqual([]);
  });

  it("names the stored assets to the planner and drops a name it does not have", async () => {
    const assets = join(work, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "logo.png"), "png");
    const sb = { ...SB, assetsDir: assets };
    saveStoryboard(work, sb);
    const inputs: StoryboardPlanInput[] = [];
    const r = await planAgain(args({ storyboard: sb }), {
      probeImageSize: async () => ({ width: 64, height: 32 }),
      plan: async (_p, input) => {
        inputs.push(input);
        return [planned(142, 152, { assets: ["logo.png", "ghost.png"] })];
      },
    });
    expect(inputs[0]!.assets).toEqual([{ name: "logo.png", width: 64, height: 32 }]);
    expect(r.storyboard.shots.find((s) => s.startWord === 142)!.assets).toEqual(["logo.png"]);
  });

  it("a stored assets folder that is gone fails before the call and leaves the file as it was", async () => {
    const sb = { ...SB, assetsDir: join(work, "gone") };
    saveStoryboard(work, sb);
    const before = readFileSync(join(work, STORYBOARD_FILE));
    let called = false;
    await expect(
      planAgain(args({ storyboard: sb }), {
        plan: async () => {
          called = true;
          return [];
        },
      }),
    ).rejects.toThrow(/assets folder .*gone.* no longer exists/);
    expect(called).toBe(false);
    expect(readFileSync(join(work, STORYBOARD_FILE)).equals(before)).toBe(true);
  });

  it("a planner failure propagates and leaves the file byte-identical", async () => {
    saveStoryboard(work, SB);
    const before = readFileSync(join(work, STORYBOARD_FILE));
    await expect(
      planAgain(args(), { plan: async () => Promise.reject(new Error("quota exceeded")) }),
    ).rejects.toThrow("quota exceeded");
    expect(readFileSync(join(work, STORYBOARD_FILE)).equals(before)).toBe(true);
  });

  it("a broken draw history fails before the call: whether that shot is drawn is unknown", async () => {
    saveStoryboard(work, SB);
    mkdirSync(join(work, "storyboard", "s1"), { recursive: true });
    writeFileSync(join(work, "storyboard", "s1", "history.json"), "{");
    let called = false;
    await expect(
      planAgain(args(), {
        plan: async () => {
          called = true;
          return [];
        },
      }),
    ).rejects.toThrow(/history\.json is not valid JSON/);
    expect(called).toBe(false);
  });
});
