import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBloopSpans } from "../src/blooper";
import { findRetakeGroups } from "../src/retake";
import type { Analysis, Span, Transcript, Word } from "../src/schema";
import { parseScript } from "../src/script/cues";
import { findScriptRetakes, scriptRetakeExcluded, type ScriptRetake } from "../src/script/retakes";

/**
 * FINDINGS §166. The recording the limits of script/retakes.ts were chosen
 * on: the raw transcript and measured silences of the EGM take (798 s, the
 * marker said 31 times), re-transcribed 2026-11-19. A retune for another
 * recording must keep these cuts, or say here why one changed.
 */
const FIXTURES = join(__dirname, "fixtures");
const recorded = JSON.parse(readFileSync(join(FIXTURES, "egm-retakes.json"), "utf8")) as {
  language: string;
  words: Word[];
  silences: Span[];
};
const transcript: Transcript = { language: recorded.language, words: recorded.words };
const analysis: Analysis = { silences: recorded.silences, fillers: [], gaps: [], cuttable: [], breaths: [] };

const run = (scriptFile: string): ScriptRetake[] => {
  const cues = parseScript(readFileSync(join(FIXTURES, scriptFile), "utf8"));
  const bloops = findBloopSpans(transcript, "blooper", recorded.silences);
  const groups = findRetakeGroups(transcript, analysis, { transparentMarker: "blooper" });
  return findScriptRetakes(cues, transcript, recorded.silences, scriptRetakeExcluded(bloops, groups));
};
const said = (from: number, to: number): string =>
  transcript.words
    .slice(from, to + 1)
    .map((w) => w.text)
    .join(" ");
const cutText = (r: ScriptRetake): string => said(r.cut.startWord, r.cut.endWord);

describe("script retakes on the recorded EGM transcript", () => {
  it("the cue script cuts the two reworded takes no other rule caught, and nothing else", () => {
    expect(run("egm-patterns.script.md").map(cutText)).toEqual([
      "The elephant in this case never forgets. It always has the design and context in its memory.",
      "So first off, I went into the terminal and typed EGM.",
    ]);
  });

  it("keeps the later take of each", () => {
    const [elephant, firstOff] = run("egm-patterns.script.md");
    expect(said(elephant!.kept.startWord, elephant!.kept.endWord)).toBe("The elephant never forgets.");
    expect(said(firstOff!.kept.startWord, firstOff!.kept.endWord)).toBe(
      "So first of all I went into a terminal",
    );
  });

  it("the full script has no 'So first of all' sentence, so it cuts the elephant take only", () => {
    expect(run("egm-script.md").map(cutText)).toEqual([
      "The elephant in this case never forgets. It always has the design and context in its memory.",
    ]);
  });
});
