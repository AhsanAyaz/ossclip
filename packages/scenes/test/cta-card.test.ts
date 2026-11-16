import { describe, expect, it } from "vitest";
import { CtaCardProps } from "@ossclip/core/browser";
import {
  CTA_DEFAULT_SCENE_SEC,
  ctaFrameState,
  ctaSceneSec,
  ctaTimeline,
} from "../src/components/CtaCard";
import { SUBSCRIBED_LABEL, SUBSCRIBE_LABEL, SEND_LABEL } from "../src/fit";
import { drawsScrim } from "../src/scrim";

/**
 * CtaCard's timing (§161, plan Task 5): every moment a pure function of the
 * cue, so a still at 1.8 s and a still at 5.4 s are the same pixels on every
 * run — the comment typed and its send pressed, the Subscribe press at 60%.
 */

describe("ctaTimeline", () => {
  it("a comment types from 0.5 s at 32 characters a second and presses send 0.3 s after", () => {
    // 16 characters take 0.5 s: typed by 1.0 s, pressed at 1.3 s.
    expect(ctaTimeline("comment", 16)).toEqual({ typeStartSec: 0.5, typeEndSec: 1.0, bumpSec: 1.3 });
    expect(ctaTimeline("comment", 0)).toEqual({ typeStartSec: 0.5, typeEndSec: 0.5, bumpSec: 0.8 });
  });

  it("subscribe presses at 60% of the scene, 6 s when the length is not known", () => {
    expect(ctaTimeline("subscribe", 18, 10).bumpSec).toBeCloseTo(6, 10);
    expect(ctaTimeline("subscribe", 18).bumpSec).toBeCloseTo(0.6 * CTA_DEFAULT_SCENE_SEC, 10);
    expect(ctaTimeline("subscribe", 18).typeStartSec).toBeNull();
  });

  it("a link only enters: nothing typed, nothing pressed", () => {
    expect(ctaTimeline("link", 16)).toEqual({ typeStartSec: null, typeEndSec: null, bumpSec: null });
  });
});

describe("ctaSceneSec", () => {
  it("is the cue's length, or 6 s with no timing", () => {
    expect(ctaSceneSec(30, { cueStartSec: 4, durationInFrames: 240 })).toBe(8);
    expect(ctaSceneSec(30)).toBe(CTA_DEFAULT_SCENE_SEC);
    expect(ctaSceneSec(30, { cueStartSec: 4, durationInFrames: 0 })).toBe(CTA_DEFAULT_SCENE_SEC);
  });
});

describe("ctaFrameState", () => {
  const comment = ctaTimeline("comment", 16);
  const subscribe = ctaTimeline("subscribe", 0, 6);

  it("types the field, caret solid while typing, then blinking on the field's own clock", () => {
    expect(ctaFrameState(0.4, comment, 16, true)).toMatchObject({ chars: 0, caret: true });
    expect(ctaFrameState(0.75, comment, 16, true)).toMatchObject({ chars: 8, caret: true });
    // Typed by 1.0 s; from then the blink runs from 0.5 s: on for [1.5, 2.0), off for [2.0, 2.5).
    expect(ctaFrameState(1.8, comment, 16, true)).toMatchObject({ chars: 16, caret: true });
    expect(ctaFrameState(2.2, comment, 16, true)).toMatchObject({ chars: 16, caret: false });
  });

  it("presses send once: 1 → 1.15 → 1 over 0.3 s from the press", () => {
    expect(ctaFrameState(1.29, comment, 16, true).buttonScale).toBe(1);
    expect(ctaFrameState(1.45, comment, 16, true).buttonScale).toBeCloseTo(1.15, 6);
    expect(ctaFrameState(1.6, comment, 16, true).buttonScale).toBe(1);
    expect(ctaFrameState(1.29, comment, 16, true).pressed).toBe(false);
    expect(ctaFrameState(5.4, comment, 16, true).pressed).toBe(true);
  });

  it("subscribe reads Subscribe until the press at 3.6 s, Subscribed from it", () => {
    expect(ctaFrameState(1.8, subscribe, 0, true)).toMatchObject({ pressed: false, caret: false });
    expect(ctaFrameState(3.59, subscribe, 0, true).pressed).toBe(false);
    expect(ctaFrameState(3.6, subscribe, 0, true).pressed).toBe(true);
    expect(ctaFrameState(5.4, subscribe, 0, true)).toMatchObject({ pressed: true, buttonScale: 1 });
  });

  it("a link draws its URL whole with no caret and no press", () => {
    expect(ctaFrameState(0.1, ctaTimeline("link", 11), 11, true)).toEqual({
      chars: 11,
      caret: false,
      buttonScale: 1,
      pressed: false,
    });
  });

  it("classic motion: the text whole from the first frame, no caret, no press, Subscribe stays", () => {
    for (const t of [0, 0.6, 1.4, 4, 5.4]) {
      expect(ctaFrameState(t, comment, 16, false)).toEqual({
        chars: 16,
        caret: false,
        buttonScale: 1,
        pressed: false,
      });
      expect(ctaFrameState(t, subscribe, 0, false).pressed).toBe(false);
    }
  });
});

describe("CtaCard", () => {
  it("the button words are fixed UI labels, not copy", () => {
    expect([SEND_LABEL, SUBSCRIBE_LABEL, SUBSCRIBED_LABEL]).toEqual(["Send", "Subscribe", "Subscribed"]);
  });

  it("props: an unknown action and an over-long text are rejected", () => {
    expect(CtaCardProps.safeParse({ action: "share", text: "Share it" }).success).toBe(false);
    expect(CtaCardProps.safeParse({ action: "link", text: "x".repeat(41) }).success).toBe(false);
    expect(CtaCardProps.safeParse({ action: "link", text: "x".repeat(40) }).success).toBe(true);
  });

  it("draws no scrim in any layout: it sits on the speaker like the clips it replaces", () => {
    expect(drawsScrim("full-bleed", "CtaCard")).toBe(false);
    expect(drawsScrim("lower-third", "CtaCard")).toBe(false);
  });
});
