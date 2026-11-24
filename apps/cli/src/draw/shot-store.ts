/**
 * A drawn shot's files (storyboard design §9, plan Task 6; §167):
 *
 *   <workdir>/storyboard/<shot-id>/
 *     v1.tsx  v2.tsx  …       the code, one file per version
 *     v1/still-1.png …        the stills of a version
 *     v1/preview.webm         the small preview, when asked for
 *     history.json            the `ShotHistory` (core draw/shot-record.ts)
 *
 * The record's rules are core's and pure; this is the I/O around them. Every
 * path below is built from an id or a name that has passed its schema first
 * (`ShotIdSchema`, `AssetNameSchema`; Review Focus 4): both come from the
 * author or from a folder listing, and a `../x` must be a parse error, not a
 * directory outside the workdir.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  AssetNameSchema,
  ShotHistorySchema,
  ShotIdSchema,
  discardUnfinished,
  loadConfig,
  run,
  type ShotHistory,
} from "@ossclip/core";

export const SHOT_HISTORY_BASENAME = "history.json";
/** The optional notes file in an `--assets` folder: one `<name>: <text>` line per file (design §4). */
export const ASSET_NOTES_BASENAME = "assets.md";
/** Where assets go inside a render's public dir; the kit's `Asset` hands `<this>/<name>` to Remotion's `staticFile`. */
export const STAGED_ASSETS_DIRNAME = "storyboard-assets";

/** The id, parsed, or an error that names it. Every path here starts with this. */
function shotId(id: string): string {
  const parsed = ShotIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(
      `shot id ${JSON.stringify(id)} is not allowed: lower-case letters, digits and dashes, ` +
        "starting with a letter or digit, at most 40 characters",
    );
  }
  return parsed.data;
}

/** `<workdir>/storyboard/<id>`. Throws for an id that fails `ShotIdSchema`. */
export function shotDir(workdir: string, id: string): string {
  return join(workdir, "storyboard", shotId(id));
}

/**
 * The files of version `n`. The code is `v<n>.tsx` because the type check
 * and the bundle both read a scene as TSX by its extension (draw/typecheck.ts).
 */
export function versionPaths(workdir: string, id: string, n: number): { code: string; stillsDir: string; preview: string } {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`version number must be a positive whole number, got ${n}`);
  const dir = shotDir(workdir, id);
  const stillsDir = join(dir, `v${n}`);
  return { code: join(dir, `v${n}.tsx`), stillsDir, preview: join(stillsDir, "preview.webm") };
}

/**
 * The clip of the shot's approved version (design §8, §9): one per shot,
 * because only the approved version keeps a ProRes clip (design §9, "Disk").
 * Approve renders beside it under another name and renames over it only once
 * the new clip is imported (storyboard/approve.ts, §169), so a failed render
 * never takes the clip already in the video with it.
 */
export function approvedClipPath(workdir: string, id: string): string {
  return join(shotDir(workdir, id), "approved.mov");
}

/**
 * The shot's record, or null when the shot has never been drawn.
 *
 * Applies `discardUnfinished` (an interrupted draw leaves a version with no
 * result, design §9) and deletes what the discarded versions left on disk,
 * then writes the cleaned record back, so the next run never sees them and
 * their numbers stay used (`nextVersion` is kept; Review Focus 5).
 *
 * A record that does not parse is an error, not a fresh shot: treating it as
 * missing would let the next `--idea` overwrite the author's versions.
 */
export function loadShot(workdir: string, id: string): ShotHistory | null {
  const stored = readShotRecord(workdir, id);
  if (stored === null) return null;
  const kept = discardUnfinished(stored);
  const keptNumbers = new Set(kept.versions.map((v) => v.n));
  const dropped = stored.versions.filter((v) => !keptNumbers.has(v.n));
  for (const v of dropped) {
    const files = versionPaths(workdir, id, v.n);
    rmSync(files.code, { force: true });
    rmSync(files.stillsDir, { recursive: true, force: true });
  }
  if (dropped.length > 0 || kept.draft !== stored.draft) saveShot(workdir, kept);
  return kept;
}

/**
 * The record as `loadShot` would return it, read without touching the disk:
 * `discardUnfinished` is applied in memory only, so no version file is
 * deleted and nothing is written. For readers that only look (the editor's
 * `GET /api/storyboard`, the protection test of "Plan again"; §168): a draw
 * may be running in another process, and its version without a result is
 * work in progress, not debris, until that run ends or dies. The cleanup
 * stays with the next `loadShot`, which a draw makes before it writes.
 */
export function peekShot(workdir: string, id: string): ShotHistory | null {
  const stored = readShotRecord(workdir, id);
  return stored === null ? null : discardUnfinished(stored);
}

/** `history.json` parsed and checked against its folder, as stored; null when absent. */
function readShotRecord(workdir: string, id: string): ShotHistory | null {
  const path = join(shotDir(workdir, id), SHOT_HISTORY_BASENAME);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ShotHistorySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a valid shot record: ${parsed.error.message}`);
  if (parsed.data.id !== id) {
    throw new Error(`${path} is the record of shot ${JSON.stringify(parsed.data.id)}, not ${JSON.stringify(id)}`);
  }
  return parsed.data;
}

/**
 * Writes the record through a temp file and a rename, so a run killed
 * mid-write leaves the previous record, never half of one. Parsed before it
 * is written: a record this command cannot read back must not reach disk.
 */
export function saveShot(workdir: string, h: ShotHistory): void {
  const record = ShotHistorySchema.parse(h);
  const dir = shotDir(workdir, record.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SHOT_HISTORY_BASENAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---- Assets ----------------------------------------------------------------

export interface StagedAsset {
  name: string;
  width: number;
  height: number;
  note?: string;
  /** The path the kit's `Asset` passes to `staticFile`, relative to the render's public dir. */
  staticPath: string;
}

/**
 * `assets.md`'s lines as name → text (pure). A line is `<name>: <text>`,
 * optionally as a Markdown list item (`- logo.png: the logo`), because a
 * `.md` file invites one and a note silently ignored for its bullet is a
 * note the LLM never sees. Anything else (headings, prose, a name that is
 * not an allowed asset name) is not a note. The first line for a name wins.
 */
export function parseAssetNotes(text: string): Map<string, string> {
  const notes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?([^:\s][^:]*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const note = m[2]!;
    if (!AssetNameSchema.safeParse(name).success || note === "" || notes.has(name)) continue;
    notes.set(name, note);
  }
  return notes;
}

/** ffprobe's JSON for an image, only the fields read here. Parsed, never cast. */
const ImageProbeSchema = z.object({
  streams: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive() })).min(1),
});

/** An image's pixel size, from its ffprobe JSON (pure); throws when ffprobe saw none. */
export function parseImageProbe(stdout: string, path: string): { width: number; height: number } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`could not read the image size of ${path}`);
  }
  const parsed = ImageProbeSchema.safeParse(json);
  if (!parsed.success) throw new Error(`could not read the image size of ${path}`);
  const { width, height } = parsed.data.streams[0]!;
  return { width, height };
}

/** An image's pixel size through ffprobe, the binary `ossclip setup` and `OSSCLIP_FFPROBE` configure. */
export async function ffprobeImageSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(loadConfig().ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    path,
  ]);
  return parseImageProbe(stdout, path);
}

/** One image of an `--assets` folder as listed, before anything is copied. */
export interface ListedAsset {
  name: string;
  width: number;
  height: number;
  note?: string;
  /** The file's absolute path in the assets folder. */
  src: string;
}

/**
 * Describes each file of the author's `--assets` folder (design §4): name,
 * pixel size and the `assets.md` line, if any. Reads only; nothing is copied.
 * Split from `stageAssets` because a storyboard plan (§168) needs the list
 * for its prompt and its cache key long before any render's public dir
 * exists, and copying the author's files at plan time would put them in a
 * folder no render reads.
 *
 * A file whose name fails `AssetNameSchema`, or whose size ffprobe cannot
 * read, is skipped with a warning rather than failing the run: assets are
 * extra material (the AI draws what it has no asset for), and the warning
 * says which file the shot is drawn without. Sub-folders are not read.
 *
 * Async, unlike the rest of this file, because the sizes come from ffprobe.
 * `probeSize` is injected so the tests need no ffprobe.
 */
export async function listAssets(
  assetsDir: string,
  probeSize: (path: string) => Promise<{ width: number; height: number }> = ffprobeImageSize,
): Promise<{ assets: ListedAsset[]; warnings: string[] }> {
  const dir = resolve(assetsDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`assets folder not found: ${dir}`);
  const notesPath = join(dir, ASSET_NOTES_BASENAME);
  const notes = existsSync(notesPath) ? parseAssetNotes(readFileSync(notesPath, "utf8")) : new Map<string, string>();

  const assets: ListedAsset[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name === ASSET_NOTES_BASENAME) continue;
    const parsed = AssetNameSchema.safeParse(entry.name);
    if (!parsed.success) {
      warnings.push(
        `skipped asset ${JSON.stringify(entry.name)}: an asset is a .png, .jpg, .jpeg, .svg or .webp file ` +
          "whose name is letters, digits, dots, dashes and underscores",
      );
      continue;
    }
    const name = parsed.data;
    const src = join(dir, name);
    let size: { width: number; height: number };
    try {
      size = await probeSize(src);
    } catch (err) {
      warnings.push(`skipped asset ${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    const note = notes.get(name);
    assets.push({ name, width: size.width, height: size.height, ...(note !== undefined ? { note } : {}), src });
  }
  const listed = new Set(assets.map((a) => a.name));
  for (const name of notes.keys()) {
    if (!listed.has(name)) warnings.push(`${ASSET_NOTES_BASENAME} describes ${name}, which is not a usable asset in the folder`);
  }
  return { assets, warnings };
}

/**
 * Copies the author's `--assets` folder into a render's public dir and
 * describes each file for the draw call: `listAssets`, then a copy of each
 * file it kept, so what is described and what is staged are one list.
 */
export async function stageAssets(
  assetsDir: string,
  publicDir: string,
  probeSize: (path: string) => Promise<{ width: number; height: number }> = ffprobeImageSize,
): Promise<{ assets: StagedAsset[]; warnings: string[] }> {
  const listed = await listAssets(assetsDir, probeSize);
  const outDir = join(publicDir, STAGED_ASSETS_DIRNAME);
  const assets: StagedAsset[] = [];
  for (const { src, ...a } of listed.assets) {
    mkdirSync(outDir, { recursive: true });
    copyFileSync(src, join(outDir, a.name));
    assets.push({ ...a, staticPath: `${STAGED_ASSETS_DIRNAME}/${a.name}` });
  }
  return { assets, warnings: listed.warnings };
}
