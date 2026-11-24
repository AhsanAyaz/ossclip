/**
 * The storyboard's files in the workdir (storyboard design §9, plan Task 3;
 * §168): `storyboard.json`, the plan table the author edits, and
 * `storyboardplan-<key>.json`, the planner's raw reply cached under the
 * inputs that produced it. The record's rules are core's and pure
 * (storyboard/record.ts); this is the I/O around them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { StoryboardPlanReplySchema, StoryboardSchema, type PlannedShot, type Storyboard } from "@ossclip/core";

export const STORYBOARD_FILE = "storyboard.json";

/**
 * A `storyboard.json` that exists but cannot be used. Its own class so a
 * caller (the editor's endpoints, Task 4) can tell "the author's file is
 * broken" from any other failure, and so a test can assert the run stopped
 * for this reason and no other.
 */
export class StoryboardFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardFileError";
  }
}

/**
 * The stored table, or null when the workdir has none.
 *
 * A file that is not JSON or fails the schema throws, naming the file and the
 * first problem (plan Review Focus 4), and is never rewritten or deleted: it
 * holds the author's edits, possibly hand-made, and treating it as missing
 * would let the next run plan over them (G10). The author fixes it, or deletes
 * it to plan again from nothing.
 */
export function loadStoryboard(workdir: string): Storyboard | null {
  const path = join(workdir, STORYBOARD_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new StoryboardFileError(`${path}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = StoryboardSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new StoryboardFileError(`${path}: ${at}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * Writes the table through a temp file and a rename, so a run killed
 * mid-write leaves the previous table, never half of one. Parsed before it is
 * written: a table `loadStoryboard` would refuse must not reach disk, where
 * the next run would stop on it.
 */
export function saveStoryboard(workdir: string, sb: Storyboard): void {
  const record = StoryboardSchema.parse(sb);
  const path = join(workdir, STORYBOARD_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Refuses an `--assets` path that is not a folder. Called by produce beside
 * the flag conflicts, before the hash and the transcription, and so before
 * the repair pass's LLM call: a typo found after minutes of whisper is the
 * cost the early checks exist to avoid (the `--script` checks' reason).
 */
export function assertAssetsDir(abs: string): void {
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`--assets ${abs} is not a folder: give the folder that holds the images a shot may use`);
  }
}

/**
 * The storyboard plan cache key (`storyboardplan-<key>.json`). Its own key
 * and file, never the beat sheet's or the script plan's, so no run without
 * `--storyboard` reads or writes it (plan Global Constraints). Every part
 * changes what the planner is asked (§78: a change that changes the answer
 * must change the key): the kept words with their indices (`keptWordsKey`,
 * the cut the plan is made on, design §2 "Which cut"), the intent, the
 * assets the prompt lists, and the frame. `providerName` keeps the
 * §143/§150 read/write split working (`storyboardPlanCacheKeyCandidates`).
 */
export function storyboardPlanCacheKey(parts: {
  promptVersion: string;
  keptWords: string;
  intent?: string;
  /** The assets as the prompt lists them, serialised by the caller. */
  assets: string;
  /** `<width>x<height>`. */
  frame: string;
  providerName: string;
  llmModel?: string;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        parts.promptVersion,
        parts.keptWords,
        parts.intent ?? null,
        parts.assets,
        parts.frame,
        parts.providerName,
        parts.llmModel ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}

/** The keys to try on read, primary then fallback provider — `scriptPlanCacheKeyCandidates` (§150). */
export function storyboardPlanCacheKeyCandidates(
  parts: Omit<Parameters<typeof storyboardPlanCacheKey>[0], "providerName">,
  providerName: string,
  fallbackName: string | undefined,
): string[] {
  const keys = [storyboardPlanCacheKey({ ...parts, providerName })];
  if (fallbackName && fallbackName !== providerName) {
    keys.push(storyboardPlanCacheKey({ ...parts, providerName: fallbackName }));
  }
  return keys;
}

export const storyboardPlanCachePath = (workdir: string, key: string): string =>
  join(workdir, `storyboardplan-${key}.json`);

/**
 * What the plan cache stores: the planner's shots as it replied, BEFORE the
 * limits (plan Task 3 Step 3), so a limit that changes is applied to the
 * same reply rather than to an answer already cut down by the old one. The
 * reply's own schema, so a cache can hold nothing a reply could not.
 */
const StoryboardPlanCacheSchema = z.object({ shots: StoryboardPlanReplySchema.shape.shots });

/**
 * The cached shots under `key`, or null. Parsed, never trusted, like the
 * script plan's cache: a missing or malformed file means a fresh plan, never
 * a crash.
 */
export function readStoryboardPlanCache(workdir: string, key: string): PlannedShot[] | null {
  const path = storyboardPlanCachePath(workdir, key);
  if (!existsSync(path)) return null;
  try {
    const parsed = StoryboardPlanCacheSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return null;
    // The schema bounds priority to 1-3; the cast only narrows the type.
    return parsed.data.shots.map((s) => ({ ...s, priority: s.priority as 1 | 2 | 3 }));
  } catch {
    return null;
  }
}

export function writeStoryboardPlanCache(workdir: string, key: string, shots: readonly PlannedShot[]): void {
  writeFileSync(storyboardPlanCachePath(workdir, key), `${JSON.stringify({ shots }, null, 2)}\n`);
}
