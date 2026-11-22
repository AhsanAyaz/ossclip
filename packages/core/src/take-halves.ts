import {
  effectiveOverride,
  isPlainTakeKey,
  splitRootId,
  type OverrideDoc,
  type ResolvedSplitPoint,
  type SceneOverride,
  type Split,
} from "./overrides";

/**
 * Take halves keyed by where their split LANDED (take-framing-identity P2).
 *
 * A take half is `${root}@${splitId}`, and a plain take's root is an ordinal
 * of the clip starts (`fillPlainCues`). A cut in front of the root changes
 * that ordinal, so the piece the render makes is named after a different
 * root than the one its edit was keyed to — the FE Loop short (2026-11-22):
 * `take-2@66055`'s split resolves inside take-3, the half renders as
 * `take-3@66055` unframed, and the edit orphans. This pass moves the edit
 * onto the key the render actually has, migrates a legacy split (no
 * `ownFraming`) to own its framing without changing what it shows, and
 * refreshes a landed take split's `at` so the editor previews it where the
 * render put it (R5-B1).
 */

export interface TakeRekeyResult {
  doc: OverrideDoc;
  /** Human sentences for produce to print, one per migration, move, park or refresh. */
  notes: string[];
  /** Set by WRITES, never by a deep compare (take-framing-identity "`changed`"):
   * a flag-only migration counts, a left-in-place orphan does not. */
  changed: boolean;
}

/** overrides.ts's park suffix (`PARKED_SUFFIX`), restated as
 * `added-scenes.ts` does — the test pins it against `isParkedOverrideKey`
 * so the two spellings cannot drift. */
const PARKED_SUFFIX = "#orphaned";

const TAKE_ROOT = /^take-(\d+)(?:-(\d+))?$/;

/** The mover's sort key (P2 step 3): the take index numerically, so `take-2`
 * beats `take-10`; then a bare `take-N` (k = -1) before its own `take-N-k`
 * pieces, which sort by k. */
function takeOrder(key: string): [number, number] {
  const m = TAKE_ROOT.exec(splitRootId(key))!;
  return [Number(m[1]), m[2] === undefined ? -1 : Number(m[2])];
}

function byTakeOrder(a: string, b: string): number {
  const [an, ak] = takeOrder(a);
  const [bn, bk] = takeOrder(b);
  return an - bn || ak - bk;
}

/** The `video`/`pip` a key resolves to through its OWN root with no
 * own-framing set — what a legacy half rendered with — as fresh copies, so
 * the output never aliases the input doc. Undefined when there is neither. */
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
 * Re-key every plain take half to the root its split landed in, migrate
 * legacy take splits to own framing, and refresh a landed take split's `at`
 * (take-framing-identity P2 steps 1–7).
 *
 * `landed` is `splitCuesWithLanding`'s map for THIS run; `points` the
 * resolved split points it consumed; `graphicWindows` the windows of
 * produce's pass-1 graphic cues BEFORE hidden ones drop (step 7). Only
 * landings on a plain take are handled: graphic halves have their overrides
 * applied before their split, and `take-kept-*` pieces are a different
 * ordinal space.
 *
 * Every choice is made from the INPUT doc before anything is written
 * (R4-B3), so the order splits are visited in cannot change who wins.
 * Moving or parking carries the WHOLE entry (R4-S3). Idempotent: a second
 * call on its own output returns `changed: false`, its only notes the
 * repeating "left as an orphan" ones — deliberately not dropped the way
 * `remapSceneOverrides` drops its quiet orphans, because the collision is
 * actionable and the orphan report keeps telling the author.
 */
export function rekeyTakeHalves(
  doc: OverrideDoc,
  landed: ReadonlyMap<string, string>,
  points: readonly ResolvedSplitPoint[],
  graphicWindows: ReadonlyArray<{ startSec: number; endSec: number }>,
): TakeRekeyResult {
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
    if (splits[idx]!.ownFraming !== true) {
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
      const parkKey = `${k}${PARKED_SUFFIX}`;
      if (Object.prototype.hasOwnProperty.call(input, parkKey)) {
        notes.push(`edit for ${k} left as an orphan — its park slot is taken`);
        continue;
      }
      scenes[parkKey] = scenes[k]!;
      delete scenes[k];
      notes.push(`edit for ${k} parked — ${target} already has its own edit`);
      changed = true;
    }

    // Step 7: refresh `at` onto the clock this render split on (R5-B1), so
    // the editor — which splits `{at, src}` splits at `at` — puts the piece
    // where the render did and shows the edit just moved to `target`. Take
    // splits that landed only, and only with both anchors: a src-only split
    // has no `at` to refresh, and graphic, inert and unlanded splits were
    // never reached (R4-B1, B2). Both points are checked against the
    // pass-1 graphic windows, hidden ones included: an old `at` inside a
    // graphic splits that graphic today, and moving it would remove that
    // split (R6-B1); a new point inside one — even a hidden graphic a take
    // now covers — would split it on the next run and bring a deleted half
    // back (R7-B1).
    const point = points.find((p) => p.id === sid);
    const cur = splits[idx]!;
    if (point && cur.at !== undefined && cur.src !== undefined) {
      const next = Math.round(point.at * 1000) / 1000;
      if (!inAnyWindow(cur.at, graphicWindows) && !inAnyWindow(point.at, graphicWindows) && next !== cur.at) {
        splits[idx] = { ...cur, at: next };
        notes.push(`split ${sid} moved to ${next.toFixed(3)}s on this cut`);
        changed = true;
      }
    }
  }

  return { doc: { ...doc, scenes, splits }, notes, changed };
}
