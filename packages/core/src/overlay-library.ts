import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { CONFIG_DIR } from "./config";
import { autoMatchableName } from "./overlay-match";

/**
 * The global overlay library — `~/.ossclip/library/` — discovered and grown.
 * The `lut-library.ts` / `sfx-pack.ts` shape: the loader is a thin fs layer
 * that never throws and reports per-file issues, because `library.json` is
 * hand-editable user input and one typo must cost one logo, not the produce
 * run (spec "Library on disk"). Node-only: the browser-safe matcher and cue
 * resolver consume `LoadedLibraryEntry` values, never this module.
 */

export const LIBRARY_INDEX_FILE = "library.json";

/** Upload cap (plan Global Constraints): checked BEFORE sniffing or writing. */
export const LIBRARY_MAX_BYTES = 20 * 1024 * 1024;

export type OverlayKind = "logo" | "image" | "gif";
export type OverlayLook = "overlay" | "card";
/**
 * `jpg`, never `jpeg`: the staged file's extension downstream is derived from
 * this value alone, so it must already be the extension we want on disk.
 */
export type ImageFormat = "png" | "jpg" | "webp" | "svg" | "gif";

export interface LibraryEntry {
  id: string;
  /** Relative to the library dir — never absolute, never escaping it. */
  file: string;
  /** First = display name; the rest are aliases the matcher also hears. */
  names: string[];
  kind: OverlayKind;
  look?: OverlayLook;
  /** An sfx sound id; `null` is an explicit "silent", absent means "pop". */
  sound?: string | null;
}

/** An entry resolved to a file on disk. `absPath` stays server-side, like SFX. */
export interface LoadedLibraryEntry extends LibraryEntry {
  absPath: string;
  /** Sniffed from the bytes, not the extension (spec "Library on disk"). */
  format: ImageFormat;
}

/** Library entry ids (plan Global Constraints "Ids"). */
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const OverlayKindSchema = z.enum(["logo", "image", "gif"]);

export const LibraryEntrySchema: z.ZodType<LibraryEntry> = z.object({
  id: z.string().regex(ENTRY_ID_RE),
  file: z.string().min(1),
  names: z.array(z.string().trim().min(1)).min(1),
  kind: OverlayKindSchema,
  look: z.enum(["overlay", "card"]).optional(),
  sound: z.string().min(1).nullable().optional(),
});

/** Where the library lives: `~/.ossclip/library/`. */
export function userLibraryDir(): string {
  return join(CONFIG_DIR, "library");
}

/**
 * The extensions that make a dropped file a CANDIDATE for the unindexed scan.
 * The extension only nominates; the bytes decide (`sniffImageFormat`). The
 * filter exists so a `.DS_Store` or a `notes.txt` beside the logos is silence,
 * not an issue line on every produce.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);

/**
 * How much of a file the sniffer sees. SVG is the only format that needs more
 * than 12 bytes: an exporter's XML prolog, comment banner and DOCTYPE come
 * before the `<svg` root, and 4 KB covers every one seen in practice without
 * reading a 20 MB GIF whole on every library load.
 */
const SNIFF_BYTES = 4096;

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * The image format of `bytes` by magic number, or null. Magic bytes rather
 * than the extension because the extension is whatever the URL or the user's
 * file manager said — an HTML error page saved as `logo.png` must be refused
 * here, not discovered as a broken box in a render (spec "Formats").
 *
 * SVG has no magic number, so it is recognised by its ROOT element: after an
 * optional BOM, whitespace, XML prolog, comments and DOCTYPE, the first element
 * must be `<svg`. An `<html>` page that embeds an `<svg>` is not an SVG.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  return isSvgRoot(bytes) ? "svg" : null;
}

function isSvgRoot(bytes: Uint8Array): boolean {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, SNIFF_BYTES));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Each alternative is one thing allowed before the root; repeated until none
  // match. DOCTYPE may carry an internal subset in brackets.
  const preamble = /^(?:\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)/i;
  for (;;) {
    const m = preamble.exec(text);
    if (!m || m[0].length === 0) break;
    text = text.slice(m[0].length);
  }
  // `<svg` followed by whitespace, `>` or `/` — so `<svgfoo>` is not an SVG.
  return /^<svg[\s>/]/.test(text);
}

/**
 * The pixel size a raster image declares in its header, or null when the
 * header is missing, truncated or declares a zero side. The logo finder
 * keeps a raster candidate only when its short side is at least 64 px
 * (logo-finder spec §Step 2), because a 32 px favicon blown up to overlay
 * size is a blur, not a logo. Always null for SVG: it has no pixel size, and
 * the spec exempts it from the floor.
 *
 * Only headers are read, never pixels, so a file that lies about its size
 * passes; the bytes still have to sniff as an image first.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const be16 = (at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
  const le16 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  const le24 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  const has = (n: number): boolean => bytes.length >= n;
  const size = (width: number, height: number): { width: number; height: number } | null =>
    width > 0 && height > 0 ? { width, height } : null;

  switch (sniffImageFormat(bytes)) {
    case "png":
      // The IHDR chunk is required to come first: width and height are its
      // first two big-endian u32s, at 16 and 20.
      if (!has(24) || !startsWith(bytes, ascii("IHDR"), 12)) return null;
      return size(
        ((bytes[16]! << 24) >>> 0) + (bytes[17]! << 16) + (bytes[18]! << 8) + bytes[19]!,
        ((bytes[20]! << 24) >>> 0) + (bytes[21]! << 16) + (bytes[22]! << 8) + bytes[23]!,
      );
    case "gif":
      // The logical screen descriptor follows the 6-byte signature.
      return has(10) ? size(le16(6), le16(8)) : null;
    case "jpg":
      return jpegSize(bytes, be16);
    case "webp": {
      if (!has(16)) return null;
      const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      if (chunk === "VP8 ") {
        // Lossy: a 3-byte frame tag, the 9d 01 2a start code, then 14-bit
        // sides (the top 2 bits are a scale hint, not size).
        if (!has(30) || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
        return size(le16(26) & 0x3fff, le16(28) & 0x3fff);
      }
      if (chunk === "VP8L") {
        // Lossless: a 0x2f signature, then (side - 1) packed as two 14-bit fields.
        if (!has(25) || bytes[20] !== 0x2f) return null;
        const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X") return has(30) ? size(le24(24) + 1, le24(27) + 1) : null;
      return null;
    }
    default:
      return null;
  }
}

/**
 * A JPEG's size lives in its frame header (SOFn), which can sit after any
 * number of APPn/DQT/DHT segments, so the segments are walked by length
 * rather than read at a fixed offset. 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC)
 * share the SOF range but are not frame headers.
 */
function jpegSize(bytes: Uint8Array, be16: (at: number) => number): { width: number; height: number } | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes: any number of 0xFF may pad before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Standalone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // SOS starts entropy-coded data: a frame header must have come first.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = be16(at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      const height = be16(at + 5);
      const width = be16(at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** Up to `SNIFF_BYTES` from the head of a file; throws like any fs read. */
function readHead(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const NOT_AN_IMAGE = "not a supported image (png, jpg, webp, svg or gif)";

/** Longest slug before a collision suffix — keeps file names sane on every OS. */
const SLUG_MAX = 48;

/**
 * A library id for `name` that is not in `taken`. The id is also the file
 * stem on disk, so this is the ONLY thing that names a written file: a
 * `../../x` name has every separator folded to `-` and edge dashes trimmed,
 * leaving `x` — path traversal cannot survive it (spec "POST /api/library":
 * the file name comes from the slug, never from the URL or path).
 *
 * Collisions get `-2`, `-3`, … rather than a random tail so a user who adds
 * "GDE" twice can tell which is which in `library.json`.
 */
export function slugifyEntryId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, SLUG_MAX)
      .replace(/^-+|-+$/g, "") ||
    // A name with nothing ASCII-sluggable (CJK, emoji, punctuation) still
    // needs an id that passes ENTRY_ID_RE.
    "overlay";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `google-cloud` → "google cloud": the drop-in name rule (spec "Unindexed files"). */
const stemToName = (stem: string): string => stem.replace(/[-_]+/g, " ").trim();

/** True when `file` resolves inside `dir` — an index entry must not reach out. */
function insideDir(dir: string, file: string): boolean {
  if (isAbsolute(file)) return false;
  const rel = relative(resolve(dir), resolve(dir, file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface OverlayLibraryIssue {
  /** The file (or `library.json`) the problem is about. */
  file: string;
  message: string;
}

export interface OverlayLibrary {
  entries: LoadedLibraryEntry[];
  issues: OverlayLibraryIssue[];
}

/**
 * Every usable entry under `dir`: the indexed ones from `library.json` first,
 * then every image file the index does not mention, under its stem name.
 *
 * A missing directory is the normal case (most users never build a library),
 * not an issue. `dir` is a default parameter rather than a `homedir()` read
 * inside, so tests point it at a tmp dir (`loadLutLibrary`'s rule).
 *
 * A file named by ANY index entry — even one the schema rejects — is withheld
 * from the unindexed scan. Falling back to its stem name would put a word on
 * screen its author never chose, and wrong-word pops are the main anti-goal.
 */
export function loadOverlayLibrary(dir: string = userLibraryDir()): OverlayLibrary {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      // readdir order is not a promise; sorted so ids and collision suffixes
      // come out the same on every machine (loadSfxLibrary's merge-order rule).
      .sort();
  } catch {
    return { entries: [], issues: [] };
  }

  const entries: LoadedLibraryEntry[] = [];
  const issues: OverlayLibraryIssue[] = [];
  const taken = new Set<string>();
  const claimed = new Set<string>();

  const loadFile = (absPath: string): ImageFormat | string => {
    try {
      return sniffImageFormat(readHead(absPath)) ?? NOT_AN_IMAGE;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing file" : `unreadable: ${String(e)}`;
    }
  };
  const isFormat = (v: string): v is ImageFormat => ["png", "jpg", "webp", "svg", "gif"].includes(v);

  if (names.includes(LIBRARY_INDEX_FILE)) {
    for (const raw of readIndexEntries(dir, issues)) {
      const rawFile = (raw as { file?: unknown } | null)?.file;
      if (typeof rawFile === "string") claimed.add(resolve(dir, rawFile));
      const rawId = (raw as { id?: unknown } | null)?.id;
      const named = typeof rawId === "string" ? rawId : "<unnamed>";
      const label = typeof rawFile === "string" ? rawFile : named;
      const parsed = LibraryEntrySchema.safeParse(raw);
      if (!parsed.success) {
        issues.push({ file: label, message: `skipped "${named}": ${parsed.error.message}` });
        continue;
      }
      const entry = parsed.data;
      if (!insideDir(dir, entry.file)) {
        issues.push({ file: entry.file, message: `skipped "${entry.id}": file must be inside the library folder` });
        continue;
      }
      if (taken.has(entry.id)) {
        issues.push({ file: entry.file, message: `skipped "${entry.id}": duplicate id, the first entry wins` });
        continue;
      }
      const absPath = join(dir, entry.file);
      const format = loadFile(absPath);
      if (!isFormat(format)) {
        issues.push({ file: entry.file, message: `skipped "${entry.id}": ${format}` });
        continue;
      }
      taken.add(entry.id);
      entries.push({ ...entry, absPath, format });
      // Kept (it still places by hand), but said out loud (ruling R18): a
      // name the matcher refuses must not fail silently.
      for (const n of entry.names.filter((x) => !autoMatchableName(x))) {
        issues.push({
          file: entry.file,
          message: `"${entry.id}": name "${n}" is too short to auto-place in lowercase — give it its capitals or a longer name in ${LIBRARY_INDEX_FILE}`,
        });
      }
    }
  }

  for (const name of names) {
    if (name.startsWith(".") || !IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const absPath = join(dir, name);
    if (claimed.has(resolve(absPath))) continue;
    const format = loadFile(absPath);
    if (!isFormat(format)) {
      issues.push({ file: name, message: format });
      continue;
    }
    const stem = basename(name, extname(name));
    const id = slugifyEntryId(stem, taken);
    taken.add(id);
    const entryName = stemToName(stem) || id;
    // An unindexed `go.png` would be named "go" — never auto-placed (ruling
    // R18, `autoMatchableName`), so the user is told how to fix it.
    if (!autoMatchableName(entryName)) {
      issues.push({
        file: name,
        message: `"${entryName}" is too short to auto-place from a lowercase file name — name it in ${LIBRARY_INDEX_FILE} to auto-place (it can still be placed by hand)`,
      });
    }
    entries.push({
      id,
      file: name,
      names: [entryName],
      // An unindexed GIF is assumed animated — the add path's default too.
      kind: format === "gif" ? "gif" : "logo",
      absPath,
      format,
    });
  }
  return { entries, issues };
}

/**
 * The raw `entries` array of `library.json`, shallow-parsed so ONE bad entry
 * does not take the index down with it (`readPack`'s fail-soft posture). An
 * unreadable or malformed index is one issue; the unindexed scan still runs.
 */
function readIndexEntries(dir: string, issues: OverlayLibraryIssue[]): unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, LIBRARY_INDEX_FILE), "utf8"));
  } catch (e) {
    issues.push({ file: LIBRARY_INDEX_FILE, message: `unreadable ${LIBRARY_INDEX_FILE}: ${String(e)}` });
    return [];
  }
  const shell = IndexShellSchema.safeParse(raw);
  if (!shell.success) {
    issues.push({ file: LIBRARY_INDEX_FILE, message: `invalid ${LIBRARY_INDEX_FILE}: ${shell.error.message}` });
    return [];
  }
  return shell.data.entries;
}

/**
 * Loose so an add round-trips any top-level key a future version (or
 * the user) wrote — the add rewrites the whole file.
 */
const IndexShellSchema = z.looseObject({ entries: z.array(z.unknown()) });

/** A user-facing add failure; `message` is written to be shown as-is. */
export class LibraryAddError extends Error {
  /**
   * Why a DOWNLOAD failed, for callers that must not show the raw message.
   * The logo finder maps it to a fixed set of chip notes (ruling R15), so
   * the remote's wording never reaches production.json. Matching on the
   * message instead would break the moment a tray-facing string is
   * reworded. Absent for library-side refusals (sniff, size, slug).
   */
  readonly kind?: "status" | "timeout" | "unreachable" | "over-cap" | "invalid";
  /** The HTTP status, when `kind` is "status". */
  readonly status?: number;

  constructor(
    message: string,
    detail?: { kind: "status" | "timeout" | "unreachable" | "over-cap" | "invalid"; status?: number },
  ) {
    super(message);
    this.name = "LibraryAddError";
    if (detail !== undefined) {
      this.kind = detail.kind;
      if (detail.status !== undefined) this.status = detail.status;
    }
  }
}

const AddMetaSchema = z.object({
  name: z.string().trim().min(1, "a name is required"),
  aliases: z.array(z.string()).optional(),
  kind: OverlayKindSchema.optional(),
});

/** Write via a same-dir temp file + rename, so a crash never leaves half a file. */
async function writeAtomic(path: string, data: Uint8Array | string, dir: string): Promise<void> {
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Add `bytes` to the library under a fresh slug id and return the loaded entry.
 * Every refusal is a `LibraryAddError` whose message the edit server returns
 * as its 400 body.
 *
 * Order matters: size, then format, then the index read — all before anything
 * is written — so a refused add leaves the folder exactly as it was.
 *
 * The id avoids every index id, every loaded id AND every existing file stem,
 * so an add can never overwrite a drop-in the index does not mention.
 *
 * Not safe against two concurrent adds to the same dir (read-modify-write of
 * the index); the single edit server is the only writer.
 */
export async function addLibraryEntry(
  bytes: Uint8Array,
  meta: { name: string; aliases?: string[]; kind?: OverlayKind },
  dir: string = userLibraryDir(),
): Promise<LoadedLibraryEntry> {
  if (bytes.byteLength > LIBRARY_MAX_BYTES) {
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
    throw new LibraryAddError(`file is ${mb(bytes.byteLength)} MB; the limit is ${mb(LIBRARY_MAX_BYTES)} MB`);
  }
  const format = sniffImageFormat(bytes);
  if (!format) throw new LibraryAddError(`file is ${NOT_AN_IMAGE}`);
  const parsedMeta = AddMetaSchema.safeParse(meta);
  if (!parsedMeta.success) {
    throw new LibraryAddError(parsedMeta.error.issues.map((i) => i.message).join("; "));
  }
  const { name, aliases = [], kind } = parsedMeta.data;

  await mkdir(dir, { recursive: true });
  const indexPath = join(dir, LIBRARY_INDEX_FILE);
  let index: z.infer<typeof IndexShellSchema> = { entries: [] };
  let text: string | undefined;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LibraryAddError(`cannot read ${LIBRARY_INDEX_FILE}: ${String(e)}`);
    }
  }
  if (text !== undefined) {
    // Refuse rather than start a fresh index: rewriting over a file we could
    // not parse would silently delete every hand-written entry in it.
    let parsed: ReturnType<typeof IndexShellSchema.safeParse>;
    try {
      parsed = IndexShellSchema.safeParse(JSON.parse(text));
    } catch {
      throw new LibraryAddError(`${LIBRARY_INDEX_FILE} is not valid JSON; fix it before adding`);
    }
    if (!parsed.success) {
      throw new LibraryAddError(`${LIBRARY_INDEX_FILE} has no "entries" list; fix it before adding`);
    }
    index = parsed.data;
  }

  const taken = new Set<string>();
  for (const e of index.entries) {
    const id = (e as { id?: unknown } | null)?.id;
    if (typeof id === "string") taken.add(id);
  }
  for (const e of loadOverlayLibrary(dir).entries) taken.add(e.id);
  for (const f of readdirSync(dir)) taken.add(basename(f, extname(f)).toLowerCase());
  const id = slugifyEntryId(name, taken);

  const seen = new Set([name.toLowerCase()]);
  const names = [name];
  for (const alias of aliases.map((a) => a.trim())) {
    if (alias && !seen.has(alias.toLowerCase())) {
      seen.add(alias.toLowerCase());
      names.push(alias);
    }
  }
  const entry: LibraryEntry = {
    id,
    file: `${id}.${format}`,
    names,
    kind: kind ?? (format === "gif" ? "gif" : "logo"),
  };
  const absPath = join(dir, entry.file);
  // Image first, index second: a crash between the two leaves an unindexed
  // drop-in (which still loads), never an index entry pointing at nothing.
  await writeAtomic(absPath, bytes, dir);
  const next = { ...index, entries: [...index.entries, entry] };
  await writeAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`, dir);
  return { ...entry, absPath, format };
}
