import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Candidate, WorkdirProbe } from "./resolve-workdir";

/**
 * The only filesystem in the workdir ladder. Kept deliberately thin so
 * `resolveWorkdir` stays pure and every rung of the decision is tested
 * without a temp directory.
 */
export async function probeWorkdir(target: string): Promise<{ dir: string; probe: WorkdirProbe }> {
  const abs = resolve(target);

  // Pointing at the video rather than its folder is a reasonable guess, and
  // the runs live beside it — so a file target resolves to its parent.
  let dir = abs;
  try {
    if ((await stat(abs)).isFile()) dir = dirname(abs);
  } catch {
    // Missing path: fall through with an empty probe rather than throwing.
    // The "none" rung's message is a better error than ENOENT.
    return { dir: abs, probe: { isWorkdir: false, candidates: [] } };
  }

  const isWorkdir = existsSync(join(dir, "render-props.json"));

  const candidates: Candidate[] = [];
  const nest = join(dir, ".ossclip");
  try {
    for (const entry of await readdir(nest, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(nest, entry.name);
      // A workdir is exactly "a directory a produce run wrote its props
      // into" — the same definition edit.ts uses. A run killed mid-flight
      // leaves a directory with no props, and offering it would 404 the page.
      if (!existsSync(join(path, "render-props.json"))) continue;
      candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  } catch {
    // No .ossclip here — an empty candidate list, not an error.
  }

  return { dir, probe: { isWorkdir, candidates } };
}
