import { describe, expect, it } from "vitest";
import { clipVolume } from "../src/clip-scene";
import { drawsScrim } from "../src/scrim";

/**
 * ClipScene's two pure decisions (explainer plan Task 7). The component itself
 * is an `OffthreadVideo` fed by these, so the matrix runs without Remotion —
 * the SfxTrack / sfx-track.ts split.
 */

describe("clipVolume", () => {
  it("turns the registry's −13 dB default into a linear gain", () => {
    // 10^(−13/20): the clip's own audio sits well under the voice (spec 1.4).
    expect(clipVolume(-13, false)).toBeCloseTo(0.2239, 4);
  });

  it("is unity at 0 dB", () => {
    expect(clipVolume(0, false)).toBe(1);
  });

  it("is silent when muted, whatever the gain", () => {
    expect(clipVolume(0, true)).toBe(0);
    expect(clipVolume(-13, true)).toBe(0);
  });
});

describe("drawsScrim", () => {
  it("frosts a card over live video", () => {
    expect(drawsScrim("full-bleed", "TitleCard")).toBe(true);
    expect(drawsScrim("lower-third", "TitleCard")).toBe(true);
  });

  it("never frosts a clip, even over live video (spec 1.4: no scrim)", () => {
    expect(drawsScrim("full-bleed", "ClipScene")).toBe(false);
    expect(drawsScrim("lower-third", "ClipScene")).toBe(false);
  });

  it("never frosts a layout whose slot sits on the stage background", () => {
    expect(drawsScrim("graphic-only", "TitleCard")).toBe(false);
    expect(drawsScrim("video-top", "StatCard")).toBe(false);
    expect(drawsScrim("blurred-behind", "ChatMock")).toBe(false);
    expect(drawsScrim("pip-bubble", "TitleCard")).toBe(false);
  });
});
