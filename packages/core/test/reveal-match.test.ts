import { describe, expect, it } from "vitest";
import {
  entryTexts,
  locateSpoken,
  resolveItemWords,
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
    expect(revealItemTexts("TitleCard", { title: "x" })).toBeNull();
  });

  it("reads a BulletList's items as its reveal items (graphic-editor-modal §1)", () => {
    // One bullet row per item, so the item list IS the row list the render
    // staggers; the kicker title is not an item (it enters with the card).
    expect(revealItemTexts("BulletList", { items: ["A", "B"] })).toEqual(["A", "B"]);
    expect(revealItemTexts("BulletList", { title: "NEED", items: ["A", 7, "C"] })).toEqual(["A", "", "C"]);
    expect(revealItemTexts("BulletList", {})).toEqual([]);
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

describe("CardRow (§161, plan Task 4)", () => {
  it("one item per card: its text or its sub-line, as alternatives (TerminalMock's shape)", () => {
    expect(
      revealItemTexts("CardRow", { cards: [{ text: "Draft", sub: "one" }, { text: "Review" }] }),
    ).toEqual([["Draft", "one"], ["Review"]]);
  });

  it("an icon is never a text to match, and a malformed card keeps its position", () => {
    expect(revealItemTexts("CardRow", { cards: [{ text: "Bot", icon: "robot" }, 7, { text: "C" }] })).toEqual([
      ["Bot"],
      [""],
      ["C"],
    ]);
    expect(revealItemTexts("CardRow", {})).toEqual([]);
  });

  it("entry texts are every card's text and sub-line, empties skipped", () => {
    expect(
      entryTexts("CardRow", { cards: [{ text: "Draft", sub: "one" }, { text: "Review", icon: "doc" }] }),
    ).toEqual(["Draft", "one", "Review"]);
  });
});

describe("CtaCard (§161, plan Task 5)", () => {
  it("has no reveal items: it is one card", () => {
    expect(revealItemTexts("CtaCard", { action: "comment", text: "Want it?", keyword: "PROMPT" })).toBeNull();
  });

  it("enters on its headline or its keyword; the channel and the action are not texts to match", () => {
    expect(
      entryTexts("CtaCard", { action: "subscribe", text: "Subscribe for more", keyword: "AGENT", channel: "Ch" }),
    ).toEqual(["Subscribe for more", "AGENT"]);
    expect(entryTexts("CtaCard", { action: "link", text: "Grab it" })).toEqual(["Grab it"]);
  });
});

describe("BugCard (§161, plan Task 6)", () => {
  it("has no reveal items: it builds on its own timeline", () => {
    expect(revealItemTexts("BugCard", { number: 1, headline: "Captions drift", mockLines: ["a", "b"] })).toBeNull();
  });

  it("enters on its headline or its sub; the sticker and the mock's words are not texts to match", () => {
    expect(
      entryTexts("BugCard", {
        number: 2,
        headline: "Captions drift",
        sub: "out of sync",
        mock: "caption",
        mockLines: ["the", "raw", "tkae"],
        sticker: "FIXED",
      }),
    ).toEqual(["Captions drift", "out of sync"]);
    expect(entryTexts("BugCard", { number: 1, headline: "Only this", sub: "" })).toEqual(["Only this"]);
  });
});

describe("PhoneDemo (§161, plan Task 7)", () => {
  const props = {
    caption: [{ text: "Captions" }, { text: "that", emphasis: "none" }, { text: "pop", emphasis: "yellow" }],
    pills: [
      { text: "Big and bold", state: "ok" },
      { text: "Tiny grey text", state: "bad" },
    ],
  };

  it("one reveal item per pill, in order; the caption is not an item", () => {
    expect(revealItemTexts("PhoneDemo", props)).toEqual([["Big and bold"], ["Tiny grey text"]]);
    expect(revealItemTexts("PhoneDemo", { caption: props.caption })).toEqual([]);
    // A malformed pill keeps its place as "" rather than shifting the rest.
    expect(revealItemTexts("PhoneDemo", { caption: [], pills: [7, { text: "B" }] })).toEqual([[""], ["B"]]);
  });

  it("enters on the caption, joined as the phrase it is, or on any pill; enum values are never texts", () => {
    expect(entryTexts("PhoneDemo", props)).toEqual(["Captions that pop", "Big and bold", "Tiny grey text"]);
    expect(entryTexts("PhoneDemo", { caption: [{ text: "Solo" }] })).toEqual(["Solo"]);
  });
});

describe("resolveItemWords (graphic-editor-modal §3)", () => {
  // The EGM short's list (Overview), one word every 0.5 s of source.
  const SAID =
    "they hallucinate they forget the context and they review the code then they hallucinate again";
  const timed = (text: string) => text.split(" ").map((t, i) => ({ text: t, srcStart: i * 0.5 }));
  const WORDS = timed(SAID);
  const at = (i: number) => WORDS[i]!.srcStart;
  const whole = { srcStart: 0, srcEnd: WORDS.length * 0.5 };
  const allSpoken = () => true;
  const pin = (i: number, text = "") => ({ src: at(i), text });

  it("all-null pins give the same words as locateSpoken over the spoken window", () => {
    const texts = ["HALLUCINATE", "FORGET CONTEXT", "REVIEW CODE"];
    const { items, notes } = resolveItemWords(texts, WORDS, whole, allSpoken, [null, null, null]);
    expect(items).toEqual([
      { word: 1, state: "auto" },
      { word: 3, state: "auto" },
      { word: 8, state: "auto" },
    ]);
    expect(notes).toEqual([]);
    // With a cut word, the search runs over the SPOKEN window words only,
    // and the answer is in transcript indices.
    const spoken = (i: number) => i !== 1;
    const kept = WORDS.map((_, i) => i).filter(spoken);
    const direct = locateSpoken(texts, kept.map((i) => WORDS[i]!), {
      startWord: 0,
      endWord: kept.length - 1,
    }).map((j) => (j === null ? null : kept[j]!));
    expect(direct).toEqual([13, null, null]);
    const resolved = resolveItemWords(texts, WORDS, whole, spoken, [null, null, null]).items;
    expect(resolved.map((r) => r.word)).toEqual(direct);
    expect(resolved.map((r) => r.state)).toEqual(["auto", "unmatched", "unmatched"]);
  });

  it("row 5: a pin on a spoken word in order is pinned on that word", () => {
    const { items, notes } = resolveItemWords(["A", "B"], WORDS, whole, allSpoken, [pin(2), pin(10)]);
    expect(items).toEqual([
      { word: 2, state: "pinned" },
      { word: 10, state: "pinned" },
    ]);
    expect(notes).toEqual([]);
  });

  it("row 1: no transcript word within 0.05 s of the pin → auto, 'its word moved'", () => {
    // Word 3 is at 1.5 s; a pin stored at 1.6 s (a re-transcribe shifted it).
    const { items, notes } = resolveItemWords(
      ["HALLUCINATE", "FORGET"],
      WORDS,
      whole,
      allSpoken,
      [null, { src: 1.6, text: "FORGET" }],
    );
    // Turned auto, it is matched like any auto item.
    expect(items).toEqual([
      { word: 1, state: "auto" },
      { word: 3, state: "auto", note: "its word moved" },
    ]);
    expect(notes).toEqual(["item 2: its word moved"]);
  });

  it("row 1 tie-break: the nearer word wins; at equal distance, the earlier word", () => {
    const close = [
      { text: "one", srcStart: 1.0 },
      { text: "two", srcStart: 1.0625 },
    ];
    const window = { srcStart: 0, srcEnd: 2 };
    // Both within 0.05 s of 1.05; "two" is nearer (0.0125 vs 0.05).
    expect(resolveItemWords(["X"], close, window, allSpoken, [{ src: 1.05, text: "X" }]).items).toEqual([
      { word: 1, state: "pinned" },
    ]);
    // 1.03125 is exactly 0.03125 from each (binary-exact): the earlier wins.
    expect(resolveItemWords(["X"], close, window, allSpoken, [{ src: 1.03125, text: "X" }]).items).toEqual([
      { word: 0, state: "pinned" },
    ]);
  });

  it("row 1 tolerance: a word exactly 0.05 s off is found despite float rounding", () => {
    // 1.05 − 1.0 is 0.050000000000000044 in binary; "within 0.05 s" holds.
    const words = [{ text: "one", srcStart: 1.05 }];
    const window = { srcStart: 0, srcEnd: 2 };
    expect(resolveItemWords(["X"], words, window, allSpoken, [{ src: 1.0, text: "X" }]).items).toEqual([
      { word: 0, state: "pinned" },
    ]);
    // Clearly past it, the word moved.
    expect(resolveItemWords(["X"], words, window, allSpoken, [{ src: 0.99, text: "X" }]).notes).toEqual([
      "item 1: its word moved",
    ]);
  });

  it("row 2: a word outside the block window → auto, 'its word is outside this block'", () => {
    // The window holds words 0–9 (source starts in [0, 5)): word 10 "code"
    // at 5.0 s is outside — half-open, as an added entry's span.
    const window = { srcStart: 0, srcEnd: 5 };
    const { items, notes } = resolveItemWords(["FORGET", "REVIEW CODE"], WORDS, window, allSpoken, [
      null,
      pin(10),
    ]);
    // Auto, it searches only the window: "review" is there, "code" is not.
    expect(items).toEqual([
      { word: 3, state: "auto" },
      { word: null, state: "unmatched", note: "its word is outside this block" },
    ]);
    expect(notes).toEqual(["item 2: its word is outside this block"]);
  });

  it("row 3: a word not strictly after the previous bounding pin → auto, 'out of order'", () => {
    const { items, notes } = resolveItemWords(["A", "FORGET", "B", "C"], WORDS, whole, allSpoken, [
      pin(13),
      pin(3),
      pin(14),
      pin(14),
    ]);
    // Item 2 cannot sit before item 1's word, and as auto it can only search
    // after it — where "forget" is never said. An out-of-order pin is not a
    // bounding pin, so item 3 is checked against item 1, not item 2. Item 4
    // on item 3's own word is not STRICTLY after it.
    expect(items).toEqual([
      { word: 13, state: "pinned" },
      { word: null, state: "unmatched", note: "out of order" },
      { word: 14, state: "pinned" },
      { word: null, state: "unmatched", note: "out of order" },
    ]);
    expect(notes).toEqual(["item 2: out of order", "item 4: out of order"]);
  });

  it("row 4: a word not spoken on the live clock → cut, 'its word was cut'", () => {
    const spoken = (i: number) => i !== 3;
    const { items, notes } = resolveItemWords(
      ["HALLUCINATE", "FORGET", "REVIEW"],
      WORDS,
      whole,
      spoken,
      [null, pin(3), null],
    );
    expect(items).toEqual([
      { word: 1, state: "auto" },
      { word: null, state: "cut", note: "its word was cut" },
      { word: 8, state: "auto" },
    ]);
    // The log lines are prefixed with the 1-based item; the row note is not.
    expect(notes).toEqual(["item 2: its word was cut"]);
  });

  it("rows apply in the table's order; the first that applies wins", () => {
    const spoken = (i: number) => i !== 3;
    // Outside the window AND out of order: outside (row 2) wins.
    expect(
      resolveItemWords(["A", "B"], WORDS, { srcStart: 0, srcEnd: 5 }, allSpoken, [pin(8), pin(12)]).notes,
    ).toEqual(["item 2: its word is outside this block"]);
    // Out of order AND cut: out of order (row 3) wins, so it is auto, not cut.
    const r = resolveItemWords(["A", "B"], WORDS, whole, spoken, [pin(8), pin(3)]);
    expect(r.items[1]).toEqual({ word: null, state: "unmatched", note: "out of order" });
    expect(r.notes).toEqual(["item 2: out of order"]);
  });

  it("a cut pin bounds segments: an auto item after it cannot match before it", () => {
    // "forget" is said only at word 3, before the cut pin's word 10.
    const spoken = (i: number) => i !== 10;
    const { items } = resolveItemWords(["CODE", "FORGET"], WORDS, whole, spoken, [pin(10), null]);
    expect(items).toEqual([
      { word: null, state: "cut", note: "its word was cut" },
      { word: null, state: "unmatched" },
    ]);
    // The same item with no pin before it does match.
    expect(resolveItemWords(["FORGET"], WORDS, whole, spoken, [null]).items).toEqual([
      { word: 3, state: "auto" },
    ]);
  });

  it("auto items never cross a pinned word", () => {
    // "review" is said only at word 8, after item 2's pin on word 3: item 1
    // searches words 0–2 and stays unmatched rather than land past item 2.
    const { items } = resolveItemWords(["REVIEW", "FORGET"], WORDS, whole, allSpoken, [null, pin(3)]);
    expect(items).toEqual([
      { word: null, state: "unmatched" },
      { word: 3, state: "pinned" },
    ]);
  });

  it("no two items share a word", () => {
    // Auto before a pin: strictly before the pinned word.
    expect(
      resolveItemWords(["HALLUCINATE", "HALLUCINATE"], WORDS, whole, allSpoken, [null, pin(1)]).items,
    ).toEqual([
      { word: null, state: "unmatched" },
      { word: 1, state: "pinned" },
    ]);
    // Auto after a pin: strictly after it.
    expect(resolveItemWords(["CONTEXT", "CONTEXT"], WORDS, whole, allSpoken, [pin(5), null]).items).toEqual([
      { word: 5, state: "pinned" },
      { word: null, state: "unmatched" },
    ]);
    // Two auto items: locateSpoken's strict monotonicity within a segment.
    expect(resolveItemWords(["CONTEXT", "CONTEXT"], WORDS, whole, allSpoken, [null, null]).items).toEqual([
      { word: 5, state: "auto" },
      { word: null, state: "unmatched" },
    ]);
  });

  it("an item with no pin entry at all is auto", () => {
    expect(resolveItemWords(["FORGET", "REVIEW"], WORDS, whole, allSpoken, [pin(3)]).items).toEqual([
      { word: 3, state: "pinned" },
      { word: 8, state: "auto" },
    ]);
  });
});
