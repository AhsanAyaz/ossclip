import { describe, expect, it } from "vitest";
import { defaultTheme } from "@ossclip/core/browser";
import {
  captionFontFamilyFor,
  captionLineHeightFor,
  captionStrokePx,
  captionTypography,
  resolveCaptionFontSize,
} from "../src/CaptionTrack";
import { captionFontSizeFor, LANDSCAPE_FRAME, PORTRAIT_FRAME } from "../src/stage";

// Pure resolution math only: CaptionTrack itself renders inside Remotion's
// frame context, and this package deliberately carries no jsdom/react-dom to
// stand it up (the editor's caption-direction.test.ts owns the DOM-level
// contract). The cue-level precedence — `cue.captionY` beating the avoidance
// chain, `captionScale` multiplying the resolved size — lives inline in the
// component and stays covered by inspection + the editor's tests.

describe("resolveCaptionFontSize (frame-derived default, 2026-08-16)", () => {
  it("an explicit fontSizePx prop wins outright, in either frame", () => {
    expect(resolveCaptionFontSize(80, PORTRAIT_FRAME)).toBe(80);
    expect(resolveCaptionFontSize(80, LANDSCAPE_FRAME)).toBe(80);
    // 0 is a deliberate value, not an absence — nullish, never falsy.
    expect(resolveCaptionFontSize(0, LANDSCAPE_FRAME)).toBe(0);
  });

  it("unset resolves to the frame default — the single definition in stage.ts", () => {
    expect(resolveCaptionFontSize(undefined, PORTRAIT_FRAME)).toBe(64);
    expect(resolveCaptionFontSize(undefined, LANDSCAPE_FRAME)).toBe(44);
    expect(resolveCaptionFontSize(undefined, LANDSCAPE_FRAME)).toBe(
      captionFontSizeFor(LANDSCAPE_FRAME),
    );
  });
});

describe("captionStrokePx", () => {
  it("portrait output is byte-identical: the historical 64 keeps its 10px stroke", () => {
    expect(captionStrokePx(64)).toBe(10);
  });

  it("scales linearly with the font, so smaller landscape type keeps its letterforms", () => {
    expect(captionStrokePx(captionFontSizeFor(LANDSCAPE_FRAME))).toBeCloseTo(6.875, 10);
    // captionScale rides through: doubling the font doubles the stroke.
    expect(captionStrokePx(128)).toBe(2 * captionStrokePx(64));
  });
});

describe("captionTypography (theme wiring, F6 2026-08-16)", () => {
  it("no theme = the historical literals, byte for byte", () => {
    expect(captionTypography(undefined)).toEqual({
      fontFamily: "'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif",
      color: "white",
    });
  });

  it("the themeless fallbacks equal the default theme's values — so passing defaultTheme changes nothing visible", () => {
    const themed = captionTypography(defaultTheme);
    // The font literal IS defaultTheme.fontDisplay — one string, two homes,
    // pinned equal here so neither can drift without failing a test.
    expect(themed.fontFamily).toBe(captionTypography(undefined).fontFamily);
    expect(themed.fontFamily).toBe(defaultTheme.fontDisplay);
    // fg spells the same color as the literal ("white" vs "#FFFFFF") — the
    // CSS differs in bytes, the rendered pixel does not.
    expect(themed.color).toBe(defaultTheme.fg);
    expect(defaultTheme.fg.toUpperCase()).toBe("#FFFFFF");
  });

  it("a theme's fontDisplay and fg are honored", () => {
    const themed = captionTypography({
      ...defaultTheme,
      fontDisplay: "Georgia, serif",
      fg: "#FFEEDD",
    });
    expect(themed.fontFamily).toBe("Georgia, serif");
    expect(themed.color).toBe("#FFEEDD");
  });
});

describe("captionFontFamilyFor (bundled Nastaliq, 2026-08-17)", () => {
  it("an LTR line keeps the resolved stack BYTE-IDENTICAL — Latin captions must not change", () => {
    // The exact historical literal, pinned: prepending Nastaliq here would
    // silently reshape every English caption ever rendered.
    expect(
      captionFontFamilyFor("ltr", captionTypography(undefined).fontFamily),
    ).toBe("'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif");
  });

  it("an RTL line leads with the bundled face, base stack kept as fallback", () => {
    expect(
      captionFontFamilyFor("rtl", captionTypography(undefined).fontFamily),
    ).toBe(
      "'Noto Nastaliq Urdu', 'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif",
    );
  });

  it("a theme fontDisplay override (F6) survives as the RTL fallback stack, not a casualty", () => {
    const base = captionTypography({ ...defaultTheme, fontDisplay: "Georgia, serif" }).fontFamily;
    expect(captionFontFamilyFor("rtl", base)).toBe("'Noto Nastaliq Urdu', Georgia, serif");
    expect(captionFontFamilyFor("ltr", base)).toBe("Georgia, serif");
  });
});

describe("captionLineHeightFor", () => {
  it("LTR keeps the historical 1.15; RTL gets Nastaliq's deeper line box", () => {
    expect(captionLineHeightFor("ltr")).toBe(1.15);
    expect(captionLineHeightFor("rtl")).toBe(1.9);
  });
});
