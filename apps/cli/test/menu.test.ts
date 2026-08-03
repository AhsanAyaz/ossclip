import { describe, expect, it } from "vitest";
import { menuArgv } from "../src/interactive/menu";

describe("menuArgv", () => {
  it("routes edit with no argument, which is the project picker", () => {
    expect(menuArgv("edit")).toEqual(["edit"]);
  });

  it("routes setup and doctor as plain passthroughs", () => {
    expect(menuArgv("setup")).toEqual(["setup"]);
    expect(menuArgv("doctor")).toEqual(["doctor"]);
  });

  // Produce is the one choice that needs answers before it has an argv, so
  // the menu hands it off rather than returning one.
  it("returns null for produce, which the wizard builds", () => {
    expect(menuArgv("produce")).toBeNull();
  });
});
