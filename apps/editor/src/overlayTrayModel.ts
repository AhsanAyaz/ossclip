/**
 * The overlay tray's pure half (overlay-library spec §Editor, "Tray"): what a
 * pasted string IS, what a new item is called and which kind it guesses, the
 * grid's search, and the "Find library matches" sentence. No fetch, no DOM —
 * the `sfxLane.ts` split — so every decision the tray makes about a user's
 * input is testable without a page or a server.
 */

/** `GET /api/library`'s entry: metadata only, never a path (the server's
 * `libraryEntryMeta` — the page addresses the file by id). */
export interface LibraryEntryMeta {
  id: string;
  names: string[];
  kind: "logo" | "image" | "gif";
  look?: "overlay" | "card";
  sound?: string | null;
  format: "png" | "jpg" | "webp" | "svg" | "gif";
}

/** The grid thumbnail: the library's own file, by id (`/api/sfx/audio`'s
 * rule — the query never carries a path). A GIF animates through a plain
 * `<img>`, which is the spec's "GIF thumbnails animating" for free. */
export const libraryFileUrl = (id: string): string => `/api/library/file?id=${encodeURIComponent(id)}`;

/** The grid's name search: case-insensitive substring over every name and the
 * id, so "gde" finds "Google Developers Expert" through its "GDE" alias. An
 * empty query shows everything. */
export function filterLibrary(entries: readonly LibraryEntryMeta[], query: string): LibraryEntryMeta[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter((e) => e.id.includes(q) || e.names.some((n) => n.toLowerCase().includes(q)));
}

/** The upload cap (plan Global Constraints: 20 MB), restated because the
 * core constant lives in the node-only `overlay-library.ts`. The server
 * enforces the real one; the tray checks a DROP early so a mistaken video is
 * refused before it is base64'd into memory. */
export const TRAY_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type PasteSource = { url: string } | { path: string };

/**
 * What the paste box holds, in `POST /api/library`'s `source` shapes. Only
 * http(s) URLs and ABSOLUTE paths: the server refuses a relative path (it
 * would resolve against a cwd the user cannot see) and fetches nothing but
 * http/https, so the tray says so before the round-trip rather than after.
 * `~/…` is refused with its own sentence because it LOOKS absolute to the
 * person who typed it, and the server does no shell expansion. An empty box
 * is `error: null` — nothing to complain about yet.
 */
export function classifyPaste(text: string): { ok: true; source: PasteSource } | { ok: false; error: string | null } {
  const t = text.trim();
  if (t === "") return { ok: false, error: null };
  if (/^https?:\/\//i.test(t)) {
    try {
      new URL(t);
      return { ok: true, source: { url: t } };
    } catch {
      return { ok: false, error: "that URL does not parse" };
    }
  }
  if (t.startsWith("~")) return { ok: false, error: "spell the full path (e.g. /Users/you/logo.png) — ~ is not expanded" };
  // POSIX absolute, or a Windows drive path (`C:\…` / `C:/…`).
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return { ok: true, source: { path: t } };
  return { ok: false, error: "paste an http(s) URL or an absolute file path" };
}

/** The last path part of a URL or a path, decoded — the file name the spec's
 * name pre-fill and kind guess both start from. */
function lastSegment(text: string): string {
  const t = text.trim();
  let path = t;
  if (/^https?:\/\//i.test(t)) {
    try {
      path = new URL(t).pathname;
    } catch {
      return "";
    }
  }
  const seg = path.split(/[\\/]/).filter((s) => s !== "").pop() ?? "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * A new item's name, pre-filled (spec: "a name, pre-filled from the file name
 * or the URL's last path part"): the stem with `-`/`_` runs turned into
 * spaces — the library loader's own rule for an unindexed file's name, so a
 * pasted `google-cloud.png` and a dropped-in-the-folder one read the same.
 * Empty when there is nothing to go on; the user types one.
 */
export function nameFromSource(text: string): string {
  const seg = lastSegment(text);
  const stem = seg.includes(".") ? seg.slice(0, seg.lastIndexOf(".")) : seg;
  return stem.replace(/[-_]+/g, " ").trim().slice(0, 80);
}

/**
 * The kind guess (spec: "gif → gif, else logo"), from whatever hint the source
 * offers — a file name or URL's extension, or a dropped file's MIME type. Only
 * a guess the user can change: the server sniffs the real format, and
 * `addLibraryEntry` makes the same default from the bytes when no kind is sent.
 */
export function guessKind(hint: { name?: string; mimeType?: string }): "gif" | "logo" {
  if (hint.mimeType?.toLowerCase() === "image/gif") return "gif";
  if (hint.name !== undefined && /\.gif$/i.test(lastSegment(hint.name))) return "gif";
  return "logo";
}

/** The aliases box: comma-separated, blanks dropped, duplicates of the name
 * or of each other dropped (case-insensitively) — a repeat would only be a
 * second, identical match candidate. Capped at the server schema's 10. */
export function parseAliases(text: string, name: string): string[] {
  const seen = new Set([name.trim().toLowerCase()]);
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const a = raw.trim();
    if (a === "" || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a.slice(0, 80));
  }
  return out.slice(0, 10);
}

/**
 * The "Find library matches" report (spec §Editor: "added N, skipped M
 * already placed or removed"). `skipped` is the server's count of exactly
 * that. `dropped` — first mentions that found an entry but were NOT added
 * (too close to another overlay, a file that would not stage) — is reported
 * on its own, never folded into `skipped`: "skipped … already placed" would
 * then be a false sentence about a logo that was never placed anywhere, and
 * the Task 6 review's point was that "added N" must never quietly be fewer
 * than the matches found.
 */
export function matchSummary(res: {
  placements: readonly unknown[];
  skipped: number;
  dropped: readonly { entryId: string; reason: string }[];
}): string {
  const base = `added ${res.placements.length}, skipped ${res.skipped} already placed or removed`;
  if (res.dropped.length === 0) return base;
  const why = res.dropped.map((d) => `${d.entryId}: ${d.reason}`).join("; ");
  return `${base}, ${res.dropped.length} not added (${why})`;
}
