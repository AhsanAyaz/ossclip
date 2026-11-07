import { describe, expect, it } from "vitest";
import {
  classifyPaste,
  filterLibrary,
  guessKind,
  libraryFileUrl,
  matchSummary,
  nameFromSource,
  parseAliases,
  previewCaption,
  type LibraryEntryMeta,
} from "../src/overlayTrayModel";

const ENTRIES: LibraryEntryMeta[] = [
  { id: "gde", names: ["Google Developers Expert", "GDE"], kind: "logo", format: "png" },
  { id: "party", names: ["party"], kind: "gif", format: "gif" },
];

describe("filterLibrary", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterLibrary(ENTRIES, "")).toEqual(ENTRIES);
    expect(filterLibrary(ENTRIES, "   ")).toEqual(ENTRIES);
  });
  it("matches any name case-insensitively, and the id", () => {
    expect(filterLibrary(ENTRIES, "developers").map((e) => e.id)).toEqual(["gde"]);
    expect(filterLibrary(ENTRIES, "gde").map((e) => e.id)).toEqual(["gde"]);
    expect(filterLibrary(ENTRIES, "PAR").map((e) => e.id)).toEqual(["party"]);
    expect(filterLibrary(ENTRIES, "nothing")).toEqual([]);
  });
});

describe("libraryFileUrl", () => {
  it("addresses the file by an encoded id, never a path", () => {
    expect(libraryFileUrl("gde")).toBe("/api/library/file?id=gde");
    expect(libraryFileUrl("a&b")).toBe("/api/library/file?id=a%26b");
  });
});

describe("classifyPaste", () => {
  it("takes http(s) URLs as url sources", () => {
    expect(classifyPaste(" https://example.com/logo.png ")).toEqual({
      ok: true,
      source: { url: "https://example.com/logo.png" },
    });
    expect(classifyPaste("HTTP://example.com/x.gif")).toEqual({ ok: true, source: { url: "HTTP://example.com/x.gif" } });
  });
  it("takes POSIX and Windows absolute paths as path sources", () => {
    expect(classifyPaste("/Users/me/logo.png")).toEqual({ ok: true, source: { path: "/Users/me/logo.png" } });
    expect(classifyPaste("C:\\logos\\x.png")).toEqual({ ok: true, source: { path: "C:\\logos\\x.png" } });
  });
  it("is silent on an empty box", () => {
    expect(classifyPaste("  ")).toEqual({ ok: false, error: null });
  });
  it("refuses a relative path, ~, and other schemes with a sentence", () => {
    for (const t of ["logo.png", "./logo.png", "~/logo.png", "ftp://x/y.png", "file:///x.png"]) {
      const r = classifyPaste(t);
      expect(r.ok).toBe(false);
      expect(r.ok === false && typeof r.error).toBe("string");
    }
    expect(classifyPaste("~/logo.png")).toMatchObject({ error: expect.stringContaining("full path") });
  });
});

describe("nameFromSource", () => {
  it("uses the file stem with - and _ as spaces (the unindexed-file rule)", () => {
    expect(nameFromSource("/Users/me/google-cloud_logo.png")).toBe("google cloud logo");
    expect(nameFromSource("C:\\x\\Firebase.svg")).toBe("Firebase");
  });
  it("uses the URL's last path part, decoded, ignoring query and hash", () => {
    expect(nameFromSource("https://cdn.example.com/a/Clean%20Edit.png?v=2#x")).toBe("Clean Edit");
    expect(nameFromSource("https://example.com/")).toBe("");
  });
  it("keeps a name with no extension", () => {
    expect(nameFromSource("https://example.com/logos/gde")).toBe("gde");
  });
});

describe("guessKind", () => {
  it("gif → gif, else logo (spec §Editor)", () => {
    expect(guessKind({ name: "party.GIF" })).toBe("gif");
    expect(guessKind({ name: "https://x.com/a.gif?x=1" })).toBe("gif");
    expect(guessKind({ mimeType: "image/gif" })).toBe("gif");
    expect(guessKind({ name: "logo.png", mimeType: "image/png" })).toBe("logo");
    expect(guessKind({})).toBe("logo");
  });
});

describe("parseAliases", () => {
  it("splits on commas, trims, drops blanks and repeats of the name or each other", () => {
    expect(parseAliases(" GDE, gde ,, Google Dev Expert, Clean Edit", "Clean Edit")).toEqual([
      "GDE",
      "Google Dev Expert",
    ]);
    expect(parseAliases("", "x")).toEqual([]);
  });
  it("caps at the server schema's 10", () => {
    expect(parseAliases(Array.from({ length: 12 }, (_, i) => `a${i}`).join(","), "x")).toHaveLength(10);
  });
});

describe("matchSummary", () => {
  it("says the spec's sentence", () => {
    expect(matchSummary({ placements: [{}], skipped: 2, dropped: [] })).toBe(
      "added 1, skipped 2 already placed or removed",
    );
  });
  it("reports dropped first mentions on their own, never as skipped", () => {
    expect(
      matchSummary({ placements: [], skipped: 0, dropped: [{ entryId: "gde", reason: "too close to another overlay" }] }),
    ).toBe("added 0, skipped 0 already placed or removed, 1 not added (gde: too close to another overlay)");
  });
});

describe("previewCaption", () => {
  it("names the sniffed format, the pixel size and the file size", () => {
    expect(previewCaption({ format: "png", width: 512, height: 256, bytes: 34_816 })).toBe("PNG · 512×256 · 34 KB");
  });
  it("leaves out a size the server could not read (an SVG without width/height)", () => {
    expect(previewCaption({ format: "svg", bytes: 900 })).toBe("SVG · 900 B");
  });
  it("shows megabytes to one decimal", () => {
    expect(previewCaption({ format: "gif", width: 480, height: 270, bytes: 3.5 * 1024 * 1024 })).toBe(
      "GIF · 480×270 · 3.5 MB",
    );
  });
});
