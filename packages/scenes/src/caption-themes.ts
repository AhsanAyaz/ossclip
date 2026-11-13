import {
  CaptionThemeIdSchema,
  type CaptionThemeId,
  type Theme,
} from "@ossclip/core/browser";

export interface ActiveWordPillSpec {
  backgroundColor: string;
  color: string;
  borderRadius: string;
  padding: string;
  rotateDeg: number;
  clearStroke: boolean;
  /** When true, only words with (emphasisScale ?? 1) >= 1.15 receive the pill. */
  emphasisOnly: boolean;
}

export interface LineBoxSpec {
  backgroundColor: string;
  borderRadius: string;
  padding: string;
}

export interface CaptionThemeSpec {
  id: CaptionThemeId;
  revealMode: "full-line" | "word-build";
  fontScale: number;
  fontWeight: number;
  textTransform: "none" | "uppercase";
  letterSpacing: string;
  strokePx: number;
  shadowStyle: string;
  lineBoxStyle?: LineBoxSpec;
  activeWordPill?: ActiveWordPillSpec;
  inactiveOpacity: number;
  popScaleAmp: number;
}

/**
 * Parse a raw value into a valid CaptionThemeId, falling back to "default" so
 * a hand-mangled render-props.json never crashes the renderer.
 */
export function captionThemeFor(raw: unknown): CaptionThemeId {
  const parsed = CaptionThemeIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : "default";
}

/**
 * Compute readable pill ink (#0A0A0C vs #FFFFFF) from a hex accent color's
 * WCAG relative luminance. Used by `founder`, which clears stroke/shadow
 * inside the active word pill.
 */
export function pillTextColorFor(bgHex: string): "#0A0A0C" | "#FFFFFF" {
  const clean = bgHex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "#0A0A0C";
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.36 ? "#0A0A0C" : "#FFFFFF";
}

export function resolveCaptionThemeSpec(
  captionTheme: CaptionThemeId | undefined,
  theme: Pick<Theme, "accent"> | undefined,
  direction: "ltr" | "rtl",
  fontSizePx: number,
): CaptionThemeSpec {
  const id = captionThemeFor(captionTheme);
  const accent = theme?.accent ?? "#FFE14D";
  const rtl = direction === "rtl";

  switch (id) {
    case "founder": {
      return {
        id,
        revealMode: "full-line",
        fontScale: 0.92,
        fontWeight: 800,
        textTransform: "none",
        letterSpacing: rtl ? "normal" : "-0.02em",
        strokePx: (fontSizePx * 2) / 64,
        shadowStyle: `0 3px ${(fontSizePx * 14) / 64}px rgba(0,0,0,0.65)`,
        activeWordPill: {
          backgroundColor: accent,
          color: pillTextColorFor(accent),
          borderRadius: "0.22em",
          padding: rtl ? "0.14em 0.28em" : "0.04em 0.22em",
          rotateDeg: 0,
          clearStroke: true,
          emphasisOnly: false,
        },
        inactiveOpacity: 0.85,
        popScaleAmp: 0.05,
      };
    }
    case "punch": {
      return {
        id,
        revealMode: "word-build",
        fontScale: 1.08,
        fontWeight: 900,
        textTransform: rtl ? "none" : "uppercase",
        letterSpacing: rtl ? "normal" : "0.01em",
        strokePx: (fontSizePx * 12) / 64,
        shadowStyle: `0 ${Math.round((fontSizePx * 6) / 64)}px 0 rgba(0,0,0,0.9)`,
        activeWordPill: {
          backgroundColor: accent,
          color: "#FFFFFF",
          borderRadius: "0.18em",
          padding: rtl ? "0.14em 0.28em" : "0.04em 0.20em",
          rotateDeg: rtl ? 0 : -1.5,
          clearStroke: false,
          emphasisOnly: true,
        },
        inactiveOpacity: 1.0,
        popScaleAmp: 0.14,
      };
    }
    case "boxed": {
      return {
        id,
        revealMode: "full-line",
        fontScale: 0.95,
        fontWeight: 800,
        textTransform: "none",
        letterSpacing: rtl ? "normal" : "-0.01em",
        strokePx: 0,
        shadowStyle: "none",
        lineBoxStyle: {
          backgroundColor: "rgba(10, 10, 12, 0.86)",
          borderRadius: "0.28em",
          padding: rtl ? "0.28em 0.55em" : "0.16em 0.45em",
        },
        inactiveOpacity: 0.92,
        popScaleAmp: 0.04,
      };
    }
    case "minimal": {
      return {
        id,
        revealMode: "word-build",
        fontScale: 0.84,
        fontWeight: 700,
        textTransform: "none",
        letterSpacing: rtl ? "normal" : "0.01em",
        strokePx: 0,
        shadowStyle: `0 2px ${(fontSizePx * 8) / 64}px rgba(0,0,0,0.7), 0 0 ${(fontSizePx * 2) / 64}px rgba(0,0,0,0.85)`,
        inactiveOpacity: 0.6,
        popScaleAmp: 0.04,
      };
    }
    case "default":
    default: {
      return {
        id: "default",
        revealMode: "full-line",
        fontScale: 1.0,
        fontWeight: 900,
        textTransform: "none",
        letterSpacing: "normal",
        strokePx: (fontSizePx * 10) / 64,
        shadowStyle: `0 4px ${(fontSizePx * 24) / 64}px rgba(0,0,0,0.55)`,
        inactiveOpacity: 1.0,
        popScaleAmp: 0.08,
      };
    }
  }
}
