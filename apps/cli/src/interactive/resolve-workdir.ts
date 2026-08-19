import { sep as hostSep } from "node:path";
import { renderCommand } from "./render";

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

/**
 * Why the probe came back empty, when it was not simply "nothing produced
 * here yet". `missing` is ENOENT, `unreadable` is EACCES/EPERM — or any
 * other errno, which is reported with its `code` rather than silently
 * becoming "no output".
 */
export interface ProbeFailure {
  reason: "missing" | "unreadable";
  code?: string;
}

export interface WorkdirProbe {
  /** Does `dir` itself hold a render-props.json? */
  isWorkdir: boolean;
  /** Directories under `dir/.ossclip/` that hold a render-props.json. */
  candidates: Candidate[];
  /**
   * Absent when the path was read fine. The probe carries the fact; the
   * words are this module's job — the alternative was a second channel of
   * error state that only the caller could see.
   */
  reason?: ProbeFailure["reason"];
  code?: string;
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

  // Before the layout explanation, because "no ossclip output under X — run
  // produce" is a lie in both of these cases, and it is the exact lie this
  // branch exists to kill. A typo'd path was told to produce into
  // `<the typo>/your-video.mp4`, a path that can never exist; an unreadable
  // one was told to redo a run that is sitting right there.
  if (probe.reason === "missing") {
    return {
      kind: "none",
      message:
        `no such path: ${dir}\n\n` +
        `  Nothing of yours is there to edit — check the spelling.\n\n` +
        `  Or pick from recent runs:   ossclip edit`,
    };
  }
  if (probe.reason === "unreadable") {
    return {
      kind: "none",
      message:
        `can't read ${dir}${probe.code === undefined ? "" : ` (${probe.code})`}\n\n` +
        `  The path is there, but this user can't read it —\n` +
        `  check its permissions and try again.`,
    };
  }

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

/**
 * The several-candidates message for a session with no TTY, where the
 * interactive picker cannot run. Each line is rendered through
 * renderCommand so a path containing a space pastes into a shell as ONE
 * argument — an unquoted list defeats the only thing this branch is for.
 *
 * `command` is the subcommand the user actually ran: this ladder is shared
 * with `ossclip cover`, and printing `ossclip edit <path>` to someone who
 * typed `cover` sends them to a different command than the one they wanted.
 * Defaults to "edit", the only caller when this was written.
 */
export function candidateListMessage(
  dir: string,
  candidates: Candidate[],
  command: string = "edit",
): string {
  return (
    `several produce runs under ${dir} — name one:\n` +
    candidates.map((c) => `  ${renderCommand([command, c.path])}`).join("\n")
  );
}
