import { describe, expect, it } from "vitest";
import {
  dropRepetitionBursts,
  parseWhisperJson,
  parseWhisperOutput,
  REPETITION_BURST_MIN,
  whisperArgs,
  whisperPromptFor,
  type WhisperJson,
} from "../src/transcribe";

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

/**
 * A whisper repetition loop as it appears in whisper.json: `n` consecutive
 * word-starting tokens all stamped `from === to === ms` (field case
 * 2026-08-18 — 118 of them at 31040ms).
 */
const burstTokens = (n: number, ms: number): WhisperJson["transcription"] =>
  Array.from({ length: n }, (_, i) => ({ offsets: { from: ms, to: ms }, text: ` بار${i}` }));

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
      "-mc", "0",
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
      "-mc", "0",
      "--no-prints",
      "-l", "ur",
    ]);
  });

  // No prompt = byte-identical args — same contract as the -l conditional:
  // the dictionary must never perturb a run that has none (F4, 2026-08-16).
  it("passes no --prompt when the prompt is unset", () => {
    expect(whisperArgs(opts, "/w/audio.wav")).not.toContain("--prompt");
  });

  it("appends --prompt <text> when set, after the fixed args and the language", () => {
    expect(
      whisperArgs({ ...opts, language: "ur", prompt: "Vocabulary: JSON." }, "/w/audio.wav"),
    ).toEqual([
      "-m", "/m/ggml-small.en.bin",
      "-f", "/w/audio.wav",
      "-oj",
      "-of", "/w/whisper",
      "-ml", "1",
      "-mc", "0",
      "--no-prints",
      "-l", "ur",
      "--prompt", "Vocabulary: JSON.",
    ]);
  });
});

describe("whisperPromptFor (F4 dictionary, 2026-08-16)", () => {
  it("is undefined for an empty dictionary — so the args stay byte-identical", () => {
    expect(whisperPromptFor([])).toBeUndefined();
  });

  it("lists the terms verbatim, comma-joined, as a vocabulary sentence", () => {
    expect(whisperPromptFor(["JSON", "ossclip", "Genkit"])).toBe(
      "Vocabulary: JSON, ossclip, Genkit.",
    );
  });
});

describe("parseWhisperJson", () => {
  it("merges sub-word continuations into whole words", () => {
    const t = parseWhisperJson(sample);
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "everyone,", "it's", "working", "done"]);
  });

  it("starts a new word after ۔/؟ even without whitespace — the merged-sentence field case", () => {
    // Real shape from the 2026-08-18 Urdu field file: whisper emits the
    // sentence stop and the next sentence's first token as bare
    // continuations ("ہوں" + "۔" + "اس"), and the whitespace rule alone
    // fused all three into "ہوں۔اس".
    const t = parseWhisperJson({
      result: { language: "ur" },
      transcription: [
        { offsets: { from: 720, to: 1000 }, text: " ہوں" },
        { offsets: { from: 1000, to: 1160 }, text: "۔" },
        { offsets: { from: 1160, to: 1400 }, text: "اس" },
        { offsets: { from: 1400, to: 1700 }, text: " تصویر" },
        { offsets: { from: 1700, to: 1900 }, text: "؟" },
        { offsets: { from: 1900, to: 2100 }, text: "کیا" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["ہوں۔", "اس", "تصویر؟", "کیا"]);
    // The split word keeps the continuation token's own stamps.
    expect(t.words[1]).toMatchObject({ start: 1.16, end: 1.4 });
  });

  it("does NOT split on Latin punctuation — decimals tokenize as bare continuations", () => {
    const t = parseWhisperJson({
      result: { language: "en" },
      transcription: [
        { offsets: { from: 0, to: 200 }, text: " 3" },
        { offsets: { from: 200, to: 250 }, text: "." },
        { offsets: { from: 250, to: 400 }, text: "5" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["3.5"]);
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

  // Two tokens, one of them zero-length: BELOW the burst threshold, so this
  // must still repair rather than drop — the boundary the guard must not move.
  it("repairs zero-length and inverted timestamps", () => {
    const t = parseWhisperJson({
      transcription: [
        { offsets: { from: 100, to: 100 }, text: " a" },
        { offsets: { from: 90, to: 400 }, text: " b" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["a", "b"]);
    expect(t.words[0]!.end).toBeGreaterThan(t.words[0]!.start);
    expect(t.words[1]!.start).toBeGreaterThanOrEqual(t.words[0]!.end);
  });

  // Field case 2026-08-18: 118 consecutive tokens all stamped from===to===31040.
  it("drops a repetition burst and leaves its neighbors' stamps intact", () => {
    const t = parseWhisperJson({
      result: { language: "ur" },
      transcription: [
        { offsets: { from: 30700, to: 31040 }, text: " پہلے" },
        ...burstTokens(10, 31040),
        { offsets: { from: 33540, to: 33900 }, text: " بعد" },
      ],
    });
    expect(t.words.map((w) => w.text)).toEqual(["پہلے", "بعد"]);
    expect(t.words[0]).toMatchObject({ start: 30.7, end: 31.04 });
    // Without the guard the burst fanned out to 33.54s and the real word here
    // got shoved forward; its own stamps must survive the drop untouched.
    expect(t.words[1]).toMatchObject({ start: 33.54, end: 33.9 });
    for (let i = 0; i < t.words.length - 1; i++) {
      expect(t.words[i + 1]!.start).toBeGreaterThanOrEqual(t.words[i]!.end);
    }
  });

  it(`keeps a run of ${REPETITION_BURST_MIN - 1} and drops a run of ${REPETITION_BURST_MIN}`, () => {
    const kept = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 500 }, text: " a" },
        ...burstTokens(REPETITION_BURST_MIN - 1, 31040),
      ],
    });
    expect(kept.words).toHaveLength(REPETITION_BURST_MIN);
    const dropped = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 500 }, text: " a" },
        ...burstTokens(REPETITION_BURST_MIN, 31040),
      ],
    });
    expect(dropped.words.map((w) => w.text)).toEqual(["a"]);
  });

  // A burst must share ONE instant. Zero-length stamps that keep marching
  // forward are ordinary rounding artifacts, however many of them there are.
  it("does not drop zero-length tokens at DIFFERENT timestamps", () => {
    const t = parseWhisperJson({
      transcription: Array.from({ length: REPETITION_BURST_MIN + 4 }, (_, i) => ({
        offsets: { from: 1000 + i * 60, to: 1000 + i * 60 },
        text: ` w${i}`,
      })),
    });
    expect(t.words).toHaveLength(REPETITION_BURST_MIN + 4);
    for (const w of t.words) expect(w.end).toBeGreaterThan(w.start);
  });
});

describe("dropRepetitionBursts (field case 2026-08-18)", () => {
  const zero = (start: number, text = "x") => ({ text, start, end: start });

  it("keeps words that already have a real duration", () => {
    const words = [
      { text: "a", start: 0, end: 0.5 },
      { text: "b", start: 0.5, end: 1 },
    ];
    expect(dropRepetitionBursts(words)).toEqual(words);
  });

  it("drops only the burst, not the words around it", () => {
    const before = { text: "before", start: 30.7, end: 31.04 };
    const after = { text: "after", start: 33.54, end: 33.9 };
    const burst = Array.from({ length: 118 }, (_, i) => zero(31.04, `t${i}`));
    expect(dropRepetitionBursts([before, ...burst, after])).toEqual([before, after]);
  });

  it("keeps a run one short of the threshold", () => {
    const run = Array.from({ length: REPETITION_BURST_MIN - 1 }, (_, i) => zero(31.04, `t${i}`));
    expect(dropRepetitionBursts(run)).toHaveLength(REPETITION_BURST_MIN - 1);
  });

  it("keeps an isolated zero-length word for the repair pass to fix", () => {
    expect(dropRepetitionBursts([zero(1.5)])).toEqual([zero(1.5)]);
  });

  it("treats two adjacent same-length runs at different instants separately", () => {
    // Neither run reaches the threshold on its own; adjacency must not fuse
    // them, because a burst is defined by a SHARED instant.
    const a = Array.from({ length: REPETITION_BURST_MIN - 1 }, (_, i) => zero(5, `a${i}`));
    const b = Array.from({ length: REPETITION_BURST_MIN - 1 }, (_, i) => zero(6, `b${i}`));
    expect(dropRepetitionBursts([...a, ...b])).toHaveLength((REPETITION_BURST_MIN - 1) * 2);
  });

  it("drops an inverted-stamp burst too (end < start, one instant)", () => {
    const burst = Array.from({ length: REPETITION_BURST_MIN }, (_, i) => ({
      text: `t${i}`,
      start: 31.04,
      end: 30.9,
    }));
    expect(dropRepetitionBursts(burst)).toEqual([]);
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
