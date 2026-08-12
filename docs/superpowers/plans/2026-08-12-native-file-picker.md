# Native File Picker for the Produce Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's single typed-path prompt with a menu that offers the newest videos on the machine, a native OS file/folder picker, and typing — so a non-technical user never has to know what a path is.

**Architecture:** Three new units under `apps/cli/src/interactive/`. `picker.ts` builds and spawns the platform's native dialog, split pure/IO exactly like `open.ts`'s `openCommand`/`openInBrowser`. `suggest-inputs.ts` ranks the newest video files in a few likely folders, with the ranking pure over an injected file list. `ask-input.ts` composes those into one prompt and owns the fallback ladder, converging every branch on a single shared `validateInputPath`. `produce-wizard.ts:148-168` shrinks to one call.

**Tech Stack:** TypeScript, `@clack/prompts` (already a dep), vitest, `run()` from `@ossclip/core`, `binOnPath()` from `apps/cli/src/llm-detect.ts`. **No new dependencies.**

## Global Constraints

- **No new npm dependencies.** Every dialog is an OS built-in (`osascript`, `powershell`, `zenity`, `kdialog`) or already vendored.
- **Cancel is never an error.** Dismissing a dialog exits non-zero with empty stdout on all four backends. That is a normal outcome — return to the menu, never throw, never print a stack trace.
- **Comments explain *why* and cite the findings section** (`§136` for everything in this plan), per `CLAUDE.md` house style.
- **Pure logic separated from I/O.** Command construction, availability probing, output parsing and ranking are pure and table-tested; spawning and `readdir` are thin wrappers around them.
- **Telemetry props may never carry paths.** `assertSafeProps` rejects any key containing `path`, `file`, `dir`, `transcript`, `intent`, `prompt`, `key`, `hook`, `text`. The one prop added here is `input_source`, whose values are the four literals `"suggestion" | "picker" | "typed" | "argv"`.
- **Verified platform facts** (probed 2026-08-12 on macOS 26.3, plus zenity/kdialog docs) — do not "improve" these:
  - macOS `choose file ... of type {"mp4","mov","mkv","webm","m4v"}` accepts **bare extensions**; matching files stay selectable and others are dimmed. `{"public.movie"}` was rejected as the alternative because mkv coverage is unconfirmed.
  - zenity filter syntax is `--file-filter=NAME | PATTERN1 PATTERN2` (pipe between name and patterns).
  - kdialog filter syntax is `"NAME(*.ext1 *.ext2)"` (parentheses, **not** a pipe) and `--getexistingdirectory` takes **no** filter argument.
  - Windows `OpenFileDialog` deadlocks on the default MTA thread — `-STA` is load-bearing.
- **No release in this plan.** All four packages bump in lockstep later, bump last (`RELEASES.md`, the 0.1.4→0.1.5 lesson).

---

### Task 1: Export the video extension list from core

`packages/core/src/concat.ts` already owns the canonical list of extensions a folder-of-clips input accepts. The picker's file filters and the suggestion scanner must agree with it exactly — a picker that offers `.avi` while `concat` refuses it is a trap.

**Files:**
- Modify: `packages/core/src/concat.ts:23`
- Test: `packages/core/test/concat.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `VIDEO_EXTENSIONS: readonly ["mov", "mp4", "m4v", "mkv", "webm", "avi"]`, re-exported from `@ossclip/core` via the existing `export * from "./concat"` at `packages/core/src/index.ts:11`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/concat.test.ts`:

```ts
import { VIDEO_EXTENSIONS } from "../src/concat";

describe("VIDEO_EXTENSIONS (§136, shared with the CLI's file picker)", () => {
  it("is exported so the picker's file filters cannot drift from what concat accepts", () => {
    expect([...VIDEO_EXTENSIONS]).toEqual(["mov", "mp4", "m4v", "mkv", "webm", "avi"]);
  });

  it("carries no leading dots — every consumer adds its own separator", () => {
    for (const ext of VIDEO_EXTENSIONS) expect(ext.startsWith(".")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/concat.test.ts`
Expected: FAIL — `VIDEO_EXTENSIONS` is not exported from `../src/concat`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/concat.ts:23` — add `export` and a why-comment:

```ts
/**
 * The extensions a folder input may contain. Exported (§136) because the
 * CLI's native file picker builds its dialog filters from this list: a
 * picker that offers a file `concat` will later refuse is a trap, and the
 * two lists silently diverging is exactly how that ships.
 */
export const VIDEO_EXTENSIONS = ["mov", "mp4", "m4v", "mkv", "webm", "avi"] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/concat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/concat.ts packages/core/test/concat.test.ts
git commit -m "core: export VIDEO_EXTENSIONS for the CLI file picker"
```

---

### Task 2: Native picker — pure availability, command construction, output parsing

The whole platform matrix, with zero spawning. This is the `openCommand()` half of the `open.ts` split.

**Files:**
- Create: `apps/cli/src/interactive/picker.ts`
- Test: `apps/cli/test/picker.test.ts`

**Interfaces:**
- Consumes: `VIDEO_EXTENSIONS` from `@ossclip/core` (Task 1); `binOnPath` from `../llm-detect`.
- Produces:
  - `type PickMode = "file" | "folder"`
  - `interface PickerDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; hasBin: (bin: string) => boolean }`
  - `pickerAvailable(d: PickerDeps): boolean`
  - `pickerCommand(d: PickerDeps, mode: PickMode, startDir?: string): { bin: string; args: string[] }`
  - `parsePickerResult(stdout: string): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/picker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickerAvailable, pickerCommand, parsePickerResult, type PickerDeps } from "../src/interactive/picker";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/picker.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/picker`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/interactive/picker.ts`:

```ts
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
 * Is there a dialog to open at all? Probed rather than attempted, because
 * offering a "Browse…" row that cannot work is worse than not offering it —
 * the menu drops the row entirely when this is false.
 */
export function pickerAvailable(d: PickerDeps): boolean {
  // Truthiness not presence, matching `isInteractive`'s treatment of CI.
  if (d.env.OSSCLIP_NO_PICKER) return false;
  // A Mac reached over SSH has no window server for osascript to draw on:
  // `choose file` fails with -1743 (not authorized) instead of opening.
  if (d.platform === "darwin") return !d.env.SSH_CONNECTION && !d.env.SSH_TTY;
  // WinForms ships with Windows itself — nothing to detect.
  if (d.platform === "win32") return true;
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
    const script =
      mode === "folder"
        ? "Add-Type -AssemblyName System.Windows.Forms; " +
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"
        : "Add-Type -AssemblyName System.Windows.Forms; " +
          "$d = New-Object System.Windows.Forms.OpenFileDialog; " +
          `$d.Filter = 'Video|${VIDEO_EXTENSIONS.map((e) => `*.${e}`).join(";")}|All files|*.*'; ` +
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
 * Cancel is not an error. Dismissing the dialog exits non-zero with empty
 * stdout on all four backends, so emptiness — not the exit code — is the
 * signal, which also means the caller can use `allowNonZero` and never has
 * to tell a cancel apart from a failure by parsing stderr.
 */
export function parsePickerResult(stdout: string): string | undefined {
  const picked = stdout.trim();
  return picked === "" ? undefined : picked;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/picker.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/cli/src/interactive/picker.ts apps/cli/test/picker.test.ts
git commit -m "cli: native picker platform matrix, pure half"
```

---

### Task 3: Native picker — the spawn

The `openInBrowser()` half: one thin function, tested against a stub executable rather than a real dialog.

**Files:**
- Modify: `apps/cli/src/interactive/picker.ts` (append)
- Test: `apps/cli/test/picker.test.ts` (append)

**Interfaces:**
- Consumes: `pickerCommand`, `parsePickerResult`, `livePickerDeps` (Task 2); `run` from `@ossclip/core`.
- Produces: `pickPath(mode: PickMode, deps?: PickerDeps, startDir?: string): Promise<string | undefined>`

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/picker.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickPath } from "../src/interactive/picker";

/**
 * The spawn is exercised against a stub `zenity` on a temp PATH — same trick
 * the agy provider tests use (§132). A real dialog cannot be tested: it
 * blocks on a human.
 */
describe("pickPath (spawn)", () => {
  const dirs: string[] = [];
  const stub = (body: string): { dir: string; deps: PickerDeps } => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-picker-"));
    dirs.push(dir);
    const bin = join(dir, "zenity");
    writeFileSync(bin, `#!/bin/bash\n${body}\n`);
    chmodSync(bin, 0o755);
    return {
      dir,
      deps: { platform: "linux", env: { DISPLAY: ":0" }, hasBin: (b) => b === "zenity" },
    };
  };
  const withPath = <T>(dir: string, fn: () => T): T => {
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      return fn();
    } finally {
      process.env.PATH = prev;
    }
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns the picked path", async () => {
    const { dir, deps } = stub('echo "/home/a/take1.mp4"');
    await expect(withPath(dir, () => pickPath("file", deps, "/home/a"))).resolves.toBe("/home/a/take1.mp4");
  });

  it("a cancel (exit 1, empty stdout) resolves undefined instead of throwing", async () => {
    const { dir, deps } = stub("exit 1");
    await expect(withPath(dir, () => pickPath("file", deps, "/home/a"))).resolves.toBeUndefined();
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
  });
});
```

Add `afterEach` to the vitest import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/picker.test.ts -t "pickPath"`
Expected: FAIL — `pickPath` is not exported.

- [ ] **Step 3: Write minimal implementation**

First widen the existing core import at the top of the file — one import statement per module, not two:

```ts
import { VIDEO_EXTENSIONS, run } from "@ossclip/core";
```

Then append:

```ts
/**
 * Open the dialog and wait. The ONLY I/O in this module.
 *
 * The notice before the spawn is not decoration: a dialog that opens behind
 * the terminal is indistinguishable from a hung CLI, and the wait here is
 * unbounded by design — a human is deciding.
 */
export async function pickPath(
  mode: PickMode,
  deps: PickerDeps = livePickerDeps(),
  startDir: string = process.cwd(),
): Promise<string | undefined> {
  const { bin, args } = pickerCommand(deps, mode, startDir);
  console.log("▸ file picker open — look for a new window");
  try {
    // allowNonZero: a cancel exits 1 on every backend and is a normal answer.
    const { stdout } = await run(bin, args, { allowNonZero: true });
    return parsePickerResult(stdout);
  } catch {
    // `run` only rejects when the binary would not start. pickerAvailable
    // said yes, so this is a broken install or a PATH that changed under us —
    // fall through to typing rather than failing the whole wizard.
    console.log("▸ couldn't open a file picker here — type the path instead");
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/picker.test.ts`
Expected: PASS (all cases, pure and spawn)

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/cli/src/interactive/picker.ts apps/cli/test/picker.test.ts
git commit -m "cli: spawn the native picker, cancel-safe"
```

---

### Task 4: Suggestions — rank the newest videos in likely folders

**Files:**
- Create: `apps/cli/src/interactive/suggest-inputs.ts`
- Test: `apps/cli/test/suggest-inputs.test.ts`

**Interfaces:**
- Consumes: `VIDEO_EXTENSIONS` from `@ossclip/core` (Task 1).
- Produces:
  - `interface CandidateFile { path: string; mtimeMs: number; size: number }`
  - `interface Suggestion { path: string; label: string; hint: string }`
  - `humanSize(bytes: number): string`
  - `relativeAge(ms: number): string`
  - `tildeify(path: string, home: string): string`
  - `likelyDirs(d: { platform: NodeJS.Platform; cwd: string; home: string }): string[]`
  - `rankSuggestions(files: CandidateFile[], nowMs: number, home: string, limit?: number): Suggestion[]`
  - `scanLikelyDirs(): Promise<CandidateFile[]>`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/suggest-inputs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  humanSize,
  likelyDirs,
  rankSuggestions,
  relativeAge,
  tildeify,
  type CandidateFile,
} from "../src/interactive/suggest-inputs";

/**
 * "The video I just recorded" is nearly always the newest video file in the
 * working directory, Downloads, or Movies — so the wizard offers those three
 * before it offers a file picker (§136). Ranking is pure over an injected
 * listing, so none of these rules needs a real home directory.
 */
const NOW = 1_760_000_000_000;
const HOME = "/Users/a";
const f = (path: string, ageMs: number, size = 1_000_000): CandidateFile => ({
  path,
  mtimeMs: NOW - ageMs,
  size,
});

describe("rankSuggestions", () => {
  it("newest first", () => {
    const out = rankSuggestions(
      [f("/Users/a/Downloads/old.mp4", 86_400_000), f("/Users/a/Downloads/new.mp4", 60_000)],
      NOW,
      HOME,
    );
    expect(out.map((s) => s.path)).toEqual(["/Users/a/Downloads/new.mp4", "/Users/a/Downloads/old.mp4"]);
  });

  it("keeps only video extensions, case-insensitively", () => {
    const out = rankSuggestions(
      [f("/x/a.MP4", 1), f("/x/b.txt", 2), f("/x/c.pdf", 3), f("/x/d.MKV", 4)],
      NOW,
      HOME,
    );
    expect(out.map((s) => s.path)).toEqual(["/x/a.MP4", "/x/d.MKV"]);
  });

  it("drops ossclip's own output — re-cutting a finished cut is never the intent", () => {
    const out = rankSuggestions([f("/x/take.ossclip.mp4", 1), f("/x/take.mp4", 2)], NOW, HOME);
    expect(out.map((s) => s.path)).toEqual(["/x/take.mp4"]);
  });

  it("drops dotfiles", () => {
    const out = rankSuggestions([f("/x/.hidden.mp4", 1), f("/x/take.mp4", 2)], NOW, HOME);
    expect(out.map((s) => s.path)).toEqual(["/x/take.mp4"]);
  });

  it("caps at three — the menu is a shortcut, not a file manager", () => {
    const many = Array.from({ length: 9 }, (_, i) => f(`/x/take${i}.mp4`, i + 1));
    expect(rankSuggestions(many, NOW, HOME)).toHaveLength(3);
  });

  it("labels are home-relative and hints carry size and age", () => {
    const [only] = rankSuggestions([f("/Users/a/Downloads/take.mp4", 720_000, 142_000_000)], NOW, HOME);
    expect(only.label).toBe("~/Downloads/take.mp4");
    expect(only.hint).toBe("142 MB · 12m ago");
  });

  it("an empty listing is an empty menu, not an error", () => {
    expect(rankSuggestions([], NOW, HOME)).toEqual([]);
  });
});

describe("humanSize", () => {
  it("uses Finder-style base-1000 units", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(142_000_000)).toBe("142 MB");
    expect(humanSize(2_400_000_000)).toBe("2.4 GB");
    expect(humanSize(45_000)).toBe("45 kB");
  });
});

describe("relativeAge", () => {
  it("degrades from seconds to days", () => {
    expect(relativeAge(30_000)).toBe("just now");
    expect(relativeAge(720_000)).toBe("12m ago");
    expect(relativeAge(10_800_000)).toBe("3h ago");
    expect(relativeAge(172_800_000)).toBe("2d ago");
  });
});

describe("tildeify", () => {
  it("shortens a home path and leaves everything else alone", () => {
    expect(tildeify("/Users/a/Downloads/x.mp4", "/Users/a")).toBe("~/Downloads/x.mp4");
    expect(tildeify("/opt/raw/x.mp4", "/Users/a")).toBe("/opt/raw/x.mp4");
  });
});

describe("likelyDirs", () => {
  it("darwin looks in Movies", () => {
    expect(likelyDirs({ platform: "darwin", cwd: "/w", home: "/Users/a" })).toEqual([
      "/w",
      "/Users/a/Downloads",
      "/Users/a/Movies",
    ]);
  });

  it("linux and win32 look in Videos", () => {
    expect(likelyDirs({ platform: "linux", cwd: "/w", home: "/home/a" })).toContain("/home/a/Videos");
    expect(likelyDirs({ platform: "win32", cwd: "/w", home: "/home/a" })).toContain("/home/a/Videos");
  });

  it("deduplicates when cwd IS one of the folders", () => {
    const out = likelyDirs({ platform: "darwin", cwd: "/Users/a/Downloads", home: "/Users/a" });
    expect(out.filter((d) => d === "/Users/a/Downloads")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/suggest-inputs.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/suggest-inputs`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/interactive/suggest-inputs.ts`:

```ts
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

/** Base-1000 like Finder and Explorer report it, not base-1024. */
export function humanSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function relativeAge(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function tildeify(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function likelyDirs(d: { platform: NodeJS.Platform; cwd: string; home: string }): string[] {
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

/** How many names to consider per directory before giving up on it. */
const MAX_ENTRIES_PER_DIR = 2_000;

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
        .filter((e) => e.isFile())
        .slice(0, MAX_ENTRIES_PER_DIR)
        .map((e) => e.name);
    } catch {
      // A missing ~/Movies or an unreadable directory is ordinary. The
      // suggestions are a convenience; nothing here may fail the wizard.
      continue;
    }
    for (const name of names) {
      if (!VIDEO_EXT_SET.has(extname(name).slice(1).toLowerCase())) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        out.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Raced with a delete between readdir and stat — skip it.
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/suggest-inputs.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/cli/src/interactive/suggest-inputs.ts apps/cli/test/suggest-inputs.test.ts
git commit -m "cli: rank the newest videos in cwd, Downloads and Movies"
```

---

### Task 5: The input prompt — menu composition and the fallback ladder

**Files:**
- Create: `apps/cli/src/interactive/ask-input.ts`
- Modify: `apps/cli/src/interactive/produce-wizard.ts:1-4` (imports), `:148-168` (the prompt)
- Test: `apps/cli/test/ask-input.test.ts`

**Interfaces:**
- Consumes: `Suggestion`, `rankSuggestions`, `scanLikelyDirs` (Task 4); `pickerAvailable`, `pickPath`, `livePickerDeps` (Tasks 2–3); `select`, `text`, `unwrap`, `assertInteractive` from `./prompts`.
- Produces:
  - `const BROWSE_FILE = "__browse_file__"`, `BROWSE_FOLDER = "__browse_folder__"`, `TYPE_PATH = "__type_path__"`
  - `type InputSource = "suggestion" | "picker" | "typed"`
  - `validateInputPath(v: string | undefined): string | undefined` — returns an error message, or `undefined` when valid
  - `inputChoices(suggestions: Suggestion[], canBrowse: boolean): { value: string; label: string; hint?: string }[]`
  - `askInput(): Promise<string>`
  - `noteInputSource(s: InputSource): void`, `inputSourceUsed(): InputSource | "argv"` (consumed by Task 6)

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/ask-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSE_FILE,
  BROWSE_FOLDER,
  TYPE_PATH,
  inputChoices,
  validateInputPath,
} from "../src/interactive/ask-input";
import type { Suggestion } from "../src/interactive/suggest-inputs";

/**
 * The menu that replaced the typed-path prompt (§136). Composition is pure so
 * the one rule that matters — a Browse row is never offered on a machine with
 * no dialog to open — is pinned without a TTY.
 */
const sugg = (path: string): Suggestion => ({ path, label: path, hint: "1 MB · just now" });

describe("inputChoices", () => {
  it("suggestions first, then browse, then type", () => {
    const out = inputChoices([sugg("/x/a.mp4"), sugg("/x/b.mp4")], true);
    expect(out.map((c) => c.value)).toEqual(["/x/a.mp4", "/x/b.mp4", BROWSE_FILE, BROWSE_FOLDER, TYPE_PATH]);
  });

  it("no browse rows when there is no picker — never offer what cannot work", () => {
    const out = inputChoices([sugg("/x/a.mp4")], false);
    expect(out.map((c) => c.value)).toEqual(["/x/a.mp4", TYPE_PATH]);
  });

  it("typing is always reachable, even with nothing else on offer", () => {
    expect(inputChoices([], false).map((c) => c.value)).toEqual([TYPE_PATH]);
  });

  it("a suggestion row shows its size and age as the hint", () => {
    const [row] = inputChoices([sugg("/x/a.mp4")], false);
    expect(row.hint).toBe("1 MB · just now");
  });
});

describe("validateInputPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-askinput-"));
  const file = join(dir, "take.mp4");
  writeFileSync(file, "x");

  it("accepts a file and a directory", () => {
    expect(validateInputPath(file)).toBeUndefined();
    expect(validateInputPath(dir)).toBeUndefined();
  });

  it("rejects empty and missing with the wording the old prompt used", () => {
    expect(validateInputPath("")).toBe("a path is required");
    expect(validateInputPath(undefined)).toBe("a path is required");
    expect(validateInputPath("/nope/nothing.mp4")).toBe("no such path: /nope/nothing.mp4");
  });

  it("guards the picker path too — a file can vanish between dialog and return", () => {
    const gone = join(dir, "deleted.mp4");
    writeFileSync(gone, "x");
    rmSync(gone);
    expect(validateInputPath(gone)).toBe(`no such path: ${gone}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/ask-input.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/ask-input`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/interactive/ask-input.ts`:

```ts
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { assertInteractive, select, text, unwrap } from "./prompts";
import { livePickerDeps, pickPath, pickerAvailable } from "./picker";
import { rankSuggestions, scanLikelyDirs, type Suggestion } from "./suggest-inputs";

/**
 * "Which video?" — the first prompt of the wizard, and until §136 the one
 * step a non-technical user could not get past: it demanded a typed path.
 * Now it is a menu of the newest videos on the machine, a native picker, and
 * typing, in that order.
 *
 * Every branch converges on `validateInputPath` rather than trusting its
 * source. A picker result is not more trustworthy than typed text: the file
 * can be deleted between the dialog closing and the path arriving, and
 * "Browse for a folder" happily returns a folder with no video in it.
 */

export const BROWSE_FILE = "__browse_file__";
export const BROWSE_FOLDER = "__browse_folder__";
export const TYPE_PATH = "__type_path__";

export type InputSource = "suggestion" | "picker" | "typed";

/**
 * Not a zod schema, deliberately: the house rule parses user values with zod
 * because a typo must not silently coerce, and there is nothing to coerce
 * here — this is a filesystem predicate (does it exist, is it a file or a
 * folder), which zod cannot answer. The wording is carried over verbatim
 * from the prompt this replaced.
 */
export function validateInputPath(v: string | undefined): string | undefined {
  if (!v) return "a path is required";
  if (!existsSync(v)) return `no such path: ${v}`;
  const st = statSync(v);
  if (!st.isFile() && !st.isDirectory()) return `${v} is neither a video file nor a folder`;
  return undefined;
}

export function inputChoices(
  suggestions: Suggestion[],
  canBrowse: boolean,
): { value: string; label: string; hint?: string }[] {
  const rows = suggestions.map((s) => ({ value: s.path, label: s.label, hint: s.hint }));
  if (canBrowse) {
    rows.push(
      { value: BROWSE_FILE, label: "Browse…", hint: "opens a file picker" },
      { value: BROWSE_FOLDER, label: "Browse for a folder of clips", hint: "concatenated by name" },
    );
  }
  rows.push({ value: TYPE_PATH, label: "Type a path", hint: "if you already know it" });
  return rows;
}

let lastInputSource: InputSource | "argv" = "argv";

/** Which branch produced the input, for the produce_completed event (§136). */
export function noteInputSource(s: InputSource): void {
  lastInputSource = s;
}

export function inputSourceUsed(): InputSource | "argv" {
  return lastInputSource;
}

const typePath = async (): Promise<string> =>
  unwrap(
    await text({
      // A folder is concatenated by name (codepoint order, like `ls`); --sort
      // mtime reorders it but stays a typed flag.
      message: "Video file, or a folder of clips to concatenate (by name; --sort mtime is a typed flag)",
      placeholder: "./raw/take1.mp4",
      validate: validateInputPath,
    }),
  ) as string;

export async function askInput(): Promise<string> {
  assertInteractive("input prompt");
  const canBrowse = pickerAvailable(livePickerDeps());
  const suggestions = rankSuggestions(await scanLikelyDirs(), Date.now(), homedir());

  // Nothing found and nowhere to browse: a one-row menu is pure noise, so go
  // straight to the prompt this whole unit replaced.
  if (suggestions.length === 0 && !canBrowse) {
    noteInputSource("typed");
    return typePath();
  }

  // Loops rather than returns, because cancelling the OS dialog must land
  // back on the menu — Escape in a Finder window means "not that one", not
  // "abandon the run". Ctrl-C at the menu still exits via `unwrap`.
  for (;;) {
    const choice = unwrap(
      await select({ message: "Which video?", options: inputChoices(suggestions, canBrowse) }),
    ) as string;

    if (choice === TYPE_PATH) {
      noteInputSource("typed");
      return typePath();
    }

    if (choice === BROWSE_FILE || choice === BROWSE_FOLDER) {
      const picked = await pickPath(choice === BROWSE_FOLDER ? "folder" : "file");
      if (picked === undefined) continue; // cancelled or no dialog — re-ask
      const problem = validateInputPath(picked);
      if (problem !== undefined) {
        console.log(`▸ ${problem}`);
        continue;
      }
      noteInputSource("picker");
      return picked;
    }

    // A suggestion. Still validated: the listing is a snapshot, and a file
    // can be moved between the scan and the keypress.
    const problem = validateInputPath(choice);
    if (problem !== undefined) {
      console.log(`▸ ${problem}`);
      continue;
    }
    noteInputSource("suggestion");
    return choice;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/ask-input.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into the wizard**

In `apps/cli/src/interactive/produce-wizard.ts`, replace lines 148-168 (the `const input = cfg.input ?? (unwrap(await text({...})) as string)` block) with:

```ts
  // Pre-supplied by bare `ossclip <path>` (0.1.9 first-contact, 2026-08-05):
  // the user already TYPED the input on the command line, and the old flow
  // dropped it and asked again — the re-ask is where "./Anyhropic c Compiler"
  // became "./" (all of ~/Downloads). The router checks existence before the
  // wizard ever opens, so a prefilled path skips the prompt entirely.
  //
  // Everything else now lives in ask-input.ts (§136): suggestions, the native
  // picker, and typing, all converging on one validator.
  const input = cfg.input ?? (await askInput());
```

Update the imports at the top of the file:
- Line 4: drop `text` and `unwrap` **only if** no other prompt in the file still uses them — `:202`, `:211`, `:226`, `:248`, `:275`, `:293`, `:305` all still call `text`, and `unwrap` wraps them, so **both imports stay**.
- Line 2: `existsSync` and `statSync` were used only by the deleted validator — remove them from the `node:fs` import if nothing else in the file references them (check with `grep -n "existsSync\|statSync\|readdirSync" apps/cli/src/interactive/produce-wizard.ts`; `readdirSync` is still used by the whisper model enumeration, so keep the import line and drop only the two unused names).
- Add: `import { askInput } from "./ask-input";`

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all green. `apps/cli/test/wizard-model-choices.test.ts` and `apps/cli/test/produce-argv.test.ts` exercise the wizard's pure exports only and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/interactive/ask-input.ts apps/cli/src/interactive/produce-wizard.ts apps/cli/test/ask-input.test.ts
git commit -m "cli: replace the typed-path prompt with suggestions + native picker"
```

---

### Task 6: Record which branch the input came from

The user's stated reason for baking in telemetry was visibility. "Did anyone ever use the picker" is the question this feature creates, and it costs one prop.

**Files:**
- Modify: `apps/cli/src/program.ts:427-437` (the `produce_completed` props)
- Test: `apps/cli/test/telemetry.test.ts` (append)

**Interfaces:**
- Consumes: `inputSourceUsed()` from `./interactive/ask-input` (Task 5).
- Produces: the `input_source` prop on `produce_completed`, values `"suggestion" | "picker" | "typed" | "argv"`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/telemetry.test.ts`:

```ts
import { inputSourceUsed, noteInputSource } from "../src/interactive/ask-input";

/**
 * §136: the picker's whole justification is that typing a path blocked
 * non-technical users. Whether the picker is actually being reached is a
 * question only telemetry can answer — and the prop must survive the privacy
 * guard, which rejects anything that smells like a path.
 */
describe("input_source (§136)", () => {
  it("defaults to argv — a typed command line never touches the wizard", () => {
    expect(inputSourceUsed()).toBe("argv");
  });

  it("records the branch the wizard took", () => {
    noteInputSource("picker");
    expect(inputSourceUsed()).toBe("picker");
    noteInputSource("suggestion");
    expect(inputSourceUsed()).toBe("suggestion");
  });

  it("the prop name survives assertSafeProps — it names a branch, not a path", () => {
    expect(() => assertSafeProps({ input_source: "picker" })).not.toThrow();
  });

  it("the obvious wrong version of this prop is still rejected", () => {
    expect(() => assertSafeProps({ input_path: "/Users/a/take.mp4" })).toThrow(/forbidden substring "path"/);
  });
});
```

`assertSafeProps` is already imported at the top of `telemetry.test.ts`; add it to the import list if it is not.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/telemetry.test.ts -t "input_source"`
Expected: FAIL — `noteInputSource`/`inputSourceUsed` unresolved (they land with Task 5; if Task 5 is already merged, this step's first three cases pass and only the wiring below is missing).

- [ ] **Step 3: Write minimal implementation**

In `apps/cli/src/program.ts`, inside the produce action, just above the `telemetry.record("produce_completed", …)` call at `:427`:

```ts
        // Dynamic import to match how the wizard itself is loaded, and it is
        // the SAME module instance either way — so a run that never opened
        // the wizard correctly reports the "argv" default (§136).
        const { inputSourceUsed } = await import("./interactive/ask-input");
```

Then add one line to the props object:

```ts
          scenes: result.sceneCount,
          // Which branch of the input prompt was used — a branch name, never
          // the path itself (§136). The picker exists because typing a path
          // blocked non-technical users; this is how we find out if it helped.
          input_source: inputSourceUsed(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/telemetry.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/program.ts apps/cli/test/telemetry.test.ts
git commit -m "cli: report which input branch the wizard took"
```

---

### Task 7: Documentation

**Files:**
- Modify: `apps/cli/README.md` (env var list, and the wizard description)
- Modify: `README.md` (env var list)
- Modify: `docs/PHASE1-FINDINGS.md` (append §136)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Add the env var to both READMEs**

Find the environment-variable list in each README (the one containing `OSSCLIP_AGY_BIN`) and add a row in the same format:

```
| `OSSCLIP_NO_PICKER` | set to anything to disable the wizard's native file picker — the prompt falls back to suggestions and typing |
```

- [ ] **Step 2: Update the wizard's description in `apps/cli/README.md`**

Wherever the README describes the wizard's first question as asking for a path, replace that sentence with:

```
The first question offers the newest videos in your working directory,
Downloads and Movies; a **Browse…** row that opens your operating system's
own file picker; and typing a path. Over SSH, or on a Linux box with no
`zenity`/`kdialog`, the Browse rows are simply not shown — there is no
window to open.
```

- [ ] **Step 3: Append §136 to `docs/PHASE1-FINDINGS.md`**

Use the same heading format as §135. Content to record:

- The blocker: the wizard's first prompt demanded a typed path, which is where non-technical users stopped. `ossclip edit` never had this problem because `resolve-workdir.ts` auto-discovers and `pick-workdir.ts` offers a `select`.
- The ladder: suggestions → native picker → typing, with typing always reachable.
- Verified platform facts, dated 2026-08-12 on macOS 26.3: `choose file ... of type {"mp4",…}` accepts bare extensions and dims non-matches; `{"public.movie"}` rejected because mkv coverage is unconfirmed; zenity is `--file-filter=NAME | PATTERN…`; kdialog is `"Name(*.ext)"` and `--getexistingdirectory` takes no filter; `powershell -STA` is required or WinForms deadlocks.
- Cancel is empty stdout on all four backends, which is why the parser keys on emptiness rather than the exit code.
- Availability is probed, not attempted: a Browse row that cannot work is worse than no Browse row. macOS is gated on SSH env vars, Linux on display **and** binary (that conjunction is what covers WSL without WSLg).
- Why suggestions are stateless rather than a recents file: a recents list is empty on the first run, which is the run a new user needs help on.
- Why `.ossclip.mp4` outputs are excluded from suggestions.

- [ ] **Step 4: Verify nothing else claims paths must be typed**

Run: `grep -rn "type the path\|typed path\|absolute path" README.md apps/cli/README.md docs/PHASE1-FINDINGS.md`
Expected: any remaining hits refer to the whisper model prompt or flags, not the wizard's input question. Fix any that do not.

- [ ] **Step 5: Commit**

```bash
git add README.md apps/cli/README.md docs/PHASE1-FINDINGS.md
git commit -m "docs: the wizard's input prompt now offers a native picker (§136)"
```

---

## Manual verification (after Task 7)

These cannot be unit-tested — a real dialog blocks on a human.

1. `pnpm test && pnpm typecheck` — green.
2. `node apps/cli/dist/index.js` (or the local bin) with no arguments → menu → produce. Confirm the first question lists real videos from `~/Downloads` with plausible sizes and ages.
3. Choose **Browse…** → a real Finder window opens, `.txt` and `.pdf` are dimmed, `.mkv` is selectable. Pick a file; the wizard continues and the echoed command line quotes the path correctly (it will contain spaces).
4. Press Escape in the Finder window → back at the menu, no error, no stack trace.
5. Choose **Browse for a folder of clips** → folder chooser opens; pick a folder of clips; the run concatenates.
6. `OSSCLIP_NO_PICKER=1 ossclip` → no Browse rows, suggestions and Type only.
7. `ssh` into this machine and run it → no Browse rows.
8. Confirm `command.json` for the run records the same input path as always — the picker feeds the identical argv path, so replay is unaffected.

## Explicitly out of scope

- The output-file prompt (`produce-wizard.ts:211`) and the whisper-model prompt (`:275`) keep typing. The first has a computed default, the second takes a bare model name far more often than a path.
- No in-terminal directory browser. SSH and dialog-less Linux boxes fall back to typing; adding an arrow-key file browser was considered and rejected as roughly doubling the work for a population that can already type paths.
- No persisted recents file.
- No release. Version bumps happen in a separate lockstep commit, last, per `RELEASES.md`.
