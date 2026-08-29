import { describe, expect, it } from "vitest";
import { encodeEta, formatMinSec, parseFfmpegProgress } from "../src/publish/progress";

/**
 * 2026-08-29: the delivery encode ran for minutes with zero feedback — the
 * CLI line and the editor panel both read ffmpeg's `-progress pipe:1` stream
 * through these helpers. Pure only; encodeDelivery's spawn is never tested
 * here (house style — no ffmpeg in the suite).
 */

describe("parseFfmpegProgress", () => {
  it("reads out_time_us and speed from a full progress block", () => {
    const block =
      "frame=120\nfps=48.2\nout_time_us=5000000\nout_time_ms=5000000\n" +
      "out_time=00:00:05.000000\nspeed=1.53x\nprogress=continue\n";
    expect(parseFfmpegProgress(block)).toEqual({ outTimeSec: 5, speed: 1.53 });
  });

  it("keeps the LAST value per key — the stream repeats the block ~2x/sec", () => {
    const two = "out_time_us=1000000\nspeed=0.9x\nout_time_us=2000000\nspeed=1.2x\n";
    expect(parseFfmpegProgress(two)).toEqual({ outTimeSec: 2, speed: 1.2 });
  });

  it("ignores N/A — ffmpeg's warm-up block, before it has numbers", () => {
    expect(parseFfmpegProgress("out_time_us=N/A\nout_time=N/A\nspeed=N/A\n")).toEqual({});
  });

  it("out_time_ms is MICROseconds despite the name (the ffmpeg quirk)", () => {
    // Trusting the name would report a 1000x-too-long encode.
    expect(parseFfmpegProgress("out_time_ms=5000000\n")).toEqual({ outTimeSec: 5 });
  });

  it("falls back to the HH:MM:SS.xx spelling", () => {
    expect(parseFfmpegProgress("out_time=00:01:30.500000\n")).toEqual({ outTimeSec: 90.5 });
    expect(parseFfmpegProgress("out_time=01:00:00.00\n")).toEqual({ outTimeSec: 3600 });
  });

  it("split chunks: each chunk yields only its own complete keys, the caller merges", () => {
    // The chunk boundary lands between lines here; the mid-VALUE split is the
    // caller's carry buffer's job (encodeDelivery), not the parser's.
    const a = parseFfmpegProgress("out_time_us=1000000\n");
    const b = parseFfmpegProgress("speed=1.5x\n");
    expect(a).toEqual({ outTimeSec: 1 });
    expect(b).toEqual({ speed: 1.5 });
    expect({ ...a, ...b }).toEqual({ outTimeSec: 1, speed: 1.5 });
  });

  it("garbage and unknown keys yield nothing, never a guess", () => {
    expect(parseFfmpegProgress("frame=12\nbitrate=1000.2kbits/s\nnot a kv line\n")).toEqual({});
    expect(parseFfmpegProgress("out_time_us=twelve\nspeed=fastx\n")).toEqual({});
  });
});

describe("encodeEta", () => {
  it("(duration - done) / speed", () => {
    // 300s video, 80s done, 2x realtime → 110s of wall clock left.
    expect(encodeEta(300, 80, 2)).toBe(110);
  });

  it("null at speed ≤ 0 — ffmpeg's warm-up speed=0x must not print Infinity", () => {
    expect(encodeEta(300, 80, 0)).toBeNull();
    expect(encodeEta(300, 80, -1)).toBeNull();
  });

  it("clamps at 0 when out_time overshoots the probed duration (muxer flush)", () => {
    expect(encodeEta(300, 301, 1.5)).toBe(0);
  });
});

describe("formatMinSec", () => {
  it("formats seconds as M:SS — the CLI's spelling, now shared", () => {
    expect(formatMinSec(320)).toBe("5:20");
    expect(formatMinSec(300)).toBe("5:00");
    expect(formatMinSec(59.6)).toBe("1:00");
  });
});
