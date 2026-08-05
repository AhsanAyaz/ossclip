import { describe, expect, it } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";

const answers = (over: Partial<ProduceAnswers> = {}): ProduceAnswers => ({
  input: "./take.mp4",
  aspect: "9:16",
  cleanup: "standard",
  graphics: false,
  extras: {},
  ...over,
});

describe("produceArgv", () => {
  // The single most important property: a wizard run where every answer is
  // the default must teach `ossclip produce <file>` and nothing more. Emitting
  // --aspect 9:16 --cleanup standard would grow a command line the user then
  // copies forever.
  it("emits no flag for an answer that equals the default", () => {
    expect(produceArgv(answers())).toEqual(["produce", "./take.mp4"]);
  });

  it("emits the non-default shape and cleanup", () => {
    expect(produceArgv(answers({ aspect: "16:9", cleanup: "aggressive" }))).toEqual([
      "produce", "./take.mp4", "--aspect", "16:9", "--cleanup", "aggressive",
    ]);
  });

  it("pairs --intent with --produce", () => {
    expect(produceArgv(answers({ graphics: true, intent: "agents 101" }))).toEqual([
      "produce", "./take.mp4", "--produce", "--intent", "agents 101",
    ]);
  });

  // --intent without --produce is meaningless: the intent feeds the producer
  // brain, which only runs under --produce.
  it("drops an intent when graphics are off", () => {
    expect(produceArgv(answers({ graphics: false, intent: "orphaned" }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("emits --out only when given", () => {
    expect(produceArgv(answers({ out: "./short.mp4" }))).toEqual([
      "produce", "./take.mp4", "--out", "./short.mp4",
    ]);
  });

  it("emits every tier-2 extra that was set", () => {
    expect(
      produceArgv(
        answers({
          extras: {
            clip: 60,
            sourceFit: "contain",
            speaker: "Ahsan, host of Code with Ahsan",
            whisperModel: "medium.en",
            whisperLanguage: "ur",
            blooperMarker: "blooper",
            collapseRetakes: true,
            sourceIsEdited: true,
            llm: "claude-cli",
          },
        }),
      ),
    ).toEqual([
      "produce", "./take.mp4",
      "--clip", "60",
      "--source-fit", "contain",
      "--speaker", "Ahsan, host of Code with Ahsan",
      "--whisper-model", "medium.en",
      "--whisper-language", "ur",
      "--blooper-marker", "blooper",
      "--collapse-retakes",
      "--source-is-edited",
      "--llm", "claude-cli",
    ]);
  });

  // The wizard's language follow-up returns "" for "keep whisper's en
  // default" — that answer must not grow the taught command line (Urdu field
  // test 2026-08-05: only a typed code means anything).
  it("omits an empty --whisper-language rather than emitting a bare flag", () => {
    expect(
      produceArgv(answers({ extras: { whisperModel: "medium.en", whisperLanguage: "" } })),
    ).toEqual(["produce", "./take.mp4", "--whisper-model", "medium.en"]);
  });

  it("omits source-fit when it is the default cover", () => {
    expect(produceArgv(answers({ extras: { sourceFit: "cover" } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("omits a false --source-is-edited rather than emitting the flag", () => {
    expect(produceArgv(answers({ extras: { sourceIsEdited: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("omits a false --collapse-retakes rather than emitting the flag", () => {
    expect(produceArgv(answers({ extras: { collapseRetakes: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });
});
