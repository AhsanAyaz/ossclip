import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  clearElementTransform,
  resolveTheme,
  setElementTransform,
} from "../src/overrides";
import { defaultTheme, type SceneCue } from "../src/scene-schema";

const cue = (id: string): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%", inverted: false },
  startSec: 0,
  endSec: 5,
});

describe("override document", () => {
  it("defaults to an empty doc", () => {
    const doc = OverrideDocSchema.parse({});
    expect(doc.scenes).toEqual({});
    expect(doc.theme).toEqual({});
  });

  it("applies prop overrides over the producer's props", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "999%" } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.props.value).toBe("999%");
    // Untouched props survive — this is a merge, not a replacement.
    expect(cues[0]!.props.label).toBe("CODE CHURN");
  });

  it("reports overrides whose scene no longer exists instead of dropping them silently", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-7": { props: { value: "1%" } } },
    });
    const { cues, orphans } = applyOverrides([cue("scene-0")], doc);
    expect(orphans).toEqual(["scene-7"]);
    expect(cues[0]!.props.value).toBe("861%");
  });

  it("carries element transforms onto the cue", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { elements: { value: { dx: 12, dy: -4, scale: 1.08 } } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.elements).toEqual({ value: { dx: 12, dy: -4, scale: 1.08 } });
  });

  it("applies scene timing overrides, which is what pinning means", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.startSec).toBe(2);
    expect(cues[0]!.endSec).toBe(6);
    expect(cues[0]!.pinned).toBe(true);
  });

  it("leaves an unpinned cue's derived timing alone", () => {
    const { cues } = applyOverrides([cue("scene-0")], OverrideDocSchema.parse({}));
    expect(cues[0]!.startSec).toBe(0);
    expect(cues[0]!.pinned).toBeFalsy();
  });

  it("merges theme tokens over the defaults", () => {
    const doc = OverrideDocSchema.parse({ theme: { accent: "#FF0000" } });
    const theme = resolveTheme(defaultTheme, doc);
    expect(theme.accent).toBe("#FF0000");
    expect(theme.bg).toBe(defaultTheme.bg);
  });

  it("sets and clears an element transform, and clearing REMOVES the entry", () => {
    // "reset" and "nudged to exactly 0,0" must stay distinguishable, so a
    // reset deletes rather than writing zeros.
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5 });
    doc = clearElementTransform(doc, "scene-0", "value");
    expect(doc.scenes["scene-0"]?.elements?.value).toBeUndefined();
  });

  it("merges successive transform patches instead of replacing them", () => {
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    doc = setElementTransform(doc, "scene-0", "value", { dy: -3 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5, dy: -3 });
  });
});
