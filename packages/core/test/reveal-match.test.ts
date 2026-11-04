import { describe, expect, it } from "vitest";
import {
  entryTexts,
  locateSpoken,
  revealItemTexts,
  SYNC_MIN_SHARE,
  syncDecision,
} from "../src/reveal-match";

const wordsOf = (s: string) => s.split(" ").map((text) => ({ text }));

// The field take's scene-16 window (26-11-04 16-14-25 3337): a FlowDiagram
// "NEW IDEA → FRAMEWORK → BLOCKED" over speech that only ever says one of
// its three chips (spec §1).
const FIELD = wordsOf(
  "the way I was able to do this was to build a framework myself which stops me " +
    "from creating more projects or even if I'm having some amazing ideas",
);
const all = { startWord: 0, endWord: FIELD.length - 1 };
const idx = (w: string) => FIELD.findIndex((x) => x.text === w);

describe("locateSpoken (spec §1)", () => {
  it("matches only the chip actually said; one of three is paced", () => {
    const m = locateSpoken(["NEW IDEA", "FRAMEWORK", "BLOCKED"], FIELD, all);
    // "new" is never said, and "stops" is not "blocked": both stay null
    // rather than guessing a nearby word (the confident-wrong anti-goal).
    expect(m).toEqual([null, idx("framework"), null]);
    expect(syncDecision(m)).toBe("paced");
  });

  it("matches both chips in speech order, plural-insensitive, and syncs", () => {
    const m = locateSpoken(["FRAMEWORK", "IDEAS"], FIELD, all);
    expect(m).toEqual([idx("framework"), idx("ideas")]);
    expect(m[1]!).toBeGreaterThan(m[0]!);
    expect(syncDecision(m)).toBe("synced");
  });

  it("collapses -ed / -ing / plural on both sides", () => {
    // "creating" is said; the chip says "CREATED". "projects" is said; the
    // chip says "PROJECT".
    expect(locateSpoken(["CREATED PROJECT"], FIELD, all)).toEqual([idx("creating")]);
  });

  it("gives a repeated word's second chip the LATER occurrence", () => {
    const words = wordsOf("AI writes code then AI reviews code");
    const m = locateSpoken(["AI WRITES", "AI REVIEWS"], words, {
      startWord: 0,
      endWord: words.length - 1,
    });
    expect(m).toEqual([0, 4]);
  });

  it("gives an identical repeated label the later occurrence, never the same word", () => {
    const words = wordsOf("we write code and then we ship code");
    const m = locateSpoken(["CODE", "CODE"], words, { startWord: 0, endWord: words.length - 1 });
    expect(m).toEqual([2, 7]);
    // Only one "code" in the window: the second chip is unmatched, not
    // stacked on the first.
    expect(locateSpoken(["CODE", "CODE"], words, { startWord: 0, endWord: 6 })).toEqual([2, null]);
  });

  it("matches an alternatives item where ANY alternative is first said", () => {
    // A TerminalMock window: its title is never said, its second line is.
    const m = locateSpoken([["DEPLOY-BOT", "npm start", "amazing ideas"], ["FRAMEWORK"]], FIELD, all);
    expect(m).toEqual([idx("amazing"), null]);
    expect(locateSpoken([["IDEAS", "FRAMEWORK"]], FIELD, all)).toEqual([idx("framework")]);
  });

  it("never matches a stop word or a lone token under 3 letters", () => {
    const words = wordsOf("it is the thing and AI is it");
    const w = { startWord: 0, endWord: words.length - 1 };
    expect(locateSpoken(["IT", "THE"], words, w)).toEqual([null, null]);
    expect(locateSpoken(["AI"], words, w)).toEqual([null]);
    expect(locateSpoken(["", "!!"], words, w)).toEqual([null, null]);
  });

  it("is confined to the window: a match outside it is null", () => {
    // "framework" is at 12; a window ending before it must not reach it, and
    // one starting after it must not either.
    expect(locateSpoken(["FRAMEWORK"], FIELD, { startWord: 0, endWord: 11 })).toEqual([null]);
    expect(locateSpoken(["FRAMEWORK"], FIELD, { startWord: 13, endWord: all.endWord })).toEqual([
      null,
    ]);
    // endWord is inclusive, the SceneAnchor convention.
    expect(locateSpoken(["FRAMEWORK"], FIELD, { startWord: 12, endWord: 12 })).toEqual([12]);
  });

  it("treats an out-of-order hit as no match (monotonic)", () => {
    expect(locateSpoken(["IDEAS", "FRAMEWORK"], FIELD, all)).toEqual([idx("ideas"), null]);
  });

  it("requires multi-word items within a span of tokens + 2", () => {
    // "build ... framework": build(10) a(11) framework(12) — a span of 3 for 2
    // tokens is inside the +2 allowance.
    expect(locateSpoken(["BUILD FRAMEWORK"], FIELD, all)).toEqual([idx("build")]);
    // "build ... projects": 10 → 20, far outside the span.
    expect(locateSpoken(["BUILD PROJECTS"], FIELD, all)).toEqual([null]);
  });

  it("strips punctuation on the transcript side", () => {
    const words = wordsOf("so I built a Framework, honestly.");
    expect(locateSpoken(["FRAMEWORK"], words, { startWord: 0, endWord: 5 })).toEqual([4]);
  });
});

describe("syncDecision (spec §1)", () => {
  it("needs the first item and at least two thirds matched", () => {
    expect(SYNC_MIN_SHARE).toBeCloseTo(2 / 3);
    expect(syncDecision([1, 2, null])).toBe("synced");
    expect(syncDecision([null, 2, 3])).toBe("paced");
    expect(syncDecision([1, null, null])).toBe("paced");
    expect(syncDecision([1, 2, 3, null])).toBe("synced");
    expect(syncDecision([1, 2, null, null])).toBe("paced");
    expect(syncDecision([])).toBe("paced");
  });
});

describe("revealItemTexts", () => {
  it("reads each staggered component's items", () => {
    expect(revealItemTexts("FlowDiagram", { nodes: ["A", "B"] })).toEqual(["A", "B"]);
    expect(
      revealItemTexts("ChatMock", {
        messages: [
          { from: "user", text: "hi" },
          { from: "agent", text: "hello" },
        ],
      }),
    ).toEqual(["hi", "hello"]);
    // A window is ONE item matching on its title or any line (spec §1).
    expect(
      revealItemTexts("TerminalMock", {
        windows: [{ title: "PROJECT-A", lines: ["npm start", "npm test"] }],
      }),
    ).toEqual([["PROJECT-A", "npm start", "npm test"]]);
    expect(
      revealItemTexts("StrikethroughReveal", { lines: [{ text: "X", struck: true }, { text: "Y" }] }),
    ).toEqual(["X", "Y"]);
  });

  it("is the keyword's one bubble when a ChatMock keyword is set", () => {
    // The render collapses to that single bubble (FINDINGS §28b, scenes'
    // chatBubbles), so the messages are not items at all.
    expect(
      revealItemTexts("ChatMock", { messages: [{ from: "user", text: "hi" }], keyword: "slot" }),
    ).toEqual(["slot"]);
    expect(
      revealItemTexts("ChatMock", { messages: [{ from: "user", text: "hi" }], keyword: "" }),
    ).toEqual(["hi"]);
  });

  it("is null for every non-staggered component", () => {
    expect(revealItemTexts("StatCard", { label: "CHURN", value: "861%" })).toBeNull();
    expect(revealItemTexts("BulletList", { items: ["a", "b"] })).toBeNull();
    expect(revealItemTexts("TitleCard", { title: "x" })).toBeNull();
  });

  it("keeps item positions when an entry is malformed", () => {
    // Index i of the result must be rendered item i — a dropped entry would
    // shift every later item's timing onto its neighbour.
    expect(revealItemTexts("FlowDiagram", { nodes: ["A", 7, "C"] })).toEqual(["A", "", "C"]);
    expect(revealItemTexts("FlowDiagram", {})).toEqual([]);
  });
});

describe("entryTexts", () => {
  it("uses item texts for the staggered four, flattening alternatives", () => {
    expect(entryTexts("FlowDiagram", { nodes: ["A", "B"] })).toEqual(["A", "B"]);
    expect(entryTexts("ChatMock", { messages: [{ from: "user", text: "hi" }], keyword: "slot" })).toEqual(
      ["slot"],
    );
    expect(entryTexts("ChatMock", { messages: [{ from: "user", text: "hi" }] })).toEqual(["hi"]);
    expect(entryTexts("TerminalMock", { windows: [{ title: "", lines: ["npm start"] }] })).toEqual([
      "npm start",
    ]);
  });

  it("uses the single-text fields of the others, skipping missing ones", () => {
    expect(entryTexts("TitleCard", { title: "T", emphasis: "861%" })).toEqual(["T", "861%"]);
    expect(entryTexts("TitleCard", { title: "T" })).toEqual(["T"]);
    expect(entryTexts("ScreenshotFrame", {})).toEqual([]);
    expect(entryTexts("ScreenshotFrame", { label: "SKILLS" })).toEqual(["SKILLS"]);
    expect(entryTexts("StatCard", { label: "CHURN", value: "861%" })).toEqual(["CHURN", "861%"]);
    expect(entryTexts("RuleCard", { kicker: "RULE", text: "ship it" })).toEqual(["RULE", "ship it"]);
    expect(entryTexts("BulletList", { title: "NEED", items: ["a", "b"] })).toEqual(["a", "b"]);
  });
});
