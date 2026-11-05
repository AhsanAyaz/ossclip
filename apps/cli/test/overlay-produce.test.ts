import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedLibraryEntry, LoadedSfxSound, OverlayEntrySnapshot, SfxCue } from "@ossclip/core";
import { priorOverlayPlan, snapshotEntry, stageOverlayFiles, stageSfxSounds } from "../src/overlays";

/**
 * The produce-side overlay helpers (overlay-library spec §Placement schema
 * "Snapshot", §Resolve "Staging"): what a `--scenes` replay carries forward,
 * what a project remembers about a library entry, and the copy rule that
 * makes a render independent of the library folder (plan review focus 1).
 * Temp dirs only — nothing here reads or writes `~/.ossclip`.
 */
const dirs: string[] = [];
const tmp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `ossclip-overlay-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNG_A = Buffer.from("89504e470d0a1a0a0000000d49484452aaaa", "hex");
const PNG_B = Buffer.from("89504e470d0a1a0a0000000d49484452bbbb", "hex");

const libraryEntry = (dir: string, over: Partial<LoadedLibraryEntry> = {}): LoadedLibraryEntry => ({
  id: "gde",
  file: "gde.png",
  names: ["Google Developers Expert", "GDE"],
  kind: "logo",
  absPath: join(dir, "gde.png"),
  format: "png",
  ...over,
});

const snap: OverlayEntrySnapshot = {
  id: "gde",
  name: "Google Developers Expert",
  names: ["Google Developers Expert", "GDE"],
  kind: "logo",
  ext: "png",
};

describe("priorOverlayPlan (the matched plan a --scenes replay carries)", () => {
  const workdirWith = (production: string | undefined): string => {
    const work = tmp("prior");
    if (production !== undefined) writeFileSync(join(work, "production.json"), production);
    return work;
  };

  it("missing file, garbage file, or no overlays key → undefined", () => {
    expect(priorOverlayPlan(workdirWith(undefined))).toBeUndefined();
    expect(priorOverlayPlan(workdirWith("{not json"))).toBeUndefined();
    expect(priorOverlayPlan(workdirWith(JSON.stringify({ version: 1 })))).toBeUndefined();
  });

  it("an overlays block the schema rejects → undefined, never a cast", () => {
    // A hand-edited look of "CARD" must not reach the renderer as a look.
    const bad = { overlays: { entries: [snap], placements: [{ id: "gde@3", entryId: "gde", word: 3, look: "CARD", source: "match" }] } };
    expect(priorOverlayPlan(workdirWith(JSON.stringify(bad)))).toBeUndefined();
  });

  it("valid → parsed", () => {
    const overlays = { entries: [snap], placements: [{ id: "gde@3", entryId: "gde", word: 3, source: "match" }] };
    expect(priorOverlayPlan(workdirWith(JSON.stringify({ version: 1, overlays })))).toEqual(overlays);
  });
});

describe("snapshotEntry", () => {
  it("keeps what a render needs, drops the library's own file name and path", () => {
    const s = snapshotEntry(libraryEntry("/lib", { look: "card", sound: null }));
    expect(s).toEqual({ ...snap, look: "card", sound: null });
    expect(s).not.toHaveProperty("absPath");
    expect(s).not.toHaveProperty("file");
  });

  it("writes no look/sound keys the entry does not have, so production.json stays minimal", () => {
    expect(Object.keys(snapshotEntry(libraryEntry("/lib")))).toEqual(["id", "name", "names", "kind", "ext"]);
  });

  it("a JPEG snapshots as ext jpg (the sniffed format, never the source name)", () => {
    expect(snapshotEntry(libraryEntry("/lib", { file: "x.JPEG", format: "jpg" })).ext).toBe("jpg");
  });
});

describe("stageOverlayFiles", () => {
  const setup = () => {
    const lib = tmp("lib");
    const work = tmp("work");
    const pub = tmp("pub");
    writeFileSync(join(lib, "gde.png"), PNG_A);
    return { lib, work, pub, entry: libraryEntry(lib) };
  };

  it("first stage copies library → workdir → publicDir", () => {
    const { work, pub, entry } = setup();
    const r = stageOverlayFiles([snap], [entry], work, pub);
    expect(r.issues).toEqual([]);
    expect([...r.staged]).toEqual(["library/gde.png"]);
    expect(readFileSync(join(work, "library", "gde.png"))).toEqual(PNG_A);
    expect(readFileSync(join(pub, "library", "gde.png"))).toEqual(PNG_A);
  });

  it("workdir copy wins even when the library file changed", () => {
    const { lib, work, pub, entry } = setup();
    stageOverlayFiles([snap], [entry], work, pub);
    writeFileSync(join(lib, "gde.png"), PNG_B);
    // A stale publicDir copy must be corrected FROM the workdir, not left.
    writeFileSync(join(pub, "library", "gde.png"), PNG_B);
    const r = stageOverlayFiles([snap], [entry], work, pub);
    expect(r.staged.has("library/gde.png")).toBe(true);
    expect(readFileSync(join(work, "library", "gde.png"))).toEqual(PNG_A);
    expect(readFileSync(join(pub, "library", "gde.png"))).toEqual(PNG_A);
  });

  it("library file deleted → workdir copy still staged", () => {
    const { lib, work, pub, entry } = setup();
    stageOverlayFiles([snap], [entry], work, pub);
    rmSync(join(lib, "gde.png"));
    rmSync(join(pub, "library"), { recursive: true });
    const r = stageOverlayFiles([snap], [], work, pub);
    expect(r.issues).toEqual([]);
    expect(r.staged.has("library/gde.png")).toBe(true);
    expect(readFileSync(join(pub, "library", "gde.png"))).toEqual(PNG_A);
  });

  it("both missing → issue, not staged", () => {
    const { lib, work, pub, entry } = setup();
    rmSync(join(lib, "gde.png"));
    const r = stageOverlayFiles([snap], [entry], work, pub);
    expect(r.staged.size).toBe(0);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toContain("gde");
    expect(existsSync(join(work, "library", "gde.png"))).toBe(false);
  });

  it("a library entry whose format no longer matches the snapshot is not copied under the old ext", () => {
    // Re-saved as a JPEG under the same id: copying those bytes into
    // `gde.png` would hand the renderer a mislabelled file.
    const { work, pub, entry } = setup();
    const r = stageOverlayFiles([snap], [{ ...entry, format: "jpg" }], work, pub);
    expect(r.staged.size).toBe(0);
    expect(r.issues).toHaveLength(1);
    expect(existsSync(join(work, "library", "gde.png"))).toBe(false);
  });

  it("publicDir === workdir stages once, in place", () => {
    const { work, entry } = setup();
    const r = stageOverlayFiles([snap], [entry], work, work);
    expect(r.staged.has("library/gde.png")).toBe(true);
    expect(readFileSync(join(work, "library", "gde.png"))).toEqual(PNG_A);
  });
});

describe("stageSfxSounds (the one stager sfx and overlay pops share)", () => {
  const sound = (dir: string, id: string): LoadedSfxSound => {
    const absPath = join(dir, `${id}.mp3`);
    writeFileSync(absPath, id);
    return { id, kind: "sound", file: `${id}.mp3`, whenToUse: "x", tags: [], gain: 1, absPath, packName: "p" };
  };
  const cue = (soundFile: string): SfxCue => ({ soundFile, atSec: 1, gain: 1 });

  it("copies only the CUED sounds, into every dir", () => {
    const pack = tmp("pack");
    const a = tmp("a");
    const b = tmp("b");
    stageSfxSounds([sound(pack, "pop"), sound(pack, "whoosh")], [cue("sfx/pop.mp3")], [a, b]);
    for (const d of [a, b]) {
      expect(readFileSync(join(d, "sfx", "pop.mp3"), "utf8")).toBe("pop");
      expect(existsSync(join(d, "sfx", "whoosh.mp3"))).toBe(false);
    }
  });

  it("a sound listed twice (two library loads) is staged from the FIRST", () => {
    const p1 = tmp("p1");
    const p2 = tmp("p2");
    mkdirSync(join(p2, "x"));
    const first = sound(p1, "pop");
    const second = { ...sound(p2, "pop"), absPath: join(p2, "x", "missing.mp3") };
    const out = tmp("out");
    // The second's absPath does not exist: reaching it would throw.
    stageSfxSounds([first, second], [cue("sfx/pop.mp3")], [out, out]);
    expect(readFileSync(join(out, "sfx", "pop.mp3"), "utf8")).toBe("pop");
  });
});
