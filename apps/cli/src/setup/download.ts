import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Download with resume + integrity check — the model is a 466 MB file and
 * "my wifi dropped at 91%" must not mean starting over.
 *
 * Writes `<dest>.part`, resumes with a Range header when a partial exists
 * (GitHub and Hugging Face both honor ranges; a server that answers 200
 * instead of 206 restarts cleanly), verifies the hash of the COMPLETE file
 * before renaming into place — a `.part` never becomes a `dest` unverified.
 */

/**
 * A pinned asset is gone from the host — distinguished from every other HTTP
 * failure because it is OURS, not the user's: the manifest names an exact
 * upstream release, and hosts rotate releases out from under a pin (BtbN
 * prunes daily autobuilds after ~2 weeks — #6, §145). A stale pin reported as
 * a bare "download failed: HTTP 404" reads as a broken network and leaves the
 * user nowhere; the caller catches this type and adds the manual install for
 * their platform, which turns a dead end into a two-minute detour.
 *
 * Deliberately generic: this module downloads models and whisper builds too,
 * so it names the problem and lets the caller name the remedy.
 */
export class PinnedAssetGoneError extends Error {
  constructor(readonly url: string) {
    super(
      `the pinned download is gone upstream (HTTP 404)\n  ${url}\n` +
        "  This is a stale pin in ossclip's manifest, not a problem on your machine.",
    );
    this.name = "PinnedAssetGoneError";
  }
}

export interface DownloadOptions {
  /** hex digest; algorithm chosen by which field is set */
  sha256?: string;
  sha1?: string;
  onProgress?: (doneBytes: number, totalBytes: number | null) => void;
  /** injected in tests */
  fetchImpl?: typeof fetch;
}

export async function download(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });

  let offset = 0;
  try {
    offset = statSync(part).size;
  } catch {
    // no partial — fresh download
  }

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const res = await fetchImpl(url, { headers, redirect: "follow" });
  if (res.status === 200) {
    offset = 0; // server ignored the range — start over
  } else if (res.status === 404) {
    throw new PinnedAssetGoneError(url);
  } else if (res.status !== 206) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  if (!res.body) throw new Error(`download failed: empty body for ${url}`);

  const lengthHeader = res.headers.get("content-length");
  const total = lengthHeader ? offset + Number.parseInt(lengthHeader, 10) : null;

  const out = createWriteStream(part, offset > 0 ? { flags: "a" } : {});
  let done = offset;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      if (value) {
        done += value.length;
        if (!out.write(value)) {
          await new Promise<void>((r) => out.once("drain", () => r()));
        }
        opts.onProgress?.(done, total);
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }

  const algo = opts.sha256 ? "sha256" : opts.sha1 ? "sha1" : null;
  const expected = opts.sha256 ?? opts.sha1;
  if (algo && expected) {
    const actual = await hashFile(part, algo);
    if (actual !== expected.toLowerCase()) {
      // A corrupt partial would resume corrupt forever — a mismatch removes it.
      const { rmSync } = await import("node:fs");
      rmSync(part, { force: true });
      throw new Error(
        `checksum mismatch for ${url}\n  expected ${algo} ${expected}\n  got      ${actual}\n` +
          "The partial download was removed — re-run to try again.",
      );
    }
  }
  renameSync(part, dest);
}

export function hashFile(path: string, algo: "sha256" | "sha1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Single rewritten stderr line: `▸ ggml-small.en.bin  312/466 MB  67%`.
 * Piped output (CI logs) gets a plain line every 10% instead — `\r` doesn't
 * rewrite in a captured log, it accumulates.
 */
export function progressLine(label: string): (done: number, total: number | null) => void {
  const tty = process.stderr.isTTY === true;
  const stepPct = tty ? 1 : 10;
  let lastPct = -1;
  let lastMB = -1;
  return (done, total) => {
    const doneMB = Math.round(done / 1e6);
    if (total === null) {
      if (doneMB !== lastMB && doneMB % 25 === 0) {
        lastMB = doneMB;
        process.stderr.write(`${tty ? "\r" : ""}▸ ${label}  ${doneMB} MB${tty ? "" : "\n"}`);
      }
      return;
    }
    const pct = Math.floor((done / total) * 100);
    if (pct === lastPct || pct % stepPct !== 0) return;
    lastPct = pct;
    const totalMB = Math.round(total / 1e6);
    const line = `▸ ${label}  ${doneMB}/${totalMB} MB  ${pct}%`;
    process.stderr.write(tty ? `\r${line}${pct === 100 ? "\n" : ""}` : `${line}\n`);
  };
}
