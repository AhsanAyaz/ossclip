import { describe, expect, it } from "vitest";
import { buildArrayPatch } from "../src/Overlay";

describe("buildArrayPatch — ChatMock CTA keyword mapping", () => {
  const props = { keyword: "agents" };

  it("maps a fresh full retype (no decoration) straight through", () => {
    expect(buildArrayPatch("message-0", props, "friends")).toEqual({ keyword: "friends" });
  });

  it("strips quotes and undoes the uppercasing from an in-place edit of the decorated display string", () => {
    // The inline edit box seeds from the live (decorated) `textContent`:
    // `"AGENTS"`. An in-place edit — say, fixing a typo — leaves most of
    // that decoration intact rather than replacing the whole string, so the
    // mapping must still produce a clean, lowercase keyword.
    expect(buildArrayPatch("message-0", props, '"AGENTZ"')).toEqual({ keyword: "agentz" });
  });

  it("undoes uppercasing even without surrounding quotes", () => {
    expect(buildArrayPatch("message-0", props, "AGENTS")).toEqual({ keyword: "agents" });
  });

  it("still strips quotes when the casing is already lowercase", () => {
    expect(buildArrayPatch("message-0", props, '"agents"')).toEqual({ keyword: "agents" });
  });

  it("returns null for an empty mapped keyword", () => {
    expect(buildArrayPatch("message-0", props, '""')).toBeNull();
  });
});
