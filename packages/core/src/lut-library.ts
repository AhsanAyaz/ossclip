import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CONFIG_DIR } from "./config";
import { parseCubeLut } from "./color-grade";

/**
 * The user's .cube LUT directory, discovered — the `sfx-pack.ts` shape for
 * color grades. `parseCubeLut` stays pure; this module is the thin fs layer
 * that walks `~/.ossclip/luts` and reports, per file, either a usable LUT or
 * the reason it is not one. Nothing here throws: a hand-dropped .cube is user
 * input, and a broken one must cost that one menu entry, not the editor.
 */

/** Where user LUTs live: `~/.ossclip/luts/<name>.cube`. */
export function userLutDir(): string {
  return join(CONFIG_DIR, "luts");
}

/** One LUT the menu can offer. `path` stays server-side, like SFX `absPath`. */
export interface LutLibraryItem {
  /** The filename stem — what `ColorGrade.lut` (basename) resolves against. */
  id: string;
  /** The .cube's own TITLE when it has one, else the stem. */
  title: string;
  /** Absolute path — the caller's I/O concern, never sent to a client. */
  path: string;
}

/** Why one file is not in the library — `SfxPackIssue`'s shape, per file. */
export interface LutLibraryIssue {
  /** The .cube filename (basename) that failed. */
  file: string;
  message: string;
}

export interface LutLibrary {
  items: LutLibraryItem[];
  issues: LutLibraryIssue[];
}

/**
 * Every parseable `.cube` under `dir`, plus an issue per file that is not one.
 * Each file is fully parsed here — not just listed — because the menu is the
 * ONLY surface where a broken LUT can be reported before a render silently
 * drops it: `parseCubeLut` is strict about content on purpose, and offering a
 * file the bake will refuse is the exact mismatch the SFX library gate exists
 * to avoid.
 *
 * A missing directory is the normal case (most users never drop a LUT), not
 * an issue. `dir` is a parameter with a default rather than a `homedir()`
 * read inside, so tests point it at a tmp dir and never touch a real home
 * (`loadSfxLibrary`'s rule).
 */
export function loadLutLibrary(dir: string = userLutDir()): LutLibrary {
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".cube"))
      .map((e) => e.name)
      // Sorted so the menu reads the same on every machine — readdir order is
      // not a promise (loadSfxLibrary's merge-order rule).
      .sort();
  } catch {
    return { items: [], issues: [] };
  }
  const items: LutLibraryItem[] = [];
  const issues: LutLibraryIssue[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const stem = basename(name, extname(name));
    try {
      const lut = parseCubeLut(readFileSync(path, "utf8"));
      // TITLE when the exporter wrote one — a human-readable label the stem
      // (often `Vendor_Look_33pt_v2`) cannot match. Empty titles fall back.
      items.push({ id: stem, title: lut.title?.trim() || stem, path });
    } catch (e) {
      issues.push({ file: name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { items, issues };
}
