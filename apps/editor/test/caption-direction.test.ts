// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CaptionLine } from "@ossclip/core/browser";

/**
 * CaptionTrack renders inside Remotion's frame/timing context; standing up a
 * real <Player> in jsdom would be slow and beside the point (same reasoning
 * as scene-layer-structure.test.ts, which this mock is copied from). This
 * test is about the RTL layout decision (Urdu field test 2026-08-05): the
 * flex container carries `direction` from the LINE'S OWN text, while the DOM
 * order of the word spans — the order the editor's word ids and the
 * time-keyed highlight walk — stays spoken order in both directions.
 *
 * Imported from CaptionTrack's own module, not the barrel, so the mock only
 * has to cover what CaptionTrack itself touches.
 */
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children, style }: any) => React.createElement("div", { style }, children),
  Sequence: ({ children }: any) => React.createElement(React.Fragment, null, children),
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 900 }),
  // The bundled-Nastaliq loader (2026-08-17) mounts for these RTL fixtures
  // and takes a delayRender handle in useState — renderToStaticMarkup never
  // runs its effect, so inert stubs are all it touches here.
  staticFile: (p: string) => `/${p}`,
  delayRender: () => 0,
  continueRender: () => {},
}));

const { CaptionTrack } = await import("../../../packages/scenes/src/CaptionTrack");

/**
 * `srcStart` is distinct per word and never omitted (§137). This file is
 * outside every tsconfig's `include` (apps/editor's is `["src"]`), so nothing
 * would flag a missing `srcStart` here — and CaptionTrack owns the word ids
 * the retype override keys on, so words sharing an absent anchor would make
 * this test pass vacuously. No map exists in this fixture, so the values are
 * set equal to `start` purely as a stand-in; they carry no source semantics.
 */
const lineOf = (texts: string[], start = 0): CaptionLine => ({
  words: texts.map((text, i) => ({
    text,
    start: start + i * 0.3,
    end: start + i * 0.3 + 0.25,
    srcStart: start + i * 0.3,
  })),
  start,
  end: start + texts.length * 0.3,
});

describe("CaptionTrack — per-line direction (Urdu field test 2026-08-05)", () => {
  it("lays an Urdu line out RTL and an English line LTR, per line", () => {
    const markup = renderToStaticMarkup(
      React.createElement(CaptionTrack, {
        lines: [lineOf(["یہ", "ایک", "ٹاپک"], 0), lineOf(["this", "is", "english"], 2)],
      }),
    );
    expect(markup).toContain("direction:rtl");
    expect(markup).toContain("direction:ltr");
  });

  // A code-switched line opening with a Latin loanword resolves LTR by
  // first-strong — the language code alone must not force RTL.
  it("resolves a leading-Latin code-switched line LTR", () => {
    const markup = renderToStaticMarkup(
      React.createElement(CaptionTrack, { lines: [lineOf(["Fulfillment", "کیا", "ہے"])] }),
    );
    expect(markup).toContain("direction:ltr");
    expect(markup).not.toContain("direction:rtl");
  });

  it("keeps word spans in spoken order in the DOM — RTL is visual-only", () => {
    const markup = renderToStaticMarkup(
      React.createElement(CaptionTrack, { lines: [lineOf(["یہ", "ایک", "ٹاپک"])] }),
    );
    // data-caption-word ids must stay 0,1,2 in DOM order: the highlight is
    // keyed to each word's own start/end times, and the attribute is the
    // editor's hit-test hook for a double-click (Overlay.tsx's
    // `[data-caption-word]` selector) — CSS direction alone reverses the
    // visuals. The retype override no longer keys on these ids: it keys on
    // `data-caption-src`, the word's SOURCE time (§137), because a user cut
    // shifts every later index.
    const ids = [...markup.matchAll(/data-caption-word="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["0", "1", "2"]);
    const texts = [...markup.matchAll(/data-caption-text="([^"]*)"/g)].map((m) => m[1]);
    expect(texts).toEqual(["یہ", "ایک", "ٹاپک"]);
  });
});
