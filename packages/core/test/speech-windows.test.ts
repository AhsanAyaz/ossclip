import { describe, expect, it } from "vitest";
import {
  compressArgs,
  compressionLine,
  compressionPlan,
  parseSilences,
  remapTime,
  remapWords,
  shouldCompress,
  silenceDetectArgs,
  silencesInWindow,
  speechRuns,
  takeCompressionPlans,
  type CompressionSegment,
} from "../src/transcribe/speech-windows";

/**
 * Silence-compressed decoding (FINDINGS §159): one whisper pass over a
 * 13-minute recording put 31% of its words inside measured silence. Every
 * rule here is pure — no ffmpeg, no whisper, no workdir.
 */

describe("silenceDetectArgs", () => {
  it("runs silencedetect at -35 dB / 0.35 s and throws the output away", () => {
    expect(silenceDetectArgs("/w/audio.wav")).toEqual([
      "-hide_banner",
      "-nostats",
      "-i", "/w/audio.wav",
      "-af", "silencedetect=n=-35dB:d=0.35",
      "-f", "null",
      "-",
    ]);
  });
});

describe("parseSilences", () => {
  const STDERR = [
    "Input #0, wav, from 'audio.wav':",
    "  Duration: 00:00:20.00, bitrate: 256 kb/s",
    "[silencedetect @ 0x5581] silence_start: 2.5",
    "[silencedetect @ 0x5581] silence_end: 4.25 | silence_duration: 1.75",
    "[silencedetect @ 0x5581] silence_start: 9.1",
    "[silencedetect @ 0x5581] silence_end: 9.6 | silence_duration: 0.5",
  ].join("\n");

  it("pairs each silence_start with its silence_end", () => {
    expect(parseSilences(STDERR, 20)).toEqual([
      { start: 2.5, end: 4.25 },
      { start: 9.1, end: 9.6 },
    ]);
  });

  it("closes a trailing silence_start at the audio duration", () => {
    // ffmpeg never prints silence_end for silence that runs to EOF.
    const out = parseSilences(`${STDERR}\n[silencedetect @ 0x5581] silence_start: 17.3\n`, 20);
    expect(out[out.length - 1]).toEqual({ start: 17.3, end: 20 });
  });

  it("clamps ffmpeg's slightly negative leading silence_start to 0", () => {
    const out = parseSilences(
      "[silencedetect @ 0x1] silence_start: -0.00175\n[silencedetect @ 0x1] silence_end: 1.2 | silence_duration: 1.2",
      5,
    );
    expect(out).toEqual([{ start: 0, end: 1.2 }]);
  });

  it("returns nothing when no silence was found", () => {
    expect(parseSilences("Input #0, wav\n  Duration: 00:00:05.00", 5)).toEqual([]);
  });
});

describe("speechRuns", () => {
  it("is the gaps between silences, inside the audio", () => {
    expect(speechRuns([{ start: 0, end: 1 }, { start: 3, end: 4 }], 6)).toEqual([
      { startSec: 1, endSec: 3 },
      { startSec: 4, endSec: 6 },
    ]);
  });

  it("is the whole audio when there is no silence", () => {
    expect(speechRuns([], 6)).toEqual([{ startSec: 0, endSec: 6 }]);
  });
});

describe("silencesInWindow", () => {
  it("clips silences to a take and puts them on the take's clock", () => {
    const out = silencesInWindow(
      [{ start: 1, end: 2 }, { start: 9, end: 12 }, { start: 14, end: 15 }, { start: 30, end: 31 }],
      { startSec: 10, endSec: 20 },
    );
    expect(out).toEqual([{ start: 0, end: 2 }, { start: 4, end: 5 }]);
  });
});

const run = (startSec: number, endSec: number) => ({ startSec, endSec });
const seg = (srcStart: number, srcEnd: number, dstStart: number): CompressionSegment => ({
  srcStart,
  srcEnd,
  dstStart,
});

describe("compressionPlan", () => {
  it("pads each speech run by 0.15 s and lays the segments end to end", () => {
    expect(compressionPlan([run(1, 2), run(5, 7)], 10)).toEqual([
      seg(0.85, 2.15, 0),
      seg(4.85, 7.15, 1.3),
    ]);
  });

  it("merges runs whose pads would overlap into one segment", () => {
    // 0.2 s apart: the two 0.15 s pads meet in the middle — one segment.
    expect(compressionPlan([run(1, 2), run(2.2, 3), run(6, 7)], 10)).toEqual([
      seg(0.85, 3.15, 0),
      seg(5.85, 7.15, 2.3),
    ]);
  });

  it("never pads past the start or the end of the audio", () => {
    expect(compressionPlan([run(0.05, 2), run(9, 9.9)], 9.9)).toEqual([
      seg(0, 2.15, 0),
      seg(8.85, 9.9, 2.15),
    ]);
  });

  it("puts every boundary on the 10 ms grid the ffmpeg selection works in", () => {
    // aselect picks whole 160-sample frames; an off-grid boundary would make
    // the compressed wav a frame longer or shorter than the plan says, and
    // the error would accumulate over every later segment.
    const p = compressionPlan([run(1.234, 2.001)], 10, { padSec: 0 });
    expect(p).toEqual([seg(1.23, 2.01, 0)]);
  });

  it("is empty when there is no speech", () => {
    expect(compressionPlan([], 10)).toEqual([]);
  });
});

describe("compressArgs", () => {
  it("selects exactly the planned segments, in order, as 16 kHz mono PCM", () => {
    const plan = [seg(0.85, 2.15, 0), seg(4.85, 7.15, 1.3)];
    expect(compressArgs("/w/audio.wav", "/w/audio-speech.wav", plan)).toEqual({
      args: [
        "-y",
        "-hide_banner",
        "-i", "/w/audio.wav",
        "-af",
        "asetnsamples=n=160:p=0," +
          "aselect='between(t,0.845,2.145)+between(t,4.845,7.145)'," +
          "asetpts=N/SR/TB",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "/w/audio-speech.wav",
      ],
    });
  });

  it("moves a long selection into a filter script beside the output", () => {
    const plan = Array.from({ length: 2000 }, (_, i) => seg(i, i + 0.5, i * 0.5));
    const out = compressArgs("/w/audio.wav", "/w/audio-speech.wav", plan);
    expect(out.script).toBeDefined();
    expect(out.script!.path).toBe("/w/audio-speech.wav.filter");
    expect(out.script!.text.startsWith("asetnsamples=n=160:p=0,aselect='between(t,")).toBe(true);
    expect(out.args).toContain("-filter_script:a");
    expect(out.args).not.toContain("-af");
    expect(out.args[out.args.indexOf("-filter_script:a") + 1]).toBe("/w/audio-speech.wav.filter");
  });
});

describe("remapTime", () => {
  const plan = [seg(0.85, 2.15, 0), seg(4.85, 7.15, 1.3)];

  it("maps a segment's start to its source start", () => {
    expect(remapTime(0, plan)).toBeCloseTo(0.85, 9);
    expect(remapTime(1.3, plan)).toBeCloseTo(4.85, 9);
  });

  it("maps inside a segment by its offset", () => {
    expect(remapTime(0.5, plan)).toBeCloseTo(1.35, 9);
    expect(remapTime(2.0, plan)).toBeCloseTo(5.55, 9);
  });

  it("maps a segment's end to its source end", () => {
    expect(remapTime(3.6, plan)).toBeCloseTo(7.15, 9);
  });

  it("maps a time past the last segment to the last source end", () => {
    expect(remapTime(9, plan)).toBeCloseTo(7.15, 9);
  });

  it("is the identity for an empty plan", () => {
    expect(remapTime(3, [])).toBe(3);
  });
});

describe("remapWords", () => {
  const plan = [seg(0.85, 2.15, 0), seg(4.85, 7.15, 1.3)];

  it("maps start and end back to the original clock", () => {
    const [w] = remapWords([{ text: "hi", start: 0.2, end: 0.6 }], plan);
    expect(w!.text).toBe("hi");
    expect(w!.start).toBeCloseTo(1.05, 9);
    expect(w!.end).toBeCloseTo(1.45, 9);
  });

  it("clamps a word whose end falls in a later segment to its start segment", () => {
    // A spoken word cannot span a removed silence of 0.35 s or more.
    const [w] = remapWords([{ text: "designer", start: 1.1, end: 1.6 }], plan);
    expect(w!.start).toBeCloseTo(1.95, 9);
    expect(w!.end).toBeCloseTo(2.15, 9);
  });

  it("never drops a word and never ends one before it starts", () => {
    const words = [
      { text: "a", start: 0.1, end: 0.2 },
      { text: "edge", start: 1.3, end: 1.3 },
      { text: "late", start: 3.7, end: 4.2 },
    ];
    const out = remapWords(words, plan);
    expect(out.map((w) => w.text)).toEqual(["a", "edge", "late"]);
    for (const w of out) expect(w.end - w.start).toBeGreaterThanOrEqual(0.02 - 1e-9);
    // Past the end: pinned to the last source end, at minimum length — and
    // inside the kept audio, not 0.02 s into the silence after it.
    expect(out[2]!.start).toBeCloseTo(7.13, 9);
    expect(out[2]!.end).toBeCloseTo(7.15, 9);
  });

  it("keeps a word stamped on a splice inside the segment it starts in", () => {
    // Field shape (§159): whisper stamps a word at the very end of a
    // segment; at minimum length it must not poke into the removed silence.
    const [w] = remapWords([{ text: "and", start: 1.295, end: 1.3 }], plan);
    expect(w!.start).toBeCloseTo(2.13, 9);
    expect(w!.end).toBeCloseTo(2.15, 9);
  });

  it("keeps every other field of a word", () => {
    const [w] = remapWords([{ text: "x", start: 0, end: 0.1, confidence: 0.9 } as never], plan);
    expect((w as unknown as { confidence: number }).confidence).toBe(0.9);
  });
});

describe("shouldCompress", () => {
  it("compresses when removable silence is at least 10% and at least 3 s", () => {
    // 60 s with 10 s of silence: ~9.7 s removable after pads.
    expect(shouldCompress([{ start: 20, end: 30 }], 60)).toBe(true);
  });

  it("decodes as today when removable silence is under 10% of the duration", () => {
    // 100 s, 8 s of silence: over 3 s but under 10 s.
    expect(shouldCompress([{ start: 40, end: 48 }], 100)).toBe(false);
  });

  it("decodes as today when removable silence is under 3 s, however short the clip", () => {
    // A 20 s short with 2.5 s of silence: 12% but only ~2.2 s removable.
    expect(shouldCompress([{ start: 5, end: 7.5 }], 20)).toBe(false);
  });

  it("does not compress when there is no silence", () => {
    expect(shouldCompress([], 600)).toBe(false);
  });
});

describe("takeCompressionPlans", () => {
  it("plans each take on its own clock, or null to decode it as today", () => {
    const takes = [run(0, 60), run(60, 80)];
    const plans = takeCompressionPlans([{ start: 20, end: 30 }, { start: 65, end: 66 }], takes);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual([seg(0, 20.15, 0), seg(29.85, 60, 20.15)]);
    expect(plans[1]).toBeNull();
  });

  it("decodes a take that is silence end to end as today, not as an empty selection", () => {
    expect(takeCompressionPlans([{ start: 0, end: 30 }], [run(0, 30)])).toEqual([null]);
  });
});

describe("compressionLine", () => {
  it("names both passes: the whole recording, then the speech", () => {
    expect(compressionLine(373.9, 798.3)).toBe(
      "▸ transcribing 798 s recording, then timing 374 s of speech with silences removed",
    );
  });
});
