import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pickPath,
  pickerAvailable,
  pickerCommand,
  parsePickerResult,
  type PickerDeps,
} from "../src/interactive/picker";

/**
 * The platform matrix for the native file picker (§136). Same shape as the
 * openCommand test: the whole cross-platform decision is asserted here so a
 * Linux or Windows user is never the one who discovers the command was wrong
 * — the 0.1.4 `ossclip edit` crash is the cautionary tale for exactly this.
 *
 * Syntax facts pinned below were verified 2026-08-12, not guessed:
 * macOS accepts bare extensions in `of type {...}`; zenity separates filter
 * name from patterns with a pipe; kdialog uses `Name(*.ext)` parentheses.
 */
const deps = (over: Partial<PickerDeps> = {}): PickerDeps => ({
  platform: "darwin",
  env: {},
  hasBin: () => false,
  ...over,
});

describe("pickerAvailable", () => {
  it("darwin: yes on a local session", () => {
    expect(pickerAvailable(deps({ platform: "darwin" }))).toBe(true);
  });

  it("darwin: no over SSH — osascript cannot own a window there (-1743)", () => {
    expect(pickerAvailable(deps({ platform: "darwin", env: { SSH_CONNECTION: "x" } }))).toBe(false);
    expect(pickerAvailable(deps({ platform: "darwin", env: { SSH_TTY: "/dev/ttys1" } }))).toBe(false);
  });

  it("win32: yes — WinForms ships in-box on every supported Windows", () => {
    expect(pickerAvailable(deps({ platform: "win32" }))).toBe(true);
  });

  it("win32: no over SSH — Windows ships an OpenSSH server, and ShowDialog() there hangs forever", () => {
    expect(pickerAvailable(deps({ platform: "win32", env: { SSH_CONNECTION: "x" } }))).toBe(false);
    expect(pickerAvailable(deps({ platform: "win32", env: { SSH_TTY: "/dev/pts/0" } }))).toBe(false);
  });

  it("linux: SSH does NOT disqualify it — `ssh -X` forwards a real display", () => {
    // The SSH check is a proxy for the signal darwin and win32 lack. Linux
    // has the signal, and X11 forwarding sets it truthfully: zenity draws on
    // the caller's local screen. Applying the proxy here would override
    // evidence with a guess and break a working setup.
    expect(
      pickerAvailable(
        deps({
          platform: "linux",
          env: { DISPLAY: "localhost:10.0", SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
          hasBin: (b) => b === "zenity",
        }),
      ),
    ).toBe(true);
    // …but SSH with no forwarded display is still a no, on the display check.
    expect(
      pickerAvailable(
        deps({ platform: "linux", env: { SSH_CONNECTION: "x" }, hasBin: (b) => b === "zenity" }),
      ),
    ).toBe(false);
  });

  it("linux: needs BOTH a display and a dialog binary", () => {
    const withZenity = (bin: string) => bin === "zenity";
    expect(pickerAvailable(deps({ platform: "linux", env: { DISPLAY: ":0" }, hasBin: withZenity }))).toBe(true);
    expect(pickerAvailable(deps({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, hasBin: withZenity }))).toBe(true);
    // display but no dialog binary — the common bare-server case
    expect(pickerAvailable(deps({ platform: "linux", env: { DISPLAY: ":0" } }))).toBe(false);
    // binary but no display — WSL without WSLg
    expect(pickerAvailable(deps({ platform: "linux", hasBin: withZenity }))).toBe(false);
  });

  it("linux: kdialog counts too", () => {
    expect(
      pickerAvailable(deps({ platform: "linux", env: { DISPLAY: ":0" }, hasBin: (b) => b === "kdialog" })),
    ).toBe(true);
  });

  it("OSSCLIP_NO_PICKER switches it off everywhere", () => {
    expect(pickerAvailable(deps({ platform: "darwin", env: { OSSCLIP_NO_PICKER: "1" } }))).toBe(false);
    expect(pickerAvailable(deps({ platform: "win32", env: { OSSCLIP_NO_PICKER: "1" } }))).toBe(false);
  });
});

describe("pickerCommand", () => {
  it("darwin file: bare extensions, not UTIs (verified on macOS 26.3)", () => {
    const { bin, args } = pickerCommand(deps({ platform: "darwin" }), "file", "/tmp/raw");
    expect(bin).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('of type {"mov","mp4","m4v","mkv","webm","avi"}');
    expect(args[1]).toContain("POSIX path of (choose file");
    expect(args[1]).toContain('default location POSIX file "/tmp/raw"');
  });

  it("darwin folder: no type filter — `choose folder` takes none", () => {
    const { args } = pickerCommand(deps({ platform: "darwin" }), "folder");
    expect(args[1]).toContain("choose folder");
    expect(args[1]).not.toContain("of type");
  });

  it("win32: -STA is load-bearing — WinForms deadlocks on the default MTA thread", () => {
    const { bin, args } = pickerCommand(deps({ platform: "win32" }), "file");
    expect(bin).toBe("powershell");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-Command"]);
    expect(args[3]).toContain("OpenFileDialog");
    expect(args[3]).toContain("*.mov;*.mp4;*.m4v;*.mkv;*.webm;*.avi");
  });

  it("win32 folder: FolderBrowserDialog, and SelectedPath not FileName", () => {
    const { args } = pickerCommand(deps({ platform: "win32" }), "folder");
    expect(args[3]).toContain("FolderBrowserDialog");
    expect(args[3]).toContain("$d.SelectedPath");
    expect(args[3]).not.toContain("$d.FileName");
  });

  it("win32 file: startDir is honoured — Windows was the one platform that ignored it", () => {
    const { args } = pickerCommand(deps({ platform: "win32" }), "file", "D:\\shoots\\raw");
    expect(args[3]).toContain("$d.InitialDirectory = 'D:\\shoots\\raw'");
  });

  it("win32 folder: startDir seeds SelectedPath — the property it also answers in", () => {
    const { args } = pickerCommand(deps({ platform: "win32" }), "folder", "D:\\shoots\\raw");
    expect(args[3]).toContain("$d.SelectedPath = 'D:\\shoots\\raw'");
  });

  it("win32: an apostrophe in the path is doubled — PowerShell's only single-quote escape", () => {
    const { args } = pickerCommand(deps({ platform: "win32" }), "file", "C:\\Users\\Ahsan's videos");
    expect(args[3]).toContain("$d.InitialDirectory = 'C:\\Users\\Ahsan''s videos'");
  });

  it("win32: no startDir sets neither property", () => {
    expect(pickerCommand(deps({ platform: "win32" }), "file").args[3]).not.toContain("InitialDirectory");
    expect(pickerCommand(deps({ platform: "win32" }), "folder").args[3]).not.toContain("$d.SelectedPath =");
  });

  it("linux: zenity wins when present, with pipe-separated filter syntax", () => {
    const { bin, args } = pickerCommand(
      deps({ platform: "linux", hasBin: (b) => b === "zenity" }),
      "file",
      "/home/a/raw",
    );
    expect(bin).toBe("zenity");
    expect(args).toContain("--file-selection");
    expect(args).toContain("--file-filter=Video | *.mov *.mp4 *.m4v *.mkv *.webm *.avi");
    // trailing slash is what makes zenity treat it as a start DIRECTORY
    expect(args).toContain("--filename=/home/a/raw/");
  });

  it("linux folder: zenity --directory", () => {
    const { args } = pickerCommand(deps({ platform: "linux", hasBin: (b) => b === "zenity" }), "folder");
    expect(args).toContain("--directory");
    expect(args.some((a) => a.startsWith("--file-filter"))).toBe(false);
  });

  it("linux: BOTH installed still picks zenity — the precedence, not just the fallback", () => {
    // The single-binary cases above pass under either branch order, so they
    // do not pin precedence. A GNOME box with kdialog pulled in as some
    // package's dependency is the machine this protects: it should still get
    // the GTK dialog.
    expect(pickerCommand(deps({ platform: "linux", hasBin: () => true }), "file").bin).toBe("zenity");
    expect(pickerCommand(deps({ platform: "linux", hasBin: () => true }), "folder").bin).toBe("zenity");
  });

  it("linux: kdialog uses Qt parentheses, NOT zenity's pipe", () => {
    const { bin, args } = pickerCommand(
      deps({ platform: "linux", hasBin: (b) => b === "kdialog" }),
      "file",
      "/home/a/raw",
    );
    expect(bin).toBe("kdialog");
    expect(args).toEqual([
      "--getopenfilename",
      "/home/a/raw",
      "Video files(*.mov *.mp4 *.m4v *.mkv *.webm *.avi)",
    ]);
  });

  it("linux folder: kdialog --getexistingdirectory takes no filter argument", () => {
    const { args } = pickerCommand(deps({ platform: "linux", hasBin: (b) => b === "kdialog" }), "folder");
    expect(args).toEqual(["--getexistingdirectory", "."]);
  });
});

describe("parsePickerResult", () => {
  it("trims the trailing newline every backend adds", () => {
    expect(parsePickerResult("/Users/a/take1.mp4\n")).toBe("/Users/a/take1.mp4");
  });

  it("empty stdout is a CANCEL, not an error — all four backends do this", () => {
    expect(parsePickerResult("")).toBeUndefined();
    expect(parsePickerResult("\n")).toBeUndefined();
    expect(parsePickerResult("   ")).toBeUndefined();
  });

  it("keeps spaces inside a path — 2026-08-11 06-50-33.mp4 is a real filename here", () => {
    expect(parsePickerResult("/Users/a/2026-08-11 06-50-33.mp4\n")).toBe("/Users/a/2026-08-11 06-50-33.mp4");
  });
});

/**
 * The spawn is exercised against a stub `zenity`: a real dialog cannot be
 * tested, because it blocks on a human (§136).
 *
 * The stub is reached by mutating `process.env.PATH`, which is heavier than
 * anything else in the repo does — the agy provider tests inject the binary
 * path instead, and these are the only PATH writes here. PATH is the only
 * seam available: `pickerCommand` emits a bare binary name so the OS resolves
 * it, and `run` offers no env or cwd option to redirect that. Read this as
 * local necessity, not as a licence to mutate PATH elsewhere.
 */
describe("pickPath (spawn)", () => {
  // The exact line pickPath prints when the binary would not start. Asserting
  // on its absence is what separates a cancel from a spawn failure — both
  // resolve undefined, so the return value alone cannot tell them apart.
  const FALLBACK = "▸ couldn't open a file picker here — type the path instead";
  const dirs: string[] = [];
  let logs: string[] = [];

  const stub = (body: string): { dir: string; argv: () => string[]; deps: PickerDeps } => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-picker-"));
    dirs.push(dir);
    const argvFile = join(dir, "argv");
    const bin = join(dir, "zenity");
    // Every stub records its argv before running its body: that recording is
    // the only thing pinning that pickPath forwards `mode` and `startDir` into
    // pickerCommand. Both are optional there, so dropping them typechecks
    // clean and silently opens every dialog at the wrong directory.
    // One arg per line — args contain spaces (`--file-filter=Video | *.mov …`)
    // but never newlines.
    writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argvFile}"\n${body}\n`);
    chmodSync(bin, 0o755);
    return {
      dir,
      argv: () => readFileSync(argvFile, "utf8").split("\n").filter(Boolean),
      deps: { platform: "linux", env: { DISPLAY: ":0" }, hasBin: (b) => b === "zenity" },
    };
  };

  const withPath = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      // Awaited INSIDE the try so the mutated PATH outlives the spawn no
      // matter when it happens. `run` spawns synchronously in its promise
      // executor today, so a sync restore would also work — but only today: a
      // single `await` added ahead of that spawn (a timeout is the obvious
      // candidate) would have the stub vanish from PATH, and the cancel test
      // below would go green down the spawn-failure path while testing
      // nothing. Holding PATH across the await is safe because vitest runs a
      // file's `it`s sequentially and none of these are `test.concurrent`.
      return await fn();
    } finally {
      process.env.PATH = prev;
    }
  };

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns the picked path, and forwards mode and startDir into the command", async () => {
    const { dir, argv, deps } = stub('echo "/home/a/take1.mp4"');
    await expect(withPath(dir, () => pickPath("file", deps, "/home/a"))).resolves.toBe(
      "/home/a/take1.mp4",
    );
    // startDir actually reached the dialog — trailing slash and all.
    expect(argv()).toContain("--filename=/home/a/");
    expect(argv()).toContain("--file-selection");
    expect(argv()).not.toContain("--directory");
  });

  it("folder mode reaches the dialog as --directory", async () => {
    const { dir, argv, deps } = stub('echo "/home/a/clips"');
    await expect(withPath(dir, () => pickPath("folder", deps, "/home/a"))).resolves.toBe(
      "/home/a/clips",
    );
    expect(argv()).toContain("--directory");
  });

  it("a cancel (exit 1, empty stdout) resolves undefined instead of throwing", async () => {
    const { dir, deps } = stub("exit 1");
    await expect(withPath(dir, () => pickPath("file", deps, "/home/a"))).resolves.toBeUndefined();
    // The point of the test. Without `allowNonZero`, a dismissed dialog would
    // reject, land in the catch, and still resolve undefined — telling a user
    // whose picker works perfectly that it is broken. Only the missing
    // fallback line proves the cancel came back down the resolve path.
    expect(logs).not.toContain(FALLBACK);
  });

  it("a missing binary resolves undefined — never takes the wizard down", async () => {
    const deps: PickerDeps = {
      platform: "linux",
      env: { DISPLAY: ":0" },
      hasBin: () => true, // claims zenity exists; PATH says otherwise
    };
    const empty = mkdtempSync(join(tmpdir(), "ossclip-picker-empty-"));
    dirs.push(empty);
    await expect(withPath(empty, () => pickPath("file", deps, "/home/a"))).resolves.toBeUndefined();
    // …and here the same undefined DOES come with the fallback line.
    expect(logs).toContain(FALLBACK);
  });
});
