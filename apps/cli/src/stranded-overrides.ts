import { basename } from "node:path";

/**
 * §131's residue: renaming/adding/removing clips in a folder input re-keys
 * the content hash, so produce derives a FRESH workdir — correct for every
 * cache (a stale transcript against a different edit is the bug §131's
 * manifest hashing exists to prevent), but the OLD workdir's editor edits
 * (`overrides.json`) are user-owned work that silently stops being found.
 * The user sees a clean produce and never learns their edits live one
 * sibling directory over. This module is the pure half of the pointer that
 * closes that gap: given the sibling directory listing, decide WHICH
 * directories to point at. All filesystem reads stay in produce.ts so the
 * cross-folder matching rules below are testable without a disk.
 */

/**
 * The `<basename>-<hash8>` naming's basename half, shared with
 * `deriveWorkdir` (produce.ts) so the sibling scan can never disagree with
 * the naming scheme it scans for — a drift between the two would make every
 * pointer silently miss.
 */
export function workdirBaseName(identity: string): string {
  return basename(identity).replace(/\.[^.]+$/, "");
}

export interface SiblingWorkdirEntry {
  /** Directory entry name inside the workdir root (not a full path). */
  name: string;
  hasOverrides: boolean;
  /** mtime of the entry's overrides.json — 0 when it has none. */
  mtimeMs: number;
}

/** Cap on printed pointers — a folder edited across many re-keys must not flood the run log. */
export const MAX_STRANDED_POINTERS = 3;

/**
 * Which sibling workdirs hold stranded editor edits for this folder, newest
 * edit first. Matching is prefix + exactly-8-lowercase-hex (sha1's own
 * alphabet), NOT a loose startsWith: `MyClips2-bbbbbbbb` must never match
 * base `MyClips` (a different folder entirely), and requiring the hash shape
 * after the `-` is what rules it out — `2-bbbbbbbb` is not 8 hex. The
 * optional `-16x9` tail mirrors deriveWorkdir's landscape suffix; edits
 * stranded in either aspect's workdir are still this folder's edits. Same
 * hash in the other aspect is excluded: that workdir is reachable by
 * re-running with the other --aspect, not stranded by a re-key.
 */
export function strandedOverrideSiblings(p: {
  base: string;
  /** This run's 8-hex content hash — its own workdirs are not "previous". */
  currentHash: string;
  entries: SiblingWorkdirEntry[];
}): string[] {
  const prefix = `${p.base}-`;
  return p.entries
    .filter((e) => {
      if (!e.hasOverrides || !e.name.startsWith(prefix)) return false;
      const m = /^([0-9a-f]{8})(-16x9)?$/.exec(e.name.slice(prefix.length));
      return m !== null && m[1] !== p.currentHash;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_STRANDED_POINTERS)
    .map((e) => e.name);
}

/**
 * The printed pointer. Says "for this folder" deliberately loosely — two
 * different folders sharing a basename under one --workdir root can collide
 * into this list, and the wording stays honest for that case rather than
 * claiming a provenance the name alone can't prove (§131 brief).
 */
export function strandedPointerLine(path: string): string {
  return (
    `▸ previous project for this folder: ${path} ` +
    `(has editor edits — they don't carry over; open it with: ossclip edit '${path}')`
  );
}
