import type { OverrideDoc } from "./overrides";
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
