import {
  effectiveOverride,
  isLookPieceKey,
  splitRootId,
  type OverrideDoc,
  type SceneOverride,
} from "./overrides";
import type { SceneCue } from "./scene-schema";
import { inScope, pieceSourceRanges, setTakeLook, type TakeLook, type TakeLookEntry } from "./take-looks";
import type { TimeMap } from "./timemap";

/**
 * The one-time move of a legacy doc's take looks onto source time
 * (take-looks-by-source L3, N1–N4, N7, S1–S3). Its own module, not
 * take-looks.ts: it needs `effectiveOverride` and `isLookPieceKey` at
 * runtime, and take-looks.ts must stay types-only towards overrides.ts,
 * whose schema imports it (R6-8).
 */

export interface TakeLookMigration {
  doc: OverrideDoc;
  /** Human sentences for produce to print. */
  notes: string[];
  /** True whenever the marker was set — even onto `takeLooks: []` (S5) —
   * so produce writes the marker once and never migrates again. */
  changed: boolean;
}

const LOOK_FIELDS = ["video", "pip", "layout", "captionY", "captionScale"] as const satisfies readonly (keyof TakeLook)[];

/** No keys but an empty `props` and an empty `elements` — the same test as
 * the editor's `isEmptyEntry` (take-framing-identity R4-S6), which R7-7
 * moves into core in the editor task. An entry left like this by the strip
 * has nothing to say, so it is dropped rather than written as dead weight. */
const isEmptyEntry = (entry: SceneOverride): boolean =>
  Object.entries(entry).every(
    ([k, v]) =>
      v === undefined || ((k === "props" || k === "elements") && Object.keys(v as object).length === 0),
  );

/**
 * Move every current take piece's id-keyed look onto the source range it
 * plays, once (L3). `cues` are the second `applyOverrides`' output on `map`
 * — this run's pieces on this run's clock, so every piece exists (N3, N4) —
 * and `doc` the doc after `rekeyTakeHalves`, whose step 4 already gave a
 * moved legacy half its framing (L5). `ownFramingIds` is
 * `ownFramingSplitIds(doc.splits)`, the set the merge itself read.
 *
 * Present `takeLooks` (even `[]`) is the marker: such a doc comes back as
 * the same object with `changed: false` (S2, R4-S9), so produce can call
 * this on every run and a stale editor's legacy save — the marker dropped,
 * the fields back on the takes — simply migrates again from those fields
 * (S11).
 *
 * Output is unchanged by construction: each piece showed exactly its
 * `values` before, and `applyTakeLooks` resolves the same ranges to the
 * same values on the same map.
 */
export function migrateTakeLooks(
  doc: OverrideDoc,
  cues: readonly SceneCue[],
  map: TimeMap,
  ownFramingIds: ReadonlySet<string>,
): TakeLookMigration {
  if (doc.takeLooks !== undefined) return { doc, notes: [], changed: false };

  // Writes start from an empty list and the pieces are disjoint in source
  // time on one map, so no write competes with another (S3).
  let takeLooks: TakeLookEntry[] = [];
  let moved = 0;
  // Every key some current piece resolves through: its own and its root's
  // (a half inherits from its root, N2). These are the keys the strip
  // empties — anything else names no piece this run.
  const resolvedThrough = new Set<string>();
  for (const piece of cues) {
    if (piece.kind !== "plain" || !isLookPieceKey(piece.id)) continue;
    resolvedThrough.add(piece.id);
    resolvedThrough.add(splitRootId(piece.id));
    // Id-keyed values only, never the cue's own: a plan value is not an
    // edit, and `inScope` over a schema-parsed entry is what keeps the look
    // values validated (`normalizeTakeLooks` checks structure only).
    const values = inScope(effectiveOverride(doc.scenes, piece.id, ownFramingIds));
    // The one base exception (R4-S7): a minted kept block with no plain
    // neighbour got `"video-top"` from the carve, not from an edit. In look
    // mode the base is `"full-bleed"` (L2), so without this it would change
    // on screen — the only piece whose base layout is not the fill's.
    if (values.layout === undefined && piece.layout !== "full-bleed") values.layout = piece.layout;
    if (Object.keys(values).length === 0) continue;
    const ranges = pieceSourceRanges(piece, map);
    if (ranges.length === 0) continue;
    takeLooks = setTakeLook(takeLooks, ranges, values);
    moved++;
  }

  // Strip the look fields from the keys the pieces resolved through: from
  // here on look fields on takes come only from `takeLooks`, so a copy left
  // on a key would be a second, silently ignored source of truth.
  const scenes: Record<string, SceneOverride> = { ...doc.scenes };
  for (const key of resolvedThrough) {
    const entry = scenes[key];
    if (entry === undefined) continue;
    const next: SceneOverride = { ...entry };
    for (const f of LOOK_FIELDS) delete next[f];
    if (isEmptyEntry(next)) delete scenes[key];
    else scenes[key] = next;
  }

  // Look edits on keys no piece resolves through — an inactive
  // `take-kept-*` (its id knows only `srcIn`, so there is no honest range
  // to move it to, m12), an inert half, an orphan — are left as they are
  // and become dead data. A declared loss (S1), so it is named.
  const left = Object.keys(doc.scenes)
    .filter((k) => isLookPieceKey(k) && !resolvedThrough.has(k))
    .filter((k) => Object.keys(inScope(doc.scenes[k])).length > 0)
    .sort();

  const notes = [`moved the look of ${moved} take piece(s) onto source time`];
  if (left.length > 0) {
    notes.push(`left ${left.length} look edit(s) on takes not in this cut: ${left.join(", ")}`);
  }
  return { doc: { ...doc, scenes, takeLooks }, notes, changed: true };
}
