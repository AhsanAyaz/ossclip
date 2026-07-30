import { spawn } from "node:child_process";
import { chmodSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Archive extraction without a single npm dependency: every platform we
 * download for ships a `tar` that reads everything we download. GNU tar
 * covers .tar.gz/.tar.xz on Linux; bsdtar (macOS, and Windows 10+ as
 * C:\Windows\System32\tar.exe) additionally reads .zip. The one gap —
 * a Windows box with tar.exe removed — falls back to PowerShell's
 * Expand-Archive for zips.
 */

export function extractArchive(
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", destDir], { stdio: "ignore" });
    child.on("error", () => {
      if (platform === "win32" && archivePath.endsWith(".zip")) {
        const ps = spawn(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
          ],
          { stdio: "ignore" },
        );
        ps.on("error", (e) => reject(new Error(`neither tar nor PowerShell could extract: ${e.message}`)));
        ps.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`)),
        );
        return;
      }
      reject(new Error(`'tar' not found — needed to extract ${archivePath}`));
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code} extracting ${archivePath}`)),
    );
  });
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
