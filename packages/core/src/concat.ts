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
 * ffmpeg. `planFolderConcat`, `buildConcatFilter`, `folderManifestKey` and
 * `assertAllClipsHaveAudio` are pure so each can be asserted on directly;
 * `listFolderVideos` and `concatFolder` are the only I/O.
 */

/**
 * The extensions a folder input may contain. Exported (§136) because the
 * CLI's native file picker builds its dialog filters from this list: a
 * picker that offers a file `concat` will later refuse is a trap, and the
 * two lists silently diverging is exactly how that ships.
 */
export const VIDEO_EXTENSIONS = ["mov", "mp4", "m4v", "mkv", "webm", "avi"] as const;
const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS);

function noVideoFilesError(folder: string): Error {
  return new Error(
    `no video files found directly inside ${folder} ` +
      `(looked for: ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(", ")})`,
  );
}

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
 * A deterministic, order-independent identity for a folder's clip set —
 * sorted by name (a canonical order regardless of `readdir`'s OS-dependent
 * enumeration order) before joining, so the same files always hash the same
 * way. `sort` is folded in because a `--sort` flip changes the concat's
 * actual bytes (different clip order), not just how it was chosen.
 *
 * Fix for a review finding on the first cut of this feature: the workdir
 * hash used to be derived from the FOLDER PATH alone, which is stable across
 * content changes — but `audio.wav`, `transcript.json`, the content-rect
 * cache and the mezzanine are all existence-keyed inside that same workdir.
 * Adding a take (or flipping --sort) rebuilt `source-concat.mp4` correctly
 * but silently reused every one of those, producing a video with captions
 * transcribed against the PREVIOUS concat. Hashing the manifest content here
 * — the same invariant a file input already has via `sha1File` — means a
 * changed folder gets a fresh workdir, and every derived cache is fresh too.
 *
 * Serialized with JSON.stringify, not a `:`/`|` delimiter join (audit fix):
 * a filename is user-controlled free text that can itself contain the
 * delimiters, letting two DIFFERENT entry sets serialize to one identical
 * key — `a:1` sized 2 and `a` sized `1:2` collide under a `:` join, and a
 * collision here means one folder silently reuses another's transcript and
 * mezzanine. JSON escapes the filename instead of trusting it. This changed
 * every existing folder workdir hash once — a one-time cache invalidation
 * (fresh workdir, full re-concat/re-transcribe on the next run), accepted as
 * the cost of an injection-proof key.
 */
export function folderManifestKey(entries: readonly ConcatEntry[], sort: "name" | "mtime"): string {
  const canonical = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => ({ name: e.name, size: e.size, mtimeMs: e.mtimeMs }));
  return JSON.stringify({ sort, entries: canonical });
}

/**
 * The `-filter_complex` string concatenating `n` inputs into one output.
 * Each input gets its OWN scale+pad+fps+setsar+format chain — letterboxed to
 * `target`, never cropped, since produce's own framing decides crops later —
 * and its own audio resample, before the `concat` filter joins them.
 *
 * Rotation: ffmpeg auto-rotates on decode by default (R27 §119, `probe()` in
 * ingest.ts relies on the same fact), so every `[i:v]` input here is ASSUMED
 * to already arrive in DISPLAYED orientation — the scale/pad math needs no
 * separate rotation step. This is an assumption carried over from R27 §119,
 * not something the folder-input verification run could independently
 * confirm: a letterboxed, correctly-proportioned 1080x1920 output is also
 * what a WRONG rotation assumption would produce once padded to a portrait
 * canvas, so that run couldn't distinguish "handled correctly" from
 * "accidentally looks fine." Flagged rather than overclaimed per CLAUDE.md.
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

/**
 * `buildConcatFilter` emits `[i:a]` unconditionally for every input — it has
 * no way to know a clip is silent. Handed a video-only clip (b-roll with no
 * audio stream), ffmpeg dies deep inside the filtergraph with a bare stream-
 * specifier error that names neither the clip nor the reason. `probe()`
 * already reports `hasAudio`; failing BEFORE ffmpeg ever runs keeps faith
 * with the brief's "a file that probe() rejects is an error naming the file,
 * not a silent skip" — a clip with no audio is the same class of problem,
 * just discovered an instant later than "no video stream at all".
 *
 * `evaluateAudioProbes` is the guard's pure decision (0.1.9 first-contact,
 * 2026-08-05): the fail-fast pool below fires it the moment a silent clip is
 * seen, when only SOME probes have settled — so the verdict carries both the
 * offenders known at that moment and how many clips were never checked, and
 * the message can be honest about the difference instead of implying a
 * complete list it doesn't have.
 */
export interface AudioGuardFailure {
  /** Clips known silent when the guard fired, in enumeration order. */
  offenders: string[];
  /** Clips whose probes had not settled when the guard fired. */
  uncheckedCount: number;
}

export function evaluateAudioProbes(
  settled: ReadonlyArray<{ name: string; hasAudio: boolean }>,
  total: number,
): AudioGuardFailure | null {
  const offenders = settled.filter((c) => !c.hasAudio).map((c) => c.name);
  if (offenders.length === 0) return null;
  return { offenders, uncheckedCount: total - settled.length };
}

export function audioGuardMessage(failure: AudioGuardFailure): string {
  const { offenders, uncheckedCount } = failure;
  // "Result", not "clip": probes settle in parallel, so the unchecked set can
  // include clips EARLIER in concat order than the offender — "later clips"
  // would overclaim an ordering the pool doesn't have (review, Minor 1).
  const stopped =
    uncheckedCount > 0
      ? ` Stopped at the first missing-audio result; ${uncheckedCount} ` +
        `clip${uncheckedCount === 1 ? " was" : "s were"} not checked.`
      : "";
  // The ~/Downloads sentence is the 0.1.9 first-contact lesson: the guard
  // fired CORRECTLY, but on the wrong folder — the wizard had been answered
  // with all of ~/Downloads, and "13 clips lack audio" never suggested the
  // user was one directory too high.
  return (
    `no audio stream in: ${offenders.join(", ")} — produce cuts by silence, so ` +
    "every clip in a folder concat needs one (a silent b-roll clip can't be " +
    "concatenated this way)." +
    stopped +
    " If this is a mixed folder like ~/Downloads rather than a folder of just " +
    "the takes to concatenate, point produce at the clips folder instead."
  );
}

export function assertAllClipsHaveAudio(
  clips: ReadonlyArray<{ name: string; hasAudio: boolean }>,
): void {
  const failure = evaluateAudioProbes(clips, clips.length);
  if (failure !== null) throw new Error(audioGuardMessage(failure));
}

/**
 * Bounded, fail-fast probe pool (0.1.9 first-contact, 2026-08-05): the guard
 * used to `Promise.all` every probe — pointed at ~/Downloads, that meant
 * 4m32s of ffprobe over ~100 unrelated videos before the error the FIRST
 * silent clip already implied. Two fixes in one shape: a concurrency bound so
 * a big folder doesn't stampede the disk with a hundred simultaneous
 * ffprobes, and an immediate reject on the first missing-audio result — the
 * verdict is built from whatever has settled at that moment, and in-flight
 * probes are simply ignored (ffprobe is a short-lived read-only process;
 * letting it finish unobserved is harmless).
 *
 * Generic over `probeOne` so the scheduling is testable without ffprobe; the
 * abort/offenders DECISION lives in `evaluateAudioProbes` (pure), this is the
 * IO glue around it.
 */
export async function probeClipsWithAudioGuard<T extends { hasAudio: boolean }>(
  names: readonly string[],
  probeOne: (name: string, index: number) => Promise<T>,
  concurrency = 8,
): Promise<T[]> {
  if (names.length === 0) return [];
  const results: (T | undefined)[] = new Array(names.length);
  return await new Promise<T[]>((resolveAll, rejectAll) => {
    let nextIndex = 0;
    let settledCount = 0;
    let finished = false;

    const launch = (): void => {
      if (finished || nextIndex >= names.length) return;
      const i = nextIndex;
      nextIndex++;
      const name = names[i];
      if (name === undefined) return; // unreachable: i < names.length
      // Deferred through a resolved promise so a probeOne that throws
      // SYNCHRONOUSLY rejects the pool instead of deadlocking it (review,
      // Minor 2): a sync throw out of a replacement `launch()` inside the
      // success handler below would otherwise escape both handlers, leaving
      // the pool one settle short of ever resolving. Unreachable with the
      // real async probe, but the generic API must not depend on that.
      Promise.resolve()
        .then(() => probeOne(name, i))
        .then(
        (result) => {
          if (finished) return;
          results[i] = result;
          settledCount++;
          if (!result.hasAudio) {
            const settled: Array<{ name: string; hasAudio: boolean }> = [];
            for (let j = 0; j < names.length; j++) {
              const r = results[j];
              const n = names[j];
              if (r !== undefined && n !== undefined) settled.push({ name: n, hasAudio: r.hasAudio });
            }
            const failure = evaluateAudioProbes(settled, names.length);
            // Never null here — the result that brought us into this branch
            // lacks audio — but throwing through the pure function keeps one
            // single source of truth for the verdict.
            if (failure !== null) {
              finished = true;
              rejectAll(new Error(audioGuardMessage(failure)));
            }
            return;
          }
          if (settledCount === names.length) {
            finished = true;
            resolveAll(results as T[]);
          } else {
            launch();
          }
        },
        (err: unknown) => {
          // A probe that FAILS (e.g. `no video stream in <path>`) propagates
          // as-is, same as the Promise.all it replaced — an error naming the
          // file, not a silent skip (folder-input-brief.md).
          if (finished) return;
          finished = true;
          rejectAll(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };
    const initial = Math.min(concurrency, names.length);
    for (let k = 0; k < initial; k++) launch();
  });
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
 *
 * Belt-and-suspenders alongside `folderManifestKey`: the workdir is now
 * content-addressed too, so in practice a stale manifest can only be reached
 * by a hash collision or a folder mutated mid-run — this is what catches
 * either without trusting the hash alone.
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

export interface FolderListing {
  entries: ConcatEntry[];
  /** Files skipped for not matching a video extension (dotfiles excluded). */
  nonVideoCount: number;
}

/**
 * Enumerate the video files directly inside `folder` (no recursion — a
 * subfolder is out of scope, not "ignored", so it is never counted).
 *
 * Symlinks to a regular file are followed (`stat`, which resolves the link)
 * rather than dropped — a folder of symlinks into another drive is a normal
 * way to stage takes, and silently enumerating zero clips from it would be a
 * worse surprise than the extra `stat` call. A broken symlink or a symlink to
 * a directory stats as "not a file" and is skipped without counting, the same
 * as a real subfolder. Dotfiles (`.DS_Store` and friends) are skipped
 * entirely and never counted — they are not a folder content decision the
 * user made, so reporting them as "non-video files ignored" would be noise.
 */
export async function listFolderVideos(folder: string): Promise<FolderListing> {
  const dirents = await readdir(folder, { withFileTypes: true });
  let nonVideoCount = 0;
  const entries: ConcatEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    let isFile = d.isFile();
    if (!isFile && d.isSymbolicLink()) {
      try {
        isFile = (await stat(join(folder, d.name))).isFile();
      } catch {
        isFile = false; // broken symlink — treated like a subfolder: skipped, not counted
      }
    }
    if (!isFile) continue; // a real subfolder, or a symlink to one
    const dot = d.name.lastIndexOf(".");
    const ext = dot >= 0 ? d.name.slice(dot + 1).toLowerCase() : "";
    if (!VIDEO_EXTENSION_SET.has(ext)) {
      nonVideoCount++;
      continue;
    }
    const st = await stat(join(folder, d.name));
    entries.push({ name: d.name, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (entries.length === 0) throw noVideoFilesError(folder);
  return { entries, nonVideoCount };
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
 * Order and concat `listing`'s clips into `<workDir>/source-concat.mp4`,
 * caching on a manifest of names+sizes+mtimes so an unchanged folder skips
 * the re-encode. `listing` comes from `listFolderVideos` — the caller
 * enumerates once, up front, because it ALSO needs the listing to derive the
 * workdir's content-addressed hash (`folderManifestKey`) before this can
 * even be called with a `workDir` to write into.
 */
export async function concatFolder(
  tools: IngestTools,
  folder: string,
  listing: FolderListing,
  workDir: string,
  sort: "name" | "mtime",
  target: { w: number; h: number },
): Promise<FolderConcatResult> {
  const { entries: current, nonVideoCount } = listing;
  if (current.length === 0) throw noVideoFilesError(folder);
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
  // than caught here. The pool bounds concurrency and rejects on the FIRST
  // silent clip instead of probing the whole folder before refusing (0.1.9
  // first-contact, 2026-08-05 — see probeClipsWithAudioGuard).
  const probes = await probeClipsWithAudioGuard(order, (name) => probe(tools, join(folder, name)));

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
