/**
 * The workdir side of the overlay library (overlay-library spec §Placement
 * schema "Snapshot", §Resolve → render props "Staging"): what a `--scenes`
 * replay carries forward, what a project remembers about a library entry,
 * and the copies that make a render independent of `~/.ossclip/library`.
 *
 * Its own module rather than more of produce.ts because two commands stage
 * into a workdir: produce for matches, and the edit server for tray adds
 * (Task 6). One copy rule for both is the only way "the workdir copy wins"
 * holds whichever of them touched the project last.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  overlayStagedFile,
  ProductionOverlaysSchema,
  sfxStagedFile,
  type LoadedLibraryEntry,
  type LoadedSfxSound,
  type LogoFlag,
  type LogoSuggestion,
  type OverlayCue,
  type OverlayEntrySnapshot,
  type OverlayIssue,
  type OverlayPlacement,
  type ProductionOverlays,
  type SfxCue,
} from "@ossclip/core";

/**
 * The `overlays` plan the workdir's LAST run wrote, or undefined.
 *
 * A replay (the editor's Render re-runs command.json with `--scenes`) carries
 * this forward and never re-matches (spec §Placement schema, "When matching
 * runs"): an old project must not change because the library grew since.
 * `priorSfxPlan`'s posture exactly — a missing, unreadable or overlay-less
 * file means "no prior overlays", and the block is zod-parsed, never cast,
 * because production.json is as hand-editable as anything in the workdir.
 */
export function priorOverlayPlan(work: string): ProductionOverlays | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as { overlays?: unknown };
    if (raw.overlays === undefined) return undefined;
    const parsed = ProductionOverlaysSchema.safeParse(raw.overlays);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a project remembers about a library entry (spec "Snapshot"): enough
 * to render and to fall forward on a cut mention (`names`), and NOT the
 * library's own file name or absolute path — a render reads
 * `<workdir>/library/<id>.<ext>`, never the library folder. `ext` is the
 * SNIFFED format, so a `logo.JPEG` lands as `<id>.jpg`.
 *
 * `look` and `sound` are copied only when the entry has them: absent means
 * "the default" downstream, and an explicit `sound: null` (silent) has to
 * survive as a value — hence `!== undefined`, never truthiness.
 */
export function snapshotEntry(e: LoadedLibraryEntry): OverlayEntrySnapshot {
  return {
    id: e.id,
    name: e.names[0]!,
    names: [...e.names],
    kind: e.kind,
    ext: e.format,
    ...(e.look !== undefined ? { look: e.look } : {}),
    ...(e.sound !== undefined ? { sound: e.sound } : {}),
  };
}

/**
 * Stage every snapshotted entry's file for a render (spec "Staging"):
 *
 * - `<work>/library/<id>.<ext>` is AUTHORITATIVE. The library is copied in
 *   only when that file is missing — the first time the entry is used, or a
 *   workdir someone pruned. Changed art in the library never reaches an
 *   existing project this way; only a tray swap re-copies (spec "Snapshot").
 * - The publicDir copy is ALWAYS refreshed from the workdir, so a stale one
 *   (a previous render's, or the `--no-mezzanine` source folder's) can never
 *   outvote it.
 * - Both missing is an issue, and the entry is left out of `staged`, so the
 *   resolver skips its overlays with a ⚠ line rather than the renderer
 *   drawing a broken box (plan review focus 1).
 *
 * A library entry whose sniffed format no longer matches the snapshot's
 * `ext` is not copied: those bytes under the old name would be a
 * mislabelled file, and `ext` is what decides GIF-vs-still (ruling R8).
 *
 * `staged` holds the POSIX-literal served names (`overlayStagedFile`), the
 * exact strings the resolver's `exists` is asked about.
 */
export function stageOverlayFiles(
  entries: readonly OverlayEntrySnapshot[],
  library: readonly LoadedLibraryEntry[],
  work: string,
  publicDir: string,
): { staged: Set<string>; issues: string[] } {
  const staged = new Set<string>();
  const issues: string[] = [];
  const fromLibrary = new Map(library.map((e) => [e.id, e]));
  const mirror = resolve(publicDir) !== resolve(work);
  for (const entry of entries) {
    const rel = overlayStagedFile(entry);
    // `join` on the filesystem side, `rel` stays a URL (the
    // `sideImageDestRel` split).
    const workAbs = join(work, ...rel.split("/"));
    try {
      if (!existsSync(workAbs)) {
        const src = fromLibrary.get(entry.id);
        if (!src || !existsSync(src.absPath)) {
          issues.push(`"${entry.name}": ${rel} is not in the workdir and "${entry.id}" is not in the library`);
          continue;
        }
        if (src.format !== entry.ext) {
          issues.push(
            `"${entry.name}": the library's "${entry.id}" is now a ${src.format}, not the ${entry.ext} ` +
              `this project placed — swap it in the editor to use the new file`,
          );
          continue;
        }
        mkdirSync(dirname(workAbs), { recursive: true });
        copyFileSync(src.absPath, workAbs);
      }
      if (mirror) {
        const pubAbs = join(publicDir, ...rel.split("/"));
        mkdirSync(dirname(pubAbs), { recursive: true });
        copyFileSync(workAbs, pubAbs);
      }
      staged.add(rel);
    } catch (e) {
      issues.push(`"${entry.name}": could not stage ${rel}: ${(e as Error).message}`);
    }
  }
  return { staged, issues };
}

/**
 * Copy the sounds the cues actually NAME into each dir under `sfx/<id>.<ext>`
 * — the `--sfx` stager, shared with overlay pops so there is one copy rule
 * for one audio path (spec §Resolve: "there's no new audio path").
 *
 * Every dir, for the Nastaliq font's reason: the render bundles the public
 * dir, `ossclip edit` serves the workdir, and both fetch the same served
 * name. Only CUED sounds — the library is a menu, not a payload. `sounds` may
 * hold the same id twice (the `--sfx` load and the overlay load); the first
 * wins, which is the `--sfx` library's, so the plan's sound is what plays.
 */
export function stageSfxSounds(
  sounds: readonly LoadedSfxSound[],
  cues: readonly SfxCue[],
  dirs: readonly string[],
): void {
  const cued = new Set(cues.map((c) => c.soundFile));
  const done = new Set<string>();
  for (const sound of sounds) {
    const rel = sfxStagedFile(sound);
    if (!cued.has(rel) || done.has(rel)) continue;
    done.add(rel);
    for (const dir of new Set(dirs)) {
      const dest = join(dir, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(sound.absPath, dest);
    }
  }
}

/**
 * The overlay accounting line (spec §CLI: "overlays: 2 placed (GDE,
 * Firebase), 1 skipped"), shared by the console and report.txt — the
 * `formatSfxAccounting` contract (§118b), one formatter so the two never
 * disagree.
 *
 * Names are the entries' display names in the order their cues play, once
 * each. "Skipped" is every placement that does NOT reach the screen: the
 * matcher's overlap drops plus the resolver's drops. "moved forward" and
 * "unknown sound" are ISSUES, not drops — the overlay still renders (on a
 * later word, or silent) — so they print as ⚠ lines but are not counted.
 */
export function formatOverlayAccounting(
  applied: { entries: readonly OverlayEntrySnapshot[]; placements: readonly OverlayPlacement[] },
  cues: readonly OverlayCue[],
  issues: readonly OverlayIssue[],
  matchDrops: number,
): string {
  const nameOf = new Map(applied.entries.map((e) => [e.id, e.name]));
  const entryOf = new Map(applied.placements.map((p) => [p.id, p.entryId]));
  const names = [...new Set(cues.map((c) => nameOf.get(entryOf.get(c.id) ?? "") ?? c.id))];
  const skipped =
    matchDrops + issues.filter((i) => i.reason !== "moved forward" && i.reason !== "unknown sound").length;
  return (
    `overlays: ${cues.length} placed` + (names.length > 0 ? ` (${names.join(", ")})` : "") + `, ${skipped} skipped`
  );
}

/**
 * The logo finder's one report line (logo-finder spec §Report), shared by
 * the console and report.txt, the `formatOverlayAccounting` contract.
 *
 * `skipped` is the parenthetical of a skip ("no LLM provider", "the LLM call
 * failed: <reason>") and wins over everything else. Otherwise the line
 * counts `suggestions`; none at all is "no new names". The without-part
 * names each logo-less chip with its note (controller ruling R13, over the
 * spec's `<domain> <note>`: the note already names the domain where it is
 * the point, "kimi.ai answered 503", and a name is what the author reads on
 * the chip). It is dropped when every name has a logo.
 */
export function formatLogoFinderLine(result: { skipped?: string; suggestions?: readonly LogoSuggestion[] }): string {
  if (result.skipped !== undefined) return `logo finder: skipped (${result.skipped})`;
  const all = result.suggestions ?? [];
  if (all.length === 0) return "logo finder: no new names";
  const without = all.filter((s) => s.candidates.length === 0);
  const head =
    `logo finder: ${all.length} name${all.length === 1 ? "" : "s"} (${all.map((s) => s.name).join(", ")}) — ` +
    `${all.length - without.length} with logos`;
  if (without.length === 0) return head;
  const why = without.map((s) => (s.note !== undefined ? `${s.name} — ${s.note}` : s.name)).join("; ");
  return `${head}, ${without.length} without (${why})`;
}

/**
 * The prior run's suggestion for `flag`, when it can stand in for a fetch
 * (controller ruling R4): the same id and domain, at least one candidate,
 * and every candidate file still in the workdir. That keeps a re-plan with
 * nothing changed offline. A prior with no candidates (a timeout, a 503) is
 * never reused: the site may answer this time, so it is asked again.
 *
 * The flag's `name` and `word` win over the prior's: a recut can move the
 * first kept mention, and the files belong to the id, not the word.
 * `exists` takes a workdir-relative POSIX path, so this stays testable
 * without a filesystem.
 */
export function reusableSuggestion(
  flag: LogoFlag,
  prior: readonly LogoSuggestion[] | undefined,
  exists: (rel: string) => boolean,
): LogoSuggestion | undefined {
  const p = prior?.find((s) => s.id === flag.id);
  if (!p || p.domain !== flag.domain || p.candidates.length === 0) return undefined;
  if (!p.candidates.every((c) => exists(c.file))) return undefined;
  return { ...p, name: flag.name, word: flag.word };
}
