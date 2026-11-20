import { describe, expect, it } from "vitest";
import type { Storyboard, StoryboardShot } from "@ossclip/core/browser";
import {
  coverage,
  coverageOverLimit,
  formatRange,
  planChangesSummary,
  rowWarning,
  selectionSpan,
  spanPreview,
  storyboardButtonState,
  storyboardRows,
  wordIndexAtSourceTime,
  type StoryboardRow,
} from "../src/storyboardModel";

/** Ten words, one per second of source; word i runs i .. i+0.8. */
const words = Array.from({ length: 10 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.8 }));

/** The identity clock with words 4 and 5 cut. */
const cut = new Set([4, 5]);
const timeOf = (i: number) => (cut.has(i) ? null : { start: words[i]!.start, end: words[i]!.end });

const shot = (over: Partial<StoryboardShot> & { id: string; startWord: number; endWord: number }): StoryboardShot => ({
  idea: `idea ${over.id}`,
  why: `why ${over.id}`,
  priority: 2,
  assets: [],
  kept: true,
  origin: "planner",
  touched: false,
  ...over,
});

const board = (shots: StoryboardShot[]): Storyboard => ({ version: 1, nextShot: shots.length + 1, shots });

const row = (over: Partial<StoryboardRow>): StoryboardRow => ({
  id: "s1",
  startSec: 0,
  endSec: 5,
  line: "",
  idea: "x",
  why: "",
  priority: 1,
  state: "planned",
  touched: false,
  draft: null,
  ...over,
});

describe("storyboardRows", () => {
  it("sorts rows by start whatever order the file holds them in", () => {
    const rows = storyboardRows(
      board([shot({ id: "s2", startWord: 6, endWord: 7 }), shot({ id: "s1", startWord: 0, endWord: 1 })]),
      words,
      timeOf,
      {},
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("joins the shot's kept words into its line and times it from the first to the last kept word", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 3, endWord: 6 })]), words, timeOf, {});
    expect(r!.line).toBe("w3 w6");
    expect(r!.startSec).toBe(3);
    expect(r!.endSec).toBeCloseTo(6.8);
    expect(r!.state).toBe("planned");
  });

  it("caps a long line at 140 characters with an ellipsis", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ text: `word${i}`, start: i, end: i + 0.5 }));
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 59 })]), long, (i) => long[i]!, {});
    expect(r!.line).toHaveLength(140);
    expect(r!.line.endsWith("…")).toBe(true);
    expect(r!.line.startsWith("word0 word1 ")).toBe(true);
  });

  it("marks a shot whose words are all cut as cut away, with no times and no line", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 4, endWord: 5 })]), words, timeOf, {});
    expect(r!.state).toBe("cut away");
    expect(r!.startSec).toBeNull();
    expect(r!.endSec).toBeNull();
    expect(r!.line).toBe("");
  });

  it("marks a dropped shot as dropped, even when it has a draft or its words are cut", () => {
    const rows = storyboardRows(
      board([
        shot({ id: "s1", startWord: 0, endWord: 1, kept: false }),
        shot({ id: "s2", startWord: 4, endWord: 5, kept: false }),
      ]),
      words,
      timeOf,
      { s1: { draft: 2, versions: 2 } },
    );
    expect(rows.map((r) => r.state)).toEqual(["dropped", "dropped"]);
    expect(rows[0]!.draft).toBeNull();
  });

  it("marks a shot with a draft as drawn and carries the draft number", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 1 })]), words, timeOf, {
      s1: { draft: 3, versions: 3 },
    });
    expect(r!.state).toBe("drawn");
    expect(r!.draft).toBe(3);
  });

  it("does not call a shot with versions but no draft drawn", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 1 })]), words, timeOf, {
      s1: { draft: null, versions: 1 },
    });
    expect(r!.state).toBe("planned");
  });

  it("calls a drawn shot whose words were all cut cut away: nothing is left to draw over", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 4, endWord: 5 })]), words, timeOf, {
      s1: { draft: 1, versions: 1 },
    });
    expect(r!.state).toBe("cut away");
  });

  it("ignores indices past the end of the words instead of throwing", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 8, endWord: 20 })]), words, timeOf, {});
    expect(r!.line).toBe("w8 w9");
  });
});

describe("coverage", () => {
  it("adds the kept rows' lengths over the runtime and ignores dropped and cut-away rows", () => {
    const rows = [
      row({ id: "a", startSec: 0, endSec: 5 }),
      row({ id: "b", startSec: 10, endSec: 15, state: "drawn", draft: 1 }),
      row({ id: "c", startSec: 20, endSec: 30, state: "dropped" }),
      row({ id: "d", startSec: null, endSec: null, state: "cut away" }),
    ];
    expect(coverage(rows, 40)).toBeCloseTo(10 / 40);
  });

  it("is 0 on a zero runtime rather than infinity", () => {
    expect(coverage([row({})], 0)).toBe(0);
  });

  it("is over the limit only past 60%", () => {
    expect(coverageOverLimit(0.6)).toBe(false);
    expect(coverageOverLimit(0.61)).toBe(true);
  });
});

describe("formatRange", () => {
  it("prints minutes, zero-padded seconds and tenths", () => {
    expect(formatRange(12.4, 18)).toBe("0:12.4 – 0:18.0");
    expect(formatRange(5, 65.25)).toBe("0:05.0 – 1:05.3");
  });

  it("rounds to tenths before splitting minutes, so 59.96 s is 1:00.0", () => {
    expect(formatRange(59.96, 125.04)).toBe("1:00.0 – 2:05.0");
  });
});

describe("rowWarning", () => {
  it("warns about a kept row under 2 s on the live cut", () => {
    expect(rowWarning(row({ startSec: 3, endSec: 4.5 }))).toBe("shorter than 2 s after your cuts");
  });

  it("warns about a kept row over 15 s", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 15.5, state: "drawn", draft: 1 }))).toBe("longer than 15 s");
  });

  it("says nothing for a row from 2 to 15 s, inclusive", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 2 }))).toBeNull();
    expect(rowWarning(row({ startSec: 0, endSec: 15 }))).toBeNull();
  });

  it("says nothing for a dropped or cut-away row: it is not on screen", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 1, state: "dropped" }))).toBeNull();
    expect(rowWarning(row({ startSec: null, endSec: null, state: "cut away" }))).toBeNull();
  });
});

describe("wordIndexAtSourceTime", () => {
  it("matches a start within 1 ms", () => {
    expect(wordIndexAtSourceTime(words, 3.0004)).toBe(3);
  });

  it("returns null for a time no word starts at, never the nearest word", () => {
    expect(wordIndexAtSourceTime(words, 3.01)).toBeNull();
    expect(wordIndexAtSourceTime(words, Number.NaN)).toBeNull();
  });
});

describe("selectionSpan", () => {
  it("maps a selection to its first and last transcript index", () => {
    expect(selectionSpan(words, [{ srcStart: 2 }, { srcStart: 3 }, { srcStart: 4 }])).toEqual({
      startWord: 2,
      endWord: 4,
    });
  });

  it("does not depend on the selection's order", () => {
    expect(selectionSpan(words, [{ srcStart: 7 }, { srcStart: 5 }])).toEqual({ startWord: 5, endWord: 7 });
  });

  it("returns null when any selected word cannot be matched, the middle one included", () => {
    expect(selectionSpan(words, [{ srcStart: 2 }, { srcStart: 2.5 }, { srcStart: 3 }])).toBeNull();
    expect(selectionSpan(words, [{ srcStart: 99 }])).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(selectionSpan(words, [])).toBeNull();
  });

  it("takes the last of two words sharing a start for the end of the span", () => {
    const twin = [
      { start: 0, end: 0.5 },
      { start: 1, end: 1 },
      { start: 1, end: 1.4 },
    ];
    expect(selectionSpan(twin, [{ srcStart: 0 }, { srcStart: 1 }])).toEqual({ startWord: 0, endWord: 2 });
  });
});

describe("spanPreview", () => {
  it("shows a short span whole", () => {
    expect(spanPreview(words, { startWord: 1, endWord: 3 })).toBe("w1 w2 w3");
  });

  it("shows the first and last three words of a long span", () => {
    expect(spanPreview(words, { startWord: 0, endWord: 9 })).toBe("w0 w1 w2 … w7 w8 w9");
  });
});

describe("planChangesSummary", () => {
  it("counts the limit changes", () => {
    const c = { index: 0, kind: "moved", reason: "r" };
    expect(planChangesSummary([])).toBe("No planner shot was changed by the limits.");
    expect(planChangesSummary([c])).toBe("1 planner shot was changed by the limits.");
    expect(planChangesSummary([c, c, c])).toBe("3 planner shots were changed by the limits.");
  });
});

describe("storyboardButtonState", () => {
  const sb = board([shot({ id: "s1", startWord: 0, endWord: 1 })]);

  it("shows the button when the project has a storyboard", () => {
    expect(storyboardButtonState(200, { storyboard: sb, drawn: {} })).toEqual({ kind: "shown" });
  });

  it("hides it when there is no storyboard file", () => {
    expect(storyboardButtonState(200, { storyboard: null, drawn: {} })).toEqual({ kind: "hidden" });
  });

  it("hides it with no project open (409) or a body it cannot read", () => {
    expect(storyboardButtonState(409, { error: "no workdir open" })).toEqual({ kind: "hidden" });
    expect(storyboardButtonState(200, null)).toEqual({ kind: "hidden" });
  });

  it("keeps it, marked, when storyboard.json is broken (500), with the server's message", () => {
    expect(storyboardButtonState(500, { error: "storyboard.json: shots.0.idea: too long" })).toEqual({
      kind: "error",
      message: "storyboard.json: shots.0.idea: too long",
    });
  });
});
