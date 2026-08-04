import type { OverrideDoc } from "./overrides";
import type { Segment } from "./schema";
import { TimeMap } from "./timemap";

/**
 * What `remapOverridesThroughRecut` hands back alongside the re-anchored doc.
 * `reports` is never used to gate anything — it exists purely so a value that
 * got pushed onto a cut edge is SAID out loud (PLAN 2026-08-04 Task 4a),
 * rather than the user discovering a pin silently moved next time they open
 * the editor.
 */
export interface RecutRemap {
  doc: OverrideDoc;
  reports: string[];
}

/**
 * Remap ONE absolute-output-seconds value through a re-cut, via source time.
 *
 * `oldMap.toSource` is total — output time is always contiguous (TimeMap's
 * own doc comment) — so every stored value has a source instant under the
 * map it was recorded against. `newMap.toOutput` of that same source instant
 * returns null exactly when the NEW cut removed it; `toOutputClamped` is the
 * identical "snap to the nearest kept edge" TimeMap already uses for
 * caption/overlay boundaries, so a value pushed onto a cut lands exactly
 * where the timeline's own dead-region rendering shows the cut's edge.
 * `label` is only for the report string — it carries no behavior.
 */
function remapPoint(
  label: string,
  t: number,
  oldMap: TimeMap,
  newMap: TimeMap,
  reports: string[],
): number {
  const src = oldMap.toSource(t);
  const out = newMap.toOutput(src);
  if (out !== null) return out;
  const clamped = newMap.toOutputClamped(src);
  reports.push(
    `${label} at ${t.toFixed(3)}s fell inside the new cut — snapped to ${clamped.toFixed(3)}s`,
  );
  return clamped;
}

/** Re-anchor output-second decisions through source time across a re-cut.
 * Every stored absolute-output-seconds value (splits, pinned timing, cuts
 * recorded against an older output) maps old-output → source via the OLD
 * TimeMap, then source → new-output via the NEW TimeMap. A value whose
 * source moment was itself removed by the new cut maps to the cut's edge
 * and is reported, never silently dropped. */
export function remapOverridesThroughRecut(
  doc: OverrideDoc,
  oldMap: TimeMap,
  newMap: TimeMap,
): RecutRemap {
  const reports: string[] = [];

  const splits = doc.splits.map((t) => remapPoint("split", t, oldMap, newMap, reports));

  // Record-shaped: rebuild key by key rather than mutate, matching every
  // other `OverrideDoc`-shaping function in overrides.ts (e.g.
  // `reclampPinnedTiming`) — the doc is the user's own data, never edited
  // in place.
  const scenes = Object.fromEntries(
    Object.entries(doc.scenes).map(([id, scene]) => {
      if (!scene.timing) return [id, scene];
      const startSec = remapPoint(`"${id}" pinned start`, scene.timing.startSec, oldMap, newMap, reports);
      const endSec = remapPoint(`"${id}" pinned end`, scene.timing.endSec, oldMap, newMap, reports);
      return [id, { ...scene, timing: { startSec, endSec } }];
    }),
  );

  // `doc.cuts` ranges are themselves absolute-output-seconds, recorded
  // against whichever render-props were current when the user drew them
  // (schema comment on `OverrideDocSchema.cuts`) — a cut made before an
  // EARLIER recut is exactly as stale as a split or a pin, and needs the
  // same old→source→new re-anchoring so the next produce subtracts it from
  // the right place instead of the place it used to be.
  const cuts = doc.cuts.map((cut) => ({
    startSec: remapPoint("cut start", cut.startSec, oldMap, newMap, reports),
    endSec: remapPoint("cut end", cut.endSec, oldMap, newMap, reports),
  }));

  return { doc: { ...doc, splits, scenes, cuts }, reports };
}

/**
 * Subtract `cuts` (output-second ranges) from a cutlist's `keep` segments.
 *
 * Every cut is converted to SOURCE time through the SAME `map` — the
 * automatic, pre-user-cut cutlist's own map — independently of every other
 * cut, not cumulatively through each other (PLAN 2026-08-04 Task 4). That is
 * what keeps a stored cut interpretable the same way on every produce run:
 * `map` is deterministic from the source and `--cleanup` level alone, so as
 * long as neither changes, converting the SAME stored range through the SAME
 * map always yields the same source instant, run after run, with nothing
 * else to track.
 *
 * `remove` segments already in the cutlist pass through untouched; a `keep`
 * segment is split around every cut range that overlaps it. New `remove`
 * segments carry `reason: "user"` (`RemovalReasonSchema` already has this
 * value) so `formatCutReport` — which walks `production.cutlist` — lists a
 * user cut exactly like an automatic one, with no separate report path
 * needed for "what got removed."
 */
export function subtractCutsFromCutlist(
  cutlist: readonly Segment[],
  cuts: readonly { startSec: number; endSec: number }[],
  map: TimeMap,
): Segment[] {
  const ranges = cuts
    .map((c) => ({ start: map.toSource(c.startSec), end: map.toSource(c.endSec) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return [...cutlist];

  const out: Segment[] = [];
  for (const seg of cutlist) {
    if (seg.kind !== "keep") {
      out.push(seg);
      continue;
    }
    // Carve every overlapping range out of this ONE keep segment, left to
    // right, so the result stays sorted and non-overlapping the way
    // `TimeMap`'s constructor requires — a range that also touches a
    // NEIGHBOURING keep segment (separated by an existing automatic cut) is
    // simply considered again there, on its own bounds.
    let cursor = seg.srcIn;
    for (const r of ranges) {
      const overlapStart = Math.max(cursor, r.start);
      const overlapEnd = Math.min(seg.srcOut, r.end);
      if (overlapStart >= overlapEnd) continue;
      if (overlapStart > cursor) out.push({ srcIn: cursor, srcOut: overlapStart, kind: "keep" });
      out.push({ srcIn: overlapStart, srcOut: overlapEnd, kind: "remove", reason: "user", confidence: 1 });
      cursor = overlapEnd;
    }
    if (cursor < seg.srcOut) out.push({ srcIn: cursor, srcOut: seg.srcOut, kind: "keep" });
  }
  return out;
}

/** What applying the user's `cuts` to a cutlist hands back to `produce.ts`. */
export interface ApplyUserCutsResult {
  /** `subtractCutsFromCutlist`'s result — `[...cutlist]` unchanged when
   * `doc.cuts` is empty. */
  cutlist: Segment[];
  /** `new TimeMap(cutlist)`, handed back so the caller doesn't rebuild it. */
  map: TimeMap;
  /**
   * The doc with `splits`/pinned `scenes[id].timing` re-anchored through the
   * cut. `cuts` is deliberately NOT taken from `remapOverridesThroughRecut`'s
   * output — see the inline comment where it's restored, below.
   */
  doc: OverrideDoc;
  /** Every remap report — empty when `changed` is false, so a produce run
   * with nothing to say about it prints nothing. */
  reports: string[];
  /**
   * Whether `doc.splits`/`doc.scenes` actually moved. The write-back guard
   * (PLAN 2026-08-04 Task 4): an untouched `overrides.json` must not be
   * rewritten on every produce run just because `cuts` is non-empty.
   */
  changed: boolean;
  /** Total duration `doc.cuts` removed, for the produce report's headline. */
  removedSec: number;
}

/**
 * Subtract the user's `cuts` from `cutlist`, then re-anchor the REST of the
 * doc (splits, pinned timing) through the resulting re-cut (PLAN 2026-08-04
 * Task 4). This is the ONE sanctioned write to `overrides.json` — every
 * other file `produce.ts` writes is derived and safe to overwrite every run,
 * but this rewrites the user's OWN decisions, and does so because a cut
 * changes the timeline those decisions are anchored to. Rewriting them here
 * is what keeps them meaning the same thing, not silently landing somewhere
 * else the next time the editor opens.
 *
 * `cuts` is ALWAYS interpreted against `map` — the freshly-built automatic
 * cutlist's own map, deterministic from the source and `--cleanup` level, so
 * a stored cut keeps meaning the same source range on every run (see
 * `subtractCutsFromCutlist`'s doc comment). Splits and pinned timing are
 * different: they are written back re-anchored to whatever `map` produces
 * THIS run, so on the NEXT run they are no longer expressed in `map`'s frame
 * — treating `map` as their "old" coordinate space a second time would shift
 * them again by the same amount for nothing. `priorMap` is what fixes that:
 * pass the map their CURRENT values are actually anchored to (in
 * `produce.ts`, reconstructed from the last-written `render-props.json` via
 * `mapFromKeptSpans` — exactly "the render-props the editor showed when the
 * user set them"). Defaults to `map` for a workdir with no prior render, the
 * one case where "automatic map" and "map the user last saw" coincide.
 *
 * A no-op — `cutlist`/`map` unchanged, `changed: false` — when `doc.cuts` is
 * empty, so callers can invoke this unconditionally.
 */
export function applyUserCuts(
  doc: OverrideDoc,
  cutlist: readonly Segment[],
  map: TimeMap,
  priorMap: TimeMap = map,
): ApplyUserCutsResult {
  if (doc.cuts.length === 0) {
    return { cutlist: [...cutlist], map, doc, reports: [], changed: false, removedSec: 0 };
  }
  const newCutlist = subtractCutsFromCutlist(cutlist, doc.cuts, map);
  const newMap = new TimeMap(newCutlist);
  // `cuts: []` going IN: the schema comment on `OverrideDocSchema.cuts`
  // calls out that this function re-anchors every OTHER absolute-output-
  // seconds value in the doc, deliberately not `cuts` itself — remapping a
  // cut through the SAME transition it just caused collapses it to a
  // zero-width point at its own edge (the identical "landed on a cut edge"
  // case this reports for splits/pins), and reporting THAT would tell the
  // user their cut moved when it didn't — it's restored, unchanged, below.
  // Leaving it out of the call entirely (rather than discarding `.cuts` from
  // the result) is what keeps `reports` free of that noise in the first
  // place, not just free of the value.
  const { doc: remapped, reports } = remapOverridesThroughRecut(
    { ...doc, cuts: [] },
    priorMap,
    newMap,
  );
  const changed =
    JSON.stringify({ splits: remapped.splits, scenes: remapped.scenes }) !==
    JSON.stringify({ splits: doc.splits, scenes: doc.scenes });
  return {
    cutlist: newCutlist,
    map: newMap,
    doc: { ...remapped, cuts: doc.cuts },
    reports: changed ? reports : [],
    changed,
    removedSec: map.outputDuration - newMap.outputDuration,
  };
}
