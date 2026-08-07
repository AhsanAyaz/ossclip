import { describe, expect, it } from "vitest";
import { showCaptions } from "../src/caption-visibility";

describe("showCaptions (render-props back-compat, ProductionComposition's mount gate)", () => {
  // Every pre-feature render-props.json simply lacks the field — parsing one
  // and reading `.captionsHidden` yields undefined, which must mean VISIBLE:
  // captions are the default, the exact polarity flip of showWatermark.
  it("a pre-feature render-props.json keeps its captions", () => {
    const old = JSON.parse('{"videoFileName":"take.mp4","outputDurationSec":12}') as {
      captionsHidden?: boolean;
    };
    expect(showCaptions(old.captionsHidden)).toBe(true);
  });

  it("only a literal true hides — anything malformed falls back to the default, visible", () => {
    expect(showCaptions(true)).toBe(false);
    expect(showCaptions(false)).toBe(true);
    expect(showCaptions(undefined)).toBe(true);
    // A hand-edited render-props.json must not coerce the track away —
    // parse, never coerce (CLAUDE.md); for a default-ON feature the safe
    // reading of garbage is ON.
    expect(showCaptions("yes")).toBe(true);
    expect(showCaptions(1)).toBe(true);
  });
});
