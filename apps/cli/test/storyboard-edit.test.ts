import { describe, expect, it } from "vitest";
import type { Storyboard, StoryboardShot } from "@ossclip/core";
import {
  StoryboardEditError,
  StoryboardEditSchema,
  applyStoryboardEdit,
} from "../src/storyboard/storyboard-edit";

/**
 * One author edit of the plan table (plan Task 4 Step 1; §168), pure: no
 * file, no server. The server's tests cover the same rules through HTTP.
 */
const shot = (over: Partial<StoryboardShot> & Pick<StoryboardShot, "id" | "startWord" | "endWord">): StoryboardShot => ({
  idea: `the idea of ${over.id}, drawn as a diagram that builds`,
  why: "a picture says it faster",
  priority: 2,
  assets: [],
  kept: true,
  origin: "planner",
  touched: false,
  ...over,
});

const SB: Storyboard = {
  version: 1,
  nextShot: 4,
  shots: [
    shot({ id: "s1", startWord: 0, endWord: 9 }),
    shot({ id: "s2", startWord: 20, endWord: 29, idea: "A rocket lifts off the page and draws a curve behind it" }),
    shot({ id: "s3", startWord: 40, endWord: 49, kept: false, touched: true }),
  ],
};
const WORDS = 100;

const byId = (sb: Storyboard, id: string) => sb.shots.find((s) => s.id === id)!;
const errorOf = (f: () => unknown): StoryboardEditError => {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(StoryboardEditError);
    return err as StoryboardEditError;
  }
  throw new Error("expected a StoryboardEditError");
};

describe("applyStoryboardEdit", () => {
  it("idea: trimmed, stored, and marks the shot touched", () => {
    const next = applyStoryboardEdit(SB, { op: "idea", id: "s1", idea: "  a hand draws a box  " }, WORDS);
    expect(byId(next, "s1")).toMatchObject({ idea: "a hand draws a box", touched: true });
    // Pure: the input is not changed.
    expect(byId(SB, "s1").touched).toBe(false);
  });

  it("idea: an empty or over-long idea is refused with its length", () => {
    expect(errorOf(() => applyStoryboardEdit(SB, { op: "idea", id: "s1", idea: "   " }, WORDS)).message).toMatch(/empty/);
    expect(errorOf(() => applyStoryboardEdit(SB, { op: "idea", id: "s1", idea: "x".repeat(401) }, WORDS)).message).toMatch(
      /401 characters.*400/,
    );
    expect(byId(applyStoryboardEdit(SB, { op: "idea", id: "s1", idea: "x".repeat(400) }, WORDS), "s1").idea).toHaveLength(400);
  });

  it("span: moves the shot and marks it touched", () => {
    const next = applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 5, endWord: 15 }, WORDS);
    expect(byId(next, "s1")).toMatchObject({ startWord: 5, endWord: 15, touched: true });
  });

  it("span: overlapping another kept shot throws naming its id and the start of its idea", () => {
    const err = errorOf(() => applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 5, endWord: 20 }, WORDS));
    expect(err.message).toContain("s2");
    expect(err.message).toContain("A rocket lifts off");
    expect(err.message).not.toContain("draws a curve behind it");
  });

  it("span: sharing a single word is an overlap; touching end to start is not", () => {
    expect(() => applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 10, endWord: 20 }, WORDS)).toThrow(StoryboardEditError);
    expect(byId(applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 10, endWord: 19 }, WORDS), "s1").endWord).toBe(19);
  });

  it("span: a dropped shot does not block, and the shot does not block itself", () => {
    // s3 (40-49) is dropped.
    expect(byId(applyStoryboardEdit(SB, { op: "span", id: "s2", startWord: 25, endWord: 45 }, WORDS), "s2").endWord).toBe(45);
    expect(byId(applyStoryboardEdit(SB, { op: "span", id: "s2", startWord: 22, endWord: 27 }, WORDS), "s2").startWord).toBe(22);
  });

  it("span: past the transcript, negative or reversed throws", () => {
    expect(errorOf(() => applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 95, endWord: 100 }, WORDS)).message).toMatch(
      /100 words/,
    );
    expect(() => applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: -1, endWord: 3 }, WORDS)).toThrow(StoryboardEditError);
    expect(() => applyStoryboardEdit(SB, { op: "span", id: "s1", startWord: 8, endWord: 3 }, WORDS)).toThrow(StoryboardEditError);
  });

  it("drop: kept false, touched; the row stays", () => {
    const next = applyStoryboardEdit(SB, { op: "drop", id: "s2" }, WORDS);
    expect(byId(next, "s2")).toMatchObject({ kept: false, touched: true });
    expect(next.shots).toHaveLength(3);
  });

  it("restore: kept again when nothing kept overlaps it", () => {
    const next = applyStoryboardEdit(SB, { op: "restore", id: "s3" }, WORDS);
    expect(byId(next, "s3")).toMatchObject({ kept: true, touched: true });
  });

  it("restore: a shot that now overlaps a kept shot throws, naming that shot", () => {
    const moved = applyStoryboardEdit(SB, { op: "span", id: "s2", startWord: 25, endWord: 45 }, WORDS);
    const err = errorOf(() => applyStoryboardEdit(moved, { op: "restore", id: "s3" }, WORDS));
    expect(err.message).toContain("s2");
  });

  it("an unknown id throws, naming it", () => {
    for (const edit of [
      { op: "drop", id: "s9" },
      { op: "restore", id: "s9" },
      { op: "idea", id: "s9", idea: "x" },
      { op: "span", id: "s9", startWord: 0, endWord: 1 },
    ] as const) {
      expect(errorOf(() => applyStoryboardEdit(SB, edit, WORDS)).message).toContain("s9");
    }
  });

  it("add: an author's shot with a fresh id, priority 1, kept and touched", () => {
    const next = applyStoryboardEdit(SB, { op: "add", startWord: 60, endWord: 70, idea: " a chart rises " }, WORDS);
    expect(next.nextShot).toBe(5);
    expect(byId(next, "s4")).toEqual({
      id: "s4",
      startWord: 60,
      endWord: 70,
      idea: "a chart rises",
      why: "",
      priority: 1,
      assets: [],
      kept: true,
      origin: "author",
      touched: true,
    });
    // Sorted by start, as the table reads.
    expect(next.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    const early = applyStoryboardEdit(SB, { op: "add", startWord: 12, endWord: 15, idea: "a box" }, WORDS);
    expect(early.shots.map((s) => s.id)).toEqual(["s1", "s4", "s2", "s3"]);
  });

  it("add: overlapping a kept shot or past the transcript throws", () => {
    expect(errorOf(() => applyStoryboardEdit(SB, { op: "add", startWord: 28, endWord: 35, idea: "x" }, WORDS)).message).toContain(
      "s2",
    );
    expect(() => applyStoryboardEdit(SB, { op: "add", startWord: 90, endWord: 120, idea: "x" }, WORDS)).toThrow(StoryboardEditError);
    // A dropped shot's words are free.
    expect(() => applyStoryboardEdit(SB, { op: "add", startWord: 42, endWord: 44, idea: "x" }, WORDS)).not.toThrow();
  });
});

describe("StoryboardEditSchema", () => {
  it("parses each op and refuses an unknown op or a fractional index", () => {
    expect(StoryboardEditSchema.safeParse({ op: "drop", id: "s1" }).success).toBe(true);
    expect(StoryboardEditSchema.safeParse({ op: "span", id: "s1", startWord: 1, endWord: 2 }).success).toBe(true);
    expect(StoryboardEditSchema.safeParse({ op: "add", startWord: 1, endWord: 2, idea: "x" }).success).toBe(true);
    expect(StoryboardEditSchema.safeParse({ op: "explode", id: "s1" }).success).toBe(false);
    expect(StoryboardEditSchema.safeParse({ op: "span", id: "s1", startWord: 1.5, endWord: 2 }).success).toBe(false);
    expect(StoryboardEditSchema.safeParse({ op: "idea", id: "s1" }).success).toBe(false);
  });
});
