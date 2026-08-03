import { describe, expect, it } from "vitest";
import { editHint } from "../src/interactive/edit-hint";

describe("editHint", () => {
  it("prints a command the user can paste", () => {
    expect(editHint("/Users/k/Downloads/.ossclip/take-5add0651")).toBe(
      "▸ edit it:  ossclip edit /Users/k/Downloads/.ossclip/take-5add0651",
    );
  });

  // The reported user was on Windows with spaces nowhere in sight, but the
  // next one will not be. An unquoted path with a space teaches a command
  // that fails.
  it("quotes a path containing a space", () => {
    expect(editHint("/Users/k/My Videos/.ossclip/take-1")).toBe(
      "▸ edit it:  ossclip edit '/Users/k/My Videos/.ossclip/take-1'",
    );
  });
});
