import { renderCommand } from "./render";

/**
 * The closing signpost of a produce run.
 *
 * `▸ workdir <path>` is printed at the START of a run, which after six
 * minutes of transcription and rendering is thousands of lines up the
 * scrollback. The reported user had the written guide open and still could
 * not find the directory, because the last thing on screen named neither it
 * nor the command that opens it.
 */
export function editHint(workdir: string, platform: NodeJS.Platform = process.platform): string {
  // The platform is a parameter, defaulted to the host, for the same reason
  // resolveWorkdir takes `sep`: the Windows rendering has to be assertable
  // from a macOS dev machine and an ubuntu CI leg. It was previously PINNED
  // to "linux", which handed a Windows user under `D:\My Videos\` POSIX
  // single quotes that cmd.exe passes through literally — the branch's
  // headline artifact, broken on the platform the bug report came from.
  return `▸ edit it:  ${renderCommand(["edit", workdir], platform)}`;
}
