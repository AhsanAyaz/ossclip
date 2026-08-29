import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SFX_MEME_TAG,
  SfxPackSchema,
  bundledSfxDir,
  loadSfxLibrary,
  resolveSfxBundledPack,
  sfxLibraryHash,
  type SfxSound,
} from "../src/sfx-pack";

/** A user pack directory under `root`, written the way a user would. */
function writePack(
  root: string,
  dir: string,
  pack: { name: string; sounds: unknown[] },
  files: string[] = [],
): string {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "pack.json"), JSON.stringify(pack));
  for (const f of files) writeFileSync(join(path, f), "not really audio");
  return path;
}

const emptyUserDir = (): string => mkdtempSync(join(tmpdir(), "ossclip-sfx-"));

const sound = (over: Partial<SfxSound> = {}): Record<string, unknown> => ({
  id: "ding",
  kind: "sound",
  file: "ding.mp3",
  whenToUse: "a thing lands",
  tags: [],
  gain: 1,
  ...over,
});

describe("bundled starter pack", () => {
  it("parses, and every referenced file is on disk (no placeholder merge)", () => {
    const dir = bundledSfxDir();
    const pack = SfxPackSchema.parse(JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")));
    expect(pack.sounds).toHaveLength(11);
    for (const s of pack.sounds) {
      expect(existsSync(join(dir, s.file)), `${s.id}: ${s.file} missing`).toBe(true);
    }
    expect(existsSync(join(dir, "ATTRIBUTION.md"))).toBe(true);
  });

  it("loads with no issues and carries exactly three meme sounds", () => {
    const { sounds, issues } = loadSfxLibrary({ userDir: emptyUserDir() });
    expect(issues).toEqual([]);
    expect(sounds.map((s) => s.id).sort()).toEqual([
      "boom-dramatic",
      "click",
      "ding",
      "error-buzz",
      "pop",
      "riser-short",
      "scratch",
      "swoosh-exit",
      "tape-stop",
      "whoosh-fast",
      "whoosh-soft",
    ]);
    expect(sounds.filter((s) => s.tags.includes(SFX_MEME_TAG)).map((s) => s.id)).toEqual([
      "boom-dramatic",
      "scratch",
      "tape-stop",
    ]);
    for (const s of sounds) {
      expect(existsSync(s.absPath)).toBe(true);
      expect(s.packName).toBe("ossclip-starter");
    }
  });
});

describe("loadSfxLibrary merge", () => {
  it("a user pack overrides a bundled id, silently — that is the wanted case", () => {
    const root = emptyUserDir();
    writePack(root, "mine", { name: "mine", sounds: [sound({ whenToUse: "my own ding" })] }, ["ding.mp3"]);
    const { sounds, issues } = loadSfxLibrary({ userDir: root });
    expect(issues).toEqual([]);
    const ding = sounds.find((s) => s.id === "ding")!;
    expect(ding.packName).toBe("mine");
    expect(ding.whenToUse).toBe("my own ding");
    // Only the one id was replaced.
    expect(sounds).toHaveLength(11);
  });

  it("user vs user: the alphabetically first pack wins, with an issue naming the loser", () => {
    const root = emptyUserDir();
    writePack(root, "zed", { name: "zed", sounds: [sound({ id: "custom", file: "c.mp3", whenToUse: "zed" })] }, ["c.mp3"]);
    writePack(root, "alpha", { name: "alpha", sounds: [sound({ id: "custom", file: "c.mp3", whenToUse: "alpha" })] }, ["c.mp3"]);
    const { sounds, issues } = loadSfxLibrary({ userDir: root });
    expect(sounds.find((s) => s.id === "custom")!.packName).toBe("alpha");
    expect(issues).toEqual([
      { pack: "zed", issue: expect.stringContaining('duplicate id "custom"') },
    ]);
  });

  it("skips a missing file, a bad id and an unsupported kind — one issue each, never a throw", () => {
    const root = emptyUserDir();
    writePack(
      root,
      "mixed",
      {
        name: "mixed",
        sounds: [
          sound({ id: "gone", file: "gone.mp3", whenToUse: "never written" }),
          sound({ id: "Not A Slug" as string, file: "ok.mp3", whenToUse: "bad id" }),
          { ...sound({ id: "future", file: "ok.mp3", whenToUse: "a video meme" }), kind: "video" },
          sound({ id: "good", file: "ok.mp3", whenToUse: "fine" }),
        ],
      },
      ["ok.mp3"],
    );
    const { sounds, issues } = loadSfxLibrary({ userDir: root });
    expect(sounds.find((s) => s.id === "good")).toBeDefined();
    expect(sounds.map((s) => s.id)).not.toContain("gone");
    expect(sounds.map((s) => s.id)).not.toContain("future");
    expect(issues.map((i) => i.issue)).toEqual([
      expect.stringContaining("missing file gone.mp3"),
      expect.stringContaining('skipped "Not A Slug"'),
      expect.stringContaining('kind "video" is not supported'),
    ]);
  });

  it("unreadable pack.json costs that pack only", () => {
    const root = emptyUserDir();
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), "{ this is not json");
    const { sounds, issues } = loadSfxLibrary({ userDir: root });
    expect(sounds).toHaveLength(11); // the bundled pack survived
    expect(issues).toEqual([{ pack: "broken", issue: expect.stringContaining("unreadable pack.json") }]);
  });

  it("a directory without a pack.json is not a pack and not an issue", () => {
    const root = emptyUserDir();
    mkdirSync(join(root, "notes"), { recursive: true });
    expect(loadSfxLibrary({ userDir: root }).issues).toEqual([]);
  });

  it("a missing user directory is the normal case", () => {
    expect(loadSfxLibrary({ userDir: join(emptyUserDir(), "nope") }).issues).toEqual([]);
  });
});

describe("loadSfxLibrary — excluding the bundled pack (`sfxBundledPack: false`)", () => {
  it("serves ONLY the user packs — the stock ids leave the menu entirely", () => {
    // The field ask: a personal pack overrides `ding`, and the REST of the
    // bundled sounds (pop, click, riser-short…) must not reach the model.
    // Overriding ids one at a time cannot do this.
    const root = emptyUserDir();
    writePack(root, "mine", { name: "mine", sounds: [sound({ whenToUse: "my own ding" })] }, ["ding.mp3"]);
    const { sounds, issues } = loadSfxLibrary({ userDir: root, includeBundled: false });
    expect(issues).toEqual([]);
    expect(sounds.map((s) => s.id)).toEqual(["ding"]);
    expect(sounds[0]!.packName).toBe("mine");
    expect(sounds[0]!.whenToUse).toBe("my own ding");
  });

  it("defaults to including it, so an absent option is the shipped behaviour", () => {
    const root = emptyUserDir();
    expect(loadSfxLibrary({ userDir: root }).sounds).toHaveLength(11);
    expect(loadSfxLibrary({ userDir: root, includeBundled: true }).sounds).toHaveLength(11);
  });

  it("no bundled pack and no user packs is empty WITH an actionable issue", () => {
    // The callers' zero-sounds path is warn-and-skip, and "no usable sounds"
    // on its own reads as a packaging bug in ossclip. Only the loader knows
    // the user asked for this, so it says so.
    const root = emptyUserDir();
    const { sounds, issues } = loadSfxLibrary({ userDir: root, includeBundled: false });
    expect(sounds).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("bundled pack excluded");
    expect(issues[0]!.issue).toContain("no user packs found");
    // Actionable: it names the directory to drop a pack into and the key to
    // flip back.
    expect(issues[0]!.issue).toContain(root);
    expect(issues[0]!.issue).toContain("sfxBundledPack");
  });

  it("does not add that issue when a user pack answered", () => {
    const root = emptyUserDir();
    writePack(root, "mine", { name: "mine", sounds: [sound({ id: "custom", file: "c.mp3", whenToUse: "mine" })] }, ["c.mp3"]);
    expect(loadSfxLibrary({ userDir: root, includeBundled: false }).issues).toEqual([]);
  });

  it("still reports a broken user pack — exclusion is not silence", () => {
    const root = emptyUserDir();
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), "{ this is not json");
    const { sounds, issues } = loadSfxLibrary({ userDir: root, includeBundled: false });
    expect(sounds).toEqual([]);
    // Two issues: the unreadable pack, and the empty-library explanation.
    expect(issues.map((i) => i.issue)).toEqual([
      expect.stringContaining("unreadable pack.json"),
      expect.stringContaining("bundled pack excluded"),
    ]);
  });
});

describe("resolveSfxBundledPack", () => {
  it("defaults to true when the key is absent — the shipped library", () => {
    expect(resolveSfxBundledPack(undefined)).toEqual({ include: true });
  });

  it("takes a real boolean, in both directions", () => {
    expect(resolveSfxBundledPack(true)).toEqual({ include: true });
    expect(resolveSfxBundledPack(false)).toEqual({ include: false });
  });

  it("warns and keeps the bundled pack on anything else — parse, never coerce", () => {
    // `"no"` is the trap: truthiness would read it as `true`, the opposite of
    // what its author meant. It is not a boolean, so it earns a warning and
    // the safe default (a library that is never accidentally empty).
    for (const bad of ["yes", "no", "false", 0, 1, null, {}, []]) {
      const out = resolveSfxBundledPack(bad);
      expect(out.include, JSON.stringify(bad)).toBe(true);
      expect(out.warning).toContain("sfxBundledPack");
    }
  });
});

describe("sfxLibraryHash", () => {
  const a: SfxSound = { id: "a", kind: "sound", file: "a.mp3", whenToUse: "one", tags: ["meme"], gain: 1 };
  const b: SfxSound = { id: "b", kind: "sound", file: "b.mp3", whenToUse: "two", tags: [], gain: 0.5 };

  it("is stable under reorder of sounds and of tags", () => {
    const tagged: SfxSound = { ...a, tags: ["x", "meme"] };
    const flipped: SfxSound = { ...a, tags: ["meme", "x"] };
    expect(sfxLibraryHash([a, b])).toBe(sfxLibraryHash([b, a]));
    expect(sfxLibraryHash([tagged, b])).toBe(sfxLibraryHash([b, flipped]));
  });

  it("ignores the audio file — a re-encode must not re-bill the LLM call", () => {
    expect(sfxLibraryHash([{ ...a, file: "a-128k.mp3", durationSec: 9 }])).toBe(sfxLibraryHash([a]));
  });

  it("changes when whenToUse, tags or gain change — the model was asked something else", () => {
    const base = sfxLibraryHash([a, b]);
    expect(sfxLibraryHash([{ ...a, whenToUse: "one, but different" }, b])).not.toBe(base);
    expect(sfxLibraryHash([{ ...a, tags: [] }, b])).not.toBe(base);
    expect(sfxLibraryHash([{ ...a, gain: 0.9 }, b])).not.toBe(base);
    expect(sfxLibraryHash([a])).not.toBe(base);
  });
});
