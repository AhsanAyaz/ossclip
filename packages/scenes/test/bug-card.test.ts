import { describe, expect, it } from "vitest";
import { BugCardProps } from "@ossclip/core/browser";
import {
  BUG_FAULT_SEC,
  bugFrameState,
  bugTimeline,
  shakePx,
  strikeProgress,
} from "../src/components/BugCard";
import { bugCardMetrics, bugMockVisible, bugStickerText, bugWrongIndex } from "../src/fit";
import { PATTERN_DEFAULT_SCENE_SEC, patternSceneSec } from "../src/reveal";
import { ctaSceneSec } from "../src/components/CtaCard";
import { drawsScrim } from "../src/scrim";

/**
 * BugCard (§161, plan Task 6): what is drawn, and when, as pure functions of
 * the props and the cue — so the stills at 1.6 s and 5.4 s are the same
 * pixels on every run, and a classic render never moves.
 */

describe("bugMockVisible", () => {
  const caption = { mock: "caption" as const, mockLines: ["the", "raw", "tkae"] };

  it("draws a caption or lines mock in 16:9", () => {
    expect(bugMockVisible(caption, "16:9")).toBe(true);
    expect(bugMockVisible({ ...caption, mock: "lines" }, "16:9")).toBe(true);
  });

  it("not for mock none, not with nothing to show, never in 9:16", () => {
    expect(bugMockVisible({ ...caption, mock: "none" }, "16:9")).toBe(false);
    expect(bugMockVisible({ ...caption, mockLines: [] }, "16:9")).toBe(false);
    // Blank entries are nothing to show either: an empty box is not a mock.
    expect(bugMockVisible({ ...caption, mockLines: ["", "  "] }, "16:9")).toBe(false);
    expect(bugMockVisible(caption, "9:16")).toBe(false);
  });
});

describe("bugWrongIndex", () => {
  it("is mockWrong when it names a non-blank entry, else null", () => {
    expect(bugWrongIndex({ mockLines: ["a", "b"], mockWrong: 1 })).toBe(1);
    expect(bugWrongIndex({ mockLines: ["a", "b"] })).toBeNull();
    expect(bugWrongIndex({ mockLines: ["a", "b"], mockWrong: 2 })).toBeNull();
    expect(bugWrongIndex({ mockLines: ["a", ""], mockWrong: 1 })).toBeNull();
  });
});

describe("bugStickerText", () => {
  it("is the sticker, or null when there is none", () => {
    expect(bugStickerText({ sticker: "WATCH THE EDGE", sub: "and viewers notice" })).toBe("WATCH THE EDGE");
    expect(bugStickerText({ sticker: "NO RETRY LOOP!" })).toBe("NO RETRY LOOP!");
    expect(bugStickerText({ sub: "x" })).toBeNull();
    expect(bugStickerText({ sticker: "" })).toBeNull();
  });

  it("drops a sticker that repeats the sub, ignoring case and surrounding punctuation", () => {
    // The acceptance run's planner wrote the consequence twice (§161).
    expect(bugStickerText({ sub: "wipes captions", sticker: "WIPES CAPTIONS" })).toBeNull();
    expect(bugStickerText({ sub: "Wipes captions.", sticker: "“wipes captions!”" })).toBeNull();
    expect(bugStickerText({ sub: "  wipes captions ", sticker: "wipes captions" })).toBeNull();
    // Only the whole of it: a sticker that shares words is its own beat.
    expect(bugStickerText({ sub: "wipes captions", sticker: "WIPED" })).toBe("WIPED");
    expect(bugStickerText({ sub: "wipes the captions", sticker: "wipes captions" })).toBe("wipes captions");
  });

  it("a dropped sticker reserves no room in the layout", () => {
    const p = {
      number: 1,
      headline: "Cut word",
      sub: "wipes captions",
      mock: "none" as const,
      mockLines: [],
      mockFault: "struck" as const,
    };
    const none = bugCardMetrics(p, 1920, 1080);
    expect(bugCardMetrics({ ...p, sticker: "Wipes captions!" }, 1920, 1080)).toEqual(none);
    expect(none.sticker).toBeNull();
  });
});

describe("a lines mock with mockFault 'clipped'", () => {
  // The acceptance run's planner wrote `mock: "lines"` with
  // `mockFault: "clipped"` (§161). Clipping is a caption fault; a code
  // line has no edge to run off, so it must play as a marked line.
  const lines = {
    number: 1,
    headline: "Captions jump",
    mock: "lines" as const,
    mockLines: ["word by word", "jump left"],
    mockWrong: 1,
  };

  it("lays out exactly as struck: the wrong line marked, no clipped row", () => {
    const clipped = bugCardMetrics({ ...lines, mockFault: "clipped" }, 1920, 1080);
    expect(clipped).toEqual(bugCardMetrics({ ...lines, mockFault: "struck" }, 1920, 1080));
    expect(clipped.wrongIndex).toBe(1);
    expect(clipped.gutterPx).toBeGreaterThan(0);
    expect(clipped.clipRow).toBe(-1);
  });

  it("plays its fault: the line turns red and shakes", () => {
    const m = bugCardMetrics({ ...lines, mockFault: "clipped" }, 1920, 1080);
    const tl = bugTimeline({ sub: false, mock: m.mockPanel !== null, fault: m.wrongIndex !== null, sticker: false }, 6);
    expect(tl.faultSec).not.toBeNull();
    // A quarter of the shake's 0.1 s period in: the swing's first peak.
    const s = bugFrameState(tl.faultSec! + 0.025, tl, true);
    expect(s.faultOn).toBe(true);
    expect(s.shakePx).toBeGreaterThan(0);
  });
});

describe("bugTimeline", () => {
  const all = { sub: true, mock: true, fault: true, sticker: true };

  it("builds badge, headline, sub, mock, then the fault 0.6 s after the mock", () => {
    expect(bugTimeline(all, 6)).toMatchObject({
      badgeSec: 0.25,
      headlineSec: 0.55,
      subSec: 0.95,
      mockSec: 1.35,
    });
    expect(bugTimeline(all, 6).faultSec).toBeCloseTo(1.95, 10);
  });

  it("lands the sticker at two thirds of the scene, or 0.5 s after the fault when that is later", () => {
    expect(bugTimeline(all, 6).stickerSec).toBeCloseTo(4, 10);
    expect(bugTimeline(all, 7.4).stickerSec).toBeCloseTo((2 / 3) * 7.4, 10);
    // A 3 s cue: two thirds is 2.0 s, before the fault has finished.
    expect(bugTimeline(all, 3).stickerSec).toBeCloseTo(2.45, 10);
    expect(bugTimeline(all).stickerSec).toBeCloseTo((2 / 3) * PATTERN_DEFAULT_SCENE_SEC, 10);
  });

  it("leaves out what is not drawn; with no fault the sticker follows the last thing that is", () => {
    const tl = bugTimeline({ sub: false, mock: false, fault: false, sticker: false }, 6);
    expect(tl).toMatchObject({ subSec: null, mockSec: null, faultSec: null, stickerSec: null });
    // A fault needs a mock to play in.
    expect(bugTimeline({ ...all, mock: false }, 6).faultSec).toBeNull();
    // Short cue, no mock: half a second after the sub.
    expect(bugTimeline({ sub: true, mock: false, fault: false, sticker: true }, 1.5).stickerSec).toBeCloseTo(
      1.45,
      10,
    );
    expect(bugTimeline({ sub: false, mock: false, fault: false, sticker: true }, 1.5).stickerSec).toBeCloseTo(
      1.05,
      10,
    );
  });
});

describe("bugFrameState", () => {
  const tl = bugTimeline({ sub: true, mock: true, fault: true, sticker: true }, 7.4);

  it("explainer: nothing before the badge; each part arrives on its beat", () => {
    const s0 = bugFrameState(0.2, tl, true);
    expect(s0).toMatchObject({ panelScale: 0, badgeScale: 0, headline: 0, sub: 0, mockScale: 0, stickerOn: false });
    const s = bugFrameState(1.6, tl, true);
    expect(s.panelScale).toBe(1);
    expect(s.headline).toBe(1);
    expect(s.sub).toBe(1);
    // Mid-pop: 0.25 s into 0.35, past 1 on the overshoot.
    expect(s.mockScale).toBeGreaterThan(1);
    expect(s.fault).toBe(0);
    expect(s.faultOn).toBe(false);
  });

  it("plays the fault from 1.95 s and holds it", () => {
    expect(bugFrameState(1.94, tl, true).faultOn).toBe(false);
    const mid = bugFrameState(1.95 + BUG_FAULT_SEC / 2, tl, true);
    expect(mid.faultOn).toBe(true);
    expect(mid.fault).toBeGreaterThan(0);
    expect(mid.fault).toBeLessThan(1);
    expect(bugFrameState(5.4, tl, true)).toMatchObject({ fault: 1, faultOn: true, shakePx: 0 });
  });

  it("the sticker lands with a bump and settles at 1", () => {
    const at = tl.stickerSec!;
    expect(bugFrameState(at - 0.01, tl, true).stickerOn).toBe(false);
    expect(bugFrameState(at + 0.15, tl, true).stickerScale).toBeCloseTo(1.15, 6);
    expect(bugFrameState(5.4, tl, true)).toMatchObject({ stickerOn: true, stickerScale: 1 });
  });

  it("classic: everything present from the entrance, the fault in its final state, no bump or shake", () => {
    for (const t of [0, 0.6, 1.6, 2.1, 5.4]) {
      expect(bugFrameState(t, tl, false)).toEqual({
        panelScale: 1,
        badgeScale: 1,
        headline: 1,
        sub: 1,
        mockScale: 1,
        fault: 1,
        faultOn: true,
        shakePx: 0,
        stickerOn: true,
        stickerScale: 1,
      });
    }
    const none = bugTimeline({ sub: false, mock: true, fault: false, sticker: false }, 6);
    expect(bugFrameState(0, none, false)).toMatchObject({ fault: 0, faultOn: false, stickerOn: false });
  });
});

describe("shakePx", () => {
  it("is 0 outside the fault and inside 10 px during it", () => {
    expect(shakePx(0)).toBe(0);
    expect(shakePx(BUG_FAULT_SEC)).toBe(0);
    expect(shakePx(-1)).toBe(0);
    let peak = 0;
    for (let t = 0; t < BUG_FAULT_SEC; t += 0.005) peak = Math.max(peak, Math.abs(shakePx(t)));
    expect(peak).toBeGreaterThan(5);
    expect(peak).toBeLessThanOrEqual(10);
  });
});

describe("strikeProgress", () => {
  it("strikes words in turn at one speed across the entry", () => {
    expect(strikeProgress([4, 4], 0)).toEqual([0, 0]);
    expect(strikeProgress([4, 4], 0.25)).toEqual([0.5, 0]);
    expect(strikeProgress([4, 4], 0.75)).toEqual([1, 0.5]);
    expect(strikeProgress([4, 4], 1)).toEqual([1, 1]);
    expect(strikeProgress([0], 1)).toEqual([1]);
  });
});

describe("patternSceneSec", () => {
  it("is the cue's length, or 6 s with no timing; CtaCard reads the same function", () => {
    expect(patternSceneSec(30, { cueStartSec: 4, durationInFrames: 240 })).toBe(8);
    expect(patternSceneSec(30)).toBe(PATTERN_DEFAULT_SCENE_SEC);
    expect(ctaSceneSec).toBe(patternSceneSec);
  });
});

describe("BugCard", () => {
  it("props: number 1-9, at most four mock entries, defaults filled", () => {
    expect(BugCardProps.safeParse({ number: 0, headline: "X" }).success).toBe(false);
    expect(BugCardProps.safeParse({ number: 10, headline: "X" }).success).toBe(false);
    expect(BugCardProps.safeParse({ number: 1, headline: "X", mockLines: ["a", "b", "c", "d", "e"] }).success).toBe(
      false,
    );
    expect(BugCardProps.safeParse({ number: 1, headline: "X", mockLines: ["m".repeat(33)] }).success).toBe(false);
    expect(BugCardProps.safeParse({ number: 1, headline: "X", mockWrong: 4 }).success).toBe(false);
    expect(BugCardProps.safeParse({ number: 1, headline: "X", mock: "terminal" }).success).toBe(false);
    expect(BugCardProps.parse({ number: 1, headline: "The problem" })).toEqual({
      number: 1,
      headline: "The problem",
      mock: "none",
      mockLines: [],
      mockFault: "struck",
    });
  });

  it("draws no scrim in any layout: it sits on the speaker like the clips it replaces", () => {
    expect(drawsScrim("full-bleed", "BugCard")).toBe(false);
    expect(drawsScrim("lower-third", "BugCard")).toBe(false);
  });
});
