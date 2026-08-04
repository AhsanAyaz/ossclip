import type { OverrideDoc } from "./overrides";
import type { Segment } from "./schema";
import { mapsClose, TimeMap } from "./timemap";

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

/** One entry of `OverrideDoc.cuts` — see the schema comment on `src`. */
export type UserCut = OverrideDoc["cuts"][number];

/**
 * Deep-equal with float tolerance — a "did this actually change" check for
 * values that passed through TimeMap arithmetic and a JSON round-trip, where
 * exact equality flags noise (review fix wave, PLAN 2026-08-04 Task 4,
 * finding "Minor"): a 1-ulp drift is not a user edit, and treating it as one
 * rewrites `overrides.json` — a user-owned file whose timestamp and diffs
 * matter — on every produce run for nothing.
 */
function closeEnough(a: unknown, b: unknown, eps: number): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => closeEnough(v, b[i], eps));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) =>
      closeEnough((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps),
    );
  }
  return a === b;
}

/** Tolerance for every float comparison in this module — generous enough to
 * absorb a JSON round-trip and a chain of TimeMap arithmetic, tight enough
 * that a genuine sub-millisecond user nudge still counts as a change. */
const EPS = 1e-6;

/**
 * Resolve each user cut to a SOURCE-time range to remove, and to a `src`
 * value worth persisting.
 *
 * A cut WITH `src` already is stable and settled: `src` is used directly,
 * unconverted, every run, forever — it is never re-derived from
 * `startSec`/`endSec` again, because there is no map left that could
 * re-derive it correctly (review fix wave finding 1's Bug A: a cut's own
 * source range has no faithful representation in any output frame taken
 * AFTER that cut's own removal).
 *
 * A cut WITHOUT `src` is fresh — drawn by the user against `priorMap`, the
 * render-props they were looking at (the schema comment's "output seconds of
 * the CURRENT render-props") — so it converts through `priorMap.toSource`,
 * NOT `map` (this run's freshly-rebuilt automatic cutlist, which has no
 * relationship to what the user was looking at once anything has drifted:
 * confirmed on the dogfood workdir, where an unrelated automatic-cutlist
 * change put "output 31s in `map`" 5.8s away from "output 31s in
 * `priorMap`"). `priorMap` missing entirely (no readable render-props.json —
 * a first-ever produce, or a corrupt workdir) falls back to `map`, WITH a
 * report — never silently, per the same "nothing moves without saying so"
 * rule as `remapPoint`.
 */
export interface ResolvedCuts {
  /** Source-time ranges to remove, one per cut with a non-degenerate result. */
  ranges: { start: number; end: number }[];
  /** `cuts`, each carrying a resolved `src` — the only thing about a cut
   * that ever changes on write-back; `startSec`/`endSec` are untouched. */
  cuts: UserCut[];
  reports: string[];
}

export function resolveCutSourceRanges(
  cuts: readonly UserCut[],
  priorMap: TimeMap | null,
  map: TimeMap,
): ResolvedCuts {
  const reports: string[] = [];
  const resolved: UserCut[] = [];
  const ranges: { start: number; end: number }[] = [];
  for (const cut of cuts) {
    let src = cut.src;
    if (!src) {
      let anchor = priorMap;
      if (!anchor) {
        reports.push(
          `cut ${cut.startSec.toFixed(3)}–${cut.endSec.toFixed(3)}s has no render-props to ` +
            "anchor to — used this run's automatic cutlist instead; verify placement",
        );
        anchor = map;
      }
      src = { startSec: anchor.toSource(cut.startSec), endSec: anchor.toSource(cut.endSec) };
    }
    resolved.push(src === cut.src ? cut : { ...cut, src });
    if (src.endSec > src.startSec) ranges.push({ start: src.startSec, end: src.endSec });
  }
  return { ranges, cuts: resolved, reports };
}

/**
 * Subtract source-time `ranges` from a cutlist's `keep` segments.
 *
 * `remove` segments already in the cutlist pass through untouched; a `keep`
 * segment is split around every range that overlaps it. New `remove`
 * segments carry `reason: "user"` (`RemovalReasonSchema` already has this
 * value) so `formatCutReport` — which walks `production.cutlist` — lists a
 * user cut exactly like an automatic one, with no separate report path
 * needed for "what got removed."
 */
export function subtractRangesFromCutlist(
  cutlist: readonly Segment[],
  ranges: readonly { start: number; end: number }[],
): Segment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [...cutlist];

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
    for (const r of sorted) {
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
  /** `subtractRangesFromCutlist`'s result — `[...cutlist]` unchanged when
   * `doc.cuts` is empty. */
  cutlist: Segment[];
  /** `new TimeMap(cutlist)`, handed back so the caller doesn't rebuild it. */
  map: TimeMap;
  /**
   * The doc with `cuts[*].src` resolved and `splits`/pinned
   * `scenes[id].timing` re-anchored where drift was found. `cuts[*].startSec`/
   * `endSec` are always the user's original values — see `resolveCutSourceRanges`.
   */
  doc: OverrideDoc;
  /** Every report worth surfacing — missing-anchor fallbacks (always) plus
   * remap reports (only when a re-anchor actually happened). Shown
   * regardless of `changed`: these are about DECISIONS, not about whether a
   * file got written. */
  reports: string[];
  /**
   * Whether `doc` actually differs from what was read (a cut resolved its
   * `src` for the first time, and/or splits/pins moved). The write-back
   * guard (PLAN 2026-08-04 Task 4 + review fix wave finding 3): an untouched
   * `overrides.json` must not be rewritten on every produce run.
   */
  changed: boolean;
  /** Total duration this run's cuts removed, for the produce report's headline. */
  removedSec: number;
}

/**
 * Subtract the user's `cuts` from `cutlist`, then re-anchor `splits`/pinned
 * timing through whatever drift is found between `priorMap` (the frame the
 * doc's stored values are CURRENTLY anchored to — `produce.ts` reconstructs
 * this from the last-written `render-props.json`) and this run's final map
 * (PLAN 2026-08-04 Task 4). This is the ONE sanctioned write to
 * `overrides.json` — every other file `produce.ts` writes is derived and
 * safe to overwrite every run, but this rewrites the user's OWN decisions,
 * and does so because the timeline those decisions are anchored to keeps
 * moving out from under them. Rewriting them here is what keeps them meaning
 * the same thing, not silently landing somewhere else the next time the
 * editor opens.
 *
 * Two gates, deliberately independent (review fix wave finding 3):
 *  - Subtracting cuts from the cutlist only happens when `doc.cuts` is
 *    non-empty — nothing to subtract otherwise.
 *  - Re-anchoring `splits`/`scenes[*].timing` happens whenever `priorMap` is
 *    available AND differs (span-for-span, float-tolerant) from this run's
 *    final map — REGARDLESS of whether `cuts` is empty. A doc with cuts
 *    already applied, then emptied again (the editor's Restore gesture), has
 *    splits/pins still sitting in last run's POST-cut frame with nothing in
 *    `cuts` left to drive a re-anchor off of; gating on `cuts.length` alone
 *    stranded them. The same gate also catches the automatic cutlist itself
 *    drifting for a reason that has nothing to do with the user's cuts at
 *    all (a `--cleanup` change, a repair-pass improvement) — confirmed for
 *    real on the dogfood workdir during verification.
 *
 * `priorMap === null` (no readable render-props.json: first-ever produce, or
 * a corrupt workdir) skips re-anchoring entirely — there is nothing to
 * compare against — but a `src`-less cut still resolves, falling back to
 * `map` with a report (see `resolveCutSourceRanges`).
 */
export function applyUserCuts(
  doc: OverrideDoc,
  cutlist: readonly Segment[],
  map: TimeMap,
  priorMap: TimeMap | null,
): ApplyUserCutsResult {
  let newCutlist: Segment[] = [...cutlist];
  let cuts = doc.cuts;
  let reports: string[] = [];
  if (doc.cuts.length > 0) {
    const resolved = resolveCutSourceRanges(doc.cuts, priorMap, map);
    newCutlist = subtractRangesFromCutlist(cutlist, resolved.ranges);
    cuts = resolved.cuts;
    reports = resolved.reports;
  }
  const newMap = new TimeMap(newCutlist);
  const removedSec = map.outputDuration - newMap.outputDuration;
  const cutsChanged = !closeEnough(cuts, doc.cuts, EPS);

  let finalDoc: OverrideDoc = { ...doc, cuts };
  let reanchored = false;
  if (priorMap !== null && !mapsClose(priorMap, newMap, EPS)) {
    // `cuts: []` going IN: this function re-anchors `splits`/pinned timing
    // only — see `resolveCutSourceRanges` above for why `cuts` itself is
    // handled separately and never round-tripped through `remapPoint`
    // (remapping a cut through the very recut it caused collapses it to a
    // zero-width point at its own edge, the identical "landed on a cut
    // edge" case reported for splits/pins — and reporting THAT would tell
    // the user their cut moved when it didn't).
    const { doc: remapped, reports: remapReports } = remapOverridesThroughRecut(
      { ...doc, cuts: [] },
      priorMap,
      newMap,
    );
    if (!closeEnough(remapped.splits, doc.splits, EPS) || !closeEnough(remapped.scenes, doc.scenes, EPS)) {
      finalDoc = { ...remapped, cuts };
      reports = [...reports, ...remapReports];
      reanchored = true;
    }
  }

  return {
    cutlist: newCutlist,
    map: newMap,
    doc: finalDoc,
    reports,
    changed: cutsChanged || reanchored,
    removedSec,
  };
}
