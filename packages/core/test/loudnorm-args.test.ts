import { describe, expect, it } from "vitest";
import { loudnormArgs } from "../src/ingest";

// 2026-11-13: ffmpeg's loudnorm filter resamples to 192 kHz internally and
// keeps a high rate on output unless told otherwise — every final render
// shipped 96 kHz AAC, and Threads (48 kHz max) silently refused it.
describe("loudnormArgs", () => {
  it("normalizes loudness, copies video and pins the output to 48 kHz", () => {
    const args = loudnormArgs("/w/raw.mp4", "/w/norm.mp4");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("-af")).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(after("-c:v")).toBe("copy");
    expect(after("-ar")).toBe("48000");
    expect(args.at(-1)).toBe("/w/norm.mp4");
  });
});
