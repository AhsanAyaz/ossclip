import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { livePickerDeps, pickPath, pickerAvailable, type PickMode } from "./picker";
import { assertInteractive, select, text, unwrap } from "./prompts";
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
 *
 * There is deliberately no extension whitelist, on any branch: typing a path
 * was never extension-checked either, and ossclip accepts whatever ffmpeg can
 * read — a list would reject legitimate containers.
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
  // Offering a "Browse…" row on a machine with no dialog to open is worse
  // than not offering it — `pickerAvailable` has already probed, so the row
  // simply does not exist when it cannot work.
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

/**
 * Module state outlives a single wizard, and "argv" is a real answer — the
 * value the telemetry reads when `ossclip <path>` prefilled the input and
 * `askInput` never ran. So a second run in the same process (a batch or REPL
 * caller, and every test file, where module state persists across `it`s)
 * would report the PREVIOUS run's branch with nothing to signal the staleness.
 * Reset at the start of a run — or of a test — rather than trusting one
 * invocation per process.
 */
export function resetInputSource(): void {
  lastInputSource = "argv";
}

/**
 * The seam. Same shape and same reason as `PickerDeps` (picker.ts) and
 * `TtyDeps` (tty.ts): the branch logic is what has rules worth pinning — a
 * cancelled dialog re-asks, every branch validates, each sets its own source —
 * and none of that is reachable through a real `select` blocking on a human.
 * `pickPath` is tested the same way through its own injected deps.
 *
 * Structural signatures rather than `typeof select`: clack's are generic, and
 * a fake cannot satisfy an unresolved type parameter. Narrowing here is what
 * makes the fakes writable, exactly as `PickerDeps` declares `hasBin` rather
 * than `typeof binOnPath`.
 */
export interface AskInputDeps {
  /** Probed once per run, not per loop — no dialog appears mid-prompt. */
  canBrowse: boolean;
  suggest: () => Promise<Suggestion[]>;
  pick: (mode: PickMode) => Promise<string | undefined>;
  select: (opts: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
  }) => Promise<string | symbol>;
  text: (opts: {
    message: string;
    placeholder?: string;
    validate?: (v: string | undefined) => string | undefined;
  }) => Promise<string | symbol>;
  /** Injected because the guard itself takes an injected check (tty.ts:58). */
  assertInteractive: () => void;
}

export const liveAskInputDeps = (): AskInputDeps => ({
  canBrowse: pickerAvailable(livePickerDeps()),
  suggest: async () => rankSuggestions(await scanLikelyDirs(), Date.now(), homedir()),
  pick: (mode) => pickPath(mode),
  select,
  text,
  assertInteractive: () => assertInteractive("input prompt"),
});

const typePath = async (deps: AskInputDeps): Promise<string> =>
  unwrap(
    await deps.text({
      // Finding 1 (final-review fix wave): `ossclip produce <folder>` shipped
      // (folder-input-brief.md) but this prompt still rejected a directory —
      // the wizard was the only way in that couldn't do what the CLI could.
      // A folder is concatenated by name (codepoint order, like `ls`); --sort
      // mtime reorders it but stays a typed flag, not a wizard question (see
      // the file-level comment in produce-wizard.ts for why).
      message: "Video file, or a folder of clips to concatenate (by name; --sort mtime is a typed flag)",
      placeholder: "./raw/take1.mp4",
      validate: validateInputPath,
    }),
  ) as string;

export async function askInput(deps: AskInputDeps = liveAskInputDeps()): Promise<string> {
  deps.assertInteractive();
  const canBrowse = deps.canBrowse;
  const suggestions = await deps.suggest();

  // Nothing found and nowhere to browse: a one-row menu is pure noise, so go
  // straight to the prompt this whole unit replaced.
  if (suggestions.length === 0 && !canBrowse) {
    noteInputSource("typed");
    return typePath(deps);
  }

  // Loops rather than returns, because cancelling the OS dialog must land
  // back on the menu — Escape in a Finder window means "not that one", not
  // "abandon the run". Ctrl-C at the menu still exits via `unwrap`.
  for (;;) {
    const choice = unwrap(
      await deps.select({ message: "Which video?", options: inputChoices(suggestions, canBrowse) }),
    ) as string;

    if (choice === TYPE_PATH) {
      noteInputSource("typed");
      return typePath(deps);
    }

    if (choice === BROWSE_FILE || choice === BROWSE_FOLDER) {
      const picked = await deps.pick(choice === BROWSE_FOLDER ? "folder" : "file");
      // An empty result conflates "cancelled" with "the backend failed
      // silently" — no backend distinguishes them reliably (picker.ts), and
      // `pickPath` has already printed the fallback notice in the failure
      // case. Re-asking is the right next step either way.
      if (picked === undefined) continue;
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
