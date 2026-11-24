import { describe, expect, it } from "vitest";
import { defaultTheme } from "@ossclip/core";
import { StoryboardProjectError, liveDrawProject } from "../src/storyboard/draw-project";

/**
 * The project a draw in the editor is drawn for (plan B2a Task 2; §169): the
 * frame and theme the editor shows now, from render-props.json and the saved
 * overrides.json, not production.json's. Pure, on file text.
 */

const base = { ...defaultTheme, accent: "#111111", bg: "#222222" };
const rendered = { ...defaultTheme, accent: "#999999", bg: "#888888" };
const props = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    settings: { width: 1080, height: 1920, fps: 30 },
    theme: rendered,
    baseTheme: base,
    // Everything else render-props.json holds is not this reader's business.
    spans: [],
    sceneCues: [],
    ...over,
  });

describe("liveDrawProject", () => {
  it("takes the frame from settings and the theme from baseTheme with the overrides' theme over it", () => {
    const project = liveDrawProject(props(), JSON.stringify({ theme: { accent: "#ff00aa" } }));
    expect(project).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(project.theme.accent).toBe("#ff00aa");
    // The rest of the theme is the base's, not the last render's.
    expect(project.theme.bg).toBe("#222222");
  });

  it("with no overrides.json the theme is the base as it is", () => {
    expect(liveDrawProject(props(), null).theme).toEqual(base);
  });

  it("falls back to theme when baseTheme is absent (a render-props.json from before it existed)", () => {
    const text = JSON.stringify({ settings: { width: 720, height: 1280, fps: 25 }, theme: rendered });
    const project = liveDrawProject(text, JSON.stringify({ theme: { accent: "#00ff00" } }));
    expect(project).toMatchObject({ width: 720, height: 1280, fps: 25 });
    expect(project.theme.accent).toBe("#00ff00");
    expect(project.theme.bg).toBe("#888888");
  });

  it("throws StoryboardProjectError naming render-props.json for a file that fails its schema", () => {
    expect(() => liveDrawProject("{}", null)).toThrow(StoryboardProjectError);
    expect(() => liveDrawProject("{}", null)).toThrow(/render-props\.json/);
    expect(() => liveDrawProject(props({ settings: { width: "wide", height: 1920, fps: 30 } }), null)).toThrow(
      StoryboardProjectError,
    );
  });

  it("throws StoryboardProjectError naming the file for text that is not JSON", () => {
    expect(() => liveDrawProject("not json", null)).toThrow(/render-props\.json/);
    expect(() => liveDrawProject(props(), "{ nope")).toThrow(StoryboardProjectError);
    expect(() => liveDrawProject(props(), "{ nope")).toThrow(/overrides\.json/);
  });

  it("refuses an overrides.json that fails its schema rather than drawing with the base theme", () => {
    expect(() => liveDrawProject(props(), JSON.stringify({ theme: { radiusPx: "round" } }))).toThrow(/overrides\.json/);
  });
});
