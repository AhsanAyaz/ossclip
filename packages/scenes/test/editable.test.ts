import { describe, expect, it } from "vitest";
import { compensateEdits, editStyle } from "../src/editable";

describe("editStyle", () => {
  it("is empty when nothing was edited, so untouched elements keep their own styles", () => {
    expect(editStyle(undefined, "value")).toEqual({});
    expect(editStyle({}, "value")).toEqual({});
    expect(editStyle({ label: { dx: 4 } }, "value")).toEqual({});
  });

  it("translates by the nudge", () => {
    expect(editStyle({ value: { dx: 12, dy: -4 } }, "value").transform).toBe(
      "translate(12px, -4px)",
    );
  });

  it("appends scale, and defaults the missing axis to zero", () => {
    expect(editStyle({ value: { scale: 1.08 } }, "value").transform).toBe(
      "translate(0px, 0px) scale(1.08)",
    );
  });

  it("ignores a scale of exactly 1 rather than emitting a no-op transform", () => {
    expect(editStyle({ value: { dx: 2, scale: 1 } }, "value").transform).toBe(
      "translate(2px, 0px)",
    );
  });
});

describe("compensateEdits (PLAN Task 1 — drag lands where you drop it)", () => {
  it("divides the stored composition-px nudge by the wrapper's fill scale", () => {
    // The bug: editStyle renders INSIDE SceneLayer's `scale(fitScale)`
    // wrapper, so a stored delta of N composition px moved the element
    // N × fitScale px on screen — overshoot proportional to distance,
    // which is exactly what the author reported.
    const out = compensateEdits({ title: { dx: 100, dy: -40 } }, 2)!;
    expect(out.title).toEqual({ dx: 50, dy: -20 });
  });

  it("stored value renders back to the intended on-screen movement", () => {
    // Full round trip at the reported severity: 100px page drag, 380px
    // stage showing a 1080px composition, scene fitScale 2.
    const cssScale = 1080 / 380;
    const stored = 100 * cssScale; // what Overlay.tsx commits (composition px)
    const fitScale = 2;
    const rendered = compensateEdits({ el: { dx: stored } }, fitScale)!.el!.dx!;
    const onScreen = rendered * fitScale * (1 / cssScale);
    expect(onScreen).toBeCloseTo(100, 6);
  });

  it("leaves scale nudges alone — scale composes multiplicatively either way", () => {
    expect(compensateEdits({ el: { scale: 1.2 } }, 3)!.el).toEqual({ scale: 1.2 });
  });

  it("is the identity at scale 1 and for absent edits", () => {
    const edits = { el: { dx: 5 } };
    expect(compensateEdits(edits, 1)).toBe(edits);
    expect(compensateEdits(undefined, 2)).toBeUndefined();
  });

  it("composes with editStyle into the counter-scaled translate", () => {
    const style = editStyle(compensateEdits({ el: { dx: 90, dy: 30 } }, 3), "el");
    expect(style.transform).toBe("translate(30px, 10px)");
  });
});
