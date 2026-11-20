import { describe, expect, it } from "vitest";
import { CardRowProps } from "@ossclip/core/browser";
import { cardRowBumpFrame, cardRowDelays } from "../src/components/CardRow";
import { enterFrames } from "../src/anim";
import { drawsScrim } from "../src/scrim";

/**
 * CardRow's timing (§161, plan Task 4): one card per beat with no word
 * timings, each card on its own words when the plan matched them, and the
 * highlight's bump after the whole row has landed.
 */

const FPS = 30;
const DURATION = 300;
const props = CardRowProps.parse({
  cards: [{ text: "Draft" }, { text: "Review" }, { text: "Ship" }],
  highlight: 1,
});

/** A cue starting at 10 s with the given absolute item times. */
const timed = (itemAtSec?: (number | null)[], durationInFrames = DURATION) => ({
  cueStartSec: 10,
  durationInFrames,
  itemAtSec,
});

describe("cardRowDelays", () => {
  it("with no word timings the cards build one per beat (beatStarts: 0.25 s, then every 0.7 s)", () => {
    expect(cardRowDelays(props, FPS)).toEqual([8, 29, 50]);
    // A cue with no item times and no reveal prop touched is the same path.
    expect(cardRowDelays(props, FPS, timed(undefined))).toEqual([8, 29, 50]);
  });

  it("a short cue holds the beats to the last frame an entrance can finish by", () => {
    const short = 40;
    const latest = short - enterFrames(FPS);
    expect(cardRowDelays(props, FPS, timed(undefined, short))).toEqual([8, latest, latest]);
  });

  it("matched words put each card on its own word", () => {
    // Words at 10.5 s, 11.5 s and 12.9 s into a cue starting at 10 s.
    expect(cardRowDelays(props, FPS, timed([10.5, 11.5, 12.9]))).toEqual([15, 45, 87]);
  });

  it("touching a reveal prop leaves the beat path for the shared schedule", () => {
    const paced = CardRowProps.parse({ ...props, reveal: "paced" });
    const delays = cardRowDelays(paced, FPS, timed(undefined));
    expect(delays[0]).toBe(0);
    expect(delays).not.toEqual([8, 29, 50]);
  });
});

describe("cardRowBumpFrame", () => {
  it("bumps the highlight once the last card has popped in (0.35 s)", () => {
    expect(cardRowBumpFrame(props, [8, 29, 50], FPS)).toBe(50 + 11);
  });

  it("no highlight, or one naming no card, never bumps", () => {
    const plain = CardRowProps.parse({ cards: [{ text: "A" }, { text: "B" }] });
    expect(cardRowBumpFrame(plain, [8, 29], FPS)).toBeNull();
    const past = CardRowProps.parse({ cards: [{ text: "A" }, { text: "B" }], highlight: 3 });
    expect(cardRowBumpFrame(past, [8, 29], FPS)).toBeNull();
  });
});

describe("CardRow over live video", () => {
  it("draws no scrim in any layout: it sits on the speaker like the clips it replaces", () => {
    expect(drawsScrim("full-bleed", "CardRow")).toBe(false);
    expect(drawsScrim("lower-third", "CardRow")).toBe(false);
  });
});
