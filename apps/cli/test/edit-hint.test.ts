import { describe, expect, it } from "vitest";
import { editHint } from "../src/interactive/edit-hint";

describe("editHint", () => {
  it("prints a command the user can paste", () => {
    expect(editHint("/Users/k/Downloads/.ossclip/take-5add0651", "linux")).toBe(
      "▸ edit it:  ossclip edit /Users/k/Downloads/.ossclip/take-5add0651",
    );
  });

  // The reported user was on Windows with spaces nowhere in sight, but the
  // next one will not be. An unquoted path with a space teaches a command
  // that fails.
  it("quotes a path containing a space", () => {
    expect(editHint("/Users/k/My Videos/.ossclip/take-1", "linux")).toBe(
      "▸ edit it:  ossclip edit '/Users/k/My Videos/.ossclip/take-1'",
    );
  });

  // The platform the bug report came from. POSIX single quotes are passed
  // through literally by cmd.exe, so the pinned-"linux" rendering handed a
  // Windows user a command that could not work.
  it("double-quotes on Windows, where single quotes are literal", () => {
    expect(editHint("D:\\My Videos\\.ossclip\\take-1", "win32")).toBe(
      '▸ edit it:  ossclip edit "D:\\My Videos\\.ossclip\\take-1"',
    );
  });
});
