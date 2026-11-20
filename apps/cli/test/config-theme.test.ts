import { describe, expect, it } from "vitest";
import { defaultTheme, lookTheme } from "@ossclip/core";
import { configuredBaseTheme, resolveLook } from "../src/produce";
import { buildProgram, lookFlag } from "../src/program";
import { recordedProduceArgs, setReplayArgv } from "../src/replay-argv";

/**
 * The config theme's precedence and failure posture (F6, 2026-08-16). Pure:
 * the warning is RETURNED, never printed, so the malformed corner is
 * assertable without capturing a console. The overrides.json layer above this
 * base is resolveTheme's, covered in core's overrides tests — this helper
 * owns only "config theme > look > defaultTheme, all-or-nothing".
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

  // Design §2.2: defaults < look < config theme. The look is a preset under
  // the user's own palette, so "restyle for another product" is setting
  // `accent`/`accent2` in config while keeping the rest of the look.
  it("no look and no config theme = exactly the default theme", () => {
    expect(configuredBaseTheme(undefined, "default").theme).toEqual(defaultTheme);
  });

  it("the explainer look applies over the defaults", () => {
    const r = configuredBaseTheme(undefined, "explainer");
    expect(r.warning).toBeUndefined();
    expect(r.theme).toEqual({ ...defaultTheme, ...lookTheme("explainer") });
  });

  it("a config theme beats the look key by key; the rest of the look stays", () => {
    const r = configuredBaseTheme({ accent: "#00FF00" }, "explainer");
    expect(r.warning).toBeUndefined();
    expect(r.theme.accent).toBe("#00FF00");
    expect(r.theme.accent2).toBe("#7CACF8");
    expect(r.theme.fonts).toBe("bundled");
    expect(r.theme.motion).toBe("explainer");
  });

  it("a malformed config theme voids only the config layer — the look still applies", () => {
    // The all-or-nothing rule is about the palette the schema rejected; the
    // look was asked for separately and is valid, so dropping it too would
    // render a different video than the one the flag named.
    const r = configuredBaseTheme({ accent: 5 }, "explainer");
    expect(r.warning).toMatch(/config theme ignored/);
    expect(r.theme).toEqual({ ...defaultTheme, ...lookTheme("explainer") });
  });
});

describe("resolveLook", () => {
  it("the flag beats the config, and neither means the default look", () => {
    expect(resolveLook(undefined, undefined)).toBe("default");
    expect(resolveLook(undefined, "explainer")).toBe("explainer");
    expect(resolveLook("default", "explainer")).toBe("default");
    expect(resolveLook("explainer", undefined)).toBe("explainer");
  });

  it("an invalid config look is an error naming the key, never a silent default", () => {
    expect(() => resolveLook(undefined, "explainr")).toThrow(/config look/);
    expect(() => resolveLook(undefined, 3)).toThrow(/config look/);
  });

  it("a storyboard run falls back to the explainer look; flag and config still win, and every other run is unchanged (§168)", () => {
    expect(resolveLook(undefined, undefined, "explainer")).toBe("explainer");
    expect(resolveLook("default", undefined, "explainer")).toBe("default");
    expect(resolveLook(undefined, "default", "explainer")).toBe("default");
    // The two-argument call every non-storyboard run makes, and the explicit
    // "default" fallback produce now passes for them: the same answers.
    for (const [flag, config] of [[undefined, undefined], [undefined, "explainer"], ["default", "explainer"], ["explainer", undefined]] as const) {
      expect(resolveLook(flag, config, "default")).toBe(resolveLook(flag, config));
    }
    expect(resolveLook(undefined, undefined, "default")).toBe("default");
  });

  it("a typed flag still wins over a broken config value", () => {
    // The flag is already a parsed Look; the config is only consulted when
    // the flag is absent, so a bad file key cannot block an explicit choice.
    expect(resolveLook("explainer", "explainr")).toBe("explainer");
  });
});

describe("lookFlag", () => {
  it("parses the known looks and refuses a typo", () => {
    expect(lookFlag("explainer")).toBe("explainer");
    expect(lookFlag(" default ")).toBe("default");
    expect(() => lookFlag("explainr")).toThrow(/--look wants one of default, explainer/);
  });

  it("is registered on produce", () => {
    const produce = buildProgram().commands.find((c) => c.name() === "produce")!;
    expect(produce.options.map((o) => o.long)).toContain("--look");
  });
});

describe("recordedProduceArgs look pin", () => {
  // --caption-theme's shape: a look that came from config must be pinned, or
  // the editor's Render replays in a different look after a config edit.
  it("pins a non-default look and leaves the default unpinned", () => {
    setReplayArgv(["produce", "clip.mp4"]);
    const pinned = recordedProduceArgs({ look: "explainer" });
    expect(pinned[pinned.indexOf("--look") + 1]).toBe("explainer");
    setReplayArgv(["produce", "clip.mp4"]);
    expect(recordedProduceArgs({ look: "default" })).not.toContain("--look");
  });

  it("never doubles a typed --look", () => {
    setReplayArgv(["produce", "clip.mp4", "--look", "explainer"]);
    const args = recordedProduceArgs({ look: "explainer" });
    expect(args.filter((a) => a === "--look")).toHaveLength(1);
  });
});
