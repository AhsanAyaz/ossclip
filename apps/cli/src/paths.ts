import { mkdirSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * Out-path safety helpers (2026-08-16 field incident): the wizard's output
 * prompt is a plain text input, and NO shell expands a wizard text input —
 * a typed `~/Downloads/x.mp4` resolved against cwd, so the end-of-run rename
 * ENOENT'd after a 50-minute render because `<cwd>/~/Downloads` never
 * existed. Two defenses live here: tilde expansion applied at every
 * user-supplied path's resolution site, and failing (or healing) a bad out
 * path in the first second instead of at the final rename.
 */

/**
 * Expand a leading `~` to the home directory. `~user` forms are deliberately
 * left untouched — resolving another user's home needs /etc/passwd semantics
 * we don't have, and a wrong guess would be worse than the literal path.
 * `home` is injectable so the matrix is testable without the real homedir.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

/**
 * mkdir -p the parent of a would-be output file. mkdir chosen over refusal:
 * the path is the user's explicit intent and creating a folder is what they'd
 * do by hand; a genuinely un-creatable path (permissions) still fails loudly
 * — just upfront now, not after the render. `mkdirFn` is injectable so the
 * test asserts the directory asked for without touching a filesystem.
 */
export function ensureParentDir(
  filePath: string,
  mkdirFn: (dir: string) => void = (dir) => mkdirSync(dir, { recursive: true }),
): void {
  mkdirFn(dirname(filePath));
}

/**
 * `<out>.mp4` + `".cover.jpg"` → `<out>.cover.jpg`: the output's sibling
 * artifact path, centralizing the replace idiom that lived (twice, and once
 * stale — see the completion banner's call site) inline. The extension match
 * excludes path separators on purpose: the bare-idiom regex `(\.[^.]+)?$`
 * would treat a dotted DIRECTORY name as the extension of an extensionless
 * output ("/out.v2/final" → "/out.cover.jpg", a file outside the folder the
 * user chose). An input with no extension gains the suffix whole.
 *
 * Lives here rather than in produce.ts (its original home, 2026-08-17): the
 * edit server derives `<out>.thumbnail.png` from command.json's recorded out
 * and cannot import produce.ts — produce imports edit (recordRecentProject),
 * and produce's import graph drags the renderer into a deliberately
 * dependency-free server. produce.ts re-exports it for its existing callers.
 */
export function artifactPath(outPath: string, suffix: string): string {
  return outPath.replace(/(\.[^./\\]+)?$/, suffix);
}

/** The rename/copy seam, injectable for the EXDEV test. */
export interface MoveDeps {
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const liveMoveDeps: MoveDeps = { rename, copyFile, unlink };

/**
 * `fs.rename` cannot cross volumes — an `--out` on an external drive throws
 * EXDEV at the very end of the run (the sibling trap to the ENOENT above;
 * ENOENT is prevented upfront by `ensureParentDir`). On EXDEV, fall back to
 * copy+unlink; every other failure still throws, unchanged.
 */
export async function moveFile(
  from: string,
  to: string,
  deps: MoveDeps = liveMoveDeps,
): Promise<void> {
  try {
    await deps.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await deps.copyFile(from, to);
    await deps.unlink(from);
  }
}
