import { describe, expect, it } from "vitest";
import { normalizeRotation, rotationSwapsAxes } from "../src/ingest";

/**
 * R27 §119. A camera writes a portrait take as a landscape stream plus a 90°
 * display matrix. `probe()` used to report the raw stream size, but ffmpeg's
 * filter chain auto-rotates — so cropdetect, face measurement and the
 * mezzanine all worked in the DISPLAYED orientation while the pipeline
 * believed the raw one. The two got reconciled into a square that was never on
 * screen, and the render came out ~1.8x over-zoomed on a source that was
 * already 9:16 and needed no crop at all.
 */

describe("normalizeRotation", () => {
  it("reads a quarter turn from the display matrix", () => {
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  it("folds a signed matrix angle into [0, 360)", () => {
    // ffprobe reports the matrix angle signed; -90 and 270 are one quarter turn.
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
  });

  it("reads the legacy `rotate` tag, which is a string", () => {
    expect(normalizeRotation("90")).toBe(90);
    expect(normalizeRotation("270")).toBe(270);
  });

  it("treats a missing or unusable value as upright", () => {
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation("not a number")).toBe(0);
  });

  it("refuses to swap an axis on a rotation that is not a quarter turn", () => {
    // A 45° matrix cannot exchange width and height; guessing would be worse
    // than leaving the frame as measured.
    expect(normalizeRotation(45)).toBe(0);
  });
});

describe("rotationSwapsAxes", () => {
  it("swaps on a quarter turn only", () => {
    expect(rotationSwapsAxes(90)).toBe(true);
    expect(rotationSwapsAxes(270)).toBe(true);
    expect(rotationSwapsAxes(0)).toBe(false);
    expect(rotationSwapsAxes(180)).toBe(false);
  });

  it("the motivating case: a 3840x2160 stream at 90° displays as 2160x3840", () => {
    const raw = { w: 3840, h: 2160 };
    const swap = rotationSwapsAxes(normalizeRotation(90));
    expect({ w: swap ? raw.h : raw.w, h: swap ? raw.w : raw.h }).toEqual({ w: 2160, h: 3840 });
    // And that displayed frame is already the 9:16 target — nothing to crop.
    expect(2160 / 3840).toBeCloseTo(9 / 16, 10);
  });
});
