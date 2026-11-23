import {
  applyOverrides,
  ownFramingSplitIds,
  resolveSplitPoints,
  resolveSrcTimingPins,
  splitCuesWithLanding,
  type OverrideDoc,
} from "../src/overrides";
import { fillPlainCues } from "../src/fill";
import { carveKeptTakes, type KeptRange } from "../src/kept-takes";
import { reconcileSplitAnchors, rekeyTakeHalves, type TakeRekeyResult } from "../src/take-halves";
import { applyTakeLooks } from "../src/take-looks";
import { migrateTakeLooks } from "../src/take-looks-migrate";
import { TimeMap, mapFromKeptSpans, type KeptSpan } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";

/**
 * The FE Loop short as produce sees it (take-looks-by-source R6-9, R7-10),
 * shared by take-looks-migration.test.ts and take-looks-pipeline.test.ts.
 * Inline literals, copied once from the real workdirs (never read at test
 * time — they live outside the repo and are the author's project):
 *
 * - `SPANS`: the 10 spans of `work/FE Loop-116d3cbc/render-props.json`;
 * - `FE_SPLITS_A`: the splits of that workdir's `overrides.json`, the
 *   pre-phase-1 shape (`66055` unflagged, `at` still on the old clock);
 * - `TAKE_CLIP_STARTS`: `work-framing-test/…/render-props.json`'s
 *   `takeClipStarts` — produce's REAL list, the span `outIn`s plus the kept
 *   edges, 161.29118 included (R7-10 withdrew R6-9's "equals the spans").
 *
 * Not a test file (no `.test.`), so vitest does not collect it.
 */

export const SPANS: KeptSpan[] = [
  { srcIn: 1.30531, srcOut: 9.519689999999999, outIn: 0, outOut: 8.214379999999998 },
  { srcIn: 10.6995, srcOut: 20.435, outIn: 8.214379999999998, outOut: 17.949879999999997 },
  { srcIn: 20.752, srcOut: 24.518, outIn: 17.949879999999997, outOut: 21.71588 },
  { srcIn: 29.304, srcOut: 68.3526, outIn: 21.71588, outOut: 60.76447999999999 },
  { srcIn: 71.0059, srcOut: 81.0611, outIn: 60.76447999999999, outOut: 70.81967999999999 },
  { srcIn: 81.6515, srcOut: 120.401, outIn: 70.81967999999999, outOut: 109.56917999999999 },
  { srcIn: 121.366, srcOut: 133.935, outIn: 109.56917999999999, outOut: 122.13817999999999 },
  { srcIn: 136.737, srcOut: 166.219, outIn: 122.13817999999999, outOut: 151.62018 },
  { srcIn: 167.648, srcOut: 176.577, outIn: 151.62018, outOut: 160.54918 },
  { srcIn: 179.797, srcOut: 187.327, outIn: 160.54918, outOut: 168.07918 },
];

export const TAKE_CLIP_STARTS = [
  0, 8.214379999999998, 17.949879999999997, 21.71588, 60.76447999999999, 70.81967999999999,
  109.56917999999999, 122.13817999999999, 151.62018, 160.54918, 151.62018, 161.29118,
];

/** The vetoed cleanup range produce carved into `take-kept-166219` (its
 * `kept` tag in the copy's render-props). */
export const KEPT: KeptRange[] = [{ srcIn: 166.219, srcOut: 180.539 }];

export const FE_SPLITS_A = [
  { at: 18.267, src: 20.752, id: "20752" },
  { src: 24.518, id: "24518" },
  { at: 58.784, src: 66.055, id: "66055" },
  { src: 167.648, id: "167648" },
  { src: 176.577, id: "176577" },
];

/** Fixture (b): the same splits after one upgraded run — `66055` flagged
 * by phase 1, and its `at` on this clock. Phase 1's step 7 wrote that
 * 58.467 once; `reconcileSplitAnchors` now does (split-positions-by-source
 * R7-4, R9-3), so the fixture is the same value with a new writer. */
export const FE_SPLITS_B = FE_SPLITS_A.map((s) =>
  s.id === "66055" ? { ...s, at: 58.467, ownFraming: true } : s,
);

/** The two framing edits, as the workdir's `overrides.json` holds them. */
export const TAKE_2_VIDEO = { scale: 2.2, dx: 814.4 };
export const HALF_VIDEO = { scale: 2.2, dx: -664.8 };

const graphic = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  layout: "blurred-behind",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%" },
  startSec,
  endSec,
});

/** The run's two graphics (`shot-s1`, `added-1`) at their windows on the
 * FE Loop clock. Only their windows matter here: they are the gaps the
 * fill leaves, so the take numbering is the real one. */
export const FE_GRAPHICS: SceneCue[] = [
  graphic("shot-s1", 10.084879999999998, 17.949879999999997),
  graphic("added-1", 165.24718000000001, 166.89118000000002),
];

export const feMap = (): TimeMap => mapFromKeptSpans(SPANS);

/** Produce's clip-start formula (`produce.ts`, `takeClipStarts`): span
 * starts, then each kept range's mapped edges. For the pipeline tests' own
 * clocks; on the FE Loop clock it reproduces `TAKE_CLIP_STARTS`. */
export function clipStartsFor(map: TimeMap, kept: readonly KeptRange[]): number[] {
  const edges = kept.flatMap((r) => {
    const a = map.toOutput(r.srcIn);
    const b = map.toOutput(r.srcOut);
    return [...(a !== null ? [a] : []), ...(b !== null ? [b] : [])];
  });
  return [...map.spans.map((s) => s.outIn), ...edges];
}

export interface PipelineRun {
  /** The second `applyOverrides`' cues: "before" (spec Tests), the same
   * pipeline with the migration and the look pass skipped. */
  overridden: SceneCue[];
  /** The cues `resolveItemTimings` receives: looked when migrated. */
  cues: SceneCue[];
  rekey: TakeRekeyResult;
  /** `reconcileSplitAnchors`, run right after the re-key as produce does. */
  reconcile: TakeRekeyResult;
  migration: ReturnType<typeof migrateTakeLooks>;
  /** The doc produce writes back. */
  doc: OverrideDoc;
}

/**
 * Produce's take steps, in produce's order (take-looks-by-source L2 "Produce
 * order", L3 "Where"): fill → carve → `resolveSplitPoints` →
 * `splitCuesWithLanding` → `rekeyTakeHalves` → `reconcileSplitAnchors`
 * (split-positions-by-source R9-3) → the second `applyOverrides` (on the
 * src-pinned doc) → `migrateTakeLooks` → the gated `applyTakeLooks`.
 *
 * The graphic pass is not modelled: `graphics` arrive unsplit and no split
 * here lands on one, so every split is a pass-2 split and the pass-1
 * survivor set is empty. `split-positions-pipeline.test.ts` runs both.
 */
export function runTakePipeline(
  doc: OverrideDoc,
  opts: {
    map?: TimeMap;
    graphics?: readonly SceneCue[];
    clipStarts?: readonly number[];
    kept?: readonly KeptRange[];
  } = {},
): PipelineRun {
  const map = opts.map ?? feMap();
  const graphics = opts.graphics ?? FE_GRAPHICS;
  const kept = opts.kept ?? KEPT;
  const clipStarts = opts.clipStarts ?? clipStartsFor(map, kept);
  const filled0 = fillPlainCues(graphics, { outputDurationSec: map.outputDuration, clipStarts: [...clipStarts] });
  const { cues: filled } = carveKeptTakes(filled0, kept, map);
  const resolved = resolveSplitPoints(doc.splits, map);
  const { cues: split, landed } = splitCuesWithLanding(filled, resolved.points);
  const rekey = rekeyTakeHalves(doc, landed);
  const reconcile = reconcileSplitAnchors(
    rekey.doc,
    new Set(),
    landed,
    resolved.points,
    graphics.map((g) => ({ startSec: g.startSec, endSec: g.endSec })),
    map,
  );
  const { cues: overridden } = applyOverrides(split, resolveSrcTimingPins(reconcile.doc, map).doc);
  const migration = migrateTakeLooks(reconcile.doc, overridden, map, ownFramingSplitIds(reconcile.doc.splits));
  const looks = migration.doc.takeLooks;
  const cues = looks !== undefined ? applyTakeLooks(overridden, looks, map) : overridden;
  return { overridden, cues, rekey, reconcile, migration, doc: migration.doc };
}

/** The plain cue playing source second `src` on `map`. */
export function pieceAt(cues: readonly SceneCue[], map: TimeMap, src: number): SceneCue | undefined {
  const at = map.toOutput(src);
  if (at === null) return undefined;
  return cues.find((c) => c.kind === "plain" && c.startSec <= at && at < c.endSec);
}
