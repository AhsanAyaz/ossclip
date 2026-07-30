import { spawn } from "node:child_process";
import { chmodSync, readdirSync, type Dirent } from "node:fs";
import { join, win32 } from "node:path";

/**
 * Archive extraction without a single npm dependency: every platform we
 * download for ships a `tar` that reads everything we download. GNU tar
 * covers .tar.gz/.tar.xz on Linux; bsdtar (macOS, and Windows 10+ as
 * %SystemRoot%\System32\tar.exe) additionally reads .zip.
 *
 * The Windows subtlety that cost a CI run (§117): a bare `tar` there is
 * whichever one PATH finds first, and any machine with Git for Windows —
 * every GitHub runner, and most developer boxes — puts MSYS **GNU** tar
 * ahead of the system bsdtar. GNU tar cannot read a zip and exits 128. So
 * on win32 the system bsdtar is tried by absolute path FIRST, and every
 * candidate that fails for ANY reason falls through to the next: the
 * original code only fell back when `spawn` itself errored, which a
 * nonzero exit is not.
 */

/** Extractors to try, in order. Pure, so the ordering is unit-testable. */
export function tarCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== "win32") return ["tar"];
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  // `win32.join`, not `join`: this builds a Windows path and the planner is
  // pure over an injected platform, so it must not pick separators from
  // whatever host the tests happen to run on.
  // Absolute bsdtar first, then whatever PATH has (an unusual box may only
  // have one of them).
  return [win32.join(systemRoot, "System32", "tar.exe"), "tar"];
}

const spawnOk = (bin: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

export async function extractArchive(
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const bin of tarCandidates(platform, env)) {
    if (await spawnOk(bin, ["-xf", archivePath, "-C", destDir])) return;
  }
  if (platform === "win32" && archivePath.endsWith(".zip")) {
    const ok = await spawnOk("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ]);
    if (ok) return;
    throw new Error(`neither tar nor Expand-Archive could extract ${archivePath}`);
  }
  throw new Error(`tar could not extract ${archivePath}`);
}

/**
 * Find `basename` under `dir`, recursively. Release archives put binaries at
 * different depths (`Release/whisper-cli.exe`, `<verdir>/bin/ffmpeg`) and
 * those layouts are upstream's to change — searching beats hardcoding them.
 */
export function findFile(dir: string, basename: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === basename) return join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFile(join(dir, e.name), basename);
      if (hit) return hit;
    }
  }
  return null;
}

/** POSIX archives usually preserve the execute bit; make sure of it. */
export function markExecutable(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") chmodSync(path, 0o755);
}
