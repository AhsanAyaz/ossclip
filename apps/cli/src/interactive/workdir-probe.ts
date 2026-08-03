import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Candidate, ProbeFailure, WorkdirProbe } from "./resolve-workdir";

/** The errno of a filesystem rejection, when it has one. */
const errnoOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Which of the three situations a failed read was. Catching them as one is
 * the founding bug of this branch in miniature: an unreadable directory got
 * reported as "no ossclip output — run produce", which tells a user to redo
 * work that is sitting right there.
 *
 * An unexpected class (ELOOP, ENOTDIR, …) is reported as unreadable rather
 * than swallowed, and carries its code so the message names it instead of
 * inventing a cause.
 */
const failureFor = (err: unknown): ProbeFailure => {
  const code = errnoOf(err);
  if (code === "ENOENT") return { reason: "missing", code };
  return { reason: "unreadable", code };
};

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
  } catch (err) {
    // Not thrown: the "none" rung's message is a better error than a raw
    // ENOENT — but it needs to know WHICH failure this was to say so.
    return { dir: abs, probe: { isWorkdir: false, candidates: [], ...failureFor(err) } };
  }

  const isWorkdir = existsSync(join(dir, "render-props.json"));

  const candidates: Candidate[] = [];
  const nest = join(dir, ".ossclip");
  let failure: ProbeFailure | undefined;
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
  } catch (err) {
    // ENOENT is the ordinary "no .ossclip here" — an empty candidate list,
    // not an error. A directory that exists and cannot be read is NOT that,
    // and must not be described as if it were.
    if (errnoOf(err) !== "ENOENT") failure = failureFor(err);
  }

  return { dir, probe: { isWorkdir, candidates, ...failure } };
}
