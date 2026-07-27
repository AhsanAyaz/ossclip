import { describe, expect, it } from "vitest";
import { editStyle } from "../src/editable";

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
