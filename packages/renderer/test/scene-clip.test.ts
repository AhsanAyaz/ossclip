import { describe, expect, it } from "vitest";
import { defaultTheme, rebaseCue, type SceneCue } from "@ossclip/core/browser";
import { partialClipPath, sceneClipBackground, sceneClipMetadata, type SceneClipProps } from "../src/scene-clip";

const settings = { width: 1920, height: 1080, fps: 30 };

const stat = (startSec: number, endSec: number): SceneCue => ({
  id: "scene-3",
  kind: "graphic",
  layout: "video-top",
  component: "StatCard",
  props: { label: "STARS", value: "4,494", inverted: false },
  startSec,
  endSec,
});

describe("sceneClipMetadata", () => {
  it("a 137-frame cue at 30 fps is a 137-frame composition at the settings' size", () => {
    const props: SceneClipProps = {
      cue: { ...stat(0, 137 / 30) },
      theme: defaultTheme,
      settings,
    };
    expect(sceneClipMetadata(props)).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 137,
    });
  });

  it("runs exactly the scene's frame window in the full render, through rebaseCue", () => {
    // 62.2255 s → frame 1867 (1866.765 rounds up); 66.3 s → frame 1989. The
    // full render shows the scene for 122 frames, and so does the clip.
    const cue = rebaseCue(stat(62.2255, 66.3), 30);
    expect(sceneClipMetadata({ cue, theme: defaultTheme, settings }).durationInFrames).toBe(122);
  });

  it("follows the settings' frame rate and size", () => {
    const cue = rebaseCue(stat(10, 14), 60);
    expect(
      sceneClipMetadata({ cue, theme: defaultTheme, settings: { width: 1080, height: 1920, fps: 60 } }),
    ).toEqual({ width: 1080, height: 1920, fps: 60, durationInFrames: 240 });
  });
});

describe("partialClipPath", () => {
  it("puts .partial before the extension — Remotion checks the extension against the codec", () => {
    expect(partialClipPath("/kit/clips/scene-3-StatCard.mov")).toBe(
      "/kit/clips/scene-3-StatCard.partial.mov",
    );
  });

  it("keeps a dotted folder and a dotted stem intact", () => {
    expect(partialClipPath("/v.1/my.clip.mov")).toBe("/v.1/my.clip.partial.mov");
  });

  it("a name with no extension just gains the suffix", () => {
    expect(partialClipPath("/kit/clip")).toBe("/kit/clip.partial");
  });
});

describe("sceneClipBackground (§163, design 6: the solid and bubble backdrops)", () => {
  const card = (layout: SceneCue["layout"]): SceneClipProps => ({
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
    settings,
  });

  it("is null for every layout but graphic-only and pip-bubble, so their clips draw nothing new", () => {
    for (const layout of ["full-bleed", "lower-third", "video-top", "split-left", "split-right", "blurred-behind"] as const) {
      for (const frame of [0, 6, 60, 119]) expect(sceneClipBackground(card(layout), frame), layout).toBeNull();
    }
  });

  it("is the theme's background, fading in over the full render's 0.35 s and opaque mid-clip", () => {
    for (const layout of ["graphic-only", "pip-bubble"] as const) {
      const p = card(layout);
      expect(sceneClipBackground(p, 0)).toEqual({ color: "#3A4A5C", opacity: 0 });
      // 0.2 s = frame 6 at 30 fps: inside the ease.
      const fading = sceneClipBackground(p, 6)!.opacity;
      expect(fading).toBeGreaterThan(0);
      expect(fading).toBeLessThan(1);
      expect(sceneClipBackground(p, 60)).toEqual({ color: "#3A4A5C", opacity: 1 });
      // The last frame (t = 119/30) is inside the fade out.
      expect(sceneClipBackground(p, 119)!.opacity).toBeLessThan(1);
    }
  });

  it("carries the cue's own backdropColor, and theme.bg without one (backdrop-color §3)", () => {
    const base = card("graphic-only");
    const coloured = { ...base, cue: { ...base.cue, backdropColor: "#ff0000" } };
    expect(sceneClipBackground(coloured, 60)).toEqual({ color: "#ff0000", opacity: 1 });
    expect(sceneClipBackground(base, 60)).toEqual({ color: "#3A4A5C", opacity: 1 });
  });

  it("stays null for full-bleed whether or not the cue stores a colour", () => {
    const base = card("full-bleed");
    const coloured = { ...base, cue: { ...base.cue, backdropColor: "#ff0000" } };
    for (const frame of [0, 60, 119]) {
      expect(sceneClipBackground(base, frame)).toBeNull();
      expect(sceneClipBackground(coloured, frame)).toBeNull();
    }
  });

  it("reads time as frame ÷ the clip's fps", () => {
    const p = { ...card("graphic-only"), settings: { ...settings, fps: 60 } };
    // Frame 12 at 60 fps is 0.2 s, the same instant as frame 6 at 30.
    expect(sceneClipBackground(p, 12)!.opacity).toBeCloseTo(sceneClipBackground(card("graphic-only"), 6)!.opacity, 12);
  });
});
