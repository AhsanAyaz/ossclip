import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLutLibrary } from "../src/lut-library";

const emptyDir = (): string => mkdtempSync(join(tmpdir(), "ossclip-luts-"));

/** The smallest valid .cube: a 2-point identity. */
const identityCube = (title?: string): string =>
  [
    ...(title !== undefined ? [`TITLE "${title}"`] : []),
    "LUT_3D_SIZE 2",
    "0 0 0",
    "1 0 0",
    "0 1 0",
    "1 1 0",
    "0 0 1",
    "1 0 1",
    "0 1 1",
    "1 1 1",
    "",
  ].join("\n");

describe("loadLutLibrary", () => {
  it("lists parseable .cube files with the stem as id and TITLE as title", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "warm-film.cube"), identityCube("Warm Film Look"));
    const { items, issues } = loadLutLibrary(dir);
    expect(issues).toEqual([]);
    expect(items).toEqual([
      { id: "warm-film", title: "Warm Film Look", path: join(dir, "warm-film.cube") },
    ]);
  });

  it("falls back to the stem when the cube has no TITLE", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "no-title.cube"), identityCube());
    expect(loadLutLibrary(dir).items).toEqual([
      { id: "no-title", title: "no-title", path: join(dir, "no-title.cube") },
    ]);
  });

  it("matches the extension case-insensitively — exporters write .CUBE too", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "Shouty.CUBE"), identityCube());
    const { items, issues } = loadLutLibrary(dir);
    expect(issues).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(["Shouty"]);
  });

  it("an unparseable .cube is one issue naming the file, never a throw", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "broken.cube"), "LUT_3D_SIZE 2\n0 0 0\n"); // wrong line count
    writeFileSync(join(dir, "ok.cube"), identityCube());
    const { items, issues } = loadLutLibrary(dir);
    expect(items.map((i) => i.id)).toEqual(["ok"]);
    expect(issues).toEqual([
      { file: "broken.cube", message: expect.stringContaining(".cube:") },
    ]);
  });

  it("ignores non-.cube files and subdirectories — not LUTs, not issues", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "notes.txt"), "not a lut");
    mkdirSync(join(dir, "backup.cube")); // a DIRECTORY named like a cube
    writeFileSync(join(dir, "real.cube"), identityCube());
    const { items, issues } = loadLutLibrary(dir);
    expect(items.map((i) => i.id)).toEqual(["real"]);
    expect(issues).toEqual([]);
  });

  it("a missing directory is the normal case — empty, no issue", () => {
    expect(loadLutLibrary(join(emptyDir(), "nope"))).toEqual({ items: [], issues: [] });
  });

  it("sorts by filename so the menu reads the same on every machine", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "zeta.cube"), identityCube());
    writeFileSync(join(dir, "alpha.cube"), identityCube());
    expect(loadLutLibrary(dir).items.map((i) => i.id)).toEqual(["alpha", "zeta"]);
  });
});
