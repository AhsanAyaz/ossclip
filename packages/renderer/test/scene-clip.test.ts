import { describe, expect, it } from "vitest";
import { defaultTheme, rebaseCue, type SceneCue } from "@ossclip/core/browser";
import { partialClipPath, sceneClipMetadata, type SceneClipProps } from "../src/scene-clip";

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
