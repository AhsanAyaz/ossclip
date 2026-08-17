import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "../paths";
import { select, text, unwrap } from "./prompts";

/**
 * "Where should the video go?" — the output-file question, rebuilt as a
 * folder walk (2026-08-16, the `~`-path incident's second defense). The raw
 * text prompt this replaces is where `~/Downloads/x.mp4` got typed and — no
 * shell expands a wizard text input (paths.ts) — resolved against cwd.
 * expandHome now heals the typed form, but a picker removes the typing: the
 * same navigate-a-listing interaction the editor's switch-project browser
 * uses (ProjectPicker.tsx — folders only, hidden omitted, ".." to go up),
 * rendered as a clack select loop.
 *
 * Same doctrine split as ask-input.ts: option shaping and filename
 * normalization are pure and tested without a TTY; the loop takes an
 * injectable prompts/fs seam shaped like thumbnail-approve's ApprovePrompts.
 */

export const SAVE_DEFAULT = "__save_default__";
export const SAVE_HERE = "__save_here__";
export const SAVE_UP = "__save_up__";
export const SAVE_TYPE_PATH = "__save_type_path__";

/** ~20 folders on screen; past that the escape hatch is typing the path. */
export const FOLDER_CAP = 20;

/** One readdir row, reduced to what the shaping rules need. */
export interface DirEntry {
  name: string;
  isDir: boolean;
}

/**
 * Directory entries → the select rows. Pure so the rules — folders only,
 * hidden omitted, codepoint-sorted, capped at FOLDER_CAP with the type-a-path
 * row as the overflow escape — are pinned without a filesystem.
 *
 * Folder row values are ABSOLUTE paths, not names: a folder could be named
 * `__save_here__`, and a name-valued row would then collide with the
 * sentinel. An absolute path never starts with `__`, so the dunder idiom
 * (ask-input's BROWSE_FILE et al) stays collision-free.
 */
export function savePathOptions(
  entries: DirEntry[],
  opts: { dir: string; atRoot: boolean; defaultName?: string },
): { value: string; label: string; hint?: string }[] {
  const rows: { value: string; label: string; hint?: string }[] = [];
  // The fast path: today's speed was "press Enter, get no --out". This row is
  // that keystroke — offered only where produce's own default would land
  // (the caller gates it to the input's folder).
  if (opts.defaultName !== undefined) {
    rows.push({
      value: SAVE_DEFAULT,
      label: `use default: ${opts.defaultName}`,
      hint: "in this folder",
    });
  }
  rows.push({ value: SAVE_HERE, label: "✓ save here", hint: "pick the file name next" });
  if (!opts.atRoot) rows.push({ value: SAVE_UP, label: "↑ ..", hint: "up one folder" });

  const folders = entries
    .filter((e) => e.isDir && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const name of folders.slice(0, FOLDER_CAP)) {
    rows.push({ value: join(opts.dir, name), label: `${name}/` });
  }
  const hidden = folders.length - FOLDER_CAP;
  rows.push({
    value: SAVE_TYPE_PATH,
    label: "type a path instead",
    hint: hidden > 0 ? `${hidden} more folders not shown` : "if you already know it",
  });
  return rows;
}

/**
 * The typed file name, parsed not coerced: empty refused, a path separator
 * refused (this prompt names a file IN the folder the walk just chose — a
 * `sub/name` here would silently override that choice), and `.mp4` appended
 * only when there is NO dot-extension at all. A typo'd `.mp5` stays and is
 * the user's — "fixing" it is the exact coercion --source-fit's zod parse
 * exists to prevent.
 */
export function normalizeOutName(
  raw: string | undefined,
): { ok: true; name: string } | { ok: false; problem: string } {
  const name = (raw ?? "").trim();
  if (name === "") return { ok: false, problem: "a file name is required" };
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, problem: "just the file name — the folder was picked above" };
  }
  return { ok: true, name: /\.[^.]+$/.test(name) ? name : `${name}.mp4` };
}

/**
 * The seam, ApprovePrompts' shape (thumbnail-approve.ts): already unwrapped,
 * never a cancel symbol, so the loop is drivable by a scripted object.
 * `validate` rides through because the live re-ask-on-bad-input behavior is
 * clack's; a scripted fake asserts its answers pass the same predicate.
 */
export interface SavePathPrompts {
  select(opts: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
  }): Promise<string>;
  text(opts: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (v: string | undefined) => string | undefined;
  }): Promise<string>;
}

/** The live clack-backed prompts; tests inject a scripted replacement. */
export function clackSavePathPrompts(): SavePathPrompts {
  return {
    select: async (opts) => unwrap(await select(opts)) as string,
    text: async (opts) => unwrap(await text({ ...opts, defaultValue: "" })) as string,
  };
}

/** The fs seam beside the prompts seam, so the walk is testable dry. */
const liveListEntries = (dir: string): DirEntry[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
  } catch {
    // An unreadable folder (permissions, vanished between screens) lists as
    // empty rather than crashing the wizard — "↑ .." and "type a path
    // instead" remain on offer, which is every exit the user needs.
    return [];
  }
};

export interface PickSavePathArgs {
  /**
   * The input video's own folder: it is where creators keep a take's outputs,
   * and it is where produce's flag-less default lands anyway — so the walk
   * starts where the answer almost always is, and ~/Downloads is a few ".."
   * and descents away when it isn't.
   */
  startDir: string;
  /** `basename(defaultOutPath(input))` — the fast-path row's file name AND
   * the file-name prompt's prefill, so plain Enter twice matches a flag-less
   * run exactly. */
  defaultName: string;
  prompts?: SavePathPrompts;
  listEntries?: (dir: string) => DirEntry[];
}

/**
 * The walk. Returns the ABSOLUTE out path — or undefined for the use-default
 * row, so the caller emits no --out at all: the picked file would equal
 * produce's own default, and produceArgv's elision rule (a flag whose value
 * equals the default is NEVER emitted) must survive the picker.
 */
export async function pickSavePath(args: PickSavePathArgs): Promise<string | undefined> {
  const { prompts = clackSavePathPrompts(), listEntries = liveListEntries } = args;
  const startDir = resolve(expandHome(args.startDir));
  let dir = startDir;
  for (;;) {
    const options = savePathOptions(listEntries(dir), {
      dir,
      // `dirname` at the root returns the root itself, on every platform —
      // the same fixed point the editor's browser keys its ".." row off.
      atRoot: dirname(dir) === dir,
      // The default row exists wherever the default would actually land —
      // navigate away and it goes, come back and it returns.
      defaultName: dir === startDir ? args.defaultName : undefined,
    });
    const choice = await prompts.select({ message: `Save the video where? — ${dir}`, options });

    if (choice === SAVE_DEFAULT) return undefined;
    if (choice === SAVE_UP) {
      dir = dirname(dir);
      continue;
    }
    if (choice === SAVE_TYPE_PATH) {
      const typed = await prompts.text({
        message: "Output file path",
        placeholder: "~/Downloads/final.mp4",
        validate: (v) => (v?.trim() ? undefined : "a path is required"),
      });
      // expandHome BEFORE resolve (2026-08-16 incident, paths.ts): a typed
      // `~/Downloads/x.mp4` must become the home path, never `<cwd>/~/...`.
      // resolve() then makes the emitted argv absolute, matching ask-input's
      // expanded-argv behavior.
      return resolve(expandHome(typed.trim()));
    }
    if (choice === SAVE_HERE) {
      const name = await prompts.text({
        message: "File name",
        initialValue: args.defaultName,
        validate: (v) => {
          const r = normalizeOutName(v);
          return r.ok ? undefined : r.problem;
        },
      });
      const r = normalizeOutName(name);
      // The live prompt re-asks through `validate`, so not-ok here means a
      // scripted fake skipped its own predicate — re-asking is still what a
      // real user would see, so loop rather than crash.
      if (!r.ok) continue;
      return join(dir, r.name);
    }
    // A folder row: its value is already the absolute path — descend.
    dir = choice;
  }
}
