import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultTheme, type SceneCue } from "@ossclip/core/browser";
import type { SceneClipProps } from "../src/scene-clip";

/**
 * The kit clip's DOM, without a Remotion runtime (the editor's
 * scene-layer-structure.test.ts approach): `remotion` gets pass-through
 * stand-ins and the scenes barrel two markers, so the test sees exactly what
 * SceneClipComposition itself puts on the page. The frame is a variable the
 * test sets, so the fade can be read off the markup.
 */
let currentFrame = 0;
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children, style }: any) =>
    React.createElement("div", { "data-fill": "", style }, children),
  useCurrentFrame: () => currentFrame,
}));
vi.mock("@ossclip/scenes", () => ({
  BundledFonts: () => null,
  SceneLayer: ({ cues, flatPanel }: any) =>
    React.createElement("i", { "data-scene-layer": cues[0].id, "data-flat-panel": String(flatPanel) }),
}));

const { SceneClipComposition } = await import("../src/SceneClipComposition");

const props = (layout: SceneCue["layout"]): SceneClipProps => ({
  cue: {
    id: "scene-5",
    kind: "graphic",
    layout,
    component: "CardRow",
    props: { cards: [{ text: "A" }, { text: "B" }, { text: "C" }] },
    startSec: 0,
    endSec: 4,
  },
  theme: { ...defaultTheme, bg: "#3A4A5C" },
  settings: { width: 1920, height: 1080, fps: 30 },
});

const html = (layout: SceneCue["layout"], frame: number): string => {
  currentFrame = frame;
  return renderToStaticMarkup(React.createElement(SceneClipComposition, props(layout)));
};

describe("SceneClipComposition (§163, design 6)", () => {
  it("full-bleed: the scene layer alone on the transparent frame, exactly as before", () => {
    expect(html("full-bleed", 60)).toBe(
      '<div data-fill=""><i data-scene-layer="scene-5" data-flat-panel="true"></i></div>',
    );
  });

  it("graphic-only and pip-bubble: a full-frame theme background UNDER the scene layer", () => {
    for (const layout of ["graphic-only", "pip-bubble"] as const) {
      expect(html(layout, 60), layout).toBe(
        '<div data-fill="">' +
          '<div data-fill="" style="background:#3A4A5C;opacity:1"></div>' +
          '<i data-scene-layer="scene-5" data-flat-panel="true"></i>' +
          "</div>",
      );
    }
  });

  it("the background fades with the full render's ease: transparent on frame 0, part-way at 0.2 s", () => {
    expect(html("graphic-only", 0)).toContain('style="background:#3A4A5C;opacity:0"');
    const at02 = /opacity:([0-9.]+)/.exec(html("pip-bubble", 6))!;
    expect(Number(at02[1])).toBeGreaterThan(0);
    expect(Number(at02[1])).toBeLessThan(1);
  });
});
