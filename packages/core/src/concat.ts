import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { probe, type IngestTools } from "./ingest";
import { run } from "./exec";

/**
 * `ossclip produce <folder>` (2026-08-05 field request, verbatim intent in
 * .superpowers/sdd/folder-input-brief.md): a folder of camera-clip takes gets
 * concatenated into ONE source before the normal produce pipeline ever sees
 * it, instead of the user hand-concatenating with an agent first.
 *
 * Split per CLAUDE.md's pure/IO mandate — the bug that motivates the split is
 * in the brief: a hand-built ffmpeg filtergraph corrupted by shell expansion
 * (zsh's `:a` history modifier) silently played clip 1's audio in every
 * concat slot, and nothing validated the filter STRING before it reached
 * ffmpeg. `planFolderConcat` and `buildConcatFilter` are pure so that string
 * can be asserted on directly; `concatFolder` below is the only I/O.
 */

const VIDEO_EXTENSIONS = ["mov", "mp4", "m4v", "mkv", "webm", "avi"] as const;
const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS);

export interface ConcatEntry {
  name: string;
  mtimeMs: number;
  size: number;
}

/**
 * Order clips for concatenation. `name` (default, per the field request "sort
 * them by name or date modified, name being default") is a PLAIN codepoint
 * sort — comparing strings with `<`/`>` rather than `localeCompare`, which is
 * what `ls` gives on a case-sensitive filesystem and a locale-aware sort would
 * NOT: it reorders case and punctuation differently per machine locale, which
 * would make the same folder concat in a different order on a different
 * machine. `mtime` ties (a batch copy that preserved one timestamp across
 * several files) fall back to name so the order stays reproducible either way.
 */
export function planFolderConcat(
  entries: readonly ConcatEntry[],
  sort: "name" | "mtime",
): string[] {
  const byName = (a: ConcatEntry, b: ConcatEntry): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const cmp = sort === "name" ? byName : (a: ConcatEntry, b: ConcatEntry) => a.mtimeMs - b.mtimeMs || byName(a, b);
  return [...entries].sort(cmp).map((e) => e.name);
}

/**
 * The `-filter_complex` string concatenating `n` inputs into one output.
 * Each input gets its OWN scale+pad+fps+setsar+format chain — letterboxed to
 * `target`, never cropped, since produce's own framing decides crops later —
 * and its own audio resample, before the `concat` filter joins them.
 *
 * Rotation: ffmpeg auto-rotates on decode by default (R27 §119, `probe()` in
 * ingest.ts relies on the same fact), so every `[i:v]` input here already
 * arrives in DISPLAYED orientation — the scale/pad math needs no separate
 * rotation step. Verified against a real rotated portrait `.mov` in the
 * folder-input-brief.md verification run rather than assumed.
 *
 * `n` labels of each kind, never more or fewer, and the tail's `[vI][aI]`
 * pairs are built in the SAME loop that emits them — this is the direct
 * regression test target for the field bug (see module comment): a
 * hand-built graph had a slot silently reference input 0's audio a second
 * time instead of its own index, and nothing caught the STRING being wrong.
 */
export function buildConcatFilter(n: number, target: { w: number; h: number }): string {
  const chains: string[] = [];
  const tail: string[] = [];
  for (let i = 0; i < n; i++) {
    chains.push(
      `[${i}:v]scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,` +
        `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
    );
    chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    tail.push(`[v${i}][a${i}]`);
  }
  return `${chains.join(";")};${tail.join("")}concat=n=${n}:v=1:a=1[outv][outa]`;
}

const ConcatManifestSchema = z.object({
  sort: z.enum(["name", "mtime"]),
  entries: z.array(
    z.object({
      name: z.string(),
      mtimeMs: z.number(),
      size: z.number(),
      durationSec: z.number(),
    }),
  ),
});
type ConcatManifest = z.infer<typeof ConcatManifestSchema>;

/**
 * The cached build is reusable only if EVERY current file is present in the
 * manifest with the same size and mtime (a changed byte count or timestamp
 * means the clip could have been re-exported), the counts match (a clip
 * removed leaves no trace otherwise), and the sort mode is the one the
 * manifest was built under (a `--sort` change reorders the clips, so a
 * same-files cache is still the WRONG concat).
 */
function manifestStillValid(manifest: ConcatManifest, sort: "name" | "mtime", current: readonly ConcatEntry[]): boolean {
  if (manifest.sort !== sort) return false;
  if (manifest.entries.length !== current.length) return false;
  const byName = new Map(manifest.entries.map((e) => [e.name, e]));
  return current.every((e) => {
    const prev = byName.get(e.name);
    return prev !== undefined && prev.mtimeMs === e.mtimeMs && prev.size === e.size;
  });
}

export interface FolderConcatResult {
  /** The intermediate file — hand this to the rest of produce. */
  path: string;
  /** In final concat order, for the "one line per clip" console report. */
  clips: Array<{ name: string; durationSec: number }>;
  /** Files skipped for not matching a video extension. */
  nonVideoCount: number;
  /** True when the existing `source-concat.mp4` was reused, not rebuilt. */
  cached: boolean;
  /** The concat's own total duration (ffprobe'd from the output). */
  durationSec: number;
}

/**
 * Enumerate, order, and concat every video file directly inside `folder`
 * (no recursion) into `<workDir>/source-concat.mp4`, caching on a manifest of
 * names+sizes+mtimes so an unchanged folder skips the re-encode.
 */
export async function concatFolder(
  tools: IngestTools,
  folder: string,
  workDir: string,
  sort: "name" | "mtime",
  target: { w: number; h: number },
): Promise<FolderConcatResult> {
  const dirents = await readdir(folder, { withFileTypes: true });
  let nonVideoCount = 0;
  const current: ConcatEntry[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue; // no recursion — subfolders are not enumerated
    const dot = d.name.lastIndexOf(".");
    const ext = dot >= 0 ? d.name.slice(dot + 1).toLowerCase() : "";
    if (!VIDEO_EXTENSION_SET.has(ext)) {
      nonVideoCount++;
      continue;
    }
    const st = await stat(join(folder, d.name));
    current.push({ name: d.name, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (current.length === 0) {
    throw new Error(
      `no video files found directly inside ${folder} ` +
        `(looked for: ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(", ")})`,
    );
  }
  const order = planFolderConcat(current, sort);

  const outPath = join(workDir, "source-concat.mp4");
  const manifestPath = join(workDir, "source-concat.json");
  if (existsSync(outPath) && existsSync(manifestPath)) {
    const parsed = ConcatManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (parsed.success && manifestStillValid(parsed.data, sort, current)) {
      const byName = new Map(parsed.data.entries.map((e) => [e.name, e]));
      const outProbe = await probe(tools, outPath);
      return {
        path: outPath,
        clips: order.map((name) => ({ name, durationSec: byName.get(name)!.durationSec })),
        nonVideoCount,
        cached: true,
        durationSec: outProbe.duration,
      };
    }
  }

  // A file with a video EXTENSION that fails to probe (no video stream) is an
  // error naming the file, not a silent skip (folder-input-brief.md) — so
  // `probe()`'s own "no video stream in <path>" is left to propagate rather
  // than caught here.
  const probes = await Promise.all(order.map((name) => probe(tools, join(folder, name))));

  const filter = buildConcatFilter(order.length, target);
  const inputArgs = order.flatMap((name) => ["-i", join(folder, name)]);
  // Encode to a sibling temp path, rename only on success — same reasoning as
  // `bakeNormalizedSource` in normalize.ts (R27 §125): ffmpeg writes the
  // container header as it goes, so a bake that dies mid-graph leaves a file
  // with no `moov` atom, and a cache keyed on EXISTENCE would reuse that
  // corpse forever. Rename is atomic on a POSIX filesystem.
  const partial = `${outPath}.partial.mp4`;
  try {
    await run(tools.ffmpegPath, [
      "-y",
      ...inputArgs,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      partial,
    ]);
    await rename(partial, outPath);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }

  const manifest: ConcatManifest = {
    sort,
    entries: current.map((e) => ({
      ...e,
      durationSec: probes[order.indexOf(e.name)]!.duration,
    })),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const outProbe = await probe(tools, outPath);
  return {
    path: outPath,
    clips: order.map((name, i) => ({ name, durationSec: probes[i]!.duration })),
    nonVideoCount,
    cached: false,
    durationSec: outProbe.duration,
  };
}
