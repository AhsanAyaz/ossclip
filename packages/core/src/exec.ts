import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Minimal spawn wrapper: collects stdout/stderr, optionally feeds stdin,
 * throws with the stderr tail attached unless allowNonZero.
 */
export function run(
  bin: string,
  args: string[],
  opts: {
    allowNonZero?: boolean;
    stdin?: string;
    /** Per-chunk stdout tap, IN ADDITION to collection — the delivery
     * encode's `-progress pipe:1` stream needs live chunks, not the
     * post-mortem transcript. */
    onStdout?: (chunk: string) => void;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      const text = c.toString();
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => reject(new Error(`${bin} failed to start: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !opts.allowNonZero) {
        // Falls back to stdout when stderr is empty: CLIs that report in a
        // JSON envelope (`claude -p --output-format json` signed out, 2026-11-04)
        // exit 1 with the only reason on STDOUT, and the stderr-only message
        // read "failed (exit 1):" followed by nothing.
        const detail = stderr.trim() ? stderr : stdout;
        reject(new Error(`${bin} ${args.join(" ")} failed (exit ${code}):\n${detail.slice(-2000)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
