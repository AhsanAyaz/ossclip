import { describe, expect, it } from "vitest";
import { alignCues } from "../src/script/align";
import type { ScriptCue, ScriptCueHint } from "../src/script/cues";
import type { Transcript } from "../src/schema";

/** One word per space-separated token, 0.3 s each. Indices in the comments
 * below are positions in this list. */
const t = (text: string): Transcript => ({
  language: "en",
  words: text.split(" ").map((w, i) => ({ text: w, start: i * 0.3, end: (i + 1) * 0.3 })),
});

let nextIndex = 0;
const cue = (spoken: string[], hint: ScriptCueHint = { kind: "none" }): ScriptCue => {
  const index = nextIndex++;
  return { id: `cue-${index}-test`, index, cueText: `cue ${index}`, hint, spoken, line: index + 1 };
};

/** What a test asserts about a placed cue: which words, and how well. */
const placed = (r: ReturnType<typeof alignCues>) =>
  r.aligned.map((a) => ({ startWord: a.startWord, endWord: a.endWord, score: Number(a.score.toFixed(2)) }));

describe("alignCues", () => {
  it("aligns a verbatim line", () => {
    // so0 here's1 how2 most3 of4 us5 build6 with7 ai8 today9; n = 8.
    // The window from 0 (earliest start) reaches all 8 tokens at 0..8; the
    // first matched word is here's1, not the unmatched "so".
    const r = alignCues([cue(["Here's how most of us build with AI."])], t("so here's how most of us build with ai today"));
    expect(placed(r)).toEqual([{ startWord: 1, endWord: 8, score: 1 }]);
    expect(r.skipped).toEqual([]);
  });

  it("aligns a paraphrase above the floor", () => {
    // Inserted words cost nothing: big0 prompt1 and2 a3 big4 pile5 of6 code7
    // holds all 6 script tokens in order within the 12-word span limit.
    const said = alignCues([cue(["Big prompt. Big pile of code."])], t("big prompt and a big pile of code"));
    expect(placed(said)).toEqual([{ startWord: 0, endWord: 7, score: 1 }]);
    // A swapped word costs one token: big0 prompt1 and2 then3 a4 huge5 pile6
    // of7 code8 has "big prompt pile of code" in order, 5 of 6.
    const reworded = alignCues([cue(["Big prompt. Big pile of code."])], t("big prompt and then a huge pile of code"));
    expect(placed(reworded)).toEqual([{ startWord: 0, endWord: 8, score: 0.83 }]);
  });

  it("skips a cue below 0.6 and reports its best score", () => {
    // the0 elephant1 never2 forgets3 anything4 at5 all6 vs "the goldfish
    // remember nothing at all": only the, at, all line up — 3 of 6.
    const c = cue(["The goldfish remember nothing at all."]);
    const r = alignCues([c], t("the elephant never forgets anything at all"));
    expect(r.aligned).toEqual([]);
    expect(r.skipped).toEqual([{ cue: c, reason: "below-floor", score: 0.5 }]);
  });

  it("two cues with the same text take consecutive spans, never the same words", () => {
    // and0 they1 were2 right3 so4 and5 they6 were7 right8. The first cue takes
    // the earliest full match 0..3; the second searches from 4 and its window
    // from "so" holds all 4 tokens, first matched at and5.
    const r = alignCues(
      [cue(["And they were right."]), cue(["And they were right."])],
      t("and they were right so and they were right"),
    );
    expect(placed(r)).toEqual([
      { startWord: 0, endWord: 3, score: 1 },
      { startWord: 5, endWord: 8, score: 1 },
    ]);
  });

  it("a line said only inside cut words does not match there", () => {
    // they0 only1 see2 the3 design4 doc5 sorry6 | they7 see8 the9 design10
    // doc11. The blooper 0..6 is the verbatim take but it is cut; the kept
    // take dropped "only", so it scores 5 of 6 — and still wins, because the
    // cut take is not a candidate at all.
    const cut = new Set([0, 1, 2, 3, 4, 5, 6]);
    const r = alignCues(
      [cue(["They only see the design doc."])],
      t("they only see the design doc sorry they see the design doc"),
      cut,
    );
    expect(placed(r)).toEqual([{ startWord: 7, endWord: 11, score: 0.83 }]);
  });

  it("cues cannot cross: a later cue never matches before an earlier one", () => {
    // big0 prompt1 then2 a3 pile4 of5 code6. The script has "pile of code"
    // first, so it takes 4..6, and "big prompt" may only search from 7 —
    // nothing is left, best score 0.
    const second = cue(["Big prompt."]);
    const r = alignCues([cue(["Pile of code."]), second], t("big prompt then a pile of code"));
    expect(placed(r)).toEqual([{ startWord: 4, endWord: 6, score: 1 }]);
    expect(r.skipped).toEqual([{ cue: second, reason: "below-floor", score: 0 }]);
  });

  it("a skipped cue does not block the next cue from matching earlier words", () => {
    // here's0 how1 most2 of3 us4 build5. "us build bridges over rivers"
    // finds us4 build5 — 2 of 5, skipped. Had that moved the search past
    // build5, the next cue would find nothing; it must still get 0..5.
    const first = cue(["Us build bridges over rivers."]);
    const r = alignCues([first, cue(["Here's how most of us build."])], t("here's how most of us build"));
    expect(r.skipped).toEqual([{ cue: first, reason: "below-floor", score: 0.4 }]);
    expect(placed(r)).toEqual([{ startWord: 0, endWord: 5, score: 1 }]);
  });

  it("screen hints and cues with no spoken lines are skipped with their reason", () => {
    // Neither is searched, so neither consumes words: the plain cue after
    // them still gets hello0 world1.
    const screen = cue(["Hello world."], { kind: "screen" });
    const silent = cue([]);
    // Spoken, but nothing in it survives normalisation: no tokens to score.
    const punctuation = cue(["→ …"]);
    const r = alignCues([screen, silent, punctuation, cue(["Hello world."])], t("hello world"));
    expect(r.skipped).toEqual([
      { cue: screen, reason: "screen" },
      { cue: silent, reason: "no-spoken-lines" },
      { cue: punctuation, reason: "no-spoken-lines" },
    ]);
    expect(placed(r)).toEqual([{ startWord: 0, endWord: 1, score: 1 }]);
  });

  it("returns indices into the full transcript when cut words sit before the match", () => {
    // so0 um1 uh2 three3 steps4 um5 brainstorm6 draft7 review8, cut {1,2,5}.
    // Kept candidates are so0 three3 steps4 brainstorm6 draft7 review8 (list
    // positions 0..5); the match is three..review, which is 3..8 in the
    // transcript and would be 1..5 if kept-list positions leaked out.
    const r = alignCues(
      [cue(["Three steps. Brainstorm. Draft. Review."])],
      t("so um uh three steps um brainstorm draft review"),
      new Set([1, 2, 5]),
    );
    expect(placed(r)).toEqual([{ startWord: 3, endWord: 8, score: 1 }]);
  });
});
