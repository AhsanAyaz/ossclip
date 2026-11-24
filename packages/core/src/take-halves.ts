import {
  effectiveOverride,
  isPlainTakeKey,
  parkedOverrideKey,
  plainTakeOrdinal,
  type OverrideDoc,
  type ResolvedSplitPoint,
  type SceneOverride,
  type Split,
} from "./overrides";
import type { TimeMap } from "./timemap";

/**
 * Take halves keyed by where their split LANDED (take-framing-identity P2).
 *
 * A take half is `${root}@${splitId}`, and a plain take's root is an ordinal
 * of the clip starts (`fillPlainCues`). A cut in front of the root changes
 * that ordinal, so the piece the render makes is named after a different
 * root than the one its edit was keyed to — the FE Loop short (2026-11-22):
 * `take-2@66055`'s split resolves inside take-3, the half renders as
 * `take-3@66055` unframed, and the edit orphans. This pass moves the edit
 * onto the key the render actually has, and migrates a legacy split (no
 * `ownFraming`) to own its framing without changing what it shows.
 *
 * Its step 7 (refresh a landed take split's `at`, R5-B1) is gone
 * (split-positions-by-source D4): `remapOverridesThroughRecut` now moves
 * every `at` through each re-cut, and `reconcileSplitAnchors` below, run
 * right after this, writes a landed take split's `at` onto its cut with
 * step 7's graphic-window guard — and a graphic split's `src` onto its
 * `at`, which step 7 never reached.
 */

export interface TakeRekeyResult {
  doc: OverrideDoc;
  /** Human sentences for produce to print, one per migration, move or park. */
  notes: string[];
  /** Set by WRITES, never by a deep compare (take-framing-identity "`changed`"):
   * a flag-only migration counts, a left-in-place orphan does not. */
  changed: boolean;
}

/** The mover's order (P2 step 3): by `plainTakeOrdinal`, the same parse
 * `isPlainTakeKey` is, so `take-2` beats `take-10` and a bare `take-N`
 * comes before its own `take-N-k` pieces. Only ever called on candidates,
 * which passed `isPlainTakeKey`, so neither side is null. */
function byTakeOrder(a: string, b: string): number {
  const x = plainTakeOrdinal(a)!;
  const y = plainTakeOrdinal(b)!;
  return x.n - y.n || x.k - y.k;
}

/** The `video`/`pip` a key resolves to through its OWN root with no
 * own-framing set — what a legacy half rendered with. The two objects are
 * fresh copies, so writing them onto a half never shares a record with the
 * root it came from; `rekeyTakeHalves`' unchanged and moved entries are still
 * the input doc's own objects. Undefined when there is neither. */
function mergedFraming(
  scenes: Record<string, SceneOverride>,
  key: string,
): Pick<SceneOverride, "video" | "pip"> | undefined {
  const merged = effectiveOverride(scenes, key, new Set());
  if (!merged?.video && !merged?.pip) return undefined;
  return {
    ...(merged.video ? { video: { ...merged.video } } : {}),
    ...(merged.pip ? { pip: { ...merged.pip } } : {}),
  };
}

const inAnyWindow = (t: number, windows: ReadonlyArray<{ startSec: number; endSec: number }>) =>
  windows.some((w) => t >= w.startSec && t <= w.endSec);

/**
 * Re-key every plain take half to the root its split landed in, and migrate
 * legacy take splits to own framing (take-framing-identity P2 steps 1–6;
 * step 7 moved to `reconcileSplitAnchors`, split-positions-by-source D4).
 *
 * `landed` is pass 2's `splitCuesWithLanding` map for THIS run — root ids,
 * never host ids (R9-1). Only landings on a plain take are handled: graphic
 * halves have their overrides applied before their split, and
 * `take-kept-*` pieces are a different ordinal space.
 *
 * Every choice is made from the INPUT doc before anything is written
 * (R4-B3), so the order splits are visited in cannot change who wins.
 * Moving or parking carries the WHOLE entry (R4-S3). Idempotent: a second
 * call on its own output returns `changed: false`, its only notes the
 * repeating "left as an orphan" ones — deliberately not dropped the way
 * `remapSceneOverrides` drops its quiet orphans, because the collision is
 * actionable and the orphan report keeps telling the author.
 */
export function rekeyTakeHalves(doc: OverrideDoc, landed: ReadonlyMap<string, string>): TakeRekeyResult {
  const input = doc.scenes;
  const scenes: Record<string, SceneOverride> = { ...input };
  const splits: Split[] = [...doc.splits];
  const notes: string[] = [];
  let changed = false;

  // Split-id order: candidates for different splits are disjoint (their
  // suffixes differ), so this only fixes the order of the notes.
  const sids = [...landed.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sid of sids) {
    const rootId = landed.get(sid)!;
    if (!isPlainTakeKey(rootId)) continue;
    const idx = splits.findIndex((s) => s.id === sid);
    // `landed` is built from points resolved off these very splits, so this
    // holds in produce; a caller handing a foreign id gets nothing invented.
    if (idx === -1) continue;

    // Step 1: candidates are input-doc plain take keys whose suffix is
    // EXACTLY this split — parked, graphic, added and kept-block keys never.
    const candidates = Object.keys(input)
      .filter((k) => isPlainTakeKey(k) && k.includes("@") && k.slice(k.indexOf("@") + 1) === sid)
      .sort(byTakeOrder);
    // Step 2.
    const target = `${rootId}@${sid}`;
    // Step 3: choose before writing (R4-B3).
    const incumbent = candidates.includes(target) ? target : undefined;
    const mover = incumbent === undefined ? candidates[0] : undefined;
    const others = candidates.filter((k) => k !== incumbent && k !== mover);

    // Step 4: materialize a legacy split's halves, computed against each
    // key's OWN root from the input doc — what that half rendered with — so
    // flagging the split changes nothing on screen. A candidate whose merged
    // framing is empty keeps its other fields and gets no video/pip (R5-S9).
    //
    // Legacy docs only (take-looks-by-source L5, S4): once `takeLooks` is
    // present nothing reads take-keyed framing, and a look-mode split is
    // never flagged — so the WHOLE block is gated, the flag as well as the
    // copy, or every ⌘B split would be flagged, announced and written on
    // its first run for framing no take key holds. On a legacy doc this
    // runs in the same produce run as the migration, just before it, so a
    // moved legacy half carries its framing into the migration.
    if (doc.takeLooks === undefined && splits[idx]!.ownFraming !== true) {
      for (const k of candidates) {
        const f = mergedFraming(input, k);
        if (f) scenes[k] = { ...input[k]!, ...f };
      }
      if (candidates.length === 0) {
        // No entry anywhere: the half rendered with the LANDED root's
        // framing, so that is what it now owns. An empty result is not
        // stored — there is nothing to own.
        const f = mergedFraming(input, target);
        if (f) scenes[target] = { props: {}, elements: {}, ...f };
      }
      splits[idx] = { ...splits[idx]!, ownFraming: true };
      notes.push(`split ${sid} now owns its framing`);
      changed = true;
    }

    // Step 5: the mover's whole (materialized) entry takes the target key.
    // Its framing replaces whatever the target would have inherited: the
    // split is flagged, so the new root's framing never layers under it.
    if (mover !== undefined) {
      scenes[target] = scenes[mover]!;
      delete scenes[mover];
      notes.push(`edit for ${mover} re-keyed to ${target} — its split now falls in ${rootId}`);
      changed = true;
    }

    // Step 6: everyone else parks whole. A held park slot keeps its
    // incumbent and the entry stays put as an orphan `applyOverrides`
    // reports — today's posture, and no write, so `changed` stays false.
    for (const k of others) {
      const parkKey = parkedOverrideKey(k);
      if (Object.prototype.hasOwnProperty.call(input, parkKey)) {
        notes.push(`edit for ${k} left as an orphan — its park slot is taken`);
        continue;
      }
      scenes[parkKey] = scenes[k]!;
      delete scenes[k];
      notes.push(`edit for ${k} parked — ${target} already has its own edit`);
      changed = true;
    }
  }

  return { doc: { ...doc, scenes, splits }, notes, changed };
}

/** What `reconcileSplitAnchors` hands back — `TakeRekeyResult`'s shape and
 * its `changed`-by-writes rule. */
export type SplitReconcileResult = TakeRekeyResult;

/** How far apart the two anchors may sit before one is rewritten: a
 * millisecond, the precision every split writer rounds to. Under it, the
 * float residue of a `toOutput`/`toSource` round trip (FE Loop: 0.12 ms for
 * fc1 and 66055) would otherwise rewrite the file on every run. */
const RECONCILE_EPS_SEC = 0.001;

const roundMs = (t: number): number => Math.round(t * 1000) / 1000;

/**
 * Write each split's idle anchor onto the one that cut
 * (split-positions-by-source R7-4, R8-3), after both passes of THIS run.
 *
 * Every split cuts in exactly one pass (D2), with one of its two anchors:
 * a graphic split at `at`, a take split at `toOutput(src)`. The other anchor
 * is unread that run, and left alone it drifts — which is how a split came
 * to be cut twice in two places (the D5 note). So, for splits carrying BOTH
 * anchors only (R7 S3 — a src-only split gains no `at`, the "none is
 * invented" rule in `SplitSchema`, and a src-less one gains no `src` here):
 *
 *  - a pass-1 survivor (`pass1Surviving`, `survivingLandings`' set) gets
 *    `src = round(map.toSource(at))` — the graphic keeps its rendered
 *    position, and the source anchor now names that footage;
 *  - a pass-2 landing (`pass2Landed`, pass 2's `landed`, taken BEFORE the
 *    final hidden drop — eligibility is the landing, R7 S1) gets
 *    `at = round(point)`, so the next graphic pass and the editor read the
 *    moment the take was cut. NOT when the old `at` or the new point lies
 *    in any of `graphicWindows` — the pass-1 graphic cues' windows before
 *    any hidden drop, closed: an old `at` there is what keeps that split off
 *    the graphic's footage today, and a new one there would cut a hidden
 *    graphic on the next run and bring its deleted half back (step 7's
 *    guard, R6-B1, R7-B1, r7 S2). Such a split keeps a stale `at`,
 *    harmlessly: pass 1 cannot land it (r8 m11).
 *
 * A split that landed nowhere is left as it is. A difference of
 * `RECONCILE_EPS_SEC` or less writes nothing, which is what makes a second
 * run on the same clock a no-op. `map` is this run's final map.
 */
export function reconcileSplitAnchors(
  doc: OverrideDoc,
  pass1Surviving: ReadonlySet<string>,
  pass2Landed: ReadonlyMap<string, string>,
  pass2Points: readonly ResolvedSplitPoint[],
  graphicWindows: ReadonlyArray<{ startSec: number; endSec: number }>,
  map: TimeMap,
): SplitReconcileResult {
  const notes: string[] = [];
  let changed = false;
  const splits = doc.splits.map((s): Split => {
    if (s.at === undefined || s.src === undefined) return s;
    let next: Split | undefined;
    if (pass1Surviving.has(s.id)) {
      const exact = map.toSource(s.at);
      if (Math.abs(exact - s.src) > RECONCILE_EPS_SEC) next = { ...s, src: roundMs(exact) };
    } else if (pass2Landed.has(s.id)) {
      const point = pass2Points.find((p) => p.id === s.id);
      if (
        point !== undefined &&
        Math.abs(point.at - s.at) > RECONCILE_EPS_SEC &&
        !inAnyWindow(s.at, graphicWindows) &&
        !inAnyWindow(point.at, graphicWindows)
      ) {
        next = { ...s, at: roundMs(point.at) };
      }
    }
    if (next === undefined) return s;
    notes.push(`split ${s.id} anchors reconciled (at ${next.at!.toFixed(3)}s, source ${next.src!.toFixed(3)}s)`);
    changed = true;
    return next;
  });
  return { doc: changed ? { ...doc, splits } : doc, notes, changed };
}
