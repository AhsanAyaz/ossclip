import { VIDEO_EXTENSIONS } from "@ossclip/core";
import { binOnPath } from "../llm-detect";

/**
 * The native file/folder dialog (§136). Typing a path was the one step a
 * non-technical user could not get past — the blocker was never the flags,
 * it was the very first prompt.
 *
 * Split the way `open.ts` is split, and for the same reason: the platform
 * matrix is decided by pure functions with a table test, so a Linux or
 * Windows user is not the one who discovers the command was wrong. The
 * `ossclip edit` crash that shipped in 0.1.4 for every non-macOS user is what
 * this shape exists to prevent.
 */

export type PickMode = "file" | "folder";

export interface PickerDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasBin: (bin: string) => boolean;
}

export const livePickerDeps = (): PickerDeps => ({
  platform: process.platform,
  env: process.env,
  hasBin: (bin) => binOnPath(bin),
});

/** `*.mov *.mp4 …` — the shape zenity and kdialog both want, space-joined. */
const globs = (): string => VIDEO_EXTENSIONS.map((e) => `*.${e}`).join(" ");

/**
 * A PowerShell single-quoted string has exactly one escape: a literal `'` is
 * written `''`. Nothing else is special in there — not `$`, not a backtick,
 * not the `\` that fills every Windows path — which is why single quotes are
 * what the script uses and why this is the whole escape rather than a table.
 * `C:\Users\Ahsan's videos` is the case that makes it necessary.
 */
const psQuote = (s: string): string => s.replace(/'/g, "''");

/**
 * Is there a dialog to open at all? Probed rather than attempted, because
 * offering a "Browse…" row that cannot work is worse than not offering it —
 * the menu drops the row entirely when this is false.
 */
export function pickerAvailable(d: PickerDeps): boolean {
  // Truthiness not presence, matching `isInteractive`'s treatment of CI.
  if (d.env.OSSCLIP_NO_PICKER) return false;
  // No SSH session gets a dialog, on ANY platform: there is no window server
  // at the far end to draw on. macOS at least fails loudly — `choose file`
  // returns -1743 (not authorized) instead of opening. Windows fails the
  // dangerous way: it ships an in-box OpenSSH server, and ShowDialog() on a
  // non-interactive window station blocks forever on a window nobody can see.
  // `run()` has no timeout, so that is a CLI hung until Ctrl-C — the exact
  // failure the -STA comment below exists to prevent.
  if (d.env.SSH_CONNECTION || d.env.SSH_TTY) return false;
  // Nothing left to detect on either: osascript is part of macOS and WinForms
  // ships with Windows itself.
  if (d.platform === "darwin" || d.platform === "win32") return true;
  // Linux needs BOTH halves, and the display check is what covers WSL
  // without WSLg: zenity may well be installed there and still draw nowhere.
  if (!d.env.DISPLAY && !d.env.WAYLAND_DISPLAY) return false;
  return d.hasBin("zenity") || d.hasBin("kdialog");
}

export function pickerCommand(
  d: PickerDeps,
  mode: PickMode,
  startDir?: string,
): { bin: string; args: string[] } {
  if (d.platform === "darwin") {
    // Bare extensions, verified on macOS 26.3 — matching files stay
    // selectable and the rest are dimmed. The UTI form {"public.movie"} was
    // the alternative and is NOT used: its mkv coverage is unconfirmed, and
    // mkv is in VIDEO_EXTENSIONS.
    const types = VIDEO_EXTENSIONS.map((e) => `"${e}"`).join(",");
    const clause =
      mode === "folder"
        ? 'choose folder with prompt "Pick a folder of clips"'
        : `choose file with prompt "Pick your video" of type {${types}}`;
    // startDir is always process.cwd(), never user text — but JSON.stringify
    // still escapes it, because AppleScript string syntax is close enough to
    // JSON's that this is the cheap correct thing rather than concatenation.
    const loc = startDir === undefined ? "" : ` default location POSIX file ${JSON.stringify(startDir)}`;
    return { bin: "osascript", args: ["-e", `POSIX path of (${clause}${loc})`] };
  }

  if (d.platform === "win32") {
    // -STA is load-bearing: WinForms dialogs deadlock on the MTA thread that
    // `powershell -Command` uses by default, and a deadlock here looks
    // exactly like a hung CLI. `powershell` (5.1, in-box) rather than
    // `pwsh`, which is not installed by default.
    // startDir is honoured here too, under different property names on the
    // two dialogs. Without it a Windows user standing in D:\shoots\raw opens
    // at Desktop while darwin, zenity and kdialog all land in the project
    // folder — the same flag, three platforms agreeing and one not.
    const start =
      startDir === undefined
        ? ""
        : mode === "folder"
          ? // FolderBrowserDialog seeds its start folder from SelectedPath —
            // the same property it hands the answer back in.
            `$d.SelectedPath = '${psQuote(startDir)}'; `
          : `$d.InitialDirectory = '${psQuote(startDir)}'; `;
    const script =
      mode === "folder"
        ? "Add-Type -AssemblyName System.Windows.Forms; " +
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          start +
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"
        : "Add-Type -AssemblyName System.Windows.Forms; " +
          "$d = New-Object System.Windows.Forms.OpenFileDialog; " +
          `$d.Filter = 'Video|${VIDEO_EXTENSIONS.map((e) => `*.${e}`).join(";")}|All files|*.*'; ` +
          start +
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }";
    return { bin: "powershell", args: ["-NoProfile", "-STA", "-Command", script] };
  }

  // Linux. zenity first because it is the GTK/GNOME default and far more
  // widely installed; kdialog is the KDE equivalent and its filter syntax is
  // a DIFFERENT shape — `Name(*.ext)` parentheses, not zenity's pipe.
  if (d.hasBin("zenity")) {
    const args = [
      "--file-selection",
      mode === "folder" ? "--title=Pick a folder of clips" : "--title=Pick your video",
    ];
    if (mode === "folder") args.push("--directory");
    else args.push(`--file-filter=Video | ${globs()}`, "--file-filter=All files | *");
    // The trailing slash is what makes zenity read this as a starting
    // DIRECTORY rather than a pre-filled filename.
    if (startDir !== undefined) args.push(`--filename=${startDir}/`);
    return { bin: "zenity", args };
  }

  if (mode === "folder") {
    // --getexistingdirectory accepts a start dir and nothing else; passing a
    // filter here is an error, not an ignored argument.
    return { bin: "kdialog", args: ["--getexistingdirectory", startDir ?? "."] };
  }
  return {
    bin: "kdialog",
    args: ["--getopenfilename", startDir ?? ".", `Video files(${globs()})`],
  };
}

/**
 * Emptiness is the signal: no path came back. Exit codes cannot carry it —
 * zenity and kdialog exit non-zero when dismissed, but PowerShell exits 0 and
 * simply emits nothing, because the `if` guarding ShowDialog() just doesn't
 * fire. So the caller passes `allowNonZero` and reads stdout, on every
 * platform.
 *
 * What "no path came back" does NOT distinguish is a cancel from a silent
 * backend failure — osascript hitting -1743 in a launchd or tmux context that
 * sets neither SSH var, or Add-Type failing on a Windows box. That conflation
 * is deliberate: no backend gives us a reliable way to tell the two apart
 * (stderr is prose that varies by version and locale), and the caller's
 * fallback is the typed-path prompt, which is the right next step either way.
 */
export function parsePickerResult(stdout: string): string | undefined {
  const picked = stdout.trim();
  return picked === "" ? undefined : picked;
}
