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
