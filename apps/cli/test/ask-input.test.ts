import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSE_FILE,
  BROWSE_FOLDER,
  TYPE_PATH,
  askInput,
  inputChoices,
  inputSourceUsed,
  resetInputSource,
  validateInputPath,
  type AskInputDeps,
} from "../src/interactive/ask-input";
import type { PickMode } from "../src/interactive/picker";
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
    expect(out.map((c) => c.value)).toEqual([
      "/x/a.mp4",
      "/x/b.mp4",
      BROWSE_FILE,
      BROWSE_FOLDER,
      TYPE_PATH,
    ]);
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
    expect(row?.hint).toBe("1 MB · just now");
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

  // Retitled: this exercises the validator over a deleted path and nothing
  // else. The claim it used to make — that the PICKER branch is guarded — is
  // carried by "a picked path that no longer exists re-asks" below, which is
  // the test that actually goes red if that branch stops validating.
  it("rejects a path deleted after it was last seen", () => {
    const gone = join(dir, "deleted.mp4");
    writeFileSync(gone, "x");
    rmSync(gone);
    expect(validateInputPath(gone)).toBe(`no such path: ${gone}`);
  });
});

/**
 * The branch logic (§136). None of these rules is reachable through a real
 * `select` — it blocks on a human — so `askInput` takes injected deps, the
 * same seam `pickPath` is tested through (picker.test.ts) and the same shape
 * as `PickerDeps` and `TtyDeps`. Injection, not module mocking: nothing in
 * `apps/cli/test` mocks a module, and this is not the place to introduce it.
 *
 * Answers are a QUEUE rather than a single value, because the rules worth
 * pinning are all about what the SECOND prompt is: a cancelled dialog has to
 * come back to the menu, and only a script can tell "came back" from
 * "returned something".
 */
describe("askInput (branch logic)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-askloop-"));
  const take = join(dir, "take.mp4");
  const other = join(dir, "other.mp4");
  writeFileSync(take, "x");
  writeFileSync(other, "x");
  const missing = join(dir, "vanished.mp4");

  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(" "));
    });
    // Module state outlives an `it`, so the "argv" default would otherwise
    // pass or fail on test ordering alone.
    resetInputSource();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface Harness {
    deps: AskInputDeps;
    /** The options each `select` was given — its length is the call count. */
    menus: { value: string; label: string; hint?: string }[][];
    modes: PickMode[];
    typedPrompts: number;
  }

  const harness = (script: {
    answers?: string[];
    picks?: (string | undefined)[];
    typed?: string;
    suggestions?: Suggestion[];
    canBrowse?: boolean;
  }): Harness => {
    const answers = [...(script.answers ?? [])];
    const picks = [...(script.picks ?? [])];
    const h: Harness = {
      menus: [],
      modes: [],
      typedPrompts: 0,
      deps: {
        canBrowse: script.canBrowse ?? true,
        suggest: async () => script.suggestions ?? [],
        pick: async (mode) => {
          h.modes.push(mode);
          // Running past the script means the loop asked for a dialog the
          // test never planned — a hang in production, so fail loudly here
          // rather than resolving undefined and looping forever.
          if (picks.length === 0) throw new Error("pick called past the script");
          return picks.shift();
        },
        select: async (opts) => {
          h.menus.push(opts.options);
          if (answers.length === 0) throw new Error("select called past the script");
          return answers.shift() as string;
        },
        text: async (opts) => {
          h.typedPrompts += 1;
          const answer = script.typed ?? "";
          // The real prompt will not return a value its own validator
          // rejects, so a fake that does would test a state the user cannot
          // reach.
          const problem = opts.validate?.(answer);
          if (problem !== undefined) throw new Error(`typed answer rejected: ${problem}`);
          return answer;
        },
        assertInteractive: () => {},
      },
    };
    return h;
  };

  it("a cancelled dialog returns to the menu instead of abandoning the run", async () => {
    const h = harness({
      answers: [BROWSE_FILE, BROWSE_FILE],
      picks: [undefined, take],
    });
    await expect(askInput(h.deps)).resolves.toBe(take);
    // The whole point: Escape in a Finder window means "not that one", not
    // "throw away the answers already given". A `return` in place of the
    // `continue` passes every other test in this file.
    expect(h.menus).toHaveLength(2);
    expect(h.typedPrompts).toBe(0);
  });

  it("a picked path that no longer exists re-asks — the dialog is not trusted", async () => {
    const h = harness({
      answers: [BROWSE_FILE, BROWSE_FILE],
      picks: [missing, take],
    });
    await expect(askInput(h.deps)).resolves.toBe(take);
    expect(h.menus).toHaveLength(2);
    expect(logs).toContain(`▸ no such path: ${missing}`);
  });

  it("a suggestion that moved between the scan and the keypress re-asks too", async () => {
    const h = harness({
      answers: [missing, take],
      suggestions: [
        { path: missing, label: missing, hint: "1 MB · just now" },
        { path: take, label: take, hint: "1 MB · just now" },
      ],
    });
    await expect(askInput(h.deps)).resolves.toBe(take);
    expect(h.menus).toHaveLength(2);
    expect(logs).toContain(`▸ no such path: ${missing}`);
  });

  it("folder mode reaches the picker as a folder", async () => {
    const h = harness({ answers: [BROWSE_FOLDER], picks: [dir] });
    await expect(askInput(h.deps)).resolves.toBe(dir);
    expect(h.modes).toEqual(["folder"]);
    expect(inputSourceUsed()).toBe("picker");
  });

  /**
   * Swapping these two labels is invisible to every other assertion here, and
   * the number they feed is what decides whether the picker was worth
   * building (§136, Task 6 telemetry).
   */
  it("each branch records the source it came from", async () => {
    const h1 = harness({ answers: [take], suggestions: [{ path: take, label: take, hint: "h" }] });
    await expect(askInput(h1.deps)).resolves.toBe(take);
    expect(inputSourceUsed()).toBe("suggestion");

    const h2 = harness({ answers: [BROWSE_FILE], picks: [other] });
    await expect(askInput(h2.deps)).resolves.toBe(other);
    // The mode mapping, pinned on the file side too: only the folder case was
    // asserted, so a ternary that always returned "folder" passed the whole
    // suite while **Browse…** opened a folder chooser (§136, final review).
    expect(h2.modes).toEqual(["file"]);
    expect(inputSourceUsed()).toBe("picker");

    const h3 = harness({ answers: [TYPE_PATH], typed: take });
    await expect(askInput(h3.deps)).resolves.toBe(take);
    expect(inputSourceUsed()).toBe("typed");
  });

  it("defaults to argv — the branch that ran when askInput never did", () => {
    expect(inputSourceUsed()).toBe("argv");
  });

  it("nothing to suggest and nowhere to browse skips the menu entirely", async () => {
    const h = harness({ canBrowse: false, suggestions: [], typed: take });
    await expect(askInput(h.deps)).resolves.toBe(take);
    // A one-row "Type a path" menu is pure noise; the `select` must not run
    // at all. `menus` empty is the assertion — the harness would throw on a
    // call anyway, but this says why.
    expect(h.menus).toEqual([]);
    expect(h.typedPrompts).toBe(1);
    expect(inputSourceUsed()).toBe("typed");
  });

  it("with no picker, the menu still lists suggestions and offers typing", async () => {
    const h = harness({
      canBrowse: false,
      suggestions: [{ path: take, label: take, hint: "1 MB · just now" }],
      answers: [take],
    });
    await expect(askInput(h.deps)).resolves.toBe(take);
    expect(h.menus[0]?.map((c) => c.value)).toEqual([take, TYPE_PATH]);
  });
});
