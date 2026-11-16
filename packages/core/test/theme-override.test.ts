import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  emptyOverrideDoc,
  resolveTheme,
  stripFilledThemeDefaults,
} from "../src/overrides";
import { ThemeOverrideSchema, ThemeSchema, defaultTheme, type Theme } from "../src/scene-schema";

/**
 * overrides.json's `theme` is the keys the USER set, nothing else (§161).
 * zod 4's `.partial()` keeps every field's `.default(...)`, so the old
 * `ThemeSchema.partial()` filled the whole factory palette into every parsed
 * doc, and `resolveTheme` then laid it over the configured base: the config
 * theme and `--look explainer` vanished the moment a project had an
 * overrides.json.
 */
describe("ThemeOverrideSchema", () => {
  it("parses to exactly the keys given, with no defaults filled in", () => {
    expect(ThemeOverrideSchema.parse({})).toEqual({});
    expect(ThemeOverrideSchema.parse({ accent: "#00FF00" })).toEqual({ accent: "#00FF00" });
  });

  it("keeps each field's validation", () => {
    expect(ThemeOverrideSchema.safeParse({ motion: "fast" }).success).toBe(false);
    expect(ThemeOverrideSchema.safeParse({ radiusPx: "x" }).success).toBe(false);
  });

  it("covers every ThemeSchema key, so a role added later cannot be forgotten", () => {
    expect(Object.keys(ThemeOverrideSchema.shape).sort()).toEqual(
      Object.keys(ThemeSchema.shape).sort(),
    );
  });
});

describe("resolveTheme over a configured base (§161)", () => {
  const base = ThemeSchema.parse({ accent: "#00FF00", motion: "explainer" });

  it("an empty doc that went through a save leaves the base untouched", () => {
    const doc = OverrideDocSchema.parse(JSON.parse(JSON.stringify(emptyOverrideDoc())));
    expect(resolveTheme(base, doc)).toEqual(base);
  });

  it("a user key wins, and only that key", () => {
    const doc = OverrideDocSchema.parse({ theme: { radiusPx: 10 } });
    const theme = resolveTheme(base, doc);
    expect(theme.radiusPx).toBe(10);
    expect(theme.accent).toBe("#00FF00");
  });

  it("heals a legacy default-filled theme: the user's own key survives, the filled ones drop", () => {
    // What every save before §161 wrote: the eleven original keys, all
    // factory values but the one the user actually changed.
    const legacy = {
      bg: defaultTheme.bg,
      fg: defaultTheme.fg,
      accent: "#123456",
      muted: defaultTheme.muted,
      success: defaultTheme.success,
      cardBg: defaultTheme.cardBg,
      cardBorder: defaultTheme.cardBorder,
      danger: defaultTheme.danger,
      radiusPx: defaultTheme.radiusPx,
      fontDisplay: defaultTheme.fontDisplay,
      fontMono: defaultTheme.fontMono,
    };
    const explainerBase = ThemeSchema.parse({ ...base, bg: "#222222" });
    const doc = OverrideDocSchema.parse({ theme: legacy });
    expect(doc.theme).toEqual({ accent: "#123456" });
    const theme = resolveTheme(explainerBase, doc);
    expect(theme.accent).toBe("#123456");
    expect(theme.motion).toBe("explainer");
    expect(theme.bg).toBe(explainerBase.bg);
    // A save after the explainer roles landed filled all of them too.
    expect(
      OverrideDocSchema.parse({ theme: { ...defaultTheme, accent: "#123456" } }).theme,
    ).toEqual({ accent: "#123456" });
  });

  it("a filled theme saved while the terminal pair had a default still parses", () => {
    // Only this unshipped branch ever wrote these: the terminal pair is
    // optional now, `defaultTheme.terminalBg` is undefined, and the heal's
    // equality test must not trip over it.
    const filled = { ...defaultTheme, accent: "#123456", terminalBg: "#15151B", terminalBar: "#15151B" };
    expect(() => OverrideDocSchema.parse({ theme: filled })).not.toThrow();
    expect(OverrideDocSchema.parse({ theme: filled }).theme.accent).toBe("#123456");
  });

  it("a hand-written theme with only a few keys is not touched, even where it equals a default", () => {
    const few: Partial<Theme> = { accent: defaultTheme.accent, bg: "#111111", radiusPx: 4 };
    expect(stripFilledThemeDefaults(few)).toEqual(few);
  });
});
