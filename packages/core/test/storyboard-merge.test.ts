import { describe, expect, it } from "vitest";
import { isProtectedShot, mergePlanAgain } from "../src/storyboard/merge";
import type { PlannedShot, Storyboard, StoryboardShot } from "../src/storyboard/record";

/**
 * "Plan again" (storyboard design §2 "Planning again", plan Task 1 and
 * Review Focus 3; §168): what the author steered survives with its id, and
 * only untouched planned rows are replaced. Limits are not this function's
 * job; the caller runs them with the protected rows as `blocked`.
 */

function row(id: string, startWord: number, over: Partial<StoryboardShot> = {}): StoryboardShot {
  return {
    id,
    startWord,
    endWord: startWord + 5,
    idea: `idea of ${id}`,
    why: "",
    priority: 2,
    assets: [],
    kept: true,
    origin: "planner",
    touched: false,
    ...over,
  };
}

function fresh(startWord: number, idea: string): PlannedShot {
  return { startWord, endWord: startWord + 4, idea, why: "new", priority: 1, assets: ["logo.png"] };
}

describe("isProtectedShot", () => {
  it("protects a touched shot, an author's shot and a drawn shot, and nothing else", () => {
    expect(isProtectedShot(row("s1", 0), false)).toBe(false);
    expect(isProtectedShot(row("s1", 0, { touched: true }), false)).toBe(true);
    expect(isProtectedShot(row("s1", 0, { origin: "author" }), false)).toBe(true);
    expect(isProtectedShot(row("s1", 0), true)).toBe(true);
  });
});

describe("mergePlanAgain (Review Focus 3)", () => {
  // s6 and s7 were removed by an earlier plan-again, so nextShot is 8.
  const sb: Storyboard = {
    version: 1,
    intent: "teach it",
    assetsDir: "/abs/assets",
    nextShot: 8,
    shots: [
      row("s1", 0),
      row("s2", 10, { touched: true, idea: "reworded" }),
      row("s3", 20, { origin: "author", touched: true }),
      row("s4", 30),
      row("s5", 40, { touched: true, kept: false }),
    ],
  };
  const drawn = (id: string) => id === "s4";

  it("removes untouched planner shots and keeps touched, author's and drawn ones with their ids, dropped included", () => {
    const out = mergePlanAgain(sb, [], drawn);
    expect(out.shots.map((s) => s.id)).toEqual(["s2", "s3", "s4", "s5"]);
    expect(out.shots.find((s) => s.id === "s2")).toEqual(sb.shots[1]);
    expect(out.shots.find((s) => s.id === "s5")!.kept).toBe(false);
  });

  it("gives fresh shots new ids in start order, as untouched planner rows", () => {
    const out = mergePlanAgain(sb, [fresh(60, "later"), fresh(50, "earlier")], drawn);
    expect(out.shots.map((s) => [s.id, s.startWord])).toEqual([
      ["s2", 10],
      ["s3", 20],
      ["s4", 30],
      ["s5", 40],
      ["s8", 50],
      ["s9", 60],
    ]);
    expect(out.shots.find((s) => s.id === "s8")).toEqual({
      id: "s8",
      startWord: 50,
      endWord: 54,
      idea: "earlier",
      why: "new",
      priority: 1,
      assets: ["logo.png"],
      kept: true,
      origin: "planner",
      touched: false,
    });
    expect(out.nextShot).toBe(10);
  });

  it("never reuses the id of a removed shot", () => {
    const out = mergePlanAgain(sb, [fresh(0, "where s1 was")], drawn);
    expect(out.shots.find((s) => s.startWord === 0)!.id).toBe("s8");
    expect(out.shots.map((s) => s.id)).not.toContain("s1");
  });

  it("keeps the storyboard's other fields and does not change its input", () => {
    const copy = structuredClone(sb);
    const out = mergePlanAgain(sb, [fresh(50, "x")], drawn);
    expect(out.intent).toBe("teach it");
    expect(out.assetsDir).toBe("/abs/assets");
    expect(out.version).toBe(1);
    expect(sb).toEqual(copy);
  });

  it("sorts the result by start word, survivors before fresh shots on the same word", () => {
    const out = mergePlanAgain(sb, [fresh(5, "between"), fresh(10, "same start as s2")], drawn);
    expect(out.shots.map((s) => s.id)).toEqual(["s8", "s2", "s9", "s3", "s4", "s5"]);
  });
});
