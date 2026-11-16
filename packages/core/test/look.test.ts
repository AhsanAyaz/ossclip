import { describe, expect, it } from "vitest";
import { LookSchema, lookTheme } from "../src/look";
import { emptyOverrideDoc, resolveTheme } from "../src/overrides";
import { ThemeOverrideSchema, ThemeSchema, type Theme } from "../src/scene-schema";

/**
 * The explainer look (design §2.2): a theme preset, not a new theme system.
 * Every new role defaults to the colour it stands in for today, so a run
 * without `--look` renders the same pixels (plan G6).
 */
describe("theme roles", () => {
  it("defaults reproduce today's theme", () => {
    expect(ThemeSchema.parse({})).toMatchObject({
      bg: "#0B0B0E", accent: "#FFE14D", cardBg: "#15151B",
      accent2: "#FFE14D", highlight: "#FFE14D", info: "#9A9AA3", ink: "#0B0B0E",
      terminalBg: "#15151B", terminalBar: "#15151B", fonts: "system", motion: "classic",
    });
  });

  // Review Focus 1: render-props written before this change carry a theme
  // with none of the new keys. The editor re-resolves it through
  // `resolveTheme`, so the missing roles must come back as today's values and
  // the gates as off, or an old project would reopen in a different look.
  it("a theme saved before the new roles existed resolves to today's values", () => {
    const saved: Record<string, unknown> = {
      bg: "#0B0B0E", fg: "#FFFFFF", accent: "#00FF00", muted: "#9A9AA3",
      success: "#5FBF77", cardBg: "#15151B", cardBorder: "#2A2A33", danger: "#FF5C5C",
      radiusPx: 24,
      fontDisplay: "'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif",
      fontMono: "'SF Mono', 'Cascadia Code', Consolas, monospace",
    };
    const theme = resolveTheme(saved as Theme, emptyOverrideDoc());
    expect(theme).toEqual({
      ...saved,
      accent2: "#FFE14D", highlight: "#FFE14D", info: "#9A9AA3", ink: "#0B0B0E",
      terminalBg: "#15151B", terminalBar: "#15151B", fonts: "system", motion: "classic",
    });
  });

  it("rejects an unknown fonts or motion value instead of falling back", () => {
    expect(() => ThemeSchema.parse({ fonts: "google" })).toThrow();
    expect(() => ThemeSchema.parse({ motion: "bouncy" })).toThrow();
  });
});

describe("lookTheme", () => {
  it("the explainer look carries the playbook palette", () => {
    expect(lookTheme("explainer")).toEqual({
      bg: "#3A4A5C", fg: "#FFFFFF", accent: "#FF8D41", accent2: "#7CACF8",
      highlight: "#FFE14D", success: "#3DDC84", danger: "#FF4D4D",
      cardBg: "#14161C", cardBorder: "#2B3140", muted: "#7C86A6", info: "#5FD7FF",
      ink: "#0F1013", terminalBg: "#0F1320", terminalBar: "#1A2034",
      fontDisplay: "'Inter', 'Helvetica Neue', Arial, sans-serif",
      fontMono: "'DejaVu Sans Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
      fonts: "bundled", motion: "explainer",
    });
  });

  it("the default look changes nothing", () => expect(lookTheme("default")).toEqual({}));

  it("every explainer value is one the theme schema accepts", () => {
    expect(() => ThemeOverrideSchema.strict().parse(lookTheme("explainer"))).not.toThrow();
  });

  it("hands out a copy, so a caller's edit cannot restyle the next run", () => {
    const first = lookTheme("explainer");
    first.accent = "#000000";
    expect(lookTheme("explainer").accent).toBe("#FF8D41");
  });

  it("rejects an unknown look", () => expect(() => LookSchema.parse("explainr")).toThrow());
});
