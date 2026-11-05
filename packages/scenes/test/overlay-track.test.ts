import type React from "react";
import { describe, expect, it } from "vitest";
import type { CaptionLine, SceneCue } from "@ossclip/core/browser";
import {
  cardBackdropOpacity,
  isGifFile,
  overlayCuesFor,
  overlayEntranceScale,
  overlayFadeOut,
  overlayImageStyle,
  overlaySrc,
} from "../src/overlay-track";
import { overlayRect } from "../src/overlay-rect";
import {
  captionAnchorForLine,
  captionBlockBottom,
  captionBlockTop,
  captionBottomAtFor,
  captionLineHeightFor,
  captionTopAtFor,
  DEFAULT_CAPTION_ANCHOR,
  estimateCaptionRows,
  hiddenAtFrame,
} from "../src/CaptionTrack";
import { captionAnchorAvoiding, regionsDuring } from "../src/source-fit";
import { activeCueAt, layoutSlots, PORTRAIT_FRAME } from "../src/stage";

/**
 * The overlay track's pure half, plus the caption anchor chain it shares with
 * CaptionTrack. Pure, so it runs without Remotion or a DOM — the components
 * are maps over these functions.
 */

const good = {
  id: "gde@4",
  file: "library/gde.png",
  kind: "logo",
  look: "overlay",
  atSec: 1,
  endSec: 2.5,
};

describe("overlayCuesFor", () => {
  it("accepts a well-formed list", () => {
    expect(overlayCuesFor([good])).toEqual([good]);
  });

  it("reads an absent key as no track", () => {
    expect(overlayCuesFor(undefined)).toEqual([]);
    expect(overlayCuesFor(null)).toEqual([]);
    expect(overlayCuesFor("library/gde.png")).toEqual([]);
  });

  it("overlayCuesFor drops malformed entries", () => {
    const cues = overlayCuesFor([
      good,
      null,
      "x",
      { ...good, id: "" },
      { ...good, file: "" },
      { ...good, file: 3 },
      { ...good, kind: "video" },
      // A typo'd look must not silently draw an overlay for a card.
      { ...good, look: "crad" },
      { ...good, atSec: Number.NaN },
      { ...good, atSec: -1 },
      { ...good, atSec: "1" },
      { ...good, endSec: Number.POSITIVE_INFINITY },
      { ...good, endSec: 1 },
      { ...good, id: "ok", look: "card" },
    ]);
    expect(cues.map((c) => c.id)).toEqual(["gde@4", "ok"]);
  });

  it("strips unknown keys rather than passing them to the renderer", () => {
    expect(overlayCuesFor([{ ...good, extra: true }])).toEqual([good]);
  });
});

describe("isGifFile (ruling R8: by extension, never by kind)", () => {
  it("reads the extension", () => {
    expect(isGifFile("library/party.gif")).toBe(true);
    expect(isGifFile("library/party.GIF")).toBe(true);
    expect(isGifFile("/media/library/party.gif?v=2")).toBe(true);
    expect(isGifFile("library/gif.png")).toBe(false);
    expect(isGifFile("library/logo.svg")).toBe(false);
  });
});

describe("overlaySrc", () => {
  const resolve = (f: string) => `/static/${f}`;
  it("resolves a public-dir name through staticFile", () => {
    expect(overlaySrc("library/gde.png", resolve)).toBe("/static/library/gde.png");
  });
  it("passes rooted paths and URLs through (the editor's /media/…)", () => {
    expect(overlaySrc("/media/library/gde.png", resolve)).toBe("/media/library/gde.png");
    expect(overlaySrc("https://x.test/a.png", resolve)).toBe("https://x.test/a.png");
    expect(overlaySrc("http://x.test/a.png", resolve)).toBe("http://x.test/a.png");
  });
});

describe("fades", () => {
  it("overlayFadeOut is 1 until the last 0.25s, then reaches 0 at the end", () => {
    expect(overlayFadeOut(0, 45, 30)).toBe(1);
    expect(overlayFadeOut(37, 45, 30)).toBe(1);
    expect(overlayFadeOut(41, 45, 30)).toBeCloseTo(4 / 7.5);
    expect(overlayFadeOut(45, 45, 30)).toBe(0);
  });
  it("cardBackdropOpacity reaches 1 after 0.15s", () => {
    expect(cardBackdropOpacity(0, 30)).toBe(0);
    expect(cardBackdropOpacity(2, 30)).toBeCloseTo(2 / 4.5);
    expect(cardBackdropOpacity(5, 30)).toBe(1);
  });
});

/**
 * Where the entrance scale's pixels actually land, read back from the style
 * the image element gets: CSS `scale(s)` about `center bottom` of THIS
 * element keeps its bottom edge and pulls the rest toward it.
 */
function visualRect(style: React.CSSProperties): { top: number; bottom: number; left: number; right: number } {
  const pctOf = (v: unknown) => Number.parseFloat(String(v)) / 100;
  const s = Number(/scale\(([^)]+)\)/.exec(String(style.transform ?? "scale(1)"))![1]);
  expect(style.transformOrigin ?? "center bottom").toBe("center bottom");
  const top = pctOf(style.top);
  const h = pctOf(style.height);
  const left = pctOf(style.left);
  const w = pctOf(style.width);
  const bottom = top + h;
  return { top: bottom - s * h, bottom, left: left + (w * (1 - s)) / 2, right: left + w - (w * (1 - s)) / 2 };
}

describe("overlay entrance never reaches the captions (review round 1)", () => {
  // The bug: the scale sat on a FULL-FRAME layer with origin center bottom,
  // i.e. the frame's bottom edge — at 0.9 a box ending at 0.64 drew down to
  // 0.676, into the caption block.
  it("scales about the image's own bottom edge, inside its static box, at every progress", () => {
    for (const captionTop of [0.66, 0.3]) {
      const box = overlayRect({ frame: PORTRAIT_FRAME, captionTop });
      for (const p of [0, 0.25, 0.44, 1]) {
        const style = overlayImageStyle(box, overlayEntranceScale(p));
        // The transform rides the SAME element that carries the box's position.
        expect(style.position).toBe("absolute");
        expect(style.transform).toBe(`scale(${overlayEntranceScale(p)})`);
        const v = visualRect(style);
        expect(v.bottom).toBeLessThanOrEqual(box.y + box.h + 1e-9);
        expect(v.bottom).toBeLessThan(captionTop);
        expect(v.top).toBeGreaterThanOrEqual(box.y - 1e-9);
        expect(v.left).toBeGreaterThanOrEqual(box.x - 1e-9);
        expect(v.right).toBeLessThanOrEqual(box.x + box.w + 1e-9);
      }
    }
  });

  it("starts at pop's 0.9 and settles at 1", () => {
    expect(overlayEntranceScale(0)).toBeCloseTo(0.9);
    expect(overlayEntranceScale(1)).toBe(1);
  });

  it("no scale → no transform (the card's image)", () => {
    const style = overlayImageStyle({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(style.transform).toBeUndefined();
    expect(style.transformOrigin).toBeUndefined();
  });
});

describe("hiddenAtFrame (card windows hide captions)", () => {
  it("matches the card Sequence's own frame window", () => {
    // frameWindow(1, 3, 30) → frames [30, 90).
    const windows = [{ start: 1, end: 3 }];
    expect(hiddenAtFrame(29, windows, 30)).toBe(false);
    expect(hiddenAtFrame(30, windows, 30)).toBe(true);
    expect(hiddenAtFrame(89, windows, 30)).toBe(true);
    expect(hiddenAtFrame(90, windows, 30)).toBe(false);
    expect(hiddenAtFrame(30, [], 30)).toBe(false);
  });
});

/**
 * The chain as CaptionTrack inlined it before the extraction — copied here
 * verbatim so the shared helper is pinned to the behaviour it replaced.
 */
function priorAnchor(
  cues: SceneCue[],
  sourceTextRegions: { y: number; h: number; startSec?: number; endSec?: number }[],
  line: { start: number; end: number },
  verticalAnchor: number,
): number {
  const active = cues.length > 0 ? activeCueAt(cues, line.start) : null;
  return active?.captionY !== undefined
    ? active.captionY
    : cues.length > 0 || sourceTextRegions.length > 0
      ? captionAnchorAvoiding(
          active?.layout ?? "full-bleed",
          regionsDuring(sourceTextRegions, line.start, line.end),
          active?.graphicRect,
          PORTRAIT_FRAME,
        )
      : verticalAnchor;
}

describe("captionAnchorForLine reproduces CaptionTrack's prior anchors", () => {
  const line = { start: 1, end: 2 };
  const base: SceneCue = { id: "a", layout: "full-bleed", startSec: 0, endSec: 4 };

  it("captionY wins outright, captionScale rides along", () => {
    const cues = [{ ...base, captionY: 0.3, captionScale: 1.4 }];
    const regions = [{ y: 0.25, h: 0.1 }];
    expect(captionAnchorForLine(cues, regions, line, PORTRAIT_FRAME, 0.76)).toEqual({
      anchor: 0.3,
      scale: 1.4,
    });
    expect(priorAnchor(cues, regions, line, 0.76)).toBe(0.3);
  });

  it("avoiding path: cues or regions present", () => {
    const cases: Array<[SceneCue[], { y: number; h: number }[]]> = [
      [[base], []],
      [[{ ...base, layout: "lower-third" }], []],
      // A hand-moved rect over the default anchor moves the caption (R11 Task 2b).
      [[{ ...base, layout: "blurred-behind", component: "StatCard", props: {}, graphicRect: { x: 0.07, y: 0.62, w: 0.77, h: 0.12 } }], []],
      [[], [{ y: 0.65, h: 0.1 }]],
      [[base], [{ y: 0.65, h: 0.1 }]],
    ];
    for (const [cues, regions] of cases) {
      const got = captionAnchorForLine(cues, regions, line, PORTRAIT_FRAME, 0.76);
      expect(got.anchor).toBe(priorAnchor(cues, regions, line, 0.76));
      expect(got.scale).toBe(1);
    }
    // And the moved rect really did move it, so the case above is not vacuous.
    expect(captionAnchorForLine(cases[2]![0], [], line, PORTRAIT_FRAME, 0.76).anchor).not.toBe(
      layoutSlots("blurred-behind").captionAnchor,
    );
  });

  it("plain anchor: no cues, no regions → the caller's verticalAnchor", () => {
    expect(captionAnchorForLine([], [], line, PORTRAIT_FRAME, 0.76)).toEqual({ anchor: 0.76, scale: 1 });
    expect(DEFAULT_CAPTION_ANCHOR).toBe(0.76);
  });
});

const word = (text: string, start: number) => ({ text, start, end: start + 0.3, srcStart: start });
const captionLine = (texts: string[], start: number, end: number): CaptionLine => ({
  words: texts.map((t, i) => word(t, start + i * 0.3)),
  start,
  end,
});

describe("caption block top", () => {
  it("estimateCaptionRows wraps greedily and is never 0", () => {
    expect(estimateCaptionRows([], 64, 800)).toBe(1);
    expect(estimateCaptionRows(["ship", "it"], 64, 800)).toBe(1);
    // 12 letters × 0.66em × 64px ≈ 507px per word: two don't share 800px.
    expect(estimateCaptionRows(["abcdefghijkl", "abcdefghijkl"], 64, 800)).toBe(2);
  });

  it("is the anchor minus half the block, at CaptionTrack's own line height", () => {
    const l = captionLine(["ship", "it"], 1, 2);
    const top = captionBlockTop(l, { frame: PORTRAIT_FRAME });
    expect(top).toBeCloseTo(0.76 - (64 * captionLineHeightFor("ltr")) / 1920 / 2);
  });

  it("captionScale and a wrapped second row raise the top", () => {
    const short = captionLine(["ship", "it"], 1, 2);
    const long = captionLine(["abcdefghijkl", "abcdefghijkl"], 1, 2);
    const cues: SceneCue[] = [{ id: "a", layout: "full-bleed", startSec: 0, endSec: 4, captionY: 0.7 }];
    const scaled: SceneCue[] = [{ ...cues[0]!, captionScale: 2 }];
    const one = captionBlockTop(short, { frame: PORTRAIT_FRAME, cues });
    expect(captionBlockTop(long, { frame: PORTRAIT_FRAME, cues })).toBeLessThan(one);
    expect(captionBlockTop(short, { frame: PORTRAIT_FRAME, cues: scaled })).toBeLessThan(one);
  });

  it("captionTopAtFor: null between lines, the highest top when two share a moment", () => {
    const a = captionLine(["ship", "it"], 1, 2);
    const b = captionLine(["abcdefghijkl", "abcdefghijkl"], 1.9, 3);
    const at = captionTopAtFor([a, b], { frame: PORTRAIT_FRAME });
    expect(at(0.5)).toBeNull();
    expect(at(1.5)).toBeCloseTo(captionBlockTop(a, { frame: PORTRAIT_FRAME }));
    expect(at(1.95)).toBeCloseTo(captionBlockTop(b, { frame: PORTRAIT_FRAME }));
    expect(at(3)).toBeNull();
  });

  it("captionBlockBottom mirrors the top about the anchor (ruling R19)", () => {
    const l = captionLine(["abcdefghijkl", "abcdefghijkl"], 1, 2);
    const top = captionBlockTop(l, { frame: PORTRAIT_FRAME });
    const bottom = captionBlockBottom(l, { frame: PORTRAIT_FRAME });
    expect((top + bottom) / 2).toBeCloseTo(0.76);
    expect(bottom - top).toBeCloseTo((2 * 64 * captionLineHeightFor("ltr")) / 1920);
  });

  it("captionBottomAtFor: null between lines, the LOWEST bottom when two share a moment", () => {
    const a = captionLine(["ship", "it"], 1, 2);
    const b = captionLine(["abcdefghijkl", "abcdefghijkl"], 1.9, 3);
    const at = captionBottomAtFor([a, b], { frame: PORTRAIT_FRAME });
    expect(at(0.5)).toBeNull();
    expect(at(1.5)).toBeCloseTo(captionBlockBottom(a, { frame: PORTRAIT_FRAME }));
    expect(at(1.95)).toBeCloseTo(captionBlockBottom(b, { frame: PORTRAIT_FRAME }));
    expect(at(1.95)).toBeGreaterThan(captionBlockBottom(a, { frame: PORTRAIT_FRAME }));
    expect(at(3)).toBeNull();
  });
});
