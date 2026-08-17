import { describe, expect, it } from "vitest";
import { defaultTheme } from "@ossclip/core";
import { configuredBaseTheme } from "../src/produce";

/**
 * The config theme's precedence and failure posture (F6, 2026-08-16). Pure:
 * the warning is RETURNED, never printed, so the malformed corner is
 * assertable without capturing a console. The overrides.json layer above this
 * base is resolveTheme's, covered in core's overrides tests — this helper
 * owns only "config theme > defaultTheme, all-or-nothing".
 */
describe("configuredBaseTheme", () => {
  it("no config theme = exactly the default theme, no warning", () => {
    const r = configuredBaseTheme(undefined);
    expect(r.theme).toEqual(defaultTheme);
    expect(r.warning).toBeUndefined();
  });

  it("a partial config theme overlays defaultTheme — untouched tokens keep their defaults", () => {
    const r = configuredBaseTheme({ accent: "#FF00AA", fontDisplay: "Georgia, serif" });
    expect(r.warning).toBeUndefined();
    expect(r.theme.accent).toBe("#FF00AA");
    expect(r.theme.fontDisplay).toBe("Georgia, serif");
    expect(r.theme.fg).toBe(defaultTheme.fg);
    expect(r.theme.bg).toBe(defaultTheme.bg);
  });

  it("a malformed value voids the WHOLE theme with a warning naming the issue", () => {
    // All-or-nothing on purpose: half-applying a palette the schema rejected
    // would render colors the user never chose.
    const r = configuredBaseTheme({ accent: 5, fg: "#000000" });
    expect(r.theme).toEqual(defaultTheme);
    expect(r.warning).toMatch(/config theme ignored/);
    expect(r.warning).toMatch(/accent/);
  });

  it("an unknown key is a bad key, not a silent strip — a typo'd token must not vanish", () => {
    const r = configuredBaseTheme({ acccent: "#FF00AA" });
    expect(r.theme).toEqual(defaultTheme);
    expect(r.warning).toMatch(/acccent/);
  });

  it("a non-object (hand-edited string) falls back to the default with a warning", () => {
    const r = configuredBaseTheme("dark");
    expect(r.theme).toEqual(defaultTheme);
    expect(r.warning).toMatch(/config theme ignored/);
  });
});
