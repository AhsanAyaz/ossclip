import { pathToFileURL } from "node:url";

/**
 * File URLs for the kit's timeline (§162, design 3.3 "Paths", Review Focus
 * 4). Pure: the caller passes whether this is WSL and the distro name, so
 * the mapping is tested without a WSL machine.
 *
 * Under WSL ossclip sees the Linux side, while Resolve runs on Windows and
 * resolves the URL there. `pathToFileURL("/mnt/c/...")` would give
 * `file:///mnt/c/...`, a path Windows does not have; the spike (2026-11-16)
 * showed Resolve links `file:///C:/...`.
 */
export function kitFileUrl(
  absPath: string,
  env: { wsl: boolean; distro?: string },
): { url: string; warning?: string } {
  if (!env.wsl) return { url: pathToFileURL(absPath).href };
  // Percent-encode per segment, never the separators: a space or `#` in a
  // folder name must not end the URL, and the output stays ASCII.
  const encode = (segments: string[]): string => segments.map((s) => encodeURIComponent(s)).join("/");
  const drive = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(absPath);
  if (drive !== null) {
    const rest = drive[2] ?? "";
    return { url: `file:///${drive[1]!.toUpperCase()}:/${encode(rest === "" ? [] : rest.split("/"))}` };
  }
  // A file in the Linux filesystem: Windows reaches it through the
  // `\\wsl.localhost\<distro>` share, which needs the distro's name. The
  // spike never tried that form, so the author is told rather than left to
  // find an offline clip.
  const warning = `${absPath} is inside the Linux filesystem; Resolve may ask you to relink it`;
  if (env.distro === undefined || env.distro === "") {
    // No distro name (WSL_DISTRO_NAME unset) leaves no share to name; the
    // plain URL at least tells the author which file to relink.
    return { url: pathToFileURL(absPath).href, warning };
  }
  const segments = absPath.split("/").filter((s) => s !== "");
  return { url: `file://wsl.localhost/${encodeURIComponent(env.distro)}/${encode(segments)}`, warning };
}

/**
 * Whether this Linux is WSL. WSL sets `WSL_DISTRO_NAME` and `WSL_INTEROP`
 * in every shell it starts; a process started without them (a service, a
 * cleared environment) still runs on the Microsoft kernel, which
 * `/proc/version` names. The caller reads the file; `null` when it could
 * not.
 */
export function isWslEnv(
  platform: string,
  env: Record<string, string | undefined>,
  procVersion: string | null,
): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return procVersion !== null && /microsoft|wsl/i.test(procVersion);
}
