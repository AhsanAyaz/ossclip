import { describe, expect, it } from "vitest";
import { parseWhisperJson, parseWhisperOutput, whisperArgs, type WhisperJson } from "../src/transcribe";

/** Trimmed sample of real whisper.cpp `-oj -ml 1` output structure. */
const sample: WhisperJson = {
  result: { language: "en" },
  transcription: [
    { offsets: { from: 0, to: 320 }, text: " Hello" },
    { offsets: { from: 320, to: 700 }, text: " everyone" },
    { offsets: { from: 700, to: 760 }, text: "," },
    { offsets: { from: 900, to: 1200 }, text: " it" },
    { offsets: { from: 1200, to: 1450 }, text: "'s" },
    { offsets: { from: 1500, to: 1800 }, text: " work" },
    { offsets: { from: 1800, to: 2050 }, text: "ing" },
    { offsets: { from: 2100, to: 2400 }, text: " [BLANK_AUDIO]" },
    { offsets: { from: 2500, to: 2600 }, text: "   " },
    { offsets: { from: 2700, to: 3000 }, text: " done" },
  ],
};

describe("whisperArgs", () => {
  const opts = { whisperPath: "/bin/whisper-cli", modelPath: "/m/ggml-small.en.bin", outBase: "/w/whisper" };

  // Byte-identical to what every English-suffixed model always got: the
  // language flag must never perturb the default invocation.
  it("passes no -l when language is unset", () => {
    expect(whisperArgs(opts, "/w/audio.wav")).toEqual([
      "-m", "/m/ggml-small.en.bin",
      "-f", "/w/audio.wav",
      "-oj",
      "-of", "/w/whisper",
      "-ml", "1",
      "--no-prints",
    ]);
  });

  // whisper.cpp defaults to English without -l, which decodes garbage out of
  // a non-English fine-tune (Urdu field test 2026-08-05).
  it("appends -l <code> when a language is set", () => {
    expect(whisperArgs({ ...opts, language: "ur" }, "/w/audio.wav")).toEqual([
      "-m", "/m/ggml-small.en.bin",
      "-f", "/w/audio.wav",
      "-oj",
      "-of", "/w/whisper",
      "-ml", "1",
      "--no-prints",
      "-l", "ur",
    ]);
  });
});

describe("parseWhisperJson", () => {
  it("merges sub-word continuations into whole words", () => {
    const t = parseWhisperJson(sample);
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "everyone,", "it's", "working", "done"]);
  });

  it("converts millisecond offsets to seconds and keeps monotonic stamps", () => {
    const t = parseWhisperJson(sample);
    expect(t.words[0]).toMatchObject({ start: 0, end: 0.32 });
    // "it's" spans its continuation token
    const its = t.words.find((w) => w.text === "it's")!;
    expect(its.start).toBeCloseTo(0.9);
    expect(its.end).toBeCloseTo(1.45);
    for (let i = 0; i < t.words.length - 1; i++) {
      expect(t.words[i + 1]!.start).toBeGreaterThanOrEqual(t.words[i]!.end);
    }
  });

  it("drops noise markers and whitespace-only tokens", () => {
    const t = parseWhisperJson(sample);
    expect(t.words.some((w) => w.text.includes("BLANK"))).toBe(false);
  });

  // §130: a word that is nothing but U+FFFD (an unrecoverable byte fragment)
  // folds its span into a neighbor instead of painting a literal � on screen.
  it("folds a lone replacement-char-only segment into its neighbor", () => {
    const t = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 300 }, text: " hello" },
        { offsets: { from: 300, to: 500 }, text: " �" },
        { offsets: { from: 500, to: 800 }, text: " world" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["hello", "world"]);
    // The fragment's span belonged to speech — the previous word absorbs it.
    expect(t.words[0]).toMatchObject({ start: 0, end: 0.5 });
  });

  // §130's other field shape: a lone lead byte MID-WORD whose continuation
  // whisper never emitted at all ("سپی�جس"). The byte is unrecoverable; the
  // displayable best is the word without the �.
  it("strips replacement chars embedded in an otherwise real word", () => {
    const t = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 200 }, text: " سپی" },
        { offsets: { from: 200, to: 200 }, text: "�" },
        { offsets: { from: 200, to: 400 }, text: "جس" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["سپیجس"]);
  });

  it("repairs zero-length and inverted timestamps", () => {
    const t = parseWhisperJson({
      transcription: [
        { offsets: { from: 100, to: 100 }, text: " a" },
        { offsets: { from: 90, to: 400 }, text: " b" },
      ],
    });
    expect(t.words[0]!.end).toBeGreaterThan(t.words[0]!.start);
    expect(t.words[1]!.start).toBeGreaterThanOrEqual(t.words[0]!.end);
  });
});

describe("parseWhisperOutput — §130 token-split multibyte repair", () => {
  // Mirrors the field whisper.json byte-for-byte (Urdu field test 2026-08-05,
  // "ٹاپک"): segment N's text ends on the bare LEAD byte 0xD9, segment N+1
  // begins with its continuation 0xB9 (together U+0679 ٹ) followed by ا —
  // the file as a whole is NOT valid UTF-8, and a utf8 read would replace
  // both halves with U+FFFD before any parser saw them.
  const splitFixture = Buffer.concat([
    Buffer.from('{"result":{"language":"ur"},"transcription":[', "utf8"),
    Buffer.from('{"offsets":{"from":5860,"to":5860},"text":" ', "utf8"),
    Buffer.from([0xd9]),
    Buffer.from('"},{"offsets":{"from":5860,"to":6130},"text":"', "utf8"),
    Buffer.from([0xb9]),
    Buffer.from('ا"},{"offsets":{"from":6130,"to":6300},"text":"پک"}]}', "utf8"),
  ]);

  it("heals the observed field shape into the correct word, spanning both segments", () => {
    const t = parseWhisperOutput(splitFixture);
    expect(t.language).toBe("ur");
    expect(t.words.map((w) => w.text)).toEqual(["ٹاپک"]);
    // Merged word spans the split segments AND the trailing continuations.
    expect(t.words[0]).toMatchObject({ start: 5.86, end: 6.3 });
  });

  it("is byte-identical to parseWhisperJson on a valid (pure ASCII) file", () => {
    const buf = Buffer.from(JSON.stringify(sample), "utf8");
    expect(parseWhisperOutput(buf)).toEqual(parseWhisperJson(sample));
  });

  it("folds an unrecoverable dangling byte (no continuing neighbor) instead of shipping �", () => {
    // A lead byte whose neighbor does NOT continue it: unrepairable, decodes
    // to U+FFFD, and the FFFD-only word rule folds it into "ok".
    const buf = Buffer.concat([
      Buffer.from('{"transcription":[{"offsets":{"from":0,"to":200},"text":" ok"},', "utf8"),
      Buffer.from('{"offsets":{"from":200,"to":400},"text":" ', "utf8"),
      Buffer.from([0xd9]),
      Buffer.from('"},{"offsets":{"from":400,"to":700},"text":" done"}]}', "utf8"),
    ]);
    const t = parseWhisperOutput(buf);
    expect(t.words.map((w) => w.text)).toEqual(["ok", "done"]);
    expect(t.words[0]).toMatchObject({ start: 0, end: 0.4 });
  });
});
