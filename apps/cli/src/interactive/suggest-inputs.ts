import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { VIDEO_EXTENSIONS } from "@ossclip/core";

/**
 * The rows above "Browse…" in the input prompt (§136). A non-technical user
 * has just hit record and wants the file they made thirty seconds ago; it is
 * nearly always the newest video in the working directory, Downloads, or
 * Movies. Offering it by name beats any picker.
 *
 * Deliberately stateless: no recents file to keep, migrate or privacy-audit,
 * and — the reason that mattered — a recents list is EMPTY on the very first
 * run, which is the exact run a new user needs the help on.
 */

export interface CandidateFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface Suggestion {
  path: string;
  label: string;
  hint: string;
}

const VIDEO_EXT_SET = new Set<string>(VIDEO_EXTENSIONS);

/**
 * Base-1000 like Finder and Explorer report it, not base-1024.
 *
 * The thresholds are the ROUNDING boundary (999_500), not the unit boundary
 * (1_000_000): `Math.round` carries into the next unit while a unit-boundary
 * check has already committed to the current one, so a 999.7 MB screen
 * recording printed "1000 MB" next to a sibling's "1.1 GB".
 */
export function humanSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 999_500) return `${Math.round(bytes / 1_000)} kB`;
  if (bytes < 999_500_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function relativeAge(msInput: number): string {
  // A file copied off a camera with an unset clock carries an mtime years
  // ahead, which reaches here as a NEGATIVE age. Clamped rather than special
  // cased: "just now" is the honest label for "not older than now". Such
  // files are deliberately still ranked (highest, by mtime) rather than
  // filtered — a few seconds of clock skew is ordinary and the file is real.
  const ms = Math.max(0, msInput);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function tildeify(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function likelyDirs(d: {
  platform: NodeJS.Platform;
  cwd: string;
  home: string;
}): string[] {
  // Movies on macOS, Videos everywhere else — the OS's own recording default.
  const media = join(d.home, d.platform === "darwin" ? "Movies" : "Videos");
  return [...new Set([d.cwd, join(d.home, "Downloads"), media])];
}

export function rankSuggestions(
  files: CandidateFile[],
  nowMs: number,
  home: string,
  limit = 3,
): Suggestion[] {
  return files
    .filter((file) => {
      const name = basename(file.path);
      if (name.startsWith(".")) return false;
      // ossclip's own output. Cutting an already-cut video compounds the
      // trims and is never what somebody means to do from this menu.
      if (name.toLowerCase().endsWith(".ossclip.mp4")) return false;
      // Case-folded before the lookup because VIDEO_EXTENSIONS is lowercase
      // and cameras and screen recorders write `.MP4`/`.MOV` — the same fold
      // `listFolderVideos` does, for the same reason.
      return VIDEO_EXT_SET.has(extname(name).slice(1).toLowerCase());
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => ({
      path: file.path,
      label: tildeify(file.path, home),
      hint: `${humanSize(file.size)} · ${relativeAge(nowMs - file.mtimeMs)}`,
    }));
}

/** How many files to `stat` per directory. See the placement note below. */
const MAX_STATS_PER_DIR = 2_000;

/**
 * The only filesystem in this module, and non-recursive on purpose: this
 * runs before the first prompt paints, so a deep walk of somebody's
 * Downloads would show up as the CLI hanging on startup.
 */
export async function scanLikelyDirs(
  dirs: string[] = likelyDirs({ platform: process.platform, cwd: process.cwd(), home: homedir() }),
): Promise<CandidateFile[]> {
  const out: CandidateFile[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        // Symlinks are followed, matching `listFolderVideos` in concat.ts: a
        // folder of symlinks into another drive is a normal way to stage
        // takes. The `stat` below resolves the target, and a dangling link
        // throws into the per-file catch there.
        .filter((e) => e.isFile() || e.isSymbolicLink())
        .map((e) => e.name)
        // Case-folded because VIDEO_EXTENSIONS is lowercase and recorders
        // write `.MP4`/`.MOV`, the same fold `listFolderVideos` does.
        .filter((name) => VIDEO_EXT_SET.has(extname(name).slice(1).toLowerCase()))
        // The cap sits AFTER the filter on purpose: `readdir` has already
        // materialised every dirent, so capping before it saves no I/O and
        // throws away videos at random — readdir order is filesystem order,
        // not mtime, so the take recorded 30 seconds ago is as likely to land
        // in the discarded tail as anything else. Here it bounds the only
        // real cost, the per-file stat.
        .slice(0, MAX_STATS_PER_DIR);
    } catch {
      // A missing ~/Movies or an unreadable directory is ordinary. The
      // suggestions are a convenience; nothing here may fail the wizard.
      continue;
    }
    // Stat'd in parallel: awaited one at a time, a directory of 400 clips on
    // an SMB share or an iCloud "Optimize Storage" ~/Movies is seconds of
    // dead terminal before the first prompt paints, which is the startup hang
    // non-recursion alone does not prevent. try/catch inside each task rather
    // than allSettled because the recovery is identical for every failure —
    // drop that one file — and this keeps the settled result already typed.
    const stats = await Promise.all(
      names.map(async (name): Promise<CandidateFile | undefined> => {
        const path = join(dir, name);
        try {
          const st = await stat(path);
          return { path, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          // Raced with a delete between readdir and stat, or a dangling
          // symlink — skips this file only, never the whole directory.
          return undefined;
        }
      }),
    );
    for (const file of stats) if (file !== undefined) out.push(file);
  }
  return out;
}
