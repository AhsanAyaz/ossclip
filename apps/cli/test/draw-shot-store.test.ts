import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShotHistory } from "@ossclip/core";
import {
  SHOT_HISTORY_BASENAME,
  loadShot,
  parseAssetNotes,
  parseImageProbe,
  saveShot,
  listAssets,
  shotDir,
  stageAssets,
  versionPaths,
} from "../src/draw/shot-store";

/**
 * A drawn shot's files (storyboard design §9, plan Task 6; §167) in a real
 * temp workdir. ffprobe is injected, so no binary is needed.
 */
let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-shot-store-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function record(over: Partial<ShotHistory> = {}): ShotHistory {
  return {
    id: "probe",
    idea: "a goldfish swims in and says hello",
    spokenLine: "say hello",
    durationSec: 4,
    versions: [{ n: 1, result: "ok", kitVersion: 1, promptVersion: 1, said: "a goldfish" }],
    draft: 1,
    nextVersion: 2,
    notes: [],
    runs: [{ version: 1, provider: "mock", calls: 1, seconds: 3.2 }],
    ...over,
  };
}

describe("paths", () => {
  it("lays a shot out as design §9 does", () => {
    expect(shotDir(work, "probe")).toBe(join(work, "storyboard", "probe"));
    expect(versionPaths(work, "probe", 3)).toEqual({
      code: join(work, "storyboard", "probe", "v3.tsx"),
      stillsDir: join(work, "storyboard", "probe", "v3"),
      preview: join(work, "storyboard", "probe", "v3", "preview.webm"),
    });
  });

  it.each(["../x", "a/b", "", "Probe"])("refuses the shot id %j before building a path (Review Focus 4)", (id) => {
    expect(() => shotDir(work, id)).toThrow(/shot id/);
    expect(() => versionPaths(work, id, 1)).toThrow(/shot id/);
    expect(() => loadShot(work, id)).toThrow(/shot id/);
    expect(() => saveShot(work, record({ id }))).toThrow();
    expect(existsSync(join(work, "storyboard"))).toBe(false);
  });
});

describe("saveShot and loadShot", () => {
  it("round-trips a record", () => {
    const h = record({ notes: [{ onVersion: 1, text: "bigger fish" }], assetsDir: "/abs/assets" });
    saveShot(work, h);
    expect(loadShot(work, "probe")).toEqual(h);
    // Through a temp file and a rename: nothing else is left beside it.
    expect(readdirSync(shotDir(work, "probe"))).toEqual([SHOT_HISTORY_BASENAME]);
  });

  it("returns null for a shot never drawn", () => {
    expect(loadShot(work, "probe")).toBeNull();
  });

  it("refuses a record that does not parse rather than treating the shot as new", () => {
    mkdirSync(shotDir(work, "probe"), { recursive: true });
    writeFileSync(join(shotDir(work, "probe"), SHOT_HISTORY_BASENAME), JSON.stringify({ id: "probe" }));
    expect(() => loadShot(work, "probe")).toThrow(/not a valid shot record/);
  });

  it("discards an interrupted version: v3.tsx and its stills are removed, its number stays used (Review Focus 5)", () => {
    const h = record({
      versions: [
        { n: 1, result: "ok", kitVersion: 1 },
        { n: 2, result: { failed: "type error" }, kitVersion: 1 },
        { n: 3, kitVersion: 1 },
      ],
      draft: 1,
      nextVersion: 4,
    });
    saveShot(work, h);
    for (const n of [1, 3]) {
      const p = versionPaths(work, "probe", n);
      writeFileSync(p.code, "export default () => null;\n");
      mkdirSync(p.stillsDir, { recursive: true });
      writeFileSync(join(p.stillsDir, "still-1.png"), "png");
    }

    const loaded = loadShot(work, "probe");
    expect(loaded?.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(loaded?.nextVersion).toBe(4);
    expect(loaded?.draft).toBe(1);
    const v3 = versionPaths(work, "probe", 3);
    expect(existsSync(v3.code)).toBe(false);
    expect(existsSync(v3.stillsDir)).toBe(false);
    // Version 1 is untouched, and the cleaned record is what is on disk now.
    expect(existsSync(versionPaths(work, "probe", 1).code)).toBe(true);
    expect(existsSync(join(versionPaths(work, "probe", 1).stillsDir, "still-1.png"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(shotDir(work, "probe"), SHOT_HISTORY_BASENAME), "utf8"));
    expect(onDisk.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
  });

  it("refuses a record filed under another shot's folder", () => {
    saveShot(work, record({ id: "other" }));
    mkdirSync(shotDir(work, "probe"), { recursive: true });
    writeFileSync(
      join(shotDir(work, "probe"), SHOT_HISTORY_BASENAME),
      readFileSync(join(shotDir(work, "other"), SHOT_HISTORY_BASENAME)),
    );
    expect(() => loadShot(work, "probe")).toThrow(/not "probe"/);
  });
});

describe("parseAssetNotes", () => {
  it("reads one `<name>: <text>` line per file, list items included, and nothing else", () => {
    const notes = parseAssetNotes(
      [
        "# Assets",
        "logo.png: the EGM logo, an elephant and a goldfish",
        "- mark.svg: the small mark: use it in corners",
        "some prose with no name",
        "../evil.png: not an asset name",
        "logo.png: a second line for the same file",
        "empty.png:",
      ].join("\n"),
    );
    expect([...notes]).toEqual([
      ["logo.png", "the EGM logo, an elephant and a goldfish"],
      ["mark.svg", "the small mark: use it in corners"],
    ]);
  });
});

describe("parseImageProbe", () => {
  it("reads the first stream's size", () => {
    expect(parseImageProbe(JSON.stringify({ streams: [{ width: 120, height: 40 }] }), "x.svg")).toEqual({ width: 120, height: 40 });
  });

  it("throws when ffprobe saw no image", () => {
    expect(() => parseImageProbe(JSON.stringify({ streams: [] }), "x.png")).toThrow(/image size of x.png/);
    expect(() => parseImageProbe("not json", "x.png")).toThrow(/image size/);
  });
});

describe("stageAssets", () => {
  it("copies allowed files into storyboard-assets/, with sizes and notes, and warns for the rest", async () => {
    const assets = join(work, "assets");
    mkdirSync(join(assets, "nested"), { recursive: true });
    writeFileSync(join(assets, "logo.png"), "png-bytes");
    writeFileSync(join(assets, "mark.svg"), "<svg/>");
    writeFileSync(join(assets, "run.exe"), "MZ");
    writeFileSync(join(assets, "my logo.png"), "png");
    writeFileSync(join(assets, "broken.webp"), "not an image");
    writeFileSync(join(assets, "nested", "inner.png"), "png");
    writeFileSync(join(assets, "assets.md"), "logo.png: the EGM logo\nghost.png: not in the folder\n");
    const publicDir = join(work, "public");

    const probed: string[] = [];
    const out = await stageAssets(assets, publicDir, async (p) => {
      probed.push(p);
      if (p.endsWith("broken.webp")) throw new Error("ffprobe failed (exit 1):\nInvalid data");
      return p.endsWith("logo.png") ? { width: 512, height: 256 } : { width: 64, height: 64 };
    });

    expect(out.assets).toEqual([
      { name: "logo.png", width: 512, height: 256, note: "the EGM logo", staticPath: "storyboard-assets/logo.png" },
      { name: "mark.svg", width: 64, height: 64, staticPath: "storyboard-assets/mark.svg" },
    ]);
    expect(readFileSync(join(publicDir, "storyboard-assets", "logo.png"), "utf8")).toBe("png-bytes");
    expect(readdirSync(join(publicDir, "storyboard-assets")).sort()).toEqual(["logo.png", "mark.svg"]);
    // A name that fails the schema is never probed, so never reaches a path built for it.
    expect(probed.some((p) => p.includes("run.exe") || p.includes("my logo"))).toBe(false);
    expect(out.warnings).toHaveLength(4);
    expect(out.warnings.find((w) => w.includes('"run.exe"'))).toMatch(/^skipped asset/);
    expect(out.warnings.find((w) => w.includes('"my logo.png"'))).toMatch(/^skipped asset/);
    expect(out.warnings.find((w) => w.includes("broken.webp"))).toBe("skipped asset broken.webp: ffprobe failed (exit 1):");
    expect(out.warnings.find((w) => w.includes("ghost.png"))).toMatch(/assets\.md describes ghost\.png/);
  });

  it("fails clearly when the folder is gone", async () => {
    await expect(stageAssets(join(work, "nope"), join(work, "public"), async () => ({ width: 1, height: 1 }))).rejects.toThrow(
      /assets folder not found/,
    );
  });
});

describe("listAssets", () => {
  it("describes the folder's images with their source paths and copies nothing (§168: a plan stages no assets)", async () => {
    const assets = join(work, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "logo.png"), "png-bytes");
    writeFileSync(join(assets, "run.exe"), "MZ");
    writeFileSync(join(assets, "assets.md"), "- logo.png: the EGM logo\n");
    const before = readdirSync(work).sort();

    const out = await listAssets(assets, async () => ({ width: 512, height: 256 }));

    expect(out.assets).toEqual([{ name: "logo.png", width: 512, height: 256, note: "the EGM logo", src: join(assets, "logo.png") }]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/^skipped asset "run.exe"/);
    expect(readdirSync(work).sort()).toEqual(before);
    expect(readdirSync(assets).sort()).toEqual(["assets.md", "logo.png", "run.exe"]);
  });
});
