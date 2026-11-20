import { describe, expect, it } from "vitest";
import { enforcePlanLimits, type LimitContext } from "../src/storyboard/limits";
import type { PlannedShot } from "../src/storyboard/record";

/**
 * The plan limits (storyboard design §2 "Limits", plan Task 1 and Review
 * Focus 1; §168): the one place a planner's reply is made safe, so every
 * case asserts both the shots that come out and what was reported.
 *
 * The clock in these tests: kept word i is heard at [i, i + 0.9] seconds of
 * output. A real clock closes up over cuts; these rules only need it to be
 * in word order.
 */

function ctx(over: Partial<LimitContext> = {}): LimitContext {
  const cut = over.cut ?? new Set<number>();
  return {
    wordCount: 100,
    cut,
    outputTimeOf: (i) => (cut.has(i) || i < 0 || i >= (over.wordCount ?? 100) ? null : { start: i, end: i + 0.9 }),
    outputDurationSec: 100,
    maxShotSec: 15,
    gapSec: 0.05,
    assetNames: [],
    blocked: [],
    ...over,
  };
}

function p(startWord: number, endWord: number, over: Partial<PlannedShot> = {}): PlannedShot {
  return { startWord, endWord, idea: `shot ${startWord}-${endWord}`, why: "", priority: 1, assets: [], ...over };
}

const spans = (shots: PlannedShot[]) => shots.map((s) => [s.startWord, s.endWord]);

describe("enforcePlanLimits: indices (Review Focus 1)", () => {
  it("swaps reversed indices", () => {
    const r = enforcePlanLimits([p(9, 5)], ctx());
    expect(spans(r.shots)).toEqual([[5, 9]]);
    expect(r.changes).toEqual([{ index: 0, kind: "moved", reason: expect.stringContaining("reversed") }]);
  });

  it("clamps an end past wordCount to the last word", () => {
    const r = enforcePlanLimits([p(15, 30)], ctx({ wordCount: 20, outputDurationSec: 20 }));
    expect(spans(r.shots)).toEqual([[15, 19]]);
    expect(r.changes).toEqual([{ index: 0, kind: "trimmed", reason: expect.stringContaining("past the last word") }]);
  });

  it("clamps a negative start to word 0", () => {
    const r = enforcePlanLimits([p(-4, 5)], ctx());
    expect(spans(r.shots)).toEqual([[0, 5]]);
    expect(r.changes).toEqual([{ index: 0, kind: "moved", reason: expect.stringContaining("before the first word") }]);
  });

  it("drops a shot that lies wholly outside the transcript", () => {
    const r = enforcePlanLimits([p(25, 30), p(-9, -2)], ctx({ wordCount: 20, outputDurationSec: 20 }));
    expect(r.shots).toEqual([]);
    expect(r.changes).toEqual([
      { index: 0, kind: "dropped", reason: expect.stringContaining("outside the transcript") },
      { index: 1, kind: "dropped", reason: expect.stringContaining("outside the transcript") },
    ]);
  });

  it("drops every shot of an empty transcript", () => {
    const r = enforcePlanLimits([p(0, 3)], ctx({ wordCount: 0, outputDurationSec: 0 }));
    expect(r.shots).toEqual([]);
    expect(r.changes.map((c) => c.kind)).toEqual(["dropped"]);
  });
});

describe("enforcePlanLimits: cut snap (Review Focus 1)", () => {
  it("moves a start on a cut word forward to the nearest kept word", () => {
    const r = enforcePlanLimits([p(5, 10)], ctx({ cut: new Set([5, 6]) }));
    expect(spans(r.shots)).toEqual([[7, 10]]);
    expect(r.changes).toEqual([{ index: 0, kind: "moved", reason: expect.stringContaining("cut") }]);
  });

  it("moves an end on a cut word back to the nearest kept word", () => {
    const r = enforcePlanLimits([p(3, 10)], ctx({ cut: new Set([9, 10]) }));
    expect(spans(r.shots)).toEqual([[3, 8]]);
    expect(r.changes).toEqual([{ index: 0, kind: "trimmed", reason: expect.stringContaining("cut") }]);
  });

  it("drops a shot whose words are all cut", () => {
    const r = enforcePlanLimits([p(3, 5)], ctx({ cut: new Set([3, 4, 5]) }));
    expect(r.shots).toEqual([]);
    expect(r.changes).toEqual([{ index: 0, kind: "dropped", reason: expect.stringContaining("all its words are cut") }]);
  });

  it("drops a shot whose kept word has no output time, rather than guessing one", () => {
    const base = ctx();
    const r = enforcePlanLimits([p(3, 8)], { ...base, outputTimeOf: (i) => (i === 3 ? null : base.outputTimeOf(i)) });
    expect(r.shots).toEqual([]);
    expect(r.changes).toEqual([{ index: 0, kind: "dropped", reason: expect.stringContaining("no output time") }]);
  });
});

describe("enforcePlanLimits: overlap, minimum, maximum", () => {
  it("moves a shot that overlaps an earlier one to the first kept word after its end plus the gap", () => {
    // The earlier shot ends at 5.9 s; word 6 starts at 6.0 >= 5.95.
    const r = enforcePlanLimits([p(0, 5), p(3, 10)], ctx());
    expect(spans(r.shots)).toEqual([
      [0, 5],
      [6, 10],
    ]);
    expect(r.changes).toEqual([{ index: 1, kind: "moved", reason: expect.stringContaining("overlapped") }]);
  });

  it("holds a moved shot to the gap: a word starting inside it is skipped", () => {
    // Earlier shot ends at 5.9 s; word 6 starts at 5.92 (< 5.95), word 7 at 7.
    const base = ctx();
    const outputTimeOf = (i: number) => (i === 6 ? { start: 5.92, end: 6.5 } : base.outputTimeOf(i));
    const r = enforcePlanLimits([p(0, 5), p(3, 10)], { ...base, outputTimeOf });
    expect(spans(r.shots)).toEqual([
      [0, 5],
      [7, 10],
    ]);
  });

  it("drops a moved shot that is then under 2 s", () => {
    const r = enforcePlanLimits([p(0, 5), p(3, 6)], ctx());
    expect(spans(r.shots)).toEqual([[0, 5]]);
    expect(r.changes).toEqual([
      { index: 1, kind: "moved", reason: expect.stringContaining("overlapped") },
      { index: 1, kind: "dropped", reason: expect.stringContaining("under the 2 s minimum") },
    ]);
  });

  it("drops a moved shot when nothing of it is left after the earlier one", () => {
    const r = enforcePlanLimits([p(0, 9), p(3, 8)], ctx());
    expect(spans(r.shots)).toEqual([[0, 9]]);
    expect(r.changes).toEqual([{ index: 1, kind: "dropped", reason: expect.stringContaining("nothing of it is left") }]);
  });

  it("lets a shot dropped for the minimum push nothing: the next one keeps its words", () => {
    // [0,0] is 0.9 s, so it is dropped before it can occupy anything, and
    // [0,5] (same start, later in the reply) is not moved after it.
    const r = enforcePlanLimits([p(0, 0), p(0, 5)], ctx());
    expect(spans(r.shots)).toEqual([[0, 5]]);
    expect(r.changes).toEqual([{ index: 0, kind: "dropped", reason: expect.stringContaining("minimum") }]);
  });

  it("trims a shot over maxShotSec at its end to the last kept word inside the limit", () => {
    // Word 14 ends at 14.9 s (inside 15); word 15 ends at 15.9.
    const r = enforcePlanLimits([p(0, 30)], ctx());
    expect(spans(r.shots)).toEqual([[0, 14]]);
    expect(r.changes).toEqual([{ index: 0, kind: "trimmed", reason: expect.stringContaining("15 s maximum") }]);
  });

  it("trims to a kept word: a cut word inside the limit is not an end", () => {
    const r = enforcePlanLimits([p(0, 30)], ctx({ cut: new Set([14]) }));
    expect(spans(r.shots)).toEqual([[0, 13]]);
  });

  it("drops a shot that the maximum's trim leaves under the minimum", () => {
    // Word 0 is heard at 0-1 s, word 1 at 16-17 s: the only end inside 15 s is word 0.
    const base = ctx({ wordCount: 2, outputDurationSec: 100 });
    const outputTimeOf = (i: number) => (i === 0 ? { start: 0, end: 1 } : i === 1 ? { start: 16, end: 17 } : null);
    const r = enforcePlanLimits([p(0, 1)], { ...base, outputTimeOf });
    expect(r.shots).toEqual([]);
    expect(r.changes).toEqual([
      { index: 0, kind: "trimmed", reason: expect.stringContaining("15 s maximum") },
      { index: 0, kind: "dropped", reason: expect.stringContaining("minimum") },
    ]);
  });
});

describe("enforcePlanLimits: assets", () => {
  it("removes an asset name that is not in assetNames", () => {
    const r = enforcePlanLimits([p(0, 5, { assets: ["logo.png", "nope.png"] })], ctx({ assetNames: ["logo.png"] }));
    expect(r.shots[0]!.assets).toEqual(["logo.png"]);
    expect(r.changes).toEqual([{ index: 0, kind: "asset-removed", reason: expect.stringContaining("nope.png") }]);
  });
});

describe("enforcePlanLimits: coverage", () => {
  it("drops priority 3 before priority 2, latest first among equals, until coverage is at most 60%", () => {
    // Six shots of 14.9 s = 89.4 s of 100. Dropping two leaves 59.6 s.
    const prio = [2, 3, 1, 2, 1, 1] as const;
    const shots = prio.map((priority, k) => p(k * 16, k * 16 + 14, { priority }));
    const r = enforcePlanLimits(shots, ctx());
    expect(spans(r.shots)).toEqual([
      [0, 14],
      [32, 46],
      [64, 78],
      [80, 94],
    ]);
    expect(r.changes).toEqual([
      { index: 1, kind: "dropped", reason: expect.stringContaining("60%") },
      { index: 3, kind: "dropped", reason: expect.stringContaining("60%") },
    ]);
  });

  it("drops the latest of equal priority first", () => {
    const shots = [p(0, 14, { priority: 3 }), p(20, 34, { priority: 3 }), p(40, 54, { priority: 3 }), p(60, 74, { priority: 3 }), p(80, 94, { priority: 3 })];
    const r = enforcePlanLimits(shots, ctx());
    expect(spans(r.shots)).toEqual([
      [0, 14],
      [20, 34],
      [40, 54],
      [60, 74],
    ]);
    expect(r.changes.map((c) => c.index)).toEqual([4]);
  });

  it("counts blocked ranges toward coverage but never drops them", () => {
    // Blocked: 50 words = 49.9 s. A 14.9 s planned shot would make 64.8 s.
    const r = enforcePlanLimits([p(60, 74)], ctx({ blocked: [{ startWord: 0, endWord: 49 }] }));
    expect(r.shots).toEqual([]);
    expect(r.changes).toEqual([{ index: 0, kind: "dropped", reason: expect.stringContaining("60%") }]);
  });

  it("drops every planned shot when the blocked ranges alone are over the limit", () => {
    const r = enforcePlanLimits([p(80, 84, { priority: 1 }), p(90, 94, { priority: 1 })], ctx({ blocked: [{ startWord: 0, endWord: 69 }] }));
    expect(r.shots).toEqual([]);
    expect(r.changes.map((c) => [c.index, c.kind])).toEqual([
      [1, "dropped"],
      [0, "dropped"],
    ]);
  });

  it("drops every planned shot when the runtime is zero, rather than dividing by it", () => {
    const r = enforcePlanLimits([p(0, 5)], ctx({ outputDurationSec: 0 }));
    expect(r.shots).toEqual([]);
    expect(r.changes.map((c) => c.kind)).toEqual(["dropped"]);
  });
});

describe("enforcePlanLimits: blocked ranges (Review Focus 3)", () => {
  // Blocked words 5-8 are heard at 5.0-8.9 s; the first word after 8.95 s is 9.
  const blocked = [{ startWord: 5, endWord: 8 }];

  it("moves a shot that starts inside a blocked range to after it", () => {
    const r = enforcePlanLimits([p(7, 15)], ctx({ blocked }));
    expect(spans(r.shots)).toEqual([[9, 15]]);
    expect(r.changes).toEqual([{ index: 0, kind: "moved", reason: expect.stringContaining("words 5 to 8") }]);
  });

  it("moves a shot that starts before a blocked range and runs into it to after it", () => {
    const r = enforcePlanLimits([p(2, 12)], ctx({ blocked }));
    expect(spans(r.shots)).toEqual([[9, 12]]);
    expect(r.changes.map((c) => c.kind)).toEqual(["moved"]);
  });

  it("drops a shot that lies inside a blocked range", () => {
    const r = enforcePlanLimits([p(6, 8)], ctx({ blocked }));
    expect(r.shots).toEqual([]);
    expect(r.changes.map((c) => c.kind)).toEqual(["dropped"]);
  });

  it("leaves a shot that ends before the blocked range by more than the gap", () => {
    const r = enforcePlanLimits([p(0, 4)], ctx({ blocked }));
    expect(spans(r.shots)).toEqual([[0, 4]]);
    expect(r.changes).toEqual([]);
  });

  it("moves past a chain of blocked ranges until nothing overlaps", () => {
    const r = enforcePlanLimits([p(2, 20)], ctx({ blocked: [{ startWord: 10, endWord: 12 }, { startWord: 5, endWord: 9 }] }));
    expect(spans(r.shots)).toEqual([[13, 20]]);
  });

  it("ignores a blocked range whose words are all cut: it covers nothing", () => {
    const r = enforcePlanLimits([p(2, 12)], ctx({ blocked, cut: new Set([5, 6, 7, 8]) }));
    expect(spans(r.shots)).toEqual([[2, 12]]);
  });
});

describe("enforcePlanLimits: order and input indices", () => {
  it("returns shots sorted by startWord and reports changes by their index in the input", () => {
    const r = enforcePlanLimits([p(40, 50), p(20, 30, { assets: ["x.png"] }), p(0, 10)], ctx());
    expect(spans(r.shots)).toEqual([
      [0, 10],
      [20, 30],
      [40, 50],
    ]);
    expect(r.changes).toEqual([{ index: 1, kind: "asset-removed", reason: expect.stringContaining("x.png") }]);
  });

  it("does not change the input array or its shots", () => {
    const input = [p(9, 5, { assets: ["x.png"] })];
    const copy = structuredClone(input);
    enforcePlanLimits(input, ctx());
    expect(input).toEqual(copy);
  });

  it("never throws on any integer input, and what it returns is within every limit", () => {
    // A fixed linear congruential sequence, so a failure reproduces.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const int = (lo: number, hi: number) => lo + (next() % (hi - lo + 1));
    let survived = 0;
    for (let round = 0; round < 300; round++) {
      const wordCount = int(0, 60);
      const cut = new Set(Array.from({ length: int(0, 30) }, () => int(-5, 70)));
      const c = ctx({ wordCount, cut, outputDurationSec: int(0, 60), blocked: [{ startWord: int(-5, 70), endWord: int(-5, 70) }] });
      const shots = Array.from({ length: int(0, 12) }, () =>
        p(int(-1000, 1000), int(-1000, 1000), { priority: int(1, 3) as 1 | 2 | 3 }),
      );
      const r = enforcePlanLimits(shots, c);
      survived += r.shots.length;
      for (const [k, s] of r.shots.entries()) {
        expect(s.startWord).toBeGreaterThanOrEqual(0);
        expect(s.endWord).toBeLessThan(wordCount);
        expect(s.endWord).toBeGreaterThanOrEqual(s.startWord);
        expect(cut.has(s.startWord) || cut.has(s.endWord)).toBe(false);
        const len = c.outputTimeOf(s.endWord)!.end - c.outputTimeOf(s.startWord)!.start;
        expect(len).toBeGreaterThanOrEqual(2);
        expect(len).toBeLessThanOrEqual(15);
        if (k > 0) expect(s.startWord).toBeGreaterThan(r.shots[k - 1]!.endWord);
      }
      for (const ch of r.changes) expect(ch.index).toBeLessThan(shots.length);
    }
    // Not vacuous: the sequence must leave shots for the checks above to check.
    expect(survived).toBeGreaterThan(20);
  });
});
