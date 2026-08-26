import type { SceneCue } from "./scene-schema";
import type { TimeMap } from "./timemap";
import { SPLIT_MIN_PIECE_SEC } from "./overrides";

/**
 * Carve KEPT (vetoed) and DISMISSED cleanup removals out of the plain-take
 * cues, so revived material is a first-class block instead of an invisible
 * stretch annexed by its neighbour (cut-review rework, 2026-08-26).
 *
 * Why annexation happens without this: the live memo's `retimeForPreview`
 * only remaps EXISTING cue endpoints, and `TimeMap.toSource` at a seam
 * returns the earlier preimage (timemap.ts's own boundary doc), so the cue
 * after the seam starts exactly where the revived material begins — the
 * stretch belongs to it, carries no id of its own, and cannot be selected,
 * labeled, split, or trimmed.
 *
 * ONE implementation, two callers (the `applyCleanupChoices` pattern):
 * produce carves between `fillPlainCues` and `splitCues` with this run's
 * map, so `take-kept-*` ids exist server-side and framing edits on them
 * survive a re-render; the editor carves after `retimeForPreview` with
 * `livePreviewMap`'s newMap, so the block appears the moment a chip is
 * clicked. Same ranges, same map semantics — the two cannot drift.
 */

export interface KeptRange {
  /** SOURCE seconds of the removal the user kept or dismissed. */
  srcIn: number;
  srcOut: number;
  /**
   * A dismissed range carves the same stable block but WITHOUT the `kept`
   * tag: dismissed material is ordinary footage and must render as a normal
   * take, while a vetoed-kept range renders in the revived state.
   */
  dismissed?: boolean;
}

/**
 * The carved cue's id, from the range's SOURCE milliseconds — stable across
 * re-cuts, veto toggles and re-produces by construction (§155: key on the
 * property the disruption cannot move), so a framing edit on the revived
 * block survives all of them.
 */
export function keptTakeId(srcIn: number): string {
  return `take-kept-${Math.round(srcIn * 1000)}`;
}

/** Below this, a leading/trailing remainder of the carved cue is float dust
 * from seam math, not a piece anyone can edit — it folds into the carved
 * block instead of surviving as a sliver cue. */
const REMAINDER_EPS = 0.05;

export interface CarveResult {
  cues: SceneCue[];
  reports: string[];
}

/**
 * For each range: map its source edges onto `map`'s output clock (exact —
 * a kept range is interior to a merged keep span) and split the covering
 * PLAIN cue into up-to-three pieces, the middle one becoming the
 * `take-kept-<srcInMs>` block. Rules, each stated where enforced:
 *
 *  - a range shorter than `SPLIT_MIN_PIECE_SEC` carves nothing (chip-only,
 *    reported) — deliberately below `MIN_PLAIN_SEC` (0.6, fill.ts), because
 *    this is real footage the user asked to see, not an assembler gap;
 *  - a range covered by a GRAPHIC cue is left alone with a report — the
 *    graphic owns that window;
 *  - a range whose block already exists (produce carved it server-side, or
 *    an earlier call did) is skipped — carving is idempotent;
 *  - a range not fully inside one plain cue carves the part that is, with a
 *    report — never two cues sharing one id.
 */
export function carveKeptTakes(
  cues: readonly SceneCue[],
  ranges: readonly KeptRange[],
  map: TimeMap,
): CarveResult {
  const out = [...cues];
  const reports: string[] = [];
  for (const range of ranges) {
    const id = keptTakeId(range.srcIn);
    const label = `kept range ${range.srcIn.toFixed(3)}–${range.srcOut.toFixed(3)}s`;
    if (out.some((c) => c.id === id || c.id.startsWith(`${id}@`))) continue; // already carved
    if (range.srcOut - range.srcIn < SPLIT_MIN_PIECE_SEC) {
      reports.push(`${label} is shorter than ${SPLIT_MIN_PIECE_SEC}s — shown in the lane only`);
      continue;
    }
    const outIn = map.toOutput(range.srcIn);
    const outOut = map.toOutput(range.srcOut);
    if (outIn === null || outOut === null || outOut <= outIn) {
      // Not on this clock at all — the range's material is (still) removed
      // here; nothing to carve, and clamping would mint a lie of a block.
      reports.push(`${label} is not in this cut — no block carved`);
      continue;
    }
    const i = out.findIndex((c) => c.startSec <= outIn + 1e-6 && c.endSec > outIn + 1e-6);
    const host = i === -1 ? undefined : out[i];
    if (host === undefined) {
      // A HOLE, not an annexation: a removal at the head (or against a
      // graphic's edge) retimes the neighbouring take AWAY from the revived
      // stretch instead of over it (`TimeMap.toSource`'s earlier-preimage
      // rule points the old 0 at the neighbour's own source start). Nothing
      // owns the window, so the block is minted from scratch — layout
      // borrowed from the nearest plain cue so the revived footage frames
      // like its neighbours, never like a graphic.
      const overlapping = out.some((c) => c.startSec < outOut - 1e-6 && c.endSec > outIn + 1e-6);
      if (overlapping) {
        reports.push(`${label} straddles existing cues — no block carved`);
        continue;
      }
      const neighbour = [...out]
        .filter((c) => c.kind === "plain")
        .sort(
          (a, b) => Math.abs(a.startSec - outIn) - Math.abs(b.startSec - outIn),
        )[0];
      const minted: SceneCue = {
        id,
        kind: "plain",
        layout: neighbour?.layout ?? "video-top",
        ...(neighbour?.video !== undefined ? { video: neighbour.video } : {}),
        startSec: outIn,
        endSec: outOut,
        ...(range.dismissed === true
          ? {}
          : { kept: { srcIn: range.srcIn, srcOut: range.srcOut } }),
      };
      const insertAt = out.findIndex((c) => c.startSec >= outOut - 1e-6);
      out.splice(insertAt === -1 ? out.length : insertAt, 0, minted);
      continue;
    }
    if (host.kind !== "plain") {
      // Absence means "graphic" (SceneCueSchema's kind doc) — either way,
      // not ours to carve.
      reports.push(`${label} sits under graphic "${host.id}" — the graphic keeps the window`);
      continue;
    }
    const end = Math.min(outOut, host.endSec);
    if (end < outOut - 1e-6) {
      reports.push(
        `${label} crosses out of take "${host.id}" — carved up to its edge (${end.toFixed(3)}s)`,
      );
    }
    // Pieces: [host.start, outIn] (host keeps its id), the carved block,
    // [end, host.end] (host's id too — `splitCues`' both-halves-keep rule
    // does not apply: these are the SAME take around a foreign block, and
    // minting `@` names here would collide with the split-id namespace).
    const carved: SceneCue = {
      ...host,
      id,
      startSec: Math.max(host.startSec, outIn),
      endSec: end,
      ...(range.dismissed === true ? {} : { kept: { srcIn: range.srcIn, srcOut: range.srcOut } }),
    };
    // Sub-eps remainders fold into the carved block — a 20ms sliver take is
    // seam float dust, not content (REMAINDER_EPS).
    const lead = outIn - host.startSec;
    const tail = host.endSec - end;
    const pieces: SceneCue[] = [
      ...(lead >= REMAINDER_EPS ? [{ ...host, endSec: outIn }] : []),
      lead >= REMAINDER_EPS ? carved : { ...carved, startSec: host.startSec },
      ...(tail >= REMAINDER_EPS ? [{ ...host, startSec: end }] : []),
    ];
    if (tail < REMAINDER_EPS) {
      const last = pieces[pieces.length - 1]!;
      pieces[pieces.length - 1] = { ...last, endSec: host.endSec };
    }
    out.splice(i, 1, ...pieces);
  }
  return { cues: out, reports };
}
