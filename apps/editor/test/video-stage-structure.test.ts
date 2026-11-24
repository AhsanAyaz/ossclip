// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultTheme, type SceneCue } from "@ossclip/core/browser";

/**
 * What VideoStage actually writes into the DOM for a scene's framing pan
 * (2026-11-20). The pure maths is pinned in stage.test.ts (`pipPanFor`);
 * this is the wiring: under pip-bubble the pan must reach the crop window
 * (the `--ossclip-obj-*` vars EdlVideo reads) instead of becoming a
 * translate that uncovers the backdrop, and every other layout must keep
 * today's translate. Same remotion stand-ins as scene-layer-structure.test.ts,
 * for the same reason: this is DOM structure, not frame timing. Frame 15 at
 * 30 fps is t = 0.5 s, past the 0.35 s layout ease, so the slot is settled.
 */
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children, style }: any) => React.createElement("div", { style }, children),
  useCurrentFrame: () => 15,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 900 }),
}));

const { VideoStage } = await import("../../../packages/scenes/src/VideoStage");

const cue = (layout: SceneCue["layout"], video?: SceneCue["video"]): SceneCue => ({
  id: "scene-0",
  layout,
  component: "TitleCard",
  props: { title: "X" },
  startSec: 0,
  endSec: 30,
  ...(video ? { video } : {}),
});

/** The content div: the one carrying the object-position vars. */
function content(c: SceneCue): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(
    React.createElement(VideoStage, { cues: [c], theme: defaultTheme }, React.createElement("i")),
  );
  const el = [...document.querySelectorAll<HTMLElement>("div")].find((d) =>
    d.style.getPropertyValue("--ossclip-obj-y"),
  );
  if (!el) throw new Error("no content div");
  return el;
}

describe("VideoStage — a framing pan in the speaker bubble (2026-11-20)", () => {
  it("pip-bubble: dy moves the crop window and emits no translate", () => {
    const plain = content(cue("pip-bubble"));
    const panned = content(cue("pip-bubble", { dy: 40 }));
    const y0 = Number.parseFloat(plain.style.getPropertyValue("--ossclip-obj-y"));
    const y1 = Number.parseFloat(panned.style.getPropertyValue("--ossclip-obj-y"));
    // Picture down = window up the source = a lower position.
    expect(y1).toBeLessThan(y0);
    expect(panned.style.transform).toBe("");
    expect(panned.style.getPropertyValue("--ossclip-obj-x")).toBe(
      plain.style.getPropertyValue("--ossclip-obj-x"),
    );
  });

  it("pip-bubble at scale 2: a huge dx is held to the box's overhang, never a gap", () => {
    const el = content(cue("pip-bubble", { scale: 2, dx: 5000 }));
    // 324 px bubble at 2× about its 50% x-origin overhangs 162 px each side.
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(2\)/.exec(el.style.transform);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(162, 6);
    expect(Number(m![2])).toBe(0);
  });

  it("full-bleed: the same pan is today's translate, and the crop window does not move", () => {
    const plain = content(cue("full-bleed"));
    const panned = content(cue("full-bleed", { dy: 40 }));
    expect(panned.style.transform).toBe("translate(0px, 40px)");
    expect(panned.style.getPropertyValue("--ossclip-obj-y")).toBe(
      plain.style.getPropertyValue("--ossclip-obj-y"),
    );
  });

  it("pip-bubble with no pan writes exactly what it always did", () => {
    const el = content(cue("pip-bubble", { scale: 1 }));
    expect(el.style.transform).toBe("");
  });
});
