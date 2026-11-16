import { describe, expect, it } from "vitest";
import { defaultTheme, type CaptionLine, type SceneCue } from "@ossclip/core/browser";
import {
  captionAnchorForLine,
  captionBlockBottom,
  captionBlockTop,
  captionFontFamilyFor,
  captionLineHeightFor,
  captionStrokePx,
  captionTypography,
  estimateCaptionRows,
  resolveCaptionFontSize,
  resolveChoreographedAnchor,
} from "../src/CaptionTrack";
import {
  captionThemeFor,
  pillTextColorFor,
  resolveCaptionThemeSpec,
} from "../src/caption-themes";
import { overlayGeometryFor } from "../src/overlay-room";
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

describe("caption-themes (resolveCaptionThemeSpec, captionThemeFor, pillTextColorFor)", () => {
  it("captionThemeFor validates known themes and falls back to 'default' on unknown values", () => {
    expect(captionThemeFor("founder")).toBe("founder");
    expect(captionThemeFor("punch")).toBe("punch");
    expect(captionThemeFor("boxed")).toBe("boxed");
    expect(captionThemeFor("minimal")).toBe("minimal");
    expect(captionThemeFor(undefined)).toBe("default");
    expect(captionThemeFor("bogus")).toBe("default");
    expect(captionThemeFor(123)).toBe("default");
  });

  it("pillTextColorFor computes WCAG contrast ink (#0A0A0C on bright accents, #FFFFFF on dark accents)", () => {
    expect(pillTextColorFor("#FFE14D")).toBe("#0A0A0C");
    expect(pillTextColorFor("#00E5FF")).toBe("#0A0A0C");
    expect(pillTextColorFor("#E11D48")).toBe("#FFFFFF");
    expect(pillTextColorFor("#1E1B4B")).toBe("#FFFFFF");
  });

  it("resolves all 5 theme presets with distinct reveal modes, font scales, and active word pills", () => {
    const def = resolveCaptionThemeSpec("default", defaultTheme, "ltr", 64);
    expect(def.revealMode).toBe("full-line");
    expect(def.fontScale).toBe(1.0);
    expect(def.fontWeight).toBe(900);
    expect(def.strokePx).toBe(10);
    expect(def.activeWordPill).toBeUndefined();
    expect(def.lineBoxStyle).toBeUndefined();

    const founder = resolveCaptionThemeSpec("founder", defaultTheme, "ltr", 64);
    expect(founder.revealMode).toBe("full-line");
    expect(founder.fontScale).toBe(0.92);
    expect(founder.fontWeight).toBe(800);
    expect(founder.letterSpacing).toBe("-0.02em");
    expect(founder.strokePx).toBe(2);
    expect(founder.inactiveOpacity).toBe(0.85);
    expect(founder.activeWordPill).toEqual({
      backgroundColor: defaultTheme.accent,
      color: pillTextColorFor(defaultTheme.accent),
      borderRadius: "0.22em",
      padding: "0.04em 0.22em",
      rotateDeg: 0,
      clearStroke: true,
      emphasisOnly: false,
    });

    const punch = resolveCaptionThemeSpec("punch", defaultTheme, "ltr", 64);
    expect(punch.revealMode).toBe("word-build");
    expect(punch.fontScale).toBe(1.08);
    expect(punch.textTransform).toBe("uppercase");
    expect(punch.strokePx).toBe(12);
    expect(punch.popScaleAmp).toBe(0.14);
    expect(punch.activeWordPill).toEqual({
      backgroundColor: defaultTheme.accent,
      color: "#FFFFFF",
      borderRadius: "0.18em",
      padding: "0.04em 0.20em",
      rotateDeg: -1.5,
      clearStroke: false,
      emphasisOnly: true,
    });

    const boxed = resolveCaptionThemeSpec("boxed", defaultTheme, "ltr", 64);
    expect(boxed.revealMode).toBe("full-line");
    expect(boxed.fontScale).toBe(0.95);
    expect(boxed.strokePx).toBe(0);
    expect(boxed.shadowStyle).toBe("none");
    expect(boxed.lineBoxStyle).toEqual({
      backgroundColor: "rgba(10, 10, 12, 0.86)",
      borderRadius: "0.28em",
      padding: "0.16em 0.45em",
    });

    const minimal = resolveCaptionThemeSpec("minimal", defaultTheme, "ltr", 64);
    expect(minimal.revealMode).toBe("word-build");
    expect(minimal.fontScale).toBe(0.84);
    expect(minimal.fontWeight).toBe(700);
    expect(minimal.strokePx).toBe(0);
    expect(minimal.inactiveOpacity).toBe(0.6);
  });

  it("enforces RTL Nastaliq guards on textTransform, letterSpacing, rotateDeg, and pill/box padding", () => {
    const punchRtl = resolveCaptionThemeSpec("punch", defaultTheme, "rtl", 64);
    expect(punchRtl.textTransform).toBe("none");
    expect(punchRtl.letterSpacing).toBe("normal");
    expect(punchRtl.activeWordPill?.rotateDeg).toBe(0);
    expect(punchRtl.activeWordPill?.padding).toBe("0.14em 0.28em");
    expect(punchRtl.activeWordPill?.color).toBe("#FFFFFF");

    const boxedRtl = resolveCaptionThemeSpec("boxed", defaultTheme, "rtl", 64);
    expect(boxedRtl.letterSpacing).toBe("normal");
    expect(boxedRtl.lineBoxStyle?.padding).toBe("0.28em 0.55em");
  });
});

describe("resolveChoreographedAnchor and captionAnchorForLine", () => {
  it("places a hook line in the upper free band above a low face and dodges watermark when present", () => {
    const hookLine: CaptionLine = {
      start: 0.0,
      end: 1.5,
      role: "hook",
      words: [{ text: "Wait", start: 0.0, end: 1.5, srcStart: 0.0, emphasisScale: 1.3 }],
    };
    const lowFace = { centerYFrac: 0.52, sizeFrac: 0.2 };
    const anchorNoWm = resolveChoreographedAnchor(
      hookLine,
      null,
      lowFace,
      [],
      PORTRAIT_FRAME,
      false,
    );
    expect(anchorNoWm).not.toBeNull();
    // Upper band between safe.top (0.12) and head.start (0.52 - 0.2 * 0.85 = 0.35) -> center ~0.235
    expect(anchorNoWm!).toBeGreaterThanOrEqual(0.18);
    expect(anchorNoWm!).toBeLessThanOrEqual(0.3);

    // With watermark=true, top 0.06 inside safe area [0.12, 0.18] is blocked, shifting the upper band down
    const anchorWithWm = resolveChoreographedAnchor(
      hookLine,
      null,
      lowFace,
      [],
      PORTRAIT_FRAME,
      true,
    );
    expect(anchorWithWm).not.toBeNull();
    expect(anchorWithWm!).toBeGreaterThan(anchorNoWm!);
  });

  it("falls back to Priority 3 when face is null, subject is 'screen', or activeCue is a full-bleed graphic", () => {
    const hookLine: CaptionLine = {
      start: 0.0,
      end: 1.5,
      role: "hook",
      words: [{ text: "Hook", start: 0.0, end: 1.5, srcStart: 0.0 }],
    };
    expect(
      resolveChoreographedAnchor(hookLine, null, null, [], PORTRAIT_FRAME, false),
    ).toBeNull();
    expect(
      resolveChoreographedAnchor(
        hookLine,
        null,
        { centerYFrac: 0.52, sizeFrac: 0.2, subject: "screen" },
        [],
        PORTRAIT_FRAME,
        false,
      ),
    ).toBeNull();

    const graphicFullBleedCue = {
      id: "c1",
      kind: "graphic",
      component: "TitleCard",
      layout: "full-bleed",
      startSec: 0,
      endSec: 3,
      props: {},
    } as unknown as SceneCue;
    expect(
      resolveChoreographedAnchor(
        hookLine,
        graphicFullBleedCue,
        { centerYFrac: 0.52, sizeFrac: 0.2 },
        [],
        PORTRAIT_FRAME,
        false,
      ),
    ).toBeNull();

    // Priority 1: explicit cue.captionY always wins over hook choreography
    const plainCueWithCaptionY = {
      id: "c2",
      kind: "plain",
      layout: "full-bleed",
      startSec: 0,
      endSec: 3,
      captionY: 0.62,
    } as unknown as SceneCue;
    const res = captionAnchorForLine(
      [plainCueWithCaptionY],
      [],
      hookLine,
      PORTRAIT_FRAME,
      0.76,
      { centerYFrac: 0.52, sizeFrac: 0.2 },
      false,
    );
    expect(res.anchor).toBe(0.62);
  });
});

describe("estimateCaptionRows, captionBlockExtent, and overlayGeometryFor with emphasis and theme", () => {
  it("increases estimated row count and block extent when words carry emphasisScale and theme fontScale", () => {
    const plainLine: CaptionLine = {
      start: 0,
      end: 2,
      words: [
        { text: "shipping", start: 0, end: 0.5, srcStart: 0 },
        { text: "autonomous", start: 0.5, end: 1.0, srcStart: 0.5 },
        { text: "production", start: 1.0, end: 1.5, srcStart: 1.0 },
        { text: "pipelines", start: 1.5, end: 2.0, srcStart: 1.5 },
      ],
    };
    const emphLine: CaptionLine = {
      ...plainLine,
      words: plainLine.words.map((w) => ({ ...w, emphasisScale: 1.4 })),
    };

    const plainRows = estimateCaptionRows(["shipping", "autonomous", "production", "pipelines"], 64, 864);
    const emphRows = estimateCaptionRows(
      ["shipping", "autonomous", "production", "pipelines"],
      64,
      864,
      [1.4, 1.4, 1.4, 1.4],
      true,
    );
    expect(emphRows).toBeGreaterThanOrEqual(plainRows);

    const plainTop = captionBlockTop(plainLine, { frame: PORTRAIT_FRAME });
    const punchEmphTop = captionBlockTop(emphLine, {
      frame: PORTRAIT_FRAME,
      captionTheme: "punch",
    });
    const plainBottom = captionBlockBottom(plainLine, { frame: PORTRAIT_FRAME });
    const punchEmphBottom = captionBlockBottom(emphLine, {
      frame: PORTRAIT_FRAME,
      captionTheme: "punch",
    });
    expect(punchEmphBottom - punchEmphTop).toBeGreaterThan(plainBottom - plainTop);
  });

  it("overlayGeometryFor forwards captionTheme, face, and watermark into captionTopAt and captionBottomAt", () => {
    const hookLine: CaptionLine = {
      start: 0,
      end: 1.5,
      role: "hook",
      words: [{ text: "Shipped", start: 0, end: 1.5, srcStart: 0, emphasisScale: 1.35 }],
    };
    const geomDefault = overlayGeometryFor({
      captionLines: [hookLine],
      sceneCues: [],
      frame: PORTRAIT_FRAME,
    });
    const geomHook = overlayGeometryFor({
      captionLines: [hookLine],
      sceneCues: [],
      frame: PORTRAIT_FRAME,
      captionTheme: "punch",
      face: { centerYFrac: 0.52, sizeFrac: 0.2 },
      watermark: true,
    });
    // With a measured low face, the hook line anchors near the top (~0.26) instead of 0.76
    expect(geomHook.captionTopAt(0.5)!).toBeLessThan(geomDefault.captionTopAt(0.5)!);
  });
});
