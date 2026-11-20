import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStillsArgs, stillsOutDir } from "../src/stills-args";

describe("parseStillsArgs", () => {
  it("is the explainer look with no arguments, as the harness always was", () => {
    expect(parseStillsArgs([])).toEqual({ look: "explainer" });
  });

  it("takes a component and a theme in either order, and --theme=x", () => {
    expect(parseStillsArgs(["StatCard"])).toEqual({ component: "StatCard", look: "explainer" });
    expect(parseStillsArgs(["--theme", "default", "StatCard"])).toEqual({
      component: "StatCard",
      look: "default",
    });
    expect(parseStillsArgs(["TerminalMock", "--theme=default"])).toEqual({
      component: "TerminalMock",
      look: "default",
    });
  });

  it("refuses a typo'd theme rather than drawing the explainer look", () => {
    expect(() => parseStillsArgs(["--theme", "defualt"])).toThrow(/unknown --theme "defualt"/);
    expect(() => parseStillsArgs(["--theme"])).toThrow(/needs a value/);
    expect(() => parseStillsArgs(["--theme="])).toThrow(/needs a value/);
  });

  it("refuses an unknown flag and a second component", () => {
    expect(() => parseStillsArgs(["--look", "default"])).toThrow(/unknown option "--look"/);
    expect(() => parseStillsArgs(["StatCard", "CardRow"])).toThrow(/one component at a time/);
  });
});

describe("stillsOutDir", () => {
  it("keeps the explainer stills in place and puts another look in its own folder", () => {
    expect(stillsOutDir("/s", "explainer")).toBe("/s");
    expect(stillsOutDir("/s", "default")).toBe(join("/s", "default"));
  });
});
