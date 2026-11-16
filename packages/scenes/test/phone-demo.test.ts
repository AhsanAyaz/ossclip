import { describe, expect, it } from "vitest";
import { PhoneDemoProps } from "@ossclip/core/browser";
import {
  PHONE_EMPH_AFTER_SEC,
  PHONE_SETTLED_SEC,
  phoneDemoDelays,
  phoneFrameState,
} from "../src/components/PhoneDemo";
import { enterFrames } from "../src/anim";
import { drawsScrim } from "../src/scrim";

/**
 * PhoneDemo's timing (§161, plan Task 7, and the plan author's 2026-11-16
 * decisions): pills wait for the phone, land on their words when matched
 * but never before the phone has settled, and the phone bobs once idle.
 */

const FPS = 30;
const props = PhoneDemoProps.parse({
  caption: [{ text: "YOUR" }, { text: "CAPTIONS", emphasis: "yellow" }],
  pills: [{ text: "Big" }, { text: "Bold", state: "bad" }, { text: "Short", state: "plain" }],
});
const timed = (itemAtSec?: (number | null)[], durationInFrames = 300) => ({
  cueStartSec: 10,
  durationInFrames,
  itemAtSec,
});

describe("phoneDemoDelays", () => {
  it("with no word timings the pills start after the phone has settled: 0.75 s, then every 0.7 s", () => {
    expect(phoneDemoDelays(props, FPS)).toEqual([23, 44, 65]);
    expect(phoneDemoDelays(props, FPS, timed(undefined))).toEqual([23, 44, 65]);
  });

  it("no pills, no delays", () => {
    expect(phoneDemoDelays(PhoneDemoProps.parse({ caption: [{ text: "HI" }] }), FPS)).toEqual([]);
  });

  it("matched words put each pill on its word, but never before 0.6 s", () => {
    // Words at 10.1 s, 11.5 s and 12.9 s into a cue starting at 10 s: the
    // first would land at 3 frames, before the phone has settled.
    expect(phoneDemoDelays(props, FPS, timed([10.1, 11.5, 12.9]))).toEqual([18, 45, 87]);
  });

  it("a short cue holds the beats to the last frame an entrance can finish by", () => {
    const short = 40;
    const latest = short - enterFrames(FPS);
    expect(phoneDemoDelays(props, FPS, timed(undefined, short))).toEqual([23, latest, latest]);
  });

  it("touching a reveal prop leaves the beat path for the shared schedule, still floored at 0.6 s", () => {
    const paced = PhoneDemoProps.parse({ ...props, reveal: "paced" });
    const delays = phoneDemoDelays(paced, FPS, timed(undefined));
    expect(delays[0]).toBe(18);
    expect(delays).not.toEqual([23, 44, 65]);
  });
});

describe("phoneFrameState", () => {
  it("explainer: the phone pops at 0.25 s, the boxes after it settles, and it bobs only once idle", () => {
    expect(phoneFrameState(0.2, true)).toEqual({ phoneScale: 0, bobPx: 0, emphScale: 0 });
    expect(phoneFrameState(PHONE_SETTLED_SEC, true).phoneScale).toBe(1);
    expect(phoneFrameState(PHONE_SETTLED_SEC, true).bobPx).toBe(0);
    expect(phoneFrameState(PHONE_SETTLED_SEC + PHONE_EMPH_AFTER_SEC - 0.01, true).emphScale).toBe(0);
    expect(phoneFrameState(PHONE_SETTLED_SEC + PHONE_EMPH_AFTER_SEC + 0.35, true).emphScale).toBe(1);
    expect(Math.abs(phoneFrameState(PHONE_SETTLED_SEC + 0.6, true).bobPx)).toBeGreaterThan(6);
  });

  it("classic: nothing moves, the boxes are drawn from the start", () => {
    for (const t of [0, 0.5, 3]) expect(phoneFrameState(t, false)).toEqual({ phoneScale: 1, bobPx: 0, emphScale: 1 });
  });

  it("draws no scrim: it sits on the speaker like the clips it replaces", () => {
    expect(drawsScrim("full-bleed", "PhoneDemo")).toBe(false);
  });
});
