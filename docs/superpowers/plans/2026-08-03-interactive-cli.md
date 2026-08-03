# Interactive CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ossclip an interactive front door — a wizard reachable from bare `ossclip`, prompts when `produce`/`edit` are missing information at a TTY, a workdir resolution ladder that stops `ossclip edit <video folder>` from failing, and a persistable offer to open the editor after a successful produce.

**Architecture:** Wizards emit `argv` (a `string[]`), never option objects. The array is printed as `▸ running: …` and handed back through the existing commander parse, so the zod parses in `index.ts` stay the only validation path and the taught command line is provably the one that ran. Every wizard is a pure function over answers; all fs and TTY work lives in thin adapters at the call site.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), commander 12, zod (imported from `zod/v4`), vitest, and one new dependency — `@clack/prompts`.

**Spec:** `docs/superpowers/specs/2026-08-03-interactive-cli-design.md`

## Global Constraints

- Node `>=22`, pnpm `10.33.0`. Never run `npm install`; this is a pnpm workspace.
- **Exactly one new runtime dependency across the whole plan: `@clack/prompts`**, added to `apps/cli/package.json`. Adding any other dependency is a plan deviation — stop and report.
- Zod is imported as `import { z } from "zod/v4"` in the CLI and core. The manifest pins `zod ^3.25.76`, which ships the v4 API at that subpath. Match the existing imports; do not "fix" them to `"zod"`.
- Relative imports carry **no file extension** (`import { produce } from "./produce"`). Match the existing style.
- Console prefixes are load-bearing and consistent: `▸` for progress//info, `✓` for done, `✗` for failure.
- Comments explain **why**, not what, and cite the findings section when one forced the choice (`R17 §83`, `§93a`). This repo's comments are often the only record of a bug that cost hours.
- **Pure logic is separated from I/O.** No test in this plan may require a TTY, a network, or a real `$HOME`. `saveConfigPatch` already takes a `baseDir` parameter for exactly this reason — use it.
- All new source lives under `apps/cli/src/interactive/`. All new tests live in `apps/cli/test/` as `*.test.ts`.
- Every task ends with `pnpm test` (currently 734 passing) and `pnpm typecheck` both green before the commit. A task is not done on a red suite.
- Behaviour for non-TTY invocations must not change. Any test asserting existing CLI behaviour that starts failing is a regression, not a test to update.

---

### Task 1: The interactivity gate and cancel-safe prompt wrappers

Everything else in this plan asks `isInteractive()` before prompting, and unwraps clack results through `unwrap()`. Both land first so no later task invents its own.

**Files:**
- Create: `apps/cli/src/interactive/tty.ts`
- Create: `apps/cli/src/interactive/prompts.ts`
- Modify: `apps/cli/package.json` (add `@clack/prompts` to `dependencies`)
- Test: `apps/cli/test/interactive-tty.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isInteractive(deps?: TtyDeps): boolean`
  - `interface TtyDeps { env: NodeJS.ProcessEnv; stdinIsTty: boolean; stdoutIsTty: boolean }`
  - `unwrap<T>(value: T | symbol, onCancel?: () => never): T`
  - `assertInteractive(what: string): void`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/interactive-tty.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertInteractive, isInteractive, unwrap } from "../src/interactive/tty";

const deps = (over: Partial<Parameters<typeof isInteractive>[0]> = {}) => ({
  env: {} as NodeJS.ProcessEnv,
  stdinIsTty: true,
  stdoutIsTty: true,
  ...over,
});

describe("isInteractive", () => {
  it("is true only when both streams are a TTY", () => {
    expect(isInteractive(deps())).toBe(true);
    expect(isInteractive(deps({ stdinIsTty: false }))).toBe(false);
    expect(isInteractive(deps({ stdoutIsTty: false }))).toBe(false);
  });

  it("stands down inside CI even on a TTY", () => {
    expect(isInteractive(deps({ env: { CI: "true" } as NodeJS.ProcessEnv }))).toBe(false);
  });

  it("honours the explicit escape hatch", () => {
    const env = { OSSCLIP_NO_INTERACTIVE: "1" } as NodeJS.ProcessEnv;
    expect(isInteractive(deps({ env }))).toBe(false);
  });

  // An empty CI= is what some shells export when the var is merely declared;
  // treating that as "in CI" would silence prompts on a real terminal.
  it("ignores an empty CI", () => {
    expect(isInteractive(deps({ env: { CI: "" } as NodeJS.ProcessEnv }))).toBe(true);
  });
});

describe("unwrap", () => {
  it("passes a real answer straight through", () => {
    expect(unwrap("./take.mp4", () => { throw new Error("should not cancel"); })).toBe("./take.mp4");
  });

  it("routes clack's cancel symbol to the cancel path", () => {
    // clack signals cancellation with a symbol, never a value — the same
    // check clack's own isCancel() performs.
    const cancelSymbol = Symbol.for("clack:cancel");
    expect(() =>
      unwrap(cancelSymbol as unknown as string, () => {
        throw new Error("cancelled");
      }),
    ).toThrow("cancelled");
  });
});

describe("assertInteractive", () => {
  it("throws a developer-facing error when there is no TTY", () => {
    // A prompt reached without a TTY is a programming error: it must fail in
    // this suite rather than hang in somebody's CI.
    expect(() => assertInteractive("produce wizard", () => false)).toThrow(/without a TTY/);
  });

  it("is silent when interactive", () => {
    expect(() => assertInteractive("produce wizard", () => true)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/interactive-tty.test.ts`
Expected: FAIL — `Failed to resolve import "../src/interactive/tty"`.

- [ ] **Step 3: Add the dependency**

Run: `pnpm --filter ossclip add @clack/prompts`

Then confirm `apps/cli/package.json` gained exactly one entry under `dependencies` and nothing else moved:

Run: `git diff apps/cli/package.json`
Expected: a single added `"@clack/prompts"` line.

- [ ] **Step 4: Write the implementation**

Create `apps/cli/src/interactive/tty.ts`:

```ts
import { cancel, isCancel } from "@clack/prompts";

/**
 * The ONE interactivity check in the codebase. Everything that might prompt
 * asks this; nothing else sniffs `isTTY` directly. A second, subtly different
 * check is how a CLI ends up hanging in somebody's CI waiting on an answer
 * nobody can give.
 */
export interface TtyDeps {
  env: NodeJS.ProcessEnv;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

const liveDeps = (): TtyDeps => ({
  env: process.env,
  // `isTTY` is `undefined` rather than `false` on a pipe — compare explicitly.
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
});

export function isInteractive(deps: TtyDeps = liveDeps()): boolean {
  // Truthiness, not presence: some shells export CI= (empty) merely because
  // the variable is declared, and that must not silence prompts on a real
  // terminal.
  if (deps.env.OSSCLIP_NO_INTERACTIVE) return false;
  if (deps.env.CI) return false;
  return deps.stdinIsTty && deps.stdoutIsTty;
}

/**
 * Cancelling is not a failure. Ctrl-C or Esc at any prompt exits 0 with the
 * same wording `ossclip setup` already uses for the same situation — never a
 * stack trace, never a half-run.
 */
const exitOnCancel = (): never => {
  cancel("nothing changed.");
  process.exit(0);
};

export function unwrap<T>(value: T | symbol, onCancel: () => never = exitOnCancel): T {
  if (isCancel(value)) return onCancel();
  return value as T;
}

/**
 * Guards the prompt helpers themselves. Reaching a prompt without a TTY means
 * a caller forgot to check `isInteractive()` — a programming error that should
 * fail loudly in the test suite, not silently block a pipeline.
 */
export function assertInteractive(what: string, check: () => boolean = () => isInteractive()): void {
  if (!check()) {
    throw new Error(`internal: ${what} tried to prompt without a TTY`);
  }
}
```

Create `apps/cli/src/interactive/prompts.ts`:

```ts
/**
 * Re-export surface for clack, so every interactive module imports prompts
 * from one place and the dependency can be swapped without touching wizards.
 */
export { confirm, intro, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
export { assertInteractive, isInteractive, unwrap } from "./tty";
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/interactive-tty.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify nothing else moved**

Run: `pnpm test && pnpm typecheck`
Expected: 741 tests passing (734 + 7), typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/interactive/tty.ts apps/cli/src/interactive/prompts.ts \
        apps/cli/test/interactive-tty.test.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "Interactive: one TTY gate, and cancelling is not a failure

isInteractive() is deliberately the only isTTY check in the codebase — a
second, subtly different one is how a CLI ends up hanging in somebody's CI
waiting on an answer nobody can give. It stands down on CI and on an
explicit OSSCLIP_NO_INTERACTIVE, and it treats an empty CI= as absent
because some shells export the variable merely because it is declared.

unwrap() routes clack's cancel symbol to an exit-0 with setup's existing
wording. assertInteractive() makes a prompt reached without a TTY throw in
the suite rather than block a pipeline. Both take their dependency by
parameter so the whole file tests without a terminal."
```

---

### Task 2: The `▸ running:` echo

The wizard's teaching half. Rendered from the same array that executes, so the printed command cannot drift from the real one.

**Files:**
- Create: `apps/cli/src/interactive/render.ts`
- Test: `apps/cli/test/interactive-render.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `quoteArg(arg: string, platform?: NodeJS.Platform): string`
  - `renderCommand(argv: string[], platform?: NodeJS.Platform): string`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/interactive-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { quoteArg, renderCommand } from "../src/interactive/render";

describe("quoteArg", () => {
  it("leaves an ordinary path alone", () => {
    expect(quoteArg("./raw/take1.mp4", "darwin")).toBe("./raw/take1.mp4");
    expect(quoteArg("--produce", "darwin")).toBe("--produce");
  });

  // The whole reason this exists: the user who hit the edit bug was on
  // Windows with a backslash path. Quoting those would teach a command line
  // that looks wrong even though it runs.
  it("leaves a Windows path's backslashes untouched", () => {
    expect(quoteArg("D:\\CWA\\TiDB\\take.mp4", "win32")).toBe("D:\\CWA\\TiDB\\take.mp4");
  });

  it("quotes anything containing a space", () => {
    expect(quoteArg("My Videos/take 1.mp4", "darwin")).toBe("'My Videos/take 1.mp4'");
    expect(quoteArg("My Videos\\take 1.mp4", "win32")).toBe('"My Videos\\take 1.mp4"');
  });

  it("escapes an embedded quote per shell", () => {
    // POSIX has no escape inside single quotes: close, escape, reopen.
    expect(quoteArg("it's here", "darwin")).toBe("'it'\\''s here'");
    // cmd doubles an embedded double quote rather than backslash-escaping it.
    expect(quoteArg('say "hi"', "win32")).toBe('"say ""hi"""');
  });

  it("quotes the empty string rather than emitting nothing", () => {
    expect(quoteArg("", "darwin")).toBe("''");
    expect(quoteArg("", "win32")).toBe('""');
  });
});

describe("renderCommand", () => {
  it("prefixes the binary name and joins the argv", () => {
    expect(
      renderCommand(["produce", "./take.mp4", "--produce", "--intent", "agents 101"], "darwin"),
    ).toBe("ossclip produce ./take.mp4 --produce --intent 'agents 101'");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/interactive-render.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/render`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/interactive/render.ts`:

```ts
/**
 * Renders an argv into the command line a user could have typed. Printed as
 * `▸ running:` before every wizard run, so the wizard is also a flags lesson.
 *
 * This takes the SAME array that gets executed. A wizard that teaches one
 * command and runs another is worse than no wizard, and rendering from the
 * executed array makes that failure unrepresentable rather than unlikely.
 */

// Deliberately an allowlist, not a "needs quoting" denylist: a character
// nobody thought about ends up quoted (harmless) instead of unquoted (wrong).
// Backslash and colon are in it so `D:\CWA\TiDB` — the exact shape of path
// this feature exists for — renders bare rather than wrapped in quotes.
const SAFE = /^[A-Za-z0-9._\-/\\:=@+,]+$/;

export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (SAFE.test(arg)) return arg;
  if (platform === "win32") {
    // cmd doubles an embedded quote. Backslashes are left alone — escaping
    // them would corrupt every Windows path this prints.
    return `"${arg.replace(/"/g, '""')}"`;
  }
  // POSIX single quotes have no escape character: close, emit an escaped
  // quote, reopen.
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function renderCommand(argv: string[], platform: NodeJS.Platform = process.platform): string {
  return ["ossclip", ...argv].map((a) => quoteArg(a, platform)).join(" ");
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/interactive-render.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 747 passing, typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/interactive/render.ts apps/cli/test/interactive-render.test.ts
git commit -m "Interactive: the running-command echo, rendered from the executed argv

The wizard's teaching half. It takes the same string[] that gets executed,
so a wizard that teaches one command line and runs another is
unrepresentable rather than merely unlikely.

Quoting is an allowlist rather than a denylist, so an unforeseen character
ends up quoted (harmless) instead of bare (wrong) — and backslash and colon
are IN the allowlist so D:\\CWA\\TiDB renders bare. Quoting the very paths
this feature exists for would teach a command line that looks wrong even
though it runs. win32 doubles an embedded quote and never touches
backslashes; POSIX closes, escapes and reopens the single quote."
```

---

### Task 3: The workdir resolution ladder (pure)

The core of the bug report. `produce` writes into `<input dir>/.ossclip/<name>/`; `edit` wants that nested directory; the old error named a fix the user had already performed.

**Files:**
- Create: `apps/cli/src/interactive/resolve-workdir.ts`
- Test: `apps/cli/test/resolve-workdir.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Candidate { path: string; mtimeMs: number }`
  - `interface WorkdirProbe { isWorkdir: boolean; candidates: Candidate[] }`
  - `type Resolution = { kind: "resolved"; workdir: string; via: "direct" | "nested" } | { kind: "choose"; candidates: Candidate[] } | { kind: "none"; message: string }`
  - `resolveWorkdir(dir: string, probe: WorkdirProbe, sep?: string): Resolution`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/resolve-workdir.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveWorkdir, type WorkdirProbe } from "../src/interactive/resolve-workdir";

const probe = (over: Partial<WorkdirProbe> = {}): WorkdirProbe => ({
  isWorkdir: false,
  candidates: [],
  ...over,
});

describe("resolveWorkdir", () => {
  it("takes a directory that is already a workdir", () => {
    const r = resolveWorkdir("/v/.ossclip/take-abc", probe({ isWorkdir: true }));
    expect(r).toEqual({ kind: "resolved", workdir: "/v/.ossclip/take-abc", via: "direct" });
  });

  // The reported bug: `ossclip edit D:\CWA\TiDB` when the only run lives at
  // D:\CWA\TiDB\.ossclip\<name>. One candidate is not a choice to make.
  it("descends into .ossclip when exactly one run is there", () => {
    const r = resolveWorkdir("/v", probe({ candidates: [{ path: "/v/.ossclip/take-abc", mtimeMs: 5 }] }));
    expect(r).toEqual({ kind: "resolved", workdir: "/v/.ossclip/take-abc", via: "nested" });
  });

  it("asks when several runs are there, newest first", () => {
    const r = resolveWorkdir(
      "/v",
      probe({
        candidates: [
          { path: "/v/.ossclip/old", mtimeMs: 1 },
          { path: "/v/.ossclip/new", mtimeMs: 9 },
          { path: "/v/.ossclip/mid", mtimeMs: 5 },
        ],
      }),
    );
    expect(r.kind).toBe("choose");
    if (r.kind !== "choose") throw new Error("unreachable");
    expect(r.candidates.map((c) => c.path)).toEqual([
      "/v/.ossclip/new",
      "/v/.ossclip/mid",
      "/v/.ossclip/old",
    ]);
  });

  it("prefers being a workdir over descending", () => {
    // A workdir that itself contains an .ossclip (nested produce runs) must
    // not be skipped over in favour of its children.
    const r = resolveWorkdir(
      "/v",
      probe({ isWorkdir: true, candidates: [{ path: "/v/.ossclip/take", mtimeMs: 1 }] }),
    );
    expect(r).toEqual({ kind: "resolved", workdir: "/v", via: "direct" });
  });

  it("explains the layout and points at the picker when nothing is there", () => {
    const r = resolveWorkdir("/v", probe());
    expect(r.kind).toBe("none");
    if (r.kind !== "none") throw new Error("unreachable");
    // The old message said "run `ossclip produce` there first" to a user who
    // had. The new one must name the nesting AND the picker.
    expect(r.message).toContain("/v");
    expect(r.message).toContain(".ossclip");
    expect(r.message).toContain("ossclip edit");
  });

  it("writes the layout hint with the host's separator", () => {
    const r = resolveWorkdir("D:\\TiDB", probe(), "\\");
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("\\.ossclip\\");
    expect(r.message).not.toContain("/.ossclip/");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/resolve-workdir.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/resolve-workdir`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/interactive/resolve-workdir.ts`:

```ts
import { sep as hostSep } from "node:path";

/**
 * Resolving what a user meant by `ossclip edit <path>`.
 *
 * The bug this exists for: `produce` writes into
 * `<input dir>/.ossclip/<name>/`, `edit` wants that nested directory, and the
 * old failure — "no render-props.json in <dir> — run `ossclip produce` there
 * first" — named a fix the user had already performed. It also pointed away
 * from `ossclip edit` with no argument, which has opened a picker over recent
 * runs since R17 §83 and would have solved it instantly.
 *
 * Pure by construction: the caller passes a probe record and this decides.
 * That keeps every rung testable without a filesystem.
 */

export interface Candidate {
  path: string;
  mtimeMs: number;
}

export interface WorkdirProbe {
  /** Does `dir` itself hold a render-props.json? */
  isWorkdir: boolean;
  /** Directories under `dir/.ossclip/` that hold a render-props.json. */
  candidates: Candidate[];
}

export type Resolution =
  | { kind: "resolved"; workdir: string; via: "direct" | "nested" }
  | { kind: "choose"; candidates: Candidate[] }
  | { kind: "none"; message: string };

export function resolveWorkdir(
  dir: string,
  probe: WorkdirProbe,
  sep: string = hostSep,
): Resolution {
  // Checked BEFORE descending: a workdir that happens to contain its own
  // .ossclip must not be skipped in favour of its children.
  if (probe.isWorkdir) return { kind: "resolved", workdir: dir, via: "direct" };

  const newestFirst = [...probe.candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const only = newestFirst[0];
  if (only && newestFirst.length === 1) {
    return { kind: "resolved", workdir: only.path, via: "nested" };
  }
  if (newestFirst.length > 1) return { kind: "choose", candidates: newestFirst };

  return {
    kind: "none",
    message:
      `no ossclip output under ${dir}\n\n` +
      `  produce writes into <video's folder>${sep}.ossclip${sep}<name>${sep} —\n` +
      `  that nested folder is what \`edit\` wants, not the folder you ran produce in.\n\n` +
      `  Produce one:                ossclip produce ${dir}${sep}your-video.mp4\n` +
      `  Or pick from recent runs:   ossclip edit`,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/resolve-workdir.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 753 passing, typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/interactive/resolve-workdir.ts apps/cli/test/resolve-workdir.test.ts
git commit -m "The workdir ladder: what a user means by \`ossclip edit <path>\`

produce writes into <input dir>/.ossclip/<name>/ and edit wants that nested
directory. The old failure — 'no render-props.json in <dir> — run
\`ossclip produce\` there first' — named a fix the user had already
performed, and pointed away from the argument-less picker that has existed
since R17 §83 and would have solved it instantly.

Four rungs: the directory is a workdir; exactly one run under .ossclip
(descend without asking, because one candidate is not a choice); several
(ask, newest first); none (explain the nesting and name the picker).
isWorkdir is checked first so a workdir containing its own .ossclip is not
skipped in favour of its children.

Pure over an injected probe record, so every rung is tested without a
filesystem, and the separator is a parameter so the Windows wording is
tested from macOS."
```

---

### Task 4: Wire `edit` to the ladder

**Files:**
- Create: `apps/cli/src/interactive/workdir-probe.ts` (the fs adapter)
- Create: `apps/cli/src/interactive/pick-workdir.ts` (the "several runs" select)
- Modify: `apps/cli/src/index.ts:239-258` (the `edit` action)
- Modify: `apps/cli/src/edit.ts:197` (the server-side message, also hit by the browser's Open button)
- Test: `apps/cli/test/workdir-probe.test.ts`

**Interfaces:**
- Consumes: `resolveWorkdir`, `Candidate`, `WorkdirProbe` (Task 3); `isInteractive`, `unwrap` (Task 1).
- Produces:
  - `probeWorkdir(target: string): Promise<{ dir: string; probe: WorkdirProbe }>`
  - `pickWorkdir(candidates: Candidate[]): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/workdir-probe.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeWorkdir } from "../src/interactive/workdir-probe";

const scratch = (): string => mkdtempSync(join(tmpdir(), "ossclip-probe-"));

const makeRun = (root: string, name: string): string => {
  const dir = join(root, ".ossclip", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "render-props.json"), "{}");
  return dir;
};

describe("probeWorkdir", () => {
  it("reports a directory that is itself a workdir", async () => {
    const root = scratch();
    writeFileSync(join(root, "render-props.json"), "{}");
    const { dir, probe } = await probeWorkdir(root);
    expect(dir).toBe(root);
    expect(probe.isWorkdir).toBe(true);
  });

  it("finds runs nested under .ossclip", async () => {
    const root = scratch();
    const a = makeRun(root, "take-aaa");
    const b = makeRun(root, "take-bbb");
    const { probe } = await probeWorkdir(root);
    expect(probe.isWorkdir).toBe(false);
    expect(probe.candidates.map((c) => c.path).sort()).toEqual([a, b].sort());
  });

  // Rung 4: pointing at the video itself is a reasonable guess, and the runs
  // live beside it.
  it("treats a file target as its parent directory", async () => {
    const root = scratch();
    const run = makeRun(root, "take-aaa");
    const video = join(root, "take.mp4");
    writeFileSync(video, "not really a video");
    const { dir, probe } = await probeWorkdir(video);
    expect(dir).toBe(root);
    expect(probe.candidates.map((c) => c.path)).toEqual([run]);
  });

  it("ignores .ossclip children that never finished producing", async () => {
    const root = scratch();
    const good = makeRun(root, "take-good");
    mkdirSync(join(root, ".ossclip", "take-halfdone"), { recursive: true });
    const { probe } = await probeWorkdir(root);
    expect(probe.candidates.map((c) => c.path)).toEqual([good]);
  });

  it("reports an empty probe for a path that does not exist", async () => {
    const { probe } = await probeWorkdir(join(scratch(), "nope"));
    expect(probe).toEqual({ isWorkdir: false, candidates: [] });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/workdir-probe.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/workdir-probe`.

- [ ] **Step 3: Write the fs adapter**

Create `apps/cli/src/interactive/workdir-probe.ts`:

```ts
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Candidate, WorkdirProbe } from "./resolve-workdir";

/**
 * The only filesystem in the workdir ladder. Kept deliberately thin so
 * `resolveWorkdir` stays pure and every rung of the decision is tested
 * without a temp directory.
 */
export async function probeWorkdir(target: string): Promise<{ dir: string; probe: WorkdirProbe }> {
  const abs = resolve(target);

  // Pointing at the video rather than its folder is a reasonable guess, and
  // the runs live beside it — so a file target resolves to its parent.
  let dir = abs;
  try {
    if ((await stat(abs)).isFile()) dir = dirname(abs);
  } catch {
    // Missing path: fall through with an empty probe rather than throwing.
    // The "none" rung's message is a better error than ENOENT.
    return { dir: abs, probe: { isWorkdir: false, candidates: [] } };
  }

  const isWorkdir = existsSync(join(dir, "render-props.json"));

  const candidates: Candidate[] = [];
  const nest = join(dir, ".ossclip");
  try {
    for (const entry of await readdir(nest, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(nest, entry.name);
      // A workdir is exactly "a directory a produce run wrote its props
      // into" — the same definition edit.ts uses. A run killed mid-flight
      // leaves a directory with no props, and offering it would 404 the page.
      if (!existsSync(join(path, "render-props.json"))) continue;
      candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  } catch {
    // No .ossclip here — an empty candidate list, not an error.
  }

  return { dir, probe: { isWorkdir, candidates } };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/workdir-probe.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the picker for the several-runs rung**

Create `apps/cli/src/interactive/pick-workdir.ts`:

```ts
import { basename } from "node:path";
import type { Candidate } from "./resolve-workdir";
import { assertInteractive, select, unwrap } from "./prompts";

/**
 * The "several runs under .ossclip" rung. Newest first is already guaranteed
 * by resolveWorkdir; this only renders the choice.
 */
export async function pickWorkdir(candidates: Candidate[]): Promise<string> {
  assertInteractive("workdir picker");
  return unwrap(
    await select({
      message: "Several produce runs here — which one?",
      options: candidates.map((c, i) => ({
        value: c.path,
        label: basename(c.path),
        hint: i === 0 ? "most recent" : undefined,
      })),
    }),
  ) as string;
}
```

- [ ] **Step 6: Wire the `edit` action**

In `apps/cli/src/index.ts`, replace the body of the `edit` action (currently `apps/cli/src/index.ts:239-258`) so resolution happens before the server starts. The `pageDir` check and everything after `startEditServer` stay exactly as they are:

```ts
  .action(async (workdir: string | undefined, opts) => {
    const { startEditServer, resolveEditorPageDir } = await import("./edit");
    const pageDir = resolveEditorPageDir();
    if (pageDir === null) {
      throw new Error(
        "editor UI isn't built yet — run `pnpm build` " +
          "(or `pnpm --filter @ossclip/editor build`) once, then re-run `ossclip edit`.",
      );
    }

    // With no argument the editor opens on its own project picker (R17 §83).
    // With one, resolve what the user MEANT: `ossclip edit <video folder>`
    // was the reported failure, and produce's output lives one level down.
    let target: string | undefined = workdir;
    if (workdir !== undefined) {
      const { probeWorkdir } = await import("./interactive/workdir-probe");
      const { resolveWorkdir } = await import("./interactive/resolve-workdir");
      const { isInteractive } = await import("./interactive/tty");
      const { dir, probe } = await probeWorkdir(workdir);
      const resolution = resolveWorkdir(dir, probe);
      if (resolution.kind === "none") throw new Error(resolution.message);
      if (resolution.kind === "choose") {
        if (!isInteractive()) {
          throw new Error(
            `several produce runs under ${dir} — name one:\n` +
              resolution.candidates.map((c) => `  ossclip edit ${c.path}`).join("\n"),
          );
        }
        const { pickWorkdir } = await import("./interactive/pick-workdir");
        target = await pickWorkdir(resolution.candidates);
      } else {
        target = resolution.workdir;
        // Say so when the path was not the one typed — a silent redirect
        // leaves the user with the wrong mental model of where things live.
        if (resolution.via === "nested") console.log(`▸ resolved ${workdir} → ${target}`);
      }
    }

    const server = await startEditServer(target, { port: opts.port, pageDir });
    console.log(`▸ editor at ${server.url}`);
    if (opts.open) {
      const { openInBrowser } = await import("./open");
      openInBrowser(server.url);
    }
  });
```

- [ ] **Step 7: Fix the server-side message too**

The editor page's Open button calls `openWorkdir` directly, so it can hit the same dead end. In `apps/cli/src/edit.ts:197`, replace the throw:

```ts
    if (!isWorkdir(dir)) {
      // Not "run produce there first" — the reported failure said that to a
      // user who HAD, because produce writes one level down into
      // .ossclip/<name>/ and this wanted that nested directory.
      throw new Error(
        `no render-props.json in ${dir} — produce writes into ` +
          `<video's folder>/.ossclip/<name>/, and that nested folder is what edit opens`,
      );
    }
```

- [ ] **Step 8: Confirm the existing edit-server tests still hold**

Run: `pnpm vitest run apps/cli/test/edit-server.test.ts`
Expected: PASS. If a test asserted the old message text, update that assertion to the new text — the message is the fix, not an incidental.

- [ ] **Step 9: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 758 passing, typecheck silent.

- [ ] **Step 10: Manually walk the reported bug**

```bash
pnpm ossclip edit /tmp/definitely-not-a-project
```
Expected: the `none` message, naming `.ossclip` nesting and `ossclip edit`. No stack trace above it.

- [ ] **Step 11: Commit**

```bash
git add apps/cli/src/interactive/workdir-probe.ts apps/cli/src/interactive/pick-workdir.ts \
        apps/cli/src/index.ts apps/cli/src/edit.ts apps/cli/test/workdir-probe.test.ts
git commit -m "\`ossclip edit <video folder>\` now resolves instead of refusing

The reported failure, end to end: edit descends into .ossclip when exactly
one run is there and says so (\`▸ resolved D:\\TiDB → D:\\TiDB\\.ossclip\\take\`),
offers a choice when several are, and otherwise prints a message that names
the nesting and the argument-less picker rather than telling the user to
re-run produce.

Non-interactive gets the same resolution minus the select: several runs
print one copy-pasteable \`ossclip edit <path>\` per candidate, so a script
is never left waiting on a prompt.

The server-side message in edit.ts is fixed too — the editor page's Open
button calls openWorkdir directly and could reach the same dead end.

Candidates skip .ossclip children with no render-props.json: a run killed
mid-flight leaves the directory behind, and offering it would 404 the page."
```

---

### Task 5: Wizard answers → argv

**Files:**
- Create: `apps/cli/src/interactive/produce-argv.ts`
- Test: `apps/cli/test/produce-argv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ProduceExtras { clip?: number; sourceFit?: "cover" | "contain"; speaker?: string; whisperModel?: string; blooperMarker?: string; sourceIsEdited?: boolean; llm?: "claude" | "claude-cli" | "gemini" | "mock" }`
  - `interface ProduceAnswers { input: string; aspect: "9:16" | "16:9"; cleanup: "exact" | "light" | "standard" | "aggressive"; graphics: boolean; intent?: string; out?: string; extras: ProduceExtras }`
  - `produceArgv(a: ProduceAnswers): string[]`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/produce-argv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";

const answers = (over: Partial<ProduceAnswers> = {}): ProduceAnswers => ({
  input: "./take.mp4",
  aspect: "9:16",
  cleanup: "standard",
  graphics: false,
  extras: {},
  ...over,
});

describe("produceArgv", () => {
  // The single most important property: a wizard run where every answer is
  // the default must teach `ossclip produce <file>` and nothing more. Emitting
  // --aspect 9:16 --cleanup standard would grow a command line the user then
  // copies forever.
  it("emits no flag for an answer that equals the default", () => {
    expect(produceArgv(answers())).toEqual(["produce", "./take.mp4"]);
  });

  it("emits the non-default shape and cleanup", () => {
    expect(produceArgv(answers({ aspect: "16:9", cleanup: "aggressive" }))).toEqual([
      "produce", "./take.mp4", "--aspect", "16:9", "--cleanup", "aggressive",
    ]);
  });

  it("pairs --intent with --produce", () => {
    expect(produceArgv(answers({ graphics: true, intent: "agents 101" }))).toEqual([
      "produce", "./take.mp4", "--produce", "--intent", "agents 101",
    ]);
  });

  // --intent without --produce is meaningless: the intent feeds the producer
  // brain, which only runs under --produce.
  it("drops an intent when graphics are off", () => {
    expect(produceArgv(answers({ graphics: false, intent: "orphaned" }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("emits --out only when given", () => {
    expect(produceArgv(answers({ out: "./short.mp4" }))).toEqual([
      "produce", "./take.mp4", "--out", "./short.mp4",
    ]);
  });

  it("emits every tier-2 extra that was set", () => {
    expect(
      produceArgv(
        answers({
          extras: {
            clip: 60,
            sourceFit: "contain",
            speaker: "Ahsan, host of Code with Ahsan",
            whisperModel: "medium.en",
            blooperMarker: "blooper",
            sourceIsEdited: true,
            llm: "claude-cli",
          },
        }),
      ),
    ).toEqual([
      "produce", "./take.mp4",
      "--clip", "60",
      "--source-fit", "contain",
      "--speaker", "Ahsan, host of Code with Ahsan",
      "--whisper-model", "medium.en",
      "--blooper-marker", "blooper",
      "--source-is-edited",
      "--llm", "claude-cli",
    ]);
  });

  it("omits source-fit when it is the default cover", () => {
    expect(produceArgv(answers({ extras: { sourceFit: "cover" } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("omits a false --source-is-edited rather than emitting the flag", () => {
    expect(produceArgv(answers({ extras: { sourceIsEdited: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/produce-argv.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/produce-argv`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/interactive/produce-argv.ts`:

```ts
/**
 * Wizard answers → the argv a user could have typed.
 *
 * This is the load-bearing shape of the whole interactive layer: the wizard
 * produces ARGUMENTS, not a ProduceOptions, so the zod parses in index.ts
 * stay the only validation path and the printed command is the executed one.
 */

export interface ProduceExtras {
  clip?: number;
  sourceFit?: "cover" | "contain";
  speaker?: string;
  whisperModel?: string;
  blooperMarker?: string;
  sourceIsEdited?: boolean;
  llm?: "claude" | "claude-cli" | "gemini" | "mock";
}

export interface ProduceAnswers {
  input: string;
  aspect: "9:16" | "16:9";
  cleanup: "exact" | "light" | "standard" | "aggressive";
  graphics: boolean;
  intent?: string;
  out?: string;
  extras: ProduceExtras;
}

export function produceArgv(a: ProduceAnswers): string[] {
  const argv = ["produce", a.input];

  // A flag whose value equals the default is NEVER emitted. A wizard run
  // where every answer was the default must teach `ossclip produce <file>`
  // and nothing more — anything longer becomes a command line the user
  // copies forever without knowing which parts mattered.
  if (a.aspect !== "9:16") argv.push("--aspect", a.aspect);
  if (a.cleanup !== "standard") argv.push("--cleanup", a.cleanup);
  if (a.out) argv.push("--out", a.out);

  if (a.graphics) {
    argv.push("--produce");
    // Intent feeds the producer brain, which only runs under --produce —
    // emitting it alone would be a flag with nothing to act on.
    if (a.intent) argv.push("--intent", a.intent);
  }

  const e = a.extras;
  if (e.clip !== undefined) argv.push("--clip", String(e.clip));
  if (e.sourceFit === "contain") argv.push("--source-fit", "contain");
  if (e.speaker) argv.push("--speaker", e.speaker);
  if (e.whisperModel) argv.push("--whisper-model", e.whisperModel);
  if (e.blooperMarker) argv.push("--blooper-marker", e.blooperMarker);
  if (e.sourceIsEdited === true) argv.push("--source-is-edited");
  if (e.llm) argv.push("--llm", e.llm);

  return argv;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/produce-argv.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 766 passing, typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/interactive/produce-argv.ts apps/cli/test/produce-argv.test.ts
git commit -m "Wizard answers become argv, and a default answer emits no flag

The load-bearing shape of the interactive layer: the wizard produces
ARGUMENTS rather than a ProduceOptions, so the zod parses in index.ts stay
the only validation path and the printed command is the executed one.

The property worth naming: a run where every answer was the default teaches
\`ossclip produce <file>\` and nothing more. Emitting --aspect 9:16
--cleanup standard would hand the user a command line they copy forever
without knowing which parts mattered.

An intent with graphics off is dropped rather than emitted — it feeds the
producer brain, which only runs under --produce."
```

---

### Task 6: The produce wizard, and `produce` with no argument

**Files:**
- Create: `apps/cli/src/interactive/produce-wizard.ts`
- Modify: `apps/cli/src/index.ts:40` (argument becomes optional) and `apps/cli/src/index.ts:120-163` (the action)
- Test: `apps/cli/test/produce-argv-roundtrip.test.ts`

**Interfaces:**
- Consumes: `produceArgv`, `ProduceAnswers` (Task 5); `renderCommand` (Task 2); prompt helpers (Task 1).
- Produces: `produceWizard(cfg: { speaker?: string }): Promise<string[]>`

- [ ] **Step 1: Write the failing roundtrip test**

This is the test that stops wizard/flag drift, and the reason wizards emit argv at all.

Create `apps/cli/test/produce-argv-roundtrip.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";

const answers = (over: Partial<ProduceAnswers> = {}): ProduceAnswers => ({
  input: "./take.mp4",
  aspect: "9:16",
  cleanup: "standard",
  graphics: false,
  extras: {},
  ...over,
});

/**
 * Builds a commander program shaped exactly like the real `produce` command
 * and captures the options object the action would receive. If a wizard ever
 * emits a flag the CLI does not accept — or spells one differently — this
 * fails rather than shipping a wizard that teaches a broken command line.
 */
const parse = async (argv: string[]): Promise<Record<string, unknown>> => {
  const { Command } = await import("commander");
  const program = new Command();
  let captured: Record<string, unknown> = {};
  program
    .command("produce")
    .argument("[input]")
    .option("-o, --out <path>")
    .option("--cleanup <level>", "", "standard")
    .option("--aspect <ratio>", "", "9:16")
    .option("--produce", "", false)
    .option("--intent <text>")
    .option("--clip <seconds>", "", Number.parseFloat)
    .option("--source-fit <mode>", "", "cover")
    .option("--speaker <who>")
    .option("--whisper-model <name>")
    .option("--blooper-marker <word>")
    .option("--source-is-edited")
    .option("--llm <provider>")
    .action((input: string, opts: Record<string, unknown>) => {
      captured = { input, ...opts };
    });
  await program.parseAsync(["node", "ossclip", ...argv]);
  return captured;
};

describe("wizard argv survives the real commander parse", () => {
  it("a bare run reaches produce with every default intact", async () => {
    const opts = await parse(produceArgv(answers()));
    expect(opts.input).toBe("./take.mp4");
    expect(opts.aspect).toBe("9:16");
    expect(opts.cleanup).toBe("standard");
    expect(opts.produce).toBe(false);
    expect(opts.sourceFit).toBe("cover");
  });

  it("every tier-2 extra lands on the option commander names", async () => {
    const opts = await parse(
      produceArgv(
        answers({
          graphics: true,
          intent: "agents 101",
          out: "./short.mp4",
          aspect: "16:9",
          cleanup: "aggressive",
          extras: {
            clip: 60,
            sourceFit: "contain",
            speaker: "Ahsan",
            whisperModel: "medium.en",
            blooperMarker: "blooper",
            sourceIsEdited: true,
            llm: "claude-cli",
          },
        }),
      ),
    );
    expect(opts).toMatchObject({
      input: "./take.mp4",
      out: "./short.mp4",
      aspect: "16:9",
      cleanup: "aggressive",
      produce: true,
      intent: "agents 101",
      clip: 60,
      sourceFit: "contain",
      speaker: "Ahsan",
      whisperModel: "medium.en",
      blooperMarker: "blooper",
      sourceIsEdited: true,
      llm: "claude-cli",
    });
  });

  it("rejects an argv containing a flag the CLI does not define", async () => {
    // Proves the harness would actually catch drift rather than silently
    // accepting anything.
    const program = (await import("commander")).Command;
    const p = new program();
    p.exitOverride();
    p.command("produce").argument("[input]").action(() => {});
    await expect(
      p.parseAsync(["node", "ossclip", "produce", "./t.mp4", "--not-a-flag"]),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/produce-argv-roundtrip.test.ts`
Expected: FAIL — `--source-is-edited` etc. resolve, but the third test needs `vi` unused; if the linter or tsc complains about the unused `vi` import, remove it. The first failure you should see is a genuine assertion or import error, not a lint nit.

Note: if all three pass immediately, that is correct — Task 5 already produced the argv this parses. The test's value is as a regression gate for Tasks 6 onward.

- [ ] **Step 3: Write the wizard**

Create `apps/cli/src/interactive/produce-wizard.ts`:

```ts
import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { produceArgv, type ProduceAnswers, type ProduceExtras } from "./produce-argv";
import { assertInteractive, confirm, intro, multiselect, select, text, unwrap } from "./prompts";

/**
 * The produce wizard. Twenty-five flags sorted into three tiers: six always
 * asked, seven behind one "anything else?" multiselect, and twelve that stay
 * flags-only because they are debug or internal surfaces.
 *
 * --clip-window is deliberately NOT offered: --clip runs write it into
 * command.json so the editor's Render replays the same window without an LLM
 * call. A human picking it from a menu is a corrupted replay, not a
 * preference.
 */

const EXTRAS = [
  { value: "graphicsClip", label: "Only the strongest N seconds of a long take", hint: "--clip" },
  { value: "sourceFit", label: "Show the whole frame instead of cropping", hint: "--source-fit contain" },
  { value: "speaker", label: "Say who is on camera", hint: "--speaker" },
  { value: "whisperModel", label: "Pick a transcription model", hint: "--whisper-model" },
  { value: "blooperMarker", label: "Cut flubbed takes on a spoken word", hint: "--blooper-marker" },
  { value: "sourceIsEdited", label: "Source already has burned-in text", hint: "--source-is-edited" },
  { value: "llm", label: "Choose the LLM provider", hint: "--llm" },
] as const;

export async function produceWizard(cfg: { speaker?: string } = {}): Promise<string[]> {
  assertInteractive("produce wizard");
  intro("ossclip produce");

  const input = unwrap(
    await text({
      message: "Video file",
      placeholder: "./raw/take1.mp4",
      validate: (v) => {
        if (!v) return "a path is required";
        if (!existsSync(v)) return `no such file: ${v}`;
        if (!statSync(v).isFile()) return `${v} is a directory, not a video file`;
        return undefined;
      },
    }),
  ) as string;

  const aspect = unwrap(
    await select({
      message: "Shape",
      initialValue: "9:16",
      options: [
        { value: "9:16", label: "Vertical 9:16", hint: "shorts, reels" },
        { value: "16:9", label: "Landscape 16:9", hint: "1920x1080" },
      ],
    }),
  ) as ProduceAnswers["aspect"];

  const cleanup = unwrap(
    await select({
      message: "How hard should it cut?",
      initialValue: "standard",
      options: [
        { value: "exact", label: "exact", hint: "no cuts at all" },
        { value: "light", label: "light" },
        { value: "standard", label: "standard", hint: "recommended" },
        { value: "aggressive", label: "aggressive" },
      ],
    }),
  ) as ProduceAnswers["cleanup"];

  const graphics = unwrap(
    await confirm({ message: "Plan title cards and graphics with an LLM?", initialValue: false }),
  ) as boolean;

  // Only asked under graphics: the intent feeds the producer brain, which
  // does not run otherwise.
  const intent = graphics
    ? (unwrap(
        await text({
          message: "What is the video about?",
          placeholder: "educational video about agents",
        }),
      ) as string)
    : undefined;

  const defaultOut = `${basename(input).replace(/\.[^.]+$/, "")}.ossclip.mp4`;
  const out = unwrap(
    await text({ message: "Output file", placeholder: defaultOut, defaultValue: "" }),
  ) as string;

  const chosen = unwrap(
    await multiselect({
      message: "Anything else? (space to toggle, enter to accept)",
      options: [...EXTRAS],
      required: false,
    }),
  ) as string[];

  const extras: ProduceExtras = {};
  if (chosen.includes("graphicsClip")) {
    extras.clip = Number.parseFloat(
      unwrap(
        await text({
          message: "How many seconds?",
          placeholder: "60",
          validate: (v) => {
            const n = Number.parseFloat(v);
            // Mirrors the CLI's own §93a guard: a zero or a typo must be
            // rejected here rather than coerced into a NaN-length window.
            return Number.isFinite(n) && n > 0 ? undefined : "a positive number of seconds";
          },
        }),
      ) as string,
    );
  }
  if (chosen.includes("sourceFit")) extras.sourceFit = "contain";
  if (chosen.includes("sourceIsEdited")) extras.sourceIsEdited = true;
  if (chosen.includes("speaker")) {
    extras.speaker = unwrap(
      await text({
        message: "Who is on camera?",
        placeholder: "Ahsan, host of Code with Ahsan",
        // Prefilled from ~/.ossclip/config.json where set, so this answer
        // persists through the config that already exists.
        initialValue: cfg.speaker ?? "",
      }),
    ) as string;
  }
  if (chosen.includes("whisperModel")) {
    extras.whisperModel = unwrap(
      await select({
        message: "Transcription model",
        initialValue: "small.en",
        options: [
          { value: "base.en", label: "base.en", hint: "fastest, least accurate" },
          { value: "small.en", label: "small.en", hint: "default" },
          { value: "medium.en", label: "medium.en", hint: "slowest, most accurate" },
        ],
      }),
    ) as string;
  }
  if (chosen.includes("blooperMarker")) {
    extras.blooperMarker = unwrap(
      await text({ message: "Which word marks a flubbed take?", placeholder: "blooper" }),
    ) as string;
  }
  if (chosen.includes("llm")) {
    extras.llm = unwrap(
      await select({
        message: "LLM provider",
        options: [
          { value: "claude-cli", label: "claude-cli", hint: "your logged-in Claude Code, no API charges" },
          { value: "claude", label: "claude", hint: "needs ANTHROPIC_API_KEY" },
          { value: "gemini", label: "gemini", hint: "needs GEMINI_API_KEY" },
          { value: "mock", label: "mock", hint: "no LLM at all" },
        ],
      }),
    ) as ProduceExtras["llm"];
  }

  return produceArgv({
    input,
    aspect,
    cleanup,
    graphics,
    intent,
    out: out || undefined,
    extras,
  });
}
```

- [ ] **Step 4: Make the `produce` argument optional**

In `apps/cli/src/index.ts:40`, change:

```ts
  .argument("<input>", "input video file")
```

to:

```ts
  // OPTIONAL so a bare `ossclip produce` at a TTY opens the wizard instead of
  // printing a usage error at somebody who does not yet know the flags. A
  // non-interactive run still gets commander's "missing required argument".
  .argument("[input]", "input video file")
```

- [ ] **Step 5: Route a missing input into the wizard**

In `apps/cli/src/index.ts`, change the action signature and add the wizard branch as the FIRST thing in the body, before the `envFiles` line:

```ts
  .action(async (input: string | undefined, opts) => {
    if (input === undefined) {
      const { isInteractive } = await import("./interactive/tty");
      if (!isInteractive()) {
        throw new Error("missing required argument 'input' — the video file to produce");
      }
      const { produceWizard } = await import("./interactive/produce-wizard");
      const { renderCommand } = await import("./interactive/render");
      const { loadConfig } = await import("@ossclip/core");
      const argv = await produceWizard({ speaker: loadConfig().speaker });
      console.log(`\n▸ running:\n    ${renderCommand(argv)}\n`);
      // Re-entering the SAME parse the flags take: the zod checks below run
      // on wizard output exactly as they do on a typed command line.
      await program.parseAsync(["node", "ossclip", ...argv]);
      return;
    }
    if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
    // …the existing body continues unchanged from here
```

- [ ] **Step 6: Run the roundtrip test and the full suite**

Run: `pnpm vitest run apps/cli/test/produce-argv-roundtrip.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm test && pnpm typecheck`
Expected: 769 passing, typecheck silent.

- [ ] **Step 7: Confirm non-interactive behaviour is unchanged**

```bash
echo "" | pnpm ossclip produce
```
Expected: `✗ missing required argument 'input' — the video file to produce`. No prompt, no hang.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/interactive/produce-wizard.ts apps/cli/src/index.ts \
        apps/cli/test/produce-argv-roundtrip.test.ts
git commit -m "\`ossclip produce\` with no file opens the wizard, then runs its own argv

Twenty-five flags sorted into three tiers: six always asked, seven behind
one 'anything else?' multiselect, twelve left flags-only. --clip-window is
deliberately not offered — --clip runs write it into command.json so the
editor's Render replays the same window without an LLM call, which makes a
human picking it from a menu a corrupted replay rather than a preference.

The wizard's output is printed as \`▸ running:\` and then fed back through
program.parseAsync, so the zod checks run on wizard output exactly as they
do on a typed command line. The roundtrip test parses wizard argv with a
commander program shaped like the real one, which is what catches a wizard
emitting a flag the CLI does not accept.

The --clip prompt re-states §93a's guard: a zero or a typo is rejected at
the prompt rather than coerced into a NaN-length window.

Non-interactive is untouched — a missing input still errors out rather than
waiting on a prompt nobody can answer."
```

---

### Task 7: The `openEditorAfterProduce` preference, and produce reporting its workdir

**Files:**
- Modify: `packages/core/src/config.ts:7-31` (interface), `:84-102` (loadConfig)
- Create: `apps/cli/src/interactive/prefs.ts`
- Modify: `apps/cli/src/produce.ts:193` (return type), `:1393-1396` (the no-render return), `:1537-1539` (the final return)
- Test: `apps/cli/test/open-editor-prefs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OpenEditorPref = "ask" | "always" | "never"` (exported from `packages/core/src/config.ts`)
  - `decideOpenEditor(i: { flag: boolean | undefined; pref: OpenEditorPref; interactive: boolean; rendered: boolean }): "open" | "skip" | "ask"`
  - `interface ProduceResult { workdir: string; out?: string; rendered: boolean }` and `produce(): Promise<ProduceResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/open-editor-prefs.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfigPatch } from "@ossclip/core";
import { decideOpenEditor } from "../src/interactive/prefs";

const base = (over = {}) => ({
  flag: undefined as boolean | undefined,
  pref: "ask" as const,
  interactive: true,
  rendered: true,
  ...over,
});

describe("decideOpenEditor", () => {
  it("asks by default on an interactive render", () => {
    expect(decideOpenEditor(base())).toBe("ask");
  });

  it("lets the flags win over the stored preference", () => {
    expect(decideOpenEditor(base({ flag: true, pref: "never" }))).toBe("open");
    expect(decideOpenEditor(base({ flag: false, pref: "always" }))).toBe("skip");
  });

  it("honours a stored always/never without asking", () => {
    expect(decideOpenEditor(base({ pref: "always" }))).toBe("open");
    expect(decideOpenEditor(base({ pref: "never" }))).toBe("skip");
  });

  // --no-render leaves nothing to look at, so the offer would be noise.
  it("skips when nothing was rendered", () => {
    expect(decideOpenEditor(base({ rendered: false }))).toBe("skip");
    expect(decideOpenEditor(base({ rendered: false, pref: "always" }))).toBe("skip");
  });

  // An explicit flag is a deliberate instruction: the editor reads
  // render-props.json, which a --no-render run does write.
  it("still opens on an explicit flag with no render", () => {
    expect(decideOpenEditor(base({ rendered: false, flag: true }))).toBe("open");
  });

  it("never asks without a TTY", () => {
    expect(decideOpenEditor(base({ interactive: false }))).toBe("skip");
  });
});

describe("the preference round-trips through config.json", () => {
  it("writes and reads back without touching a real home", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-prefs-"));
    const path = saveConfigPatch({ openEditorAfterProduce: "always" }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      openEditorAfterProduce: "always",
    });
  });

  it("leaves neighbouring hand-edited keys alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-prefs-"));
    saveConfigPatch({ speaker: "Ahsan" }, dir);
    const path = saveConfigPatch({ openEditorAfterProduce: "never" }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      speaker: "Ahsan",
      openEditorAfterProduce: "never",
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/open-editor-prefs.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/prefs`.

- [ ] **Step 3: Add the config key**

In `packages/core/src/config.ts`, add above `export interface OssclipConfig`:

```ts
/** Whether a finished `produce` offers to open the editor. */
export type OpenEditorPref = "ask" | "always" | "never";
```

Add to the `OssclipConfig` interface, after `speaker`:

```ts
  /**
   * What a finished produce run does about the editor: ask (default), always
   * open, or never mention it. Written by the post-produce prompt when the
   * user picks one of its "stop asking" answers.
   */
  openEditorAfterProduce?: OpenEditorPref;
```

Add to the object `loadConfig` returns, after the `speaker` line:

```ts
    openEditorAfterProduce: (process.env.OSSCLIP_OPEN_EDITOR ??
      fileCfg.openEditorAfterProduce) as OpenEditorPref | undefined,
```

- [ ] **Step 4: Write the decision function**

Create `apps/cli/src/interactive/prefs.ts`:

```ts
import type { OpenEditorPref } from "@ossclip/core";

export type OpenEditorDecision = "open" | "skip" | "ask";

/**
 * Whether a finished produce run opens the editor, asks, or says nothing.
 *
 * Pure so the whole precedence order is tested without a produce run: flags
 * beat the stored preference, the stored preference beats asking, and no TTY
 * means never ask.
 */
export function decideOpenEditor(i: {
  flag: boolean | undefined;
  pref: OpenEditorPref;
  interactive: boolean;
  rendered: boolean;
}): OpenEditorDecision {
  // An explicit flag is a deliberate instruction and wins outright — including
  // over `rendered`, because the editor reads render-props.json, which a
  // --no-render run does write.
  if (i.flag === true) return "open";
  if (i.flag === false) return "skip";
  // Otherwise a run with no render has nothing to look at, so the offer is noise.
  if (!i.rendered) return "skip";
  if (i.pref === "always") return "open";
  if (i.pref === "never") return "skip";
  return i.interactive ? "ask" : "skip";
}
```

- [ ] **Step 5: Make `produce` report where it put things**

In `apps/cli/src/produce.ts`, add near the other exported interfaces (above `export interface ProduceOptions` at line 99):

```ts
/**
 * What a finished run tells its caller. The workdir is what the post-produce
 * editor offer opens; `rendered` is false for a --no-render run, which has
 * props but no video.
 */
export interface ProduceResult {
  workdir: string;
  out?: string;
  rendered: boolean;
}
```

Change the signature at line 193:

```ts
export async function produce(inputArg: string, opts: ProduceOptions): Promise<ProduceResult> {
```

Change the `--no-render` early return (currently `apps/cli/src/produce.ts:1393-1396`):

```ts
  if (!opts.render) {
    console.log(`▸ skipping render (--no-render). Props at ${join(work, "render-props.json")}`);
    return { workdir: work, rendered: false };
  }
```

Change the end of the function (currently `apps/cli/src/produce.ts:1537-1539`):

```ts
  await recordRecentProject(work);
  console.log(`✓ done → ${outPath}`);
  return { workdir: work, out: outPath, rendered: true };
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm vitest run apps/cli/test/open-editor-prefs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 777 passing, typecheck silent. The two existing `produce()` callers in `index.ts` ignore the return value, which TypeScript permits — no call-site changes needed.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config.ts apps/cli/src/interactive/prefs.ts \
        apps/cli/src/produce.ts apps/cli/test/open-editor-prefs.test.ts
git commit -m "openEditorAfterProduce, and produce reporting where it put things

A new ask/always/never key in ~/.ossclip/config.json, readable from
OSSCLIP_OPEN_EDITOR, plus the pure decision function that orders it: flags
beat the stored preference, the preference beats asking, and no TTY never
asks.

Two deliberate asymmetries, both tested. A run with no render skips the
offer, because there is nothing to look at. But an EXPLICIT --open-editor
still opens even then — the editor reads render-props.json, which a
--no-render run does write, so the flag is an instruction rather than a
hint.

produce() now returns { workdir, out, rendered } from both of its exits
instead of void. The post-produce offer needs the workdir, and reading it
back out of recent-projects.json would be inferring what the function
already knew. Existing callers ignore the value."
```

---

### Task 8: The post-produce offer

**Files:**
- Modify: `apps/cli/src/index.ts` (the `produce` command: two new options, and the tail of the action)
- Create: `apps/cli/src/interactive/offer-editor.ts`
- Test: covered by `apps/cli/test/open-editor-prefs.test.ts` (Task 7) plus the manual walk below

**Interfaces:**
- Consumes: `decideOpenEditor` (Task 7); `ProduceResult` (Task 7); prompt helpers (Task 1).
- Produces: `offerEditor(result: ProduceResult, opts: { flag: boolean | undefined; port: number }): Promise<void>`

- [ ] **Step 1: Write the offer**

Create `apps/cli/src/interactive/offer-editor.ts`:

```ts
import { loadConfig, saveConfigPatch, type OpenEditorPref } from "@ossclip/core";
import type { ProduceResult } from "../produce";
import { decideOpenEditor } from "./prefs";
import { isInteractive, select, unwrap } from "./prompts";

/**
 * The offer at the end of a produce run. The user who prompted this work
 * asked "how can I open the editor?" BEFORE running anything — the answer
 * belongs at the moment there is finally something to open.
 */
export async function offerEditor(
  result: ProduceResult,
  opts: { flag: boolean | undefined; port: number },
): Promise<void> {
  const pref: OpenEditorPref = loadConfig().openEditorAfterProduce ?? "ask";
  const decision = decideOpenEditor({
    flag: opts.flag,
    pref,
    interactive: isInteractive(),
    rendered: result.rendered,
  });

  if (decision === "skip") return;

  let open = decision === "open";
  if (decision === "ask") {
    const answer = unwrap(
      await select({
        message: "Open the editor on this project?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
          { value: "always", label: "Yes, and stop asking" },
          { value: "never", label: "No, and stop asking" },
        ],
      }),
    ) as "yes" | "no" | "always" | "never";

    if (answer === "always" || answer === "never") {
      const next: OpenEditorPref = answer === "always" ? "always" : "never";
      const path = saveConfigPatch({ openEditorAfterProduce: next });
      // Say where the answer went, and how to take it back — a preference
      // saved silently is one the user cannot find again.
      console.log(`▸ saved openEditorAfterProduce="${next}" to ${path}`);
    }
    open = answer === "yes" || answer === "always";
  }

  if (!open) return;

  const { startEditServer, resolveEditorPageDir } = await import("../edit");
  const pageDir = resolveEditorPageDir();
  if (pageDir === null) {
    // Not fatal here: the render succeeded. Say what is missing and stop.
    console.log(
      "▸ editor UI isn't built — run `pnpm build` once, then `ossclip edit` " +
        `${result.workdir}`,
    );
    return;
  }
  const server = await startEditServer(result.workdir, { port: opts.port, pageDir });
  console.log(`▸ editor at ${server.url}`);
  const { openInBrowser } = await import("../open");
  openInBrowser(server.url);
}
```

- [ ] **Step 2: Add the two flags**

In `apps/cli/src/index.ts`, add to the `produce` command's options, just before `.action(`:

```ts
  .option("--open-editor", "open the editor when the run finishes")
  .option(
    "--no-open-editor",
    "don't open the editor, and don't ask (overrides openEditorAfterProduce)",
  )
  .option("--editor-port <n>", "port for the editor started by --open-editor",
    (v) => Number.parseInt(v, 10), 5174)
```

Declaring both `--open-editor` and `--no-open-editor` leaves `opts.openEditor` as `undefined` when neither is passed — verified against commander 12. That tri-state is exactly what `decideOpenEditor` expects, so no default is needed and none should be added.

- [ ] **Step 3: Await the result and make the offer**

In the `produce` action, change `await produce(input, {…})` to capture its result and offer afterwards. The options object passed to `produce` is unchanged:

```ts
    const result = await produce(input, {
      // …every existing field, unchanged
    });
    const { offerEditor } = await import("./interactive/offer-editor");
    await offerEditor(result, { flag: opts.openEditor, port: opts.editorPort });
```

- [ ] **Step 4: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: 777 passing, typecheck silent.

- [ ] **Step 5: Walk it manually**

```bash
pnpm fixture
pnpm ossclip produce fixtures/<generated>.mp4 --no-render --open-editor
```
Expected: the run ends, then `▸ editor at http://127.0.0.1:5174` — the explicit flag opens even with no render.

```bash
OSSCLIP_NO_INTERACTIVE=1 pnpm ossclip produce fixtures/<generated>.mp4 --no-render
```
Expected: the run ends with no prompt and no editor.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/interactive/offer-editor.ts apps/cli/src/index.ts
git commit -m "A finished produce offers the editor, and remembers the answer

The user who prompted this work asked 'how can I open the editor?' before
running anything. The answer belongs at the moment there is finally
something to open.

Four answers, two of which persist to ~/.ossclip/config.json through the
existing saveConfigPatch, so a hand-edited pricing or speaker survives. The
save prints the key and the file it went to — a preference stored silently
is one the user cannot find again.

--open-editor / --no-open-editor are declared as a pair, which commander
leaves as undefined when neither is passed; that tri-state is what the
decision function expects, so no default is set.

A missing editor build is reported rather than thrown: the render already
succeeded, and failing the run over the follow-up would throw away work."
```

---

### Task 9: The front door — bare `ossclip`, and the README

**Files:**
- Create: `apps/cli/src/interactive/menu.ts`
- Modify: `apps/cli/src/index.ts` (root `.action`)
- Modify: `README.md` (the section `apps/cli/test/docs-install.test.ts` asserts against)
- Test: `apps/cli/test/menu.test.ts`

**Interfaces:**
- Consumes: `produceWizard` (Task 6), `renderCommand` (Task 2), prompt helpers (Task 1).
- Produces: `menuArgv(choice: MenuChoice): string[] | null`, `type MenuChoice = "produce" | "edit" | "setup" | "doctor"`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/menu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { menuArgv } from "../src/interactive/menu";

describe("menuArgv", () => {
  it("routes edit with no argument, which is the project picker", () => {
    expect(menuArgv("edit")).toEqual(["edit"]);
  });

  it("routes setup and doctor as plain passthroughs", () => {
    expect(menuArgv("setup")).toEqual(["setup"]);
    expect(menuArgv("doctor")).toEqual(["doctor"]);
  });

  // Produce is the one choice that needs answers before it has an argv, so
  // the menu hands it off rather than returning one.
  it("returns null for produce, which the wizard builds", () => {
    expect(menuArgv("produce")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run apps/cli/test/menu.test.ts`
Expected: FAIL — cannot resolve `../src/interactive/menu`.

- [ ] **Step 3: Write the menu**

Create `apps/cli/src/interactive/menu.ts`:

```ts
import { assertInteractive, intro, select, unwrap } from "./prompts";

export type MenuChoice = "produce" | "edit" | "setup" | "doctor";

/**
 * What each menu entry runs. Produce is the exception — it needs answers
 * before it has an argv, so it returns null and the caller hands off to the
 * wizard.
 */
export function menuArgv(choice: MenuChoice): string[] | null {
  if (choice === "produce") return null;
  // Edit with NO argument is deliberate: that is the project picker over
  // recent runs (R17 §83), which is exactly what somebody who reached a menu
  // instead of typing a command needs.
  return [choice];
}

export async function chooseFromMenu(): Promise<MenuChoice> {
  assertInteractive("main menu");
  intro("ossclip");
  return unwrap(
    await select({
      message: "What do you want to do?",
      options: [
        { value: "produce", label: "Produce a video", hint: "cut, caption, frame, render" },
        { value: "edit", label: "Edit a produced project", hint: "pick from recent runs" },
        { value: "setup", label: "Set up my install", hint: "ffmpeg, whisper, the model" },
        { value: "doctor", label: "Check what's missing" },
      ],
    }),
  ) as MenuChoice;
}
```

- [ ] **Step 4: Wire the root action**

In `apps/cli/src/index.ts`, add after the `.version(…)` call and before the first `program.command(…)`:

```ts
// Bare `ossclip` at a TTY opens the menu. Piped or in CI it prints help,
// byte for byte what it printed before — a front door must not become a
// hang for a script.
program.action(async () => {
  const { isInteractive } = await import("./interactive/tty");
  if (!isInteractive()) {
    program.outputHelp();
    return;
  }
  const { chooseFromMenu, menuArgv } = await import("./interactive/menu");
  const choice = await chooseFromMenu();
  const direct = menuArgv(choice);
  if (direct !== null) {
    await program.parseAsync(["node", "ossclip", ...direct]);
    return;
  }
  const { produceWizard } = await import("./interactive/produce-wizard");
  const { renderCommand } = await import("./interactive/render");
  const { loadConfig } = await import("@ossclip/core");
  const argv = await produceWizard({ speaker: loadConfig().speaker });
  console.log(`\n▸ running:\n    ${renderCommand(argv)}\n`);
  await program.parseAsync(["node", "ossclip", ...argv]);
});
```

- [ ] **Step 5: Run the test and the full suite**

Run: `pnpm vitest run apps/cli/test/menu.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm test && pnpm typecheck`
Expected: 780 passing, typecheck silent.

- [ ] **Step 6: Confirm bare `ossclip` still prints help when piped**

```bash
pnpm ossclip | head -5
```
Expected: the usage banner, unchanged. No prompt, no hang.

- [ ] **Step 7: Update the README**

First read what the existing test asserts, so the edit does not break it:

Run: `cat apps/cli/test/docs-install.test.ts`

Then add a short section to `README.md` immediately after the install instructions, keeping whatever strings that test requires intact:

```markdown
### Not sure what to run?

```sh
ossclip
```

Opens a menu — produce a video, open the editor on something you already
produced, set up your install, or check what's missing. Every choice prints
the equivalent command before it runs, so the menu is also how you learn the
flags.

`ossclip produce` with no file name does the same thing for just the produce
options. And `ossclip edit` with no path opens a picker over your recent
runs — you never have to know that produce writes into
`<your video's folder>/.ossclip/<name>/`.
```

- [ ] **Step 8: Full suite once more**

Run: `pnpm test && pnpm typecheck`
Expected: 780 passing (`docs-install.test.ts` still green), typecheck silent.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/interactive/menu.ts apps/cli/src/index.ts \
        apps/cli/test/menu.test.ts README.md
git commit -m "Bare \`ossclip\` opens a menu, and the README stops assuming you know

The first question the reported user asked was 'how can I open the editor?
do I have to run the produce command first?' — before typing anything. A
help page organised around commands answers that badly.

Edit is routed with NO argument on purpose: that is the picker over recent
runs, which is precisely what somebody who reached a menu rather than
typing a command needs. Setup and doctor are plain passthroughs.

Piped or in CI, bare ossclip prints exactly the help it printed before. A
front door that becomes a hang for a script is a worse bug than the one
this fixes."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the argv-not-options architecture is Tasks 5 and 6 (with the roundtrip test that enforces it); the module layout is spread across Tasks 1–9 with one file each; the four `index.ts` call sites are Tasks 4, 6, 8 and 9; the three flag tiers are Task 5's implementation and Task 6's prompts; the workdir ladder is Tasks 3 and 4; the open-editor offer is Tasks 7 and 8; cancel-is-not-a-failure and the no-TTY guard are Task 1. Every test named in the spec's Testing section exists here, though two are renamed for clarity: the spec's `produce-wizard.test.ts` is `produce-argv.test.ts` (it tests `produceArgv`, which is where the logic lives) and `argv-roundtrip.test.ts` is `produce-argv-roundtrip.test.ts`. `prefs.test.ts` is `open-editor-prefs.test.ts`.

**One addition beyond the spec.** Task 9 updates the README. The spec did not mention docs, but shipping a front door nobody is told about repeats the exact failure that motivated the work — `ossclip edit`'s picker existed for a full release and no user found it.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the code.

**Type consistency.** `WorkdirProbe` and `Candidate` are defined in Task 3 and imported by name in Task 4. `ProduceAnswers`/`ProduceExtras` are defined in Task 5 and consumed in Task 6. `OpenEditorPref` is defined in `packages/core/src/config.ts` in Task 7 and imported in Tasks 7 and 8. `ProduceResult` is defined in Task 7 and consumed in Task 8. `isInteractive`/`unwrap`/`assertInteractive` come from Task 1 and are re-exported through `prompts.ts` so later tasks import from one place.

**Test-count arithmetic.** Each task's expected total assumes the previous task landed: 734 → 741 → 747 → 753 → 758 → 766 → 769 → 777 → 780. If a count is off by a few, check whether an existing test was legitimately updated (Task 4, Step 8) before treating it as a failure.
