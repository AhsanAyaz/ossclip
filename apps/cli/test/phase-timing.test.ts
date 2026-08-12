import { describe, expect, it } from "vitest";
import {
  PhaseTimer,
  formatPhaseDuration,
  formatPhaseLine,
  phaseBucketProps,
  phaseDurationBucket,
} from "../src/phase-timing";
import { assertSafeProps } from "../src/telemetry";

/**
 * Per-phase timing for `produce` (FINDINGS §140): the pure half — the timer,
 * the log line, the telemetry buckets — tested without a clock, a TTY or a
 * network, per the house pure/IO split. The I/O half (produce() actually
 * timing its phases) is pinned by produce-timing.test.ts, the first test that
 * executes produce() at all.
 */

/** A hand-cranked clock so every duration in here is exact by construction. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PhaseTimer", () => {
  it("accumulates two intervals under one phase instead of overwriting", async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await timer.time("ffmpeg", async () => clock.advance(300));
    await timer.time("ffmpeg", async () => clock.advance(200));
    expect(timer.timings()).toEqual({ ffmpeg: 500 });
  });

  it("keeps phases separate and returns the timed fn's value", async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    const out = await timer.time("transcribe", async () => {
      clock.advance(1000);
      return "words";
    });
    await timer.time("llm", async () => clock.advance(50));
    expect(out).toBe("words");
    expect(timer.timings()).toEqual({ transcribe: 1000, llm: 50 });
  });

  it("records the time spent even when the phase throws, and rethrows", async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await expect(
      timer.time("render", async () => {
        clock.advance(700);
        throw new Error("chrome died");
      }),
    ).rejects.toThrow("chrome died");
    expect(timer.timings()).toEqual({ render: 700 });
  });

  it("totalMs is wall clock since construction, not the sum of phases", async () => {
    const clock = fakeClock(5000);
    const timer = new PhaseTimer(clock.now);
    clock.advance(100); // un-phased work
    await timer.time("llm", async () => clock.advance(400));
    clock.advance(250); // more un-phased work
    expect(timer.totalMs()).toBe(750);
    expect(timer.timings()).toEqual({ llm: 400 });
  });

  it("timings() returns a copy, not a live reference", async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await timer.time("llm", async () => clock.advance(10));
    const snapshot = timer.timings();
    await timer.time("llm", async () => clock.advance(10));
    expect(snapshot).toEqual({ llm: 10 });
  });
});

describe("formatPhaseDuration", () => {
  it("sub-minute durations keep one decimal — an 8s LLM phase must not print as 0m", () => {
    expect(formatPhaseDuration(8_200)).toBe("8.2s");
    expect(formatPhaseDuration(400)).toBe("0.4s");
  });

  it("minutes pad the seconds so 1m03s can't be misread as 1m3(0)s", () => {
    expect(formatPhaseDuration(63_000)).toBe("1m03s");
    expect(formatPhaseDuration(252_000)).toBe("4m12s");
  });

  it("hours drop the seconds — at that scale they are noise", () => {
    expect(formatPhaseDuration(3_723_000)).toBe("1h02m");
  });
});

describe("formatPhaseLine", () => {
  it("prints total, every measured phase in pipeline order, and the remainder", () => {
    const line = formatPhaseLine(
      { transcribe: 63_000, llm: 8_200, render: 161_000, ffmpeg: 12_400 },
      252_000,
    );
    expect(line).toBe(
      "▸ time: total 4m12s — whisper 1m03s · llm 8.2s · render 2m41s · ffmpeg 12.4s · other 7.4s",
    );
  });

  it("omits phases that never ran — a cached transcript is not a 0.0s whisper run", () => {
    const line = formatPhaseLine({ ffmpeg: 2_000 }, 10_000);
    expect(line).toBe("▸ time: total 10.0s — ffmpeg 2.0s · other 8.0s");
    expect(line).not.toContain("whisper");
  });

  it("a run with no measured phases is just the total — 'other 100%' says nothing", () => {
    expect(formatPhaseLine({}, 5_200)).toBe("▸ time: total 5.2s");
  });

  it("clock skew cannot print a negative remainder", () => {
    expect(formatPhaseLine({ render: 10_100 }, 10_000)).toBe(
      "▸ time: total 10.0s — render 10.1s",
    );
  });
});

describe("phaseDurationBucket", () => {
  it("buckets at 10s/60s/5m/15m — finer than durationBucket because an LLM phase lives in seconds", () => {
    expect(phaseDurationBucket(9.9)).toBe("<10s");
    expect(phaseDurationBucket(10)).toBe("10-60s");
    expect(phaseDurationBucket(60)).toBe("10-60s");
    expect(phaseDurationBucket(61)).toBe("1-5m");
    expect(phaseDurationBucket(300)).toBe("1-5m");
    expect(phaseDurationBucket(301)).toBe("5-15m");
    expect(phaseDurationBucket(900)).toBe("5-15m");
    expect(phaseDurationBucket(901)).toBe(">15m");
  });
});

describe("phaseBucketProps", () => {
  it("emits one bucketed prop per phase that ran, and nothing for phases that didn't", () => {
    expect(phaseBucketProps({ transcribe: 65_000, llm: 4_000 })).toEqual({
      transcribe_bucket: "1-5m",
      llm_bucket: "<10s",
    });
  });

  it("every key it can ever emit clears the §134 privacy floor", () => {
    const all = phaseBucketProps({ transcribe: 1, llm: 1, render: 1, ffmpeg: 1 });
    expect(Object.keys(all)).toEqual([
      "transcribe_bucket",
      "llm_bucket",
      "render_bucket",
      "ffmpeg_bucket",
    ]);
    expect(() => assertSafeProps(all)).not.toThrow();
  });

  it("never sends raw milliseconds — buckets only, per the §134 floor", () => {
    for (const v of Object.values(phaseBucketProps({ render: 123_456 }))) {
      expect(typeof v).toBe("string");
    }
  });
});
