import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  LIBRARY_INDEX_FILE,
  LIBRARY_MAX_BYTES,
  LibraryAddError,
  addLibraryEntry,
  loadOverlayLibrary,
  slugifyEntryId,
  sniffImageFormat,
} from "../src/overlay-library";

const emptyDir = (): string => mkdtempSync(join(tmpdir(), "ossclip-library-"));

/** A real 1×1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** The smallest GIF89a header plus a trailer — enough for the sniffer. */
const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16), Buffer.from([0x3b])]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);

const writeIndex = (dir: string, entries: unknown[]): void =>
  writeFileSync(join(dir, LIBRARY_INDEX_FILE), JSON.stringify({ entries }));

describe("loadOverlayLibrary", () => {
  it("loads indexed entries with absPath and sniffed format", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "gde.png"), PNG_1X1);
    writeIndex(dir, [
      { id: "gde", file: "gde.png", names: ["Google Developers Expert", "GDE"], kind: "logo" },
    ]);
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(issues).toEqual([]);
    expect(entries).toEqual([
      {
        id: "gde",
        file: "gde.png",
        names: ["Google Developers Expert", "GDE"],
        kind: "logo",
        absPath: join(dir, "gde.png"),
        format: "png",
      },
    ]);
  });

  it("a lowercase ≤3-char name loads but reports it cannot auto-place (ruling R18)", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "go.png"), PNG_1X1);
    writeFileSync(join(dir, "AWS.png"), PNG_1X1);
    writeFileSync(join(dir, "ai.png"), PNG_1X1);
    writeIndex(dir, [{ id: "ai", file: "ai.png", names: ["ai", "Artificial Intelligence"], kind: "logo" }]);
    const { entries, issues } = loadOverlayLibrary(dir);
    // Still loaded: the tray can place them by hand.
    expect(entries.map((e) => e.id).sort()).toEqual(["ai", "aws", "go"]);
    expect(issues).toEqual([
      { file: "ai.png", message: expect.stringMatching(/"ai" is too short to auto-place.*library\.json/) },
      { file: "go.png", message: expect.stringMatching(/"go" is too short.*name it in library\.json to auto-place/) },
    ]);
  });

  it("a missing directory is an empty library, not an issue", () => {
    expect(loadOverlayLibrary(join(emptyDir(), "nope"))).toEqual({ entries: [], issues: [] });
  });

  it("unindexed file loads with stem name", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "google-cloud.png"), PNG_1X1);
    writeFileSync(join(dir, "party.gif"), GIF_BYTES);
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(issues).toEqual([]);
    expect(entries).toEqual([
      {
        id: "google-cloud",
        file: "google-cloud.png",
        names: ["google cloud"],
        kind: "logo",
        absPath: join(dir, "google-cloud.png"),
        format: "png",
      },
      {
        id: "party",
        file: "party.gif",
        names: ["party"],
        kind: "gif",
        absPath: join(dir, "party.gif"),
        format: "gif",
      },
    ]);
  });

  it("unindexed underscores read as spaces, and case is kept for the short-name rule", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "GDE__Badge.png"), PNG_1X1);
    const [entry] = loadOverlayLibrary(dir).entries;
    expect(entry).toMatchObject({ id: "gde-badge", names: ["GDE Badge"] });
  });

  it("ignores non-image extensions and dotfiles in the folder", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(join(dir, ".DS_Store"), "x");
    expect(loadOverlayLibrary(dir)).toEqual({ entries: [], issues: [] });
  });

  it("an unindexed file with an image extension but other bytes is an issue", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "fake.png"), "<html></html>");
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(entries).toEqual([]);
    expect(issues).toEqual([{ file: "fake.png", message: expect.stringMatching(/not a supported image/) }]);
  });

  it("indexed file is not loaded twice", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "gde.png"), PNG_1X1);
    writeIndex(dir, [{ id: "gde-logo", file: "gde.png", names: ["GDE"], kind: "logo" }]);
    const { entries } = loadOverlayLibrary(dir);
    expect(entries.map((e) => e.id)).toEqual(["gde-logo"]);
  });

  it("bad JSON → issues, unindexed files still load", () => {
    const dir = emptyDir();
    // Not `gde.png`: a lowercase 3-letter stem is its own issue (ruling R18).
    writeFileSync(join(dir, "firebase.png"), PNG_1X1);
    writeFileSync(join(dir, LIBRARY_INDEX_FILE), "{ not json");
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(entries.map((e) => e.id)).toEqual(["firebase"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe(LIBRARY_INDEX_FILE);
  });

  it("an invalid entry is skipped with an issue; its siblings still load", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "a.png"), PNG_1X1);
    writeFileSync(join(dir, "b.png"), PNG_1X1);
    writeIndex(dir, [
      { id: "Bad Id", file: "a.png", names: ["A"], kind: "logo" },
      { id: "b", file: "b.png", names: ["B"], kind: "logo", look: "card", sound: null },
    ]);
    const { entries, issues } = loadOverlayLibrary(dir);
    // a.png stays claimed by its broken entry: loading it under the stem name
    // "a" would put a word on screen its author never chose.
    expect(entries.map((e) => e.id)).toEqual(["b"]);
    expect(entries.find((e) => e.id === "b")).toMatchObject({ look: "card", sound: null });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Bad Id/);
  });

  it("entry whose file is missing or not an image → issue, skipped", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "page.png"), "<html><body>nope</body></html>");
    writeIndex(dir, [
      { id: "gone", file: "gone.png", names: ["Gone"], kind: "logo" },
      { id: "page", file: "page.png", names: ["Page"], kind: "logo" },
    ]);
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(entries).toEqual([]);
    expect(issues.map((i) => i.file).sort()).toEqual(["gone.png", "page.png"]);
  });

  it("an entry file escaping the library dir is an issue, never read", () => {
    const dir = emptyDir();
    writeIndex(dir, [
      { id: "escape", file: "../outside.png", names: ["Escape"], kind: "logo" },
      { id: "abs", file: "/etc/passwd", names: ["Abs"], kind: "logo" },
    ]);
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(entries).toEqual([]);
    expect(issues).toHaveLength(2);
  });

  it("a duplicate indexed id keeps the first and names the second", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "a.png"), PNG_1X1);
    writeFileSync(join(dir, "b.png"), PNG_1X1);
    writeIndex(dir, [
      { id: "x", file: "a.png", names: ["A"], kind: "logo" },
      { id: "x", file: "b.png", names: ["B"], kind: "logo" },
    ]);
    const { entries, issues } = loadOverlayLibrary(dir);
    expect(entries.find((e) => e.id === "x")?.file).toBe("a.png");
    expect(issues).toHaveLength(1);
  });
});

describe("sniffImageFormat", () => {
  const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
  it.each([
    ["PNG", PNG_1X1, "png"],
    ["JPEG", JPEG_BYTES, "jpg"],
    ["GIF87a", Buffer.concat([ascii("GIF87a"), Buffer.alloc(8)]), "gif"],
    ["GIF89a", GIF_BYTES, "gif"],
    ["WEBP", Buffer.concat([ascii("RIFF"), Buffer.from([1, 2, 3, 4]), ascii("WEBPVP8 ")]), "webp"],
    ["svg with xml prolog", ascii('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="x"></svg>'), "svg"],
    ["svg with leading whitespace", ascii("  \n\t<svg viewBox='0 0 1 1'/>"), "svg"],
    [
      "svg after comment and doctype",
      ascii('<?xml version="1.0"?><!-- Illustrator --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg>'),
      "svg",
    ],
    ["svg with BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ascii("<svg>")]), "svg"],
  ] as const)("recognises %s", (_label, bytes, format) => {
    expect(sniffImageFormat(bytes)).toBe(format);
  });

  it.each([
    ["html", ascii("<html><svg></svg></html>")],
    ["svg-ish element name", ascii("<svgfoo>")],
    ["RIFF that is not WEBP", Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("WAVE")])],
    ["random bytes", Buffer.from([0x00, 0x13, 0x37, 0x42, 0x99, 0x01])],
    ["empty", new Uint8Array()],
  ] as const)("rejects %s", (_label, bytes) => {
    expect(sniffImageFormat(bytes)).toBeNull();
  });
});

describe("slugifyEntryId", () => {
  it("lowercases and dashes runs of anything else", () => {
    expect(slugifyEntryId("Google Developers Expert", new Set())).toBe("google-developers-expert");
  });
  it("strips path traversal to the last meaningful part", () => {
    expect(slugifyEntryId("../../x", new Set())).toBe("x");
  });
  it("folds accents", () => {
    expect(slugifyEntryId("Café Crème", new Set())).toBe("cafe-creme");
  });
  it("suffixes on collision", () => {
    expect(slugifyEntryId("GDE", new Set(["gde"]))).toBe("gde-2");
    expect(slugifyEntryId("GDE", new Set(["gde", "gde-2"]))).toBe("gde-3");
  });
  it("falls back when nothing sluggable is left", () => {
    expect(slugifyEntryId("日本", new Set())).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slugifyEntryId("!!!", new Set())).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("addLibraryEntry", () => {
  it("writes <slug>.<ext> and the index atomically (no .tmp left behind)", async () => {
    const dir = emptyDir();
    const entry = await addLibraryEntry(PNG_1X1, { name: "Google Developers Expert", aliases: ["GDE"] }, dir);
    expect(entry).toEqual({
      id: "google-developers-expert",
      file: "google-developers-expert.png",
      names: ["Google Developers Expert", "GDE"],
      kind: "logo",
      absPath: join(dir, "google-developers-expert.png"),
      format: "png",
    });
    expect(readFileSync(entry.absPath)).toEqual(PNG_1X1);
    expect(readdirSync(dir).sort()).toEqual(["google-developers-expert.png", LIBRARY_INDEX_FILE]);
    // And the loader reads back exactly what the add returned.
    expect(loadOverlayLibrary(dir)).toEqual({ entries: [entry], issues: [] });
  });

  it("the extension comes from the bytes, jpg for JPEG", async () => {
    const dir = emptyDir();
    const entry = await addLibraryEntry(JPEG_BYTES, { name: "photo.png" }, dir);
    expect(entry.format).toBe("jpg");
    expect(entry.file).toBe("photo-png.jpg");
  });

  it('a second add named "GDE" gets id gde-2', async () => {
    const dir = emptyDir();
    const first = await addLibraryEntry(PNG_1X1, { name: "GDE" }, dir);
    const second = await addLibraryEntry(PNG_1X1, { name: "GDE" }, dir);
    expect(first.id).toBe("gde");
    expect(second.id).toBe("gde-2");
    expect(second.file).toBe("gde-2.png");
  });

  it("never overwrites an unindexed drop-in with the same stem", async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "gde.png"), JPEG_BYTES);
    const entry = await addLibraryEntry(PNG_1X1, { name: "GDE" }, dir);
    expect(entry.id).toBe("gde-2");
    expect(readFileSync(join(dir, "gde.png"))).toEqual(JPEG_BYTES);
  });

  it("a ../../x name slugs to x; the file is always inside dir", async () => {
    const dir = emptyDir();
    const entry = await addLibraryEntry(PNG_1X1, { name: "../../x" }, dir);
    expect(entry.id).toBe("x");
    expect(relative(dir, entry.absPath)).toBe("x.png");
    expect(existsSync(join(dir, "..", "..", "x.png"))).toBe(false);
  });

  it("a non-image throws LibraryAddError", async () => {
    const dir = emptyDir();
    await expect(addLibraryEntry(Buffer.from("<html></html>"), { name: "page" }, dir)).rejects.toBeInstanceOf(
      LibraryAddError,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("more than LIBRARY_MAX_BYTES throws", async () => {
    const dir = emptyDir();
    const big = Buffer.alloc(LIBRARY_MAX_BYTES + 1);
    PNG_1X1.copy(big);
    await expect(addLibraryEntry(big, { name: "big" }, dir)).rejects.toThrow(LibraryAddError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an empty name throws LibraryAddError", async () => {
    await expect(addLibraryEntry(PNG_1X1, { name: "   " }, emptyDir())).rejects.toThrow(LibraryAddError);
  });

  it("kind defaults to gif for gif bytes, otherwise logo; an explicit kind wins", async () => {
    const dir = emptyDir();
    expect((await addLibraryEntry(GIF_BYTES, { name: "party" }, dir)).kind).toBe("gif");
    expect((await addLibraryEntry(PNG_1X1, { name: "brand" }, dir)).kind).toBe("logo");
    expect((await addLibraryEntry(PNG_1X1, { name: "photo", kind: "image" }, dir)).kind).toBe("image");
  });

  it("an existing index's other entries are preserved", async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "gde.png"), PNG_1X1);
    const existing = { id: "gde", file: "gde.png", names: ["GDE"], kind: "logo", look: "card", sound: null };
    // An entry the loader rejects is still the user's; an add must not drop it.
    const broken = { id: "Not A Slug", file: "x.png" };
    writeFileSync(join(dir, LIBRARY_INDEX_FILE), JSON.stringify({ entries: [existing, broken] }));
    const added = await addLibraryEntry(PNG_1X1, { name: "Firebase" }, dir);
    const index = JSON.parse(readFileSync(join(dir, LIBRARY_INDEX_FILE), "utf8"));
    expect(index.entries).toEqual([
      existing,
      broken,
      { id: "firebase", file: "firebase.png", names: ["Firebase"], kind: "logo" },
    ]);
    expect(added.id).toBe("firebase");
  });

  it("refuses to add over an unreadable index rather than clobber it", async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, LIBRARY_INDEX_FILE), "{ not json");
    await expect(addLibraryEntry(PNG_1X1, { name: "x" }, dir)).rejects.toThrow(LibraryAddError);
    expect(readFileSync(join(dir, LIBRARY_INDEX_FILE), "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual([LIBRARY_INDEX_FILE]);
  });

  it("creates the library dir on first add", async () => {
    const dir = join(emptyDir(), "library");
    const entry = await addLibraryEntry(PNG_1X1, { name: "x" }, dir);
    expect(existsSync(entry.absPath)).toBe(true);
  });
});
