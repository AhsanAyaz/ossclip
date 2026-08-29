import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { CONFIG_DIR } from "./config";

/**
 * One sound in a pack. `kind` is a `z.literal("sound")` rather than a plain
 * string BECAUSE the field is reserved for future video memes: when that ships
 * the literal becomes an enum, and until then an entry declaring any other
 * kind must be skipped with a warning instead of loaded as a sound (a video
 * clip handed to `<Audio>` is a broken render, not a degraded one).
 *
 * `tags` is free-form, but "meme" is the ONE tag with semantics: it gates the
 * sound out of the menu below `--sfx-level meme`. Anything else is metadata a
 * pack author writes for themselves.
 */
export const SfxSoundSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.literal("sound"),
  /** Relative to the pack directory — never absolute, never escaping it. */
  file: z.string().min(1),
  /**
   * The line the LLM reads when picking this sound. Capped rather than
   * unbounded because the whole library goes into every placement prompt;
   * this is pack metadata (a human wrote it), so a bare `.max` that REJECTS
   * is right here — the §112 "degrade instead of die" rule is about model
   * output, and a pack author gets a named issue and a skipped entry.
   */
  whenToUse: z.string().min(1).max(200),
  tags: z.array(z.string()).default([]),
  /** Mix level for this sound, multiplied by any per-placement gain. */
  gain: z.number().min(0).max(2).default(1),
  durationSec: z.number().positive().optional(),
});
export type SfxSound = z.infer<typeof SfxSoundSchema>;

export const SfxPackSchema = z.object({
  name: z.string().min(1),
  sounds: z.array(SfxSoundSchema),
});
export type SfxPack = z.infer<typeof SfxPackSchema>;

/** The only tag the pipeline reads — see `SfxSoundSchema.tags`. */
export const SFX_MEME_TAG = "meme";

/** A sound resolved to a file on disk, with the pack it came from. */
export interface LoadedSfxSound extends SfxSound {
  absPath: string;
  packName: string;
}

/**
 * Why a pack, or one entry in it, is not in the library. Every path that
 * skips something emits one of these; nothing here throws, because a
 * hand-written pack in `~/.ossclip/sfx` is user input and a typo in it must
 * cost sound effects, not the produce run.
 */
export interface SfxPackIssue {
  /** Pack directory name, or the pack's declared name for the bundled pack. */
  pack: string;
  issue: string;
}

export interface SfxLibrary {
  sounds: LoadedSfxSound[];
  issues: SfxPackIssue[];
}

/**
 * The bundled starter pack's directory. `import.meta.url` rather than a path
 * relative to cwd, the `nastaliqFontFile()` shape (fonts.ts) — and the
 * packaging test (R22 §111) scans for exactly that shape to prove `assets`
 * rides in the npm tarball.
 */
export function bundledSfxDir(): string {
  return fileURLToPath(new URL("../assets/sfx", import.meta.url));
}

/** Where user packs live: `~/.ossclip/sfx/<pack>/pack.json`. */
export function userSfxDir(): string {
  return join(CONFIG_DIR, "sfx");
}

/**
 * Read one pack directory. Returns the sounds it can resolve plus an issue
 * per entry it cannot — a missing mp3, an id that is not a slug, a `kind`
 * this version does not render. Never throws: unreadable JSON is one issue
 * for the whole pack.
 */
function readPack(dir: string, label: string): SfxLibrary {
  const issues: SfxPackIssue[] = [];
  const manifest = join(dir, "pack.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (e) {
    return { sounds: [], issues: [{ pack: label, issue: `unreadable pack.json: ${String(e)}` }] };
  }
  // Parsed shallowly first so ONE bad entry doesn't take the pack down with
  // it (the scene-props batch fail-soft posture): the pack's own fields are
  // validated here, each sound separately below.
  const shell = z.object({ name: z.string().min(1), sounds: z.array(z.unknown()) }).safeParse(raw);
  if (!shell.success) {
    return { sounds: [], issues: [{ pack: label, issue: `invalid pack.json: ${shell.error.message}` }] };
  }
  const packName = shell.data.name;
  const sounds: LoadedSfxSound[] = [];
  for (const entry of shell.data.sounds) {
    // Read `kind` BEFORE the schema so a future video-meme pack gets the
    // reason it was skipped instead of a literal-mismatch error nobody can
    // act on. v1 renders sounds only.
    const kind = (entry as { kind?: unknown } | null)?.kind;
    const id = (entry as { id?: unknown } | null)?.id;
    const named = typeof id === "string" ? id : "<unnamed>";
    if (typeof kind === "string" && kind !== "sound") {
      issues.push({ pack: packName, issue: `skipped "${named}": kind "${kind}" is not supported yet` });
      continue;
    }
    const parsed = SfxSoundSchema.safeParse(entry);
    if (!parsed.success) {
      issues.push({ pack: packName, issue: `skipped "${named}": ${parsed.error.message}` });
      continue;
    }
    const absPath = join(dir, parsed.data.file);
    if (!existsSync(absPath)) {
      issues.push({ pack: packName, issue: `skipped "${parsed.data.id}": missing file ${parsed.data.file}` });
      continue;
    }
    sounds.push({ ...parsed.data, absPath, packName });
  }
  return { sounds, issues };
}

/**
 * The bundled pack plus every user pack under `userDir`, merged by id.
 *
 * Duplicate policy:
 *  - user pack over bundled, silently — overriding a stock sound with your own
 *    recording is the WANTED case, not an error.
 *  - user vs user: the alphabetically first pack directory wins, with an issue,
 *    so the outcome is stable across filesystems that enumerate differently
 *    (readdir order is not a promise) and the loser is named out loud.
 *
 * `userDir` is a parameter with a default rather than a read of `homedir()`
 * inside, so tests point it at a tmp dir and never touch a real home.
 */
export function loadSfxLibrary(opts: { userDir?: string } = {}): SfxLibrary {
  const userDir = opts.userDir ?? userSfxDir();
  const issues: SfxPackIssue[] = [];
  const byId = new Map<string, LoadedSfxSound>();
  /** Which pack currently owns each id, and whether it was a user pack. */
  const owner = new Map<string, { pack: string; user: boolean }>();

  const bundled = readPack(bundledSfxDir(), "ossclip-starter");
  issues.push(...bundled.issues);
  for (const s of bundled.sounds) {
    byId.set(s.id, s);
    owner.set(s.id, { pack: s.packName, user: false });
  }

  let dirs: string[] = [];
  try {
    dirs = readdirSync(userDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // No user pack directory at all is the normal case, not an issue.
    dirs = [];
  }
  for (const name of dirs) {
    const dir = join(userDir, name);
    if (!existsSync(join(dir, "pack.json"))) continue; // not a pack, not an error
    const pack = readPack(dir, name);
    issues.push(...pack.issues);
    for (const s of pack.sounds) {
      const held = owner.get(s.id);
      if (held?.user) {
        issues.push({
          pack: s.packName,
          issue: `duplicate id "${s.id}" — keeping the one from "${held.pack}" (first pack alphabetically)`,
        });
        continue;
      }
      byId.set(s.id, s);
      owner.set(s.id, { pack: s.packName, user: true });
    }
  }

  // Sorted by id so the menu, the hash and every report read the same on
  // every machine — merge order must not leak into the prompt.
  const sounds = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { sounds, issues };
}

/**
 * A fingerprint of the library as the MODEL sees it — id, whenToUse, tags,
 * gain — and deliberately not the audio bytes or the file paths.
 *
 * This rides the placement cache key, so hashing the mp3s would re-bill an
 * LLM call every time a pack is re-encoded at a different bitrate, for a
 * prompt that is byte-identical. Conversely an edited `whenToUse` DOES change
 * what the model was asked, so it must invalidate.
 */
export function sfxLibraryHash(sounds: readonly SfxSound[]): string {
  const material = [...sounds]
    .map((s) => ({
      id: s.id,
      whenToUse: s.whenToUse,
      // Sorted: tag order is authoring noise, not a different library.
      tags: [...s.tags].sort(),
      gain: s.gain,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
