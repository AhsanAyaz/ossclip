import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backfillUsageLog, loadConfig, providerFromArgv } from "@ossclip/core";

/**
 * Recover the provenance of workdirs produced before R16 §78 (R16 §79).
 *
 * Their `usage.json` says `records: []` because a fully-cached re-run
 * overwrote the accounting of the run that actually planned the video, so the
 * only surviving evidence is `command.json`'s `--llm` flag. Newer workdirs
 * keep an append-only history and need none of this — which is why a log that
 * already has one is skipped rather than rewritten.
 */

export interface BackfillResult {
  workdir: string;
  status: "backfilled" | "skipped";
  provider?: string;
  reason?: string;
}

/** A workdir is a directory holding a production; a root holds workdirs. */
async function workdirsUnder(path: string): Promise<string[]> {
  if (existsSync(join(path, "production.json")) || existsSync(join(path, "usage.json"))) {
    return [path];
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = join(path, e.name);
    if (existsSync(join(child, "production.json")) || existsSync(join(child, "usage.json"))) {
      found.push(child);
    }
  }
  return found;
}

/** When the planning happened: the beat-sheet cache's mtime, else the argv's. */
async function plannedAt(work: string): Promise<string> {
  const names = await readdir(work).catch(() => []);
  const beat = names.find((f) => f.startsWith("beatsheet-"));
  const target = beat ? join(work, beat) : join(work, "command.json");
  const s = await stat(target).catch(() => null);
  return new Date(s?.mtimeMs ?? Date.now()).toISOString();
}

export async function backfillWorkdir(
  work: string,
  opts: { dryRun?: boolean; backup?: boolean } = {},
): Promise<BackfillResult> {
  const cmdPath = join(work, "command.json");
  if (!existsSync(cmdPath)) {
    return { workdir: work, status: "skipped", reason: "no command.json to recover from" };
  }
  const argv = JSON.parse(await readFile(cmdPath, "utf8")).args ?? [];
  const provider = providerFromArgv(argv);
  if (!provider) {
    return { workdir: work, status: "skipped", reason: "the recorded argv names no --llm" };
  }

  const usagePath = join(work, "usage.json");
  const previous = existsSync(usagePath)
    ? JSON.parse(await readFile(usagePath, "utf8").catch(() => "{}"))
    : {};
  const log = backfillUsageLog(previous, { provider, at: await plannedAt(work) }, loadConfig().pricing);
  if (!log) {
    // A real record always beats a reconstructed one.
    return { workdir: work, status: "skipped", reason: "already has a run history", provider };
  }
  if (opts.dryRun) return { workdir: work, status: "backfilled", provider };

  if (opts.backup !== false && existsSync(usagePath)) {
    await copyFile(usagePath, `${usagePath}.pre-backfill`);
  }
  await writeFile(usagePath, JSON.stringify(log, null, 2));

  const prodPath = join(work, "production.json");
  if (existsSync(prodPath)) {
    const production = JSON.parse(await readFile(prodPath, "utf8"));
    // Never overwrite a stamp a real run wrote.
    if (!production.producer) {
      if (opts.backup !== false) await copyFile(prodPath, `${prodPath}.pre-backfill`);
      const entry = log.runs[0]!;
      production.producer = {
        provider: entry.provider,
        models: entry.models,
        cached: entry.cached,
        at: entry.at,
      };
      await writeFile(prodPath, JSON.stringify(production, null, 2));
    }
  }
  return { workdir: work, status: "backfilled", provider };
}

export async function backfill(
  paths: string[],
  opts: { dryRun?: boolean; backup?: boolean } = {},
): Promise<BackfillResult[]> {
  const results: BackfillResult[] = [];
  for (const path of paths) {
    const root = resolve(path);
    if (!existsSync(root)) {
      results.push({ workdir: root, status: "skipped", reason: "not found" });
      continue;
    }
    for (const work of await workdirsUnder(root)) {
      results.push(await backfillWorkdir(work, opts));
    }
  }
  return results;
}

export function formatBackfill(results: readonly BackfillResult[]): string {
  const lines = results.map((r) => {
    const name = basename(r.workdir);
    return r.status === "backfilled"
      ? `  ✓ ${r.provider} — ${name}`
      : `  · skipped (${r.reason}) — ${name}`;
  });
  const done = results.filter((r) => r.status === "backfilled").length;
  return `${lines.join("\n")}\n${done} of ${results.length} workdir(s) backfilled`;
}
