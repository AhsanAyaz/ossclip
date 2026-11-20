import { describe, expect, it } from "vitest";
import {
  findScriptRetakes,
  formatScriptRetake,
  scriptRetakeExcluded,
  scriptUnits,
  type ScriptRetake,
} from "../src/script/retakes";
import type { BloopSpan } from "../src/blooper";
import type { RetakeGroup } from "../src/retake";
import type { ScriptCue } from "../src/script/cues";
import type { Span, Transcript } from "../src/schema";

/**
 * §166 (design: docs/designs/script-guided-retakes.md). A script sentence
 * said twice in a row is two takes of it, however reworded; the earlier take
 * is cut. Every limit below is pinned on both sides where the design names it.
 */

/** A transcript from words, at 0.5s per word (blooper.test.ts's helper). */
const speak = (text: string): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 })),
});

let nextIndex = 0;
const cue = (spoken: string[]): ScriptCue => {
  const index = nextIndex++;
  return { id: `cue-${index}-test`, index, cueText: `cue ${index}`, hint: { kind: "none" }, spoken, line: index + 1 };
};

const words = (t: Transcript, a: number, b: number): string =>
  t.words
    .slice(a, b + 1)
    .map((w) => w.text)
    .join(" ");
const cutText = (t: Transcript, r: ScriptRetake): string => words(t, r.cut.startWord, r.cut.endWord);
const keptText = (t: Transcript, r: ScriptRetake): string => words(t, r.kept.startWord, r.kept.endWord);

const NONE = new Set<number>();
const ELEPHANT = "The elephant never forgets.";
/** The EGM shape (§165): a reworded take, an unscripted tail, then the clean take. */
const EGM =
  "Intro line here. The elephant in this case never forgets. It always has the design in memory. " +
  "The elephant never forgets. It always holds the context. Outro.";

/** A 10-token unit, so 6 and 7 matched tokens are exactly 0.6 and 0.7. */
const TEN = "Open the terminal and then type the install command now.";

describe("scriptUnits", () => {
  it("scriptUnits splits spoken lines at sentence ends and drops units under 4 tokens", () => {
    const units = scriptUnits([cue(["Three steps. The elephant never forgets. It works in every tool."])]);
    expect(units.map((u) => u.text)).toEqual(["The elephant never forgets.", "It works in every tool."]);
    expect(units[0]!.tokens).toEqual(["the", "elephant", "never", "forgets"]);
    // The other side of the limit: "The elephant never forgets." is exactly 4.
    expect(scriptUnits([cue(["Go there now."])])).toEqual([]);
  });

  it("scriptUnits drops twins in both directions", () => {
    // "One flag for the theme." vs "One flag for the AI.": 4 of 5 in order
    // each way, so each would register as an occurrence of the other.
    const units = scriptUnits([cue(["One flag for the theme. One flag for the AI. The elephant never forgets."])]);
    expect(units.map((u) => u.text)).toEqual([ELEPHANT]);
  });

  it("drops a short unit's twin when only the short side scores 0.6", () => {
    // 4 of 4 of the short unit appear in the long one, 4 of 9 the other way:
    // "either direction" means the short side alone is enough.
    const units = scriptUnits([
      cue(["Open the terminal now. Then open the big terminal window right now please."]),
    ]);
    expect(units).toEqual([]);
  });
});

describe("findScriptRetakes", () => {
  it("cuts a reworded earlier take and its unscripted tail", () => {
    const t = speak(EGM);
    const r = findScriptRetakes([cue([ELEPHANT])], t, [], NONE);
    expect(r).toHaveLength(1);
    expect(cutText(t, r[0]!)).toBe("The elephant in this case never forgets. It always has the design in memory.");
    expect(keptText(t, r[0]!)).toBe("The elephant never forgets.");
    expect(r[0]!.unit).toBe(ELEPHANT);
    expect(r[0]!.cut.startSec).toBe(t.words[r[0]!.cut.startWord]!.start);
    expect(r[0]!.cut.endSec).toBe(t.words[r[0]!.cut.endWord]!.end);
  });

  it("two adjacent takes are two occurrences, not one long window", () => {
    const unit = [cue(["So first of all I went into a terminal and typed the command."])];
    const t = speak(
      "So first off I went into the terminal and typed. So first of all I went into a terminal and typed the command. Done.",
    );
    const r = findScriptRetakes(unit, t, [], NONE);
    expect(r).toHaveLength(1);
    expect(cutText(t, r[0]!)).toBe("So first off I went into the terminal and typed.");
    expect(r[0]!.wordsBetween).toBe(0);

    // The shape that pins the order: the later take drops its "So" (12/13),
    // so the window from the first take's "So" to "command." holds all 13
    // tokens, starts and ends on a match, and outscores both takes. Ordered
    // by score it is taken first and hides the pair; density first keeps
    // them apart (design §3).
    const spanning = speak(
      "So first off I went into the terminal and typed. First of all I went into a terminal and typed the command. Done.",
    );
    const s = findScriptRetakes(unit, spanning, [], NONE);
    expect(s).toHaveLength(1);
    expect(cutText(spanning, s[0]!)).toBe("So first off I went into the terminal and typed.");
    expect(keptText(spanning, s[0]!)).toBe("First of all I went into a terminal and typed the command.");
  });

  it("a later take that scores lower than the earlier one is not kept", () => {
    // Full take (10/10) then a restart that trails off (7/10 = 0.7).
    const t = speak(`Hello there. ${TEN} Open the terminal and type the command. Bye.`);
    expect(findScriptRetakes([cue([TEN])], t, [], NONE)).toEqual([]);
  });

  it("kept take under 0.7 → no retake", () => {
    // Earlier 6/10, later 6/10: B ≥ A holds, only the 0.7 floor stops it.
    const t = speak("Hello there. Open the terminal and type the thing. Open the terminal and type the stuff. Bye.");
    expect(findScriptRetakes([cue([TEN])], t, [], NONE)).toEqual([]);
  });

  it("at 0.7 → retake", () => {
    const t = speak("Hello there. Open the terminal and type the thing. Open the terminal and type the command. Bye.");
    const r = findScriptRetakes([cue([TEN])], t, [], NONE);
    expect(r).toHaveLength(1);
    expect(cutText(t, r[0]!)).toBe("Open the terminal and type the thing.");
    expect(keptText(t, r[0]!)).toBe("Open the terminal and type the command.");
  });

  it("26 candidate words between takes → no retake; 25 → retake", () => {
    const filler = (k: number): string => `${"blah ".repeat(k - 1)}blah.`;
    const shape = (k: number): Transcript =>
      speak(`Intro line here. The elephant in this case never forgets. ${filler(k)} ${ELEPHANT} Outro.`);
    expect(findScriptRetakes([cue([ELEPHANT])], shape(26), [], NONE)).toEqual([]);
    const t = shape(25);
    const r = findScriptRetakes([cue([ELEPHANT])], t, [], NONE);
    expect(r).toHaveLength(1);
    expect(r[0]!.wordsBetween).toBe(25);
  });

  it("a different unit said once between the takes blocks the cut", () => {
    // "It always has the design in memory." is a unit here, said once: G3.
    const cues = [cue([ELEPHANT]), cue(["It always has the design in memory."])];
    expect(findScriptRetakes(cues, speak(EGM), [], NONE)).toEqual([]);
  });

  it("the same shape with that unit said again after the later take cuts", () => {
    const cues = [cue([ELEPHANT]), cue(["It always has the design in memory."])];
    const t = speak(
      "Intro line here. The elephant in this case never forgets. It always has the design in memory. " +
        "The elephant never forgets. It always has the design in memory. Outro.",
    );
    const r = findScriptRetakes(cues, t, [], NONE);
    expect(r).toHaveLength(1);
    expect(r[0]!.unit).toBe(ELEPHANT);
    expect(cutText(t, r[0]!)).toBe("The elephant in this case never forgets. It always has the design in memory.");
  });

  it("a match with one content token is not an occurrence", () => {
    // "so i was the garden": 5 of 7 (0.71), but only "garden" has 4+ letters.
    const unit = "So I was in the garden today.";
    const one = speak("Hello. So I was at the garden. Then something else. So I was at the garden. Bye.");
    expect(findScriptRetakes([cue([unit])], one, [], NONE)).toEqual([]);
    // The other side of the limit: "garden" and "today" make two.
    const two = speak("Hello. So I was at the garden today. Then something else. So I was at the garden today. Bye.");
    const r = findScriptRetakes([cue([unit])], two, [], NONE);
    expect(r).toHaveLength(1);
    expect(cutText(two, r[0]!)).toBe("So I was at the garden today. Then something else.");
  });

  it("excluded words are not candidates", () => {
    const t = speak(EGM);
    // Words 3..9 are the earlier take: what a marker or §128 already decided.
    const excluded = new Set([3, 4, 5, 6, 7, 8, 9]);
    expect(findScriptRetakes([cue([ELEPHANT])], t, [], excluded)).toEqual([]);
  });

  it("an occurrence with half its words inside silence is dropped", () => {
    const t = speak(EGM);
    // The later take is words 17..20. A silence over a word's midpoint puts
    // that word in dead air.
    const over = (from: number, to: number): Span[] => [
      { start: t.words[from]!.start, end: t.words[to]!.end },
    ];
    expect(findScriptRetakes([cue([ELEPHANT])], t, over(17, 18), NONE)).toEqual([]);
    expect(findScriptRetakes([cue([ELEPHANT])], t, over(17, 17), NONE)).toHaveLength(1);
  });

  // The EGM field shape (FINDINGS §166): "The elephant [7 s pause] in this
  // case never forgets." 75% of the take's SPAN is silence, and a span
  // measure dropped it; its words are speech.
  it("a long pause inside a real take does not make it dead air", () => {
    const t = speak(EGM);
    // Take one is words 3..9. Stretch a pause between words 4 and 5 by
    // moving every later word 20 s on.
    const words = t.words.map((w, i) => (i >= 5 ? { ...w, start: w.start + 20, end: w.end + 20 } : w));
    const paused = { ...t, words };
    const pause: Span[] = [{ start: words[4]!.end, end: words[5]!.start }];
    expect(findScriptRetakes([cue([ELEPHANT])], paused, pause, NONE)).toHaveLength(1);
  });

  it("three takes in a row cut the first two", () => {
    const t = speak(
      "Hi there. The elephant really never forgets. The elephant never really forgets. The elephant never forgets. Bye.",
    );
    const r = findScriptRetakes([cue([ELEPHANT])], t, [], NONE);
    expect(r.map((x) => cutText(t, x))).toEqual([
      "The elephant really never forgets.",
      "The elephant never really forgets.",
    ]);
    expect(keptText(t, r[1]!)).toBe(ELEPHANT);
  });

  it("snaps a boundary back at most 3 words", () => {
    const tail = "It always has the design in memory. The elephant never forgets. Outro.";
    const near = speak(`Intro line here. Now, the elephant in this case never forgets. ${tail}`);
    const [a] = findScriptRetakes([cue([ELEPHANT])], near, [], NONE);
    expect(cutText(near, a!)).toBe(`Now, the elephant in this case never forgets. It always has the design in memory.`);

    const far = speak(`Intro line here. And so then now the elephant in this case never forgets. ${tail}`);
    const [b] = findScriptRetakes([cue([ELEPHANT])], far, [], NONE);
    expect(cutText(far, b!)).toBe(`the elephant in this case never forgets. It always has the design in memory.`);

    // The end bound moves the same way: a later take opening "And the
    // elephant…" keeps its "And" (design §5).
    const kept = speak("Intro line here. The elephant in this case never forgets. And the elephant never forgets. Outro.");
    const [c] = findScriptRetakes([cue([ELEPHANT])], kept, [], NONE);
    expect(cutText(kept, c!)).toBe("The elephant in this case never forgets.");
    expect(keptText(kept, c!)).toBe("the elephant never forgets.");
  });

  it("no units → no retakes, no throw", () => {
    const t = speak(EGM);
    expect(findScriptRetakes([cue(["Hi there. Yes. Go now."])], t, [], NONE)).toEqual([]);
    expect(findScriptRetakes([], t, [], NONE)).toEqual([]);
    // Only twins: each would match the other's take, so neither is used.
    const twins = speak("One flag for the theme. One flag for the AI. One flag for the theme. Bye.");
    expect(findScriptRetakes([cue(["One flag for the theme. One flag for the AI."])], twins, [], NONE)).toEqual([]);
  });
});

describe("scriptRetakeExcluded", () => {
  it("scriptRetakeExcluded collects bloop span words and every retake group member", () => {
    const bloop: BloopSpan = { startWord: 2, endWord: 4, startSec: 1, endSec: 2.4, markers: 1, marker: "blooper", matched: [] };
    const inst = (a: number, b: number) => ({ startWord: a, endWord: b, startSec: a * 0.5, endSec: b * 0.5 + 0.4 });
    const decided: RetakeGroup = {
      kept: inst(10, 11),
      cuts: [{ ...inst(7, 8), similarity: 0.9 }],
      hallucinated: [{ ...inst(13, 13), silenceFrac: 0.8 }],
      undecided: [{ ...inst(15, 16), silenceFrac: 0, similarity: 0.7 }],
    };
    const reportOnly: RetakeGroup = {
      kept: null,
      cuts: [],
      hallucinated: [],
      undecided: [{ ...inst(20, 21), silenceFrac: 0.4 }],
    };
    const got = [...scriptRetakeExcluded([bloop], [decided, reportOnly])].sort((a, b) => a - b);
    expect(got).toEqual([2, 3, 4, 7, 8, 10, 11, 13, 15, 16, 20, 21]);
  });
});

describe("formatScriptRetake", () => {
  it("formatScriptRetake", () => {
    const t = speak(EGM);
    const [r] = findScriptRetakes([cue([ELEPHANT])], t, [], NONE);
    expect(formatScriptRetake(t, r!)).toBe(
      'kept: "The elephant never forgets."\n' +
        '  cut (said again 7 words later; script: "The elephant never forgets."): "The elephant in this case never forgets. It always has the design in memory."',
    );
  });
});
