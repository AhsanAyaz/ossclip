import { describe, expect, it } from "vitest";
import { quoteArg, renderCommand } from "../src/interactive/render";

describe("quoteArg", () => {
  it("leaves an ordinary path alone", () => {
    expect(quoteArg("./raw/take1.mp4", "darwin")).toBe("./raw/take1.mp4");
    expect(quoteArg("--produce", "darwin")).toBe("--produce");
  });

  // The whole reason this exists: the user who hit the edit bug was on
  // Windows with a backslash path. Quoting those would teach a command line
  // that looks wrong even though it runs.
  it("leaves a Windows path's backslashes untouched", () => {
    expect(quoteArg("D:\\CWA\\TiDB\\take.mp4", "win32")).toBe("D:\\CWA\\TiDB\\take.mp4");
  });

  it("quotes anything containing a space", () => {
    expect(quoteArg("My Videos/take 1.mp4", "darwin")).toBe("'My Videos/take 1.mp4'");
    expect(quoteArg("My Videos\\take 1.mp4", "win32")).toBe('"My Videos\\take 1.mp4"');
  });

  it("escapes an embedded quote per shell", () => {
    // POSIX has no escape inside single quotes: close, escape, reopen.
    expect(quoteArg("it's here", "darwin")).toBe("'it'\\''s here'");
    // cmd doubles an embedded double quote rather than backslash-escaping it.
    expect(quoteArg('say "hi"', "win32")).toBe('"say ""hi"""');
  });

  it("quotes the empty string rather than emitting nothing", () => {
    expect(quoteArg("", "darwin")).toBe("''");
    expect(quoteArg("", "win32")).toBe('""');
  });
});

describe("renderCommand", () => {
  it("prefixes the binary name and joins the argv", () => {
    expect(
      renderCommand(["produce", "./take.mp4", "--produce", "--intent", "agents 101"], "darwin"),
    ).toBe("ossclip produce ./take.mp4 --produce --intent 'agents 101'");
  });
});
