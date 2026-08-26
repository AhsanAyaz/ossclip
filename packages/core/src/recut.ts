import { isSrcTiming, SPLIT_MIN_PIECE_SEC, type OverrideDoc } from "./overrides";
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
 *
 * Exported since cut review step 4: `retimeForPreview` (retime-preview.ts)
 * moves every output-timed render prop through THIS function so the editor's
 * live post-veto preview and produce's own re-anchoring can never disagree
 * about what "the same moment on the new clock" means.
 */
export function remapPoint(
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

  // Only `at` moves: a split's `id` is minted once and never recomputed
  // (§137, `SplitSchema`) — re-deriving it here is what renamed the half and
  // orphaned the overrides on it.
  const splits = doc.splits.map((s) => {
    // A src-anchored split passes through UNTOUCHED — the `doc.cuts`
    // non-remap rule below, for the same reason `cleanup.kept` needs no
    // entry here at all: source time is stable across every re-cut, and
    // `resolveSplitPoints` re-derives the output instant fresh at each
    // application. Only the src-less legacy shape still carries an
    // old-clock `at` worth moving.
    if (s.src !== undefined) return s;
    const before = reports.length;
    const atBefore = s.at!;
    const at = remapPoint(`split "${s.id}"`, atBefore, oldMap, newMap, reports);
    // `splitCues` needs a cue with `at >= startSec + SPLIT_MIN_PIECE_SEC` AND
    // `at <= endSec - SPLIT_MIN_PIECE_SEC`. Output time runs [0,
    // outputDuration] and every cue lives inside it, so a split closer than
    // that to EITHER end can match no cue at all and is skipped: the half it
    // named stops existing, every override keyed to it is orphaned, and the
    // scene the user deleted comes back. Before §137 the only trace of that
    // was produce.ts's generic `edit for scene-0@600 dropped — the plan no
    // longer has that scene`, which blames the plan and names neither the
    // split nor the re-cut that moved it. Name both.
    //
    // Start: the field case — a 0.6s cut pushed a split at 0.6s to 0.
    // End: `at` need not move at all; cutting the tail moves `outputDuration`
    // out from under it (a split at 9.5s of 10s, with 9.6–10.0 cut).
    //
    // Both fire only when THIS re-cut is what pushed the split past the bar:
    // `reports` is the "a value MOVED" channel (see `RecutRemap`), and a
    // split already past it beforehand is a pre-existing condition — one the
    // editor's own SPLIT_MIN_PIECE_SEC guard refuses to create — that would
    // otherwise be re-announced on every identity re-cut, forever.
    //
    // The two guards look mirrored and are NOT symmetric about a pure shift,
    // which is worth stating because reading them as a matched pair invites
    // "a shift can never be reported" — false at the start. The END bar is
    // `outputDuration - MIN`, so it slides with the timeline and both sides of
    // that comparison move together. The START bar is absolute 0 + MIN and
    // does not slide, so `at < MIN && s.at >= MIN` DOES fire under a pure
    // shift — and must: trimming 0.6s off the front is exactly what dragged a
    // split at 0.6s down to 0 in the field case (recut.test.ts, "reports the
    // split whose remapped `at` can no longer divide anything").
    //
    // `remapPoint` states the new time itself when it snapped this split onto
    // a cut edge; restating it here would read as a second, separate move
    // rather than the consequence of the one already reported.
    const where = reports.length > before ? "is" : `is now ${at.toFixed(3)}s —`;
    if (at < SPLIT_MIN_PIECE_SEC && atBefore >= SPLIT_MIN_PIECE_SEC) {
      reports.push(
        `split "${s.id}" ${where} too close to the start to divide a scene, ` +
          `so any edit on its second half will not apply`,
      );
      // `else`, not a second `if`: an output shorter than two minimum pieces
      // trips both bars for the same split, and one line already says it can
      // no longer divide anything — two would read as two problems.
    } else if (
      at > newMap.outputDuration - SPLIT_MIN_PIECE_SEC &&
      atBefore <= oldMap.outputDuration - SPLIT_MIN_PIECE_SEC
    ) {
      reports.push(
        `split "${s.id}" ${where} too close to the end to divide a scene, ` +
          `so any edit on its second half will not apply`,
      );
    }
    return { ...s, at };
  });

  // Record-shaped: rebuild key by key rather than mutate, matching every
  // other `OverrideDoc`-shaping function in overrides.ts (e.g.
  // `reclampPinnedTiming`) — the doc is the user's own data, never edited
  // in place.
  const scenes = Object.fromEntries(
    Object.entries(doc.scenes).map(([id, scene]) => {
      if (!scene.timing) return [id, scene];
      // A SRC-anchored pin is not remapped, for the same reason `cuts` below
      // and `cleanup.kept` are not: source seconds are the one clock a re-cut
      // cannot move, so re-anchoring one could only ever corrupt it — and a
      // pin inside material THIS re-cut removed has no image on the new
      // clock at all, which `remapPoint` would answer by clamping it onto
      // the seam instead of leaving it inert (`resolveTimingPin` is where
      // that verdict belongs). Legacy old-clock pins keep the remap verbatim.
      if (isSrcTiming(scene.timing)) return [id, scene];
      const startSec = remapPoint(`"${id}" pinned start`, scene.timing.startSec, oldMap, newMap, reports);
      const endSec = remapPoint(`"${id}" pinned end`, scene.timing.endSec, oldMap, newMap, reports);
      return [id, { ...scene, timing: { startSec, endSec } }];
    }),
  );

  // `doc.cuts` is deliberately NOT remapped here (PLAN 2026-08-04 Task 4c
  // prerequisite cleanup; review fix wave finding 1 is what made the old
  // comment here wrong). The design this function was first written against
  // ("a cut is exactly as stale as a split or a pin, remap it the same way")
  // changed under it: `resolveCutSourceRanges` is what interprets a cut now,
  // through `priorMap` — a bare old→source→new point remap through the very
  // recut a cut CAUSED collapses it to a zero-width point at its own edge
  // (Task 4b's Bug A), and doing that here would also silently DROP any
  // resolved `src` the caller's `doc` already carries, since this function
  // has no way to know a cut's `src` is settled and irreplaceable (schema
  // comment on `OverrideDocSchema.cuts`). `applyUserCuts` is the only place
  // `cuts` gets resolved, and its one call into this function passes
  // `cuts: []` specifically so this function is never asked to make that
  // call — the spread below carries the caller's `cuts` through untouched,
  // whatever they are.
  return { doc: { ...doc, splits, scenes }, reports };
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

/** What `pruneHidesInsideCuts` hands back: the doc (same reference when
 * nothing was pruned — the caller's changed-gate reads `pruned.length`), and
 * the retired keys so produce can SAY what it retired. */
export interface PrunedHides {
  doc: OverrideDoc;
  pruned: string[];
}

/**
 * Retire `captionWordsHidden` entries whose word the final cutlist REMOVES
 * (§59b revisited 2026-08-18 — the "captions + video" delete gesture writes
 * both a hide and a cut in one commit).
 *
 * Once the cut lands, `buildCaptionLines` drops the word before the hide
 * layer ever sees it, so the hide key would report `found: null` ("the cut
 * removed it", `captionHideDropLine`) on every subsequent run forever — the
 * cut SUPERSEDES the hide, the same superseded philosophy `overrides.ts`'s
 * caption-key migration applies. Hides whose source instant is OUTSIDE every
 * removed segment are kept verbatim — as are keys that are not §137 `w<ms>`
 * anchors at all, which name no instant this can test (see the guard below).
 *
 * HALF-OPEN interval (`srcIn <= src < srcOut`), on purpose — the two edges
 * are NOT symmetric. A word starting exactly at `srcIn` IS cut: that is
 * precisely where the FIRST word of a captions+video delete lands (its
 * srcStart round-trips through the TimeMap to the resolved cut's own srcIn),
 * and `mapWord` clamps that instant into the removal and drops the word — a
 * strictly-inside test never retired the gesture's own first hide, leaving
 * it a permanent `found: null` drop report. A word starting exactly at
 * `srcOut` belongs to the NEXT kept span (`buildCaptionLines` still emits it
 * — a seam instant has a kept-side preimage, `timemap.ts`), so its hide is
 * still doing work and must survive.
 */
export function pruneHidesInsideCuts(doc: OverrideDoc, cutlist: readonly Segment[]): PrunedHides {
  const pruned: string[] = [];
  const kept: OverrideDoc["captionWordsHidden"] = {};
  for (const [key, entry] of Object.entries(doc.captionWordsHidden)) {
    // SOURCE-KEYED ONLY, parsed and not coerced. `captionWordsHidden` is an
    // unpinned `z.record` (unlike `CaptionRangeEditSchema`'s `/^w\d+$/`), so a
    // hand-edited or legacy-keyed doc reaches here: a POSITIONAL key like "17"
    // would slice to "7", parse as 7ms, land inside any early cut and be
    // deleted with nothing said. The editor guards the identical case and
    // states the rule (`apps/editor/src/useEdits.ts:587-600`): only §137
    // `w<ms>` keys carry an interval-testable instant, and an entry this
    // function cannot honestly locate is KEPT.
    if (!/^w\d+$/.test(key)) {
      kept[key] = entry;
      continue;
    }
    // `captionKeyFor`'s quantization inverted (`w${Math.round(sec * 1000)}`,
    // overrides.ts): the key IS the word's source instant, ms-quantized.
    const srcSec = parseInt(key.slice(1), 10) / 1000;
    const removed = cutlist.some(
      (seg) => seg.kind === "remove" && srcSec >= seg.srcIn && srcSec < seg.srcOut,
    );
    if (removed) pruned.push(key);
    else kept[key] = entry;
  }
  if (pruned.length === 0) return { doc, pruned };
  return { doc: { ...doc, captionWordsHidden: kept }, pruned };
}
