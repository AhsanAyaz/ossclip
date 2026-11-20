import { describe, expect, it } from "vitest";
import { StoryboardSchema, StoryboardShotSchema, newShotId, type Storyboard, type StoryboardShot } from "../src/storyboard/record";

/**
 * The plan table's record (storyboard design §9, plan Task 1; §168). Pure:
 * the schema a load applies and the one rule that hands out ids.
 */

function shot(over: Partial<StoryboardShot> = {}): StoryboardShot {
  return {
    id: "s1",
    startWord: 3,
    endWord: 9,
    idea: "a goldfish swims in and blows a bubble",
    why: "the speaker names the goldfish here",
    priority: 1,
    assets: [],
    kept: true,
    origin: "planner",
    touched: false,
    ...over,
  };
}

function board(shots: StoryboardShot[], nextShot = shots.length + 1): Storyboard {
  return { version: 1, nextShot, shots };
}

describe("StoryboardSchema", () => {
  it("parses a valid storyboard", () => {
    const sb = { version: 1, intent: "teach the idea", assetsDir: "/abs/assets", nextShot: 3, shots: [shot(), shot({ id: "s2", startWord: 10, endWord: 10, assets: ["logo.png"], origin: "author", touched: true, priority: 3 })] };
    expect(StoryboardSchema.parse(sb)).toEqual(sb);
  });

  it("fails a shot whose endWord is before its startWord", () => {
    const r = StoryboardShotSchema.safeParse(shot({ startWord: 9, endWord: 3 }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["endWord"]);
  });

  it("fails an id that could leave the storyboard folder (Review Focus 4 of Phase A)", () => {
    expect(StoryboardShotSchema.safeParse(shot({ id: "../x" })).success).toBe(false);
  });

  it("fails an asset name with a separator, a priority outside 1 to 3, and a version other than 1", () => {
    expect(StoryboardShotSchema.safeParse(shot({ assets: ["../logo.png"] })).success).toBe(false);
    expect(StoryboardShotSchema.safeParse({ ...shot(), priority: 4 }).success).toBe(false);
    expect(StoryboardSchema.safeParse({ ...board([shot()]), version: 2 }).success).toBe(false);
  });
});

describe("newShotId", () => {
  it("returns s1 then s2, bumping nextShot", () => {
    const a = newShotId(board([], 1));
    expect(a.id).toBe("s1");
    expect(a.sb.nextShot).toBe(2);
    const b = newShotId(a.sb);
    expect(b.id).toBe("s2");
    expect(b.sb.nextShot).toBe(3);
  });

  it("never repeats an id after its shot is removed", () => {
    const sb = board([shot({ id: "s1" }), shot({ id: "s2" })], 3);
    const removed = { ...sb, shots: sb.shots.filter((s) => s.id !== "s2") };
    expect(newShotId(removed).id).toBe("s3");
  });

  it("skips an id already in the table when nextShot fell behind (a hand-edited file)", () => {
    const r = newShotId(board([shot({ id: "s1" }), shot({ id: "s2" })], 1));
    expect(r.id).toBe("s3");
    expect(r.sb.nextShot).toBe(4);
  });
});
