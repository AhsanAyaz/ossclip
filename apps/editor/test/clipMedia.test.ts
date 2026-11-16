import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core/browser";
import { withMediaClipSrc } from "../src/clipMedia";

/**
 * The editor's Player reads the workdir only through `/media/*`, so a clip
 * cue's public-dir-relative `src` 404'd in the preview (explainer plan Task 8).
 */
const clip = (src: string): SceneCue => ({
  id: "scene-1",
  kind: "graphic",
  layout: "full-bleed",
  component: "ClipScene",
  props: { src, durationSec: 4.6, gainDb: -13, muted: false },
  startSec: 1,
  endSec: 5.6,
});
const card: SceneCue = {
  id: "scene-0",
  kind: "graphic",
  layout: "video-top",
  component: "TitleCard",
  props: { title: "HI", src: "clips/not-a-clip.webm" },
  startSec: 0,
  endSec: 1,
};

describe("withMediaClipSrc", () => {
  it("points a clip's src at /media/, leaving its other props alone", () => {
    const [out] = withMediaClipSrc([clip("clips/0123456789ab.webm")]);
    expect(out!.props).toEqual({ src: "/media/clips/0123456789ab.webm", durationSec: 4.6, gainDb: -13, muted: false });
  });

  it("does not mutate the cue it was given (the Inspector reads the original)", () => {
    const original = clip("clips/0123456789ab.webm");
    withMediaClipSrc([original]);
    expect(original.props!.src).toBe("clips/0123456789ab.webm");
  });

  it("touches only ClipScene cues", () => {
    const out = withMediaClipSrc([card, clip("clips/a.webm")]);
    expect(out[0]).toBe(card);
    expect(out[1]!.props!.src).toBe("/media/clips/a.webm");
  });

  it("leaves a URL or an already-rooted path as it is, and is idempotent", () => {
    expect(withMediaClipSrc([clip("https://cdn.example/a.webm")])[0]!.props!.src).toBe("https://cdn.example/a.webm");
    const once = withMediaClipSrc([clip("clips/a.webm")]);
    expect(withMediaClipSrc(once)[0]!.props!.src).toBe("/media/clips/a.webm");
  });

  it("returns the same list when there is no clip to rewrite", () => {
    const cues = [card];
    expect(withMediaClipSrc(cues)).toBe(cues);
  });
});
