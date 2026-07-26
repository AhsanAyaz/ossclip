import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Minimal promisified execFile with a generous buffer; throws with stderr attached. */
export function run(bin: string, args: string[], opts: { allowNonZero?: boolean } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !opts.allowNonZero) {
        reject(new Error(`${bin} ${args.join(" ")} failed: ${err.message}\n${stderr.slice(-2000)}`));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}
