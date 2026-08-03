import { quoteArg } from "./render";

/**
 * The closing signpost of a produce run.
 *
 * `▸ workdir <path>` is printed at the START of a run, which after six
 * minutes of transcription and rendering is thousands of lines up the
 * scrollback. The reported user had the written guide open and still could
 * not find the directory, because the last thing on screen named neither it
 * nor the command that opens it.
 */
export function editHint(workdir: string): string {
  // Platform pinned rather than defaulted: this string is asserted in a test
  // that runs on the Windows CI leg too.
  return `▸ edit it:  ossclip edit ${quoteArg(workdir, "linux")}`;
}
