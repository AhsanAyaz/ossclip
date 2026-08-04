// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultTheme, type SceneCue } from "@ossclip/core/browser";
import { findEditableFrom } from "../src/hitTest";

/**
 * SceneLayer needs Remotion's frame/timing context (`useCurrentFrame`,
 * `useVideoConfig`, and `spring` via `anim.ts`'s `useEnter`, which every
 * scene component calls) and renders inside `<Sequence>`. Standing up a real
 * `<Player>` in jsdom to get that context would be slow and beside the
 * point — this test is about DOM STRUCTURE (does the editor's attribute walk
 * still reach through `EntranceRise`/`ExitFade`?), not frame math, which
 * Task 1/2's `motion.test.ts` already covers exhaustively. Mocking
 * `remotion` with plain pass-through stand-ins gives a deterministic tree
 * without a Player.
 *
 * Imported directly from `SceneLayer`'s own module rather than through
 * `@ossclip/scenes`'s barrel (`src/index.ts`) — the barrel also re-exports
 * `EdlVideo`/`CaptionTrack`/`VideoStage`, which pull in `OffthreadVideo` and
 * other remotion exports SceneLayer itself never touches. Going straight to
 * the module keeps this mock to exactly what SceneLayer's own import graph
 * needs: itself, `anim.ts` (every component's `useEnter`), and
 * `ScreenshotFrame` (the one component that talks to remotion directly) —
 * eight exports, all inert stand-ins since only TitleCard is ever rendered.
 */
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children, style }: any) => React.createElement("div", { style }, children),
  Sequence: ({ children }: any) => React.createElement(React.Fragment, null, children),
  useCurrentFrame: () => 15,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 900 }),
  spring: () => 1,
  Img: ({ src, style }: any) => React.createElement("img", { src, style }),
  interpolate: (_input: number, _inputRange: number[], outputRange: number[]) =>
    outputRange[outputRange.length - 1],
  staticFile: (path: string) => path,
}));

const { SceneLayer } = await import("../../../packages/scenes/src/SceneLayer");

describe("SceneLayer — the editor's attribute walk survives EntranceRise/ExitFade", () => {
  it("keeps data-edit-id leaves reachable from data-edit-scene through both wrappers", () => {
    // lower-third: an OVER_VIDEO layout, so the scrim sits inside both
    // wrappers too — the structural claim the task brief made about the
    // scrim arriving/leaving WITH its card, not exposed by a plain layout.
    const cue: SceneCue = {
      id: "scene-0",
      kind: "graphic",
      layout: "lower-third",
      component: "TitleCard",
      props: { title: "SHIP IT", eyebrow: "BREAKING" },
      startSec: 0,
      endSec: 30,
      // A per-element nudge, so compensateEdits/editStyle's path through the
      // fill-scaled wrapper is exercised too, not just an untouched leaf.
      elements: { title: { dx: 12, dy: -4 } },
    };

    const markup = renderToStaticMarkup(
      React.createElement(SceneLayer, { cues: [cue], theme: defaultTheme }),
    );
    document.body.innerHTML = markup;

    const sceneBox = document.querySelector("[data-edit-scene]");
    expect(sceneBox).not.toBeNull();
    expect(sceneBox?.getAttribute("data-edit-scene")).toBe("scene-0");

    const leaf = document.querySelector('[data-edit-id="title"]');
    expect(leaf).not.toBeNull();

    // The exact walk hitTest.ts does on a real click — proves the leaf's
    // nearest `[data-edit-scene]` ancestor is still the cue's own box, i.e.
    // neither EntranceRise nor ExitFade broke or rerouted the ancestry.
    expect(findEditableFrom(leaf)).toEqual({ sceneId: "scene-0", elementId: "title" });
  });
});
