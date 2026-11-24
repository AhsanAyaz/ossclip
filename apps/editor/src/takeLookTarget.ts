import { isLookPieceKey, pieceSourceRanges, type SceneCue, type SrcRange, type TimeMap } from "@ossclip/core/browser";
import type { Selection, VideoPreview } from "./Overlay";

/**
 * Which take piece a look-mode selection names (take-looks-by-source L4,
 * R6-1, R6-4, R7-1, R7-8).
 *
 * Carved lead and tail pieces SHARE an id (`carveKeptTakes` gives both the
 * host's), and a cut, keep, undo or ⌘B renumbers the rest — so in look mode a
 * selected take is named by the SOURCE footage it plays, the same principle
 * the looks themselves follow. The anchor is the hull of the piece's source
 * ranges (`pieceExtent`), and resolution is by largest overlap, never by id.
 *
 * Pure, and gated by the CALLERS: every helper here is only reached when the
 * doc is migrated (`takeLooks !== undefined`, R6-4). A legacy doc keeps id
 * matching everywhere (R4-S11), so nothing in this module runs for it.
 */

const toMs = (sec: number): number => Math.round(sec * 1000);

/** The look-mode refusal with no clock to place a take's footage on
 * (take-looks-by-source L4): the honest state of an unrendered workdir. */
export const LOOK_NEEDS_CLOCK = "Can't edit this take's look yet — render once and try again.";

/** The source ranges a cue plays on `clock`, or none without a clock — the
 * one range source every look write and read site uses (L4: "The range is
 * `pieceSourceRanges(piece window, cueClock)`"). */
export function pieceRanges(cue: SceneCue, clock: TimeMap | null): SrcRange[] {
  return clock === null ? [] : pieceSourceRanges(cue, clock);
}

/**
 * A plain cue's selection anchor (R6-1, R7-8): the hull `[min srcIn, max
 * srcOut]` of the source it plays on `clock`. Null with no clock (nothing can
 * be placed, L2), for a graphic (extents apply to plain cues only, R6-4), or
 * for a window that plays no source.
 */
export function pieceAnchor(cue: SceneCue, clock: TimeMap | null): SrcRange | null {
  if (cue.kind !== "plain") return null;
  return hullOf(pieceRanges(cue, clock));
}

/** `[min srcIn, max srcOut]` of `ranges`, or null for none — the extent a
 * look-mode selection or preview carries (R6-1) and the span a write
 * covers (R6-3). */
export function hullOf(ranges: readonly SrcRange[]): SrcRange | null {
  if (ranges.length === 0) return null;
  return {
    srcIn: Math.min(...ranges.map((r) => r.srcIn)),
    srcOut: Math.max(...ranges.map((r) => r.srcOut)),
  };
}

/** Whole milliseconds of `ranges` inside `extent`; a range overlapping by
 * under 1 ms adds nothing (the floor `lookAt` uses, R6-1). */
function overlapMs(ranges: readonly SrcRange[], extent: SrcRange): number {
  const a = toMs(extent.srcIn);
  const b = toMs(extent.srcOut);
  let total = 0;
  for (const r of ranges) {
    const o = Math.min(b, toMs(r.srcOut)) - Math.max(a, toMs(r.srcIn));
    if (o >= 1) total += o;
  }
  return total;
}

/**
 * The plain cue a look-mode selection names (R6-1): the one whose source
 * ranges on `clock` overlap `pieceExtent` most. Ids play no part, so a
 * renumbered piece still resolves. A tie goes to the earlier `startSec`
 * (R7-8). No extent, no clock, or no overlap of a whole millisecond gives
 * null — never the lead silently, which is the bug a shared id invites.
 */
export function selectedPiece(
  cues: readonly SceneCue[],
  sel: Selection,
  clock: TimeMap | null,
): SceneCue | null {
  const extent = sel.pieceExtent;
  if (extent === undefined || clock === null) return null;
  let best: { cue: SceneCue; overlap: number } | null = null;
  for (const cue of cues) {
    if (cue.kind !== "plain") continue;
    const overlap = overlapMs(pieceSourceRanges(cue, clock), extent);
    if (overlap === 0) continue;
    if (
      best === null ||
      overlap > best.overlap ||
      (overlap === best.overlap && cue.startSec < best.cue.startSec)
    ) {
      best = { cue, overlap };
    }
  }
  return best?.cue ?? null;
}

/** A selection of `cue`: scene-level, carrying the extent when `cue` is a
 * plain piece that plays source on `clock`. Every look-mode site that
 * selects a cue builds it here (R4-S2), so none forgets the extent. */
export function pieceSelection(cue: SceneCue, clock: TimeMap | null): Selection {
  const extent = pieceAnchor(cue, clock);
  return { sceneId: cue.id, elementId: null, ...(extent !== null ? { pieceExtent: extent } : {}) };
}

const sameExtent = (a: SrcRange | undefined, b: SrcRange | undefined): boolean =>
  a === b ||
  (a !== undefined && b !== undefined && toMs(a.srcIn) === toMs(b.srcIn) && toMs(a.srcOut) === toMs(b.srcOut));

/**
 * The selection after the cues or the clock changed (R6-1, R7-1): an extent
 * selection is re-pointed at the piece it resolves to — its id AND its own
 * hull, so the Inspector header, the writes and the previews follow the
 * footage through a renumber or a ⌘B — or cleared (null) when no piece plays
 * that footage any more.
 *
 * A selection WITHOUT an extent is left alone unless its id names a plain
 * cue (the first with that id): that is a selection carried over from legacy
 * mode or an id-only site, and it gets its extent here — the one place an id
 * is used (R6-1). A graphic selection never has an extent and is returned as
 * is, ghosts included.
 *
 * Returns `sel` itself when nothing changed, so a functional `setSelection`
 * with this is a no-op re-render rather than a loop.
 */
export function revalidateSelection(
  sel: Selection,
  cues: readonly SceneCue[],
  clock: TimeMap | null,
): Selection | null {
  if (sel.pieceExtent === undefined) {
    const byId = cues.find((c) => c.id === sel.sceneId);
    if (byId === undefined || byId.kind !== "plain") return sel;
    const extent = pieceAnchor(byId, clock);
    return extent === null ? sel : { ...sel, pieceExtent: extent };
  }
  const piece = selectedPiece(cues, sel, clock);
  if (piece === null) return null;
  const extent = pieceAnchor(piece, clock)!;
  if (piece.id === sel.sceneId && sameExtent(extent, sel.pieceExtent)) return sel;
  return { ...sel, sceneId: piece.id, pieceExtent: extent };
}

/**
 * The ⌥-arrow walk in look mode (R6-4, R7-8): from the selected PIECE — not
 * the first cue holding its id, which is the lead even when the tail is
 * selected — to its neighbour in `cues` (plain or graphic), selected with
 * its own extent when it is a plain piece. Null at either end, or when an
 * extent selection no longer resolves (revalidation is about to clear it).
 */
export function walkPiece(
  cues: readonly SceneCue[],
  sel: Selection,
  dir: 1 | -1,
  clock: TimeMap | null,
): Selection | null {
  let idx: number;
  if (sel.pieceExtent !== undefined) {
    const piece = selectedPiece(cues, sel, clock);
    if (piece === null) return null;
    idx = cues.indexOf(piece);
  } else {
    idx = cues.findIndex((c) => c.id === sel.sceneId);
  }
  if (idx === -1) return null;
  const next = cues[idx + dir];
  return next === undefined ? null : pieceSelection(next, clock);
}

/** What a look-mode stage press on scene `id` targets (take-looks-by-source
 * final review, T3-M1). */
export type StagePressTarget =
  /** Not a take: a graphic keeps its id, as in legacy mode (R6-4). */
  | { kind: "id" }
  /** The take piece the press landed on, with source to write on the clock. */
  | { kind: "piece"; piece: SceneCue }
  /** A take, but which piece cannot be told (no frame, no clock, no
   * footage): nothing may be selected or armed — refused out loud. */
  | { kind: "unresolved" };

/**
 * The piece a look-mode press on the stage hit (take-looks-by-source R6-4;
 * final review T3-M1). The DOM names only an id, and a carved lead and tail
 * SHARE it — so the piece is the cue with that id at the playhead
 * (`atSec`), or, when the playhead sits just outside every such cue (the
 * frame the stage painted and the frame the Player reports can straddle a
 * boundary or a transition), the one nearest it; a tie goes to the earlier
 * `startSec` (R7-8).
 *
 * It never falls back to an id-only answer for a take. That fallback was the
 * bug: an id-only selection revalidates to the LEAD even when the tail was
 * clicked, the legacy drag reads an id-keyed base the migration emptied,
 * previews by id onto lead and tail both, and the reducer then refuses the
 * commit. With no frame (`atSec` null), no clock, or no footage under the
 * piece, the answer is `unresolved`.
 *
 * A take is an `isLookPieceKey` id — the reducer's own refusal rule — or any
 * id a plain cue carries, since a plain cue resolves its look by source in
 * look mode (L2) whatever its id. Anything else is a graphic and keeps `id`.
 */
export function stagePressTarget(
  cues: readonly SceneCue[],
  id: string,
  atSec: number | null,
  clock: TimeMap | null,
): StagePressTarget {
  const candidates = cues.filter((c) => c.id === id && c.kind === "plain");
  if (candidates.length === 0 && !isLookPieceKey(id)) return { kind: "id" };
  if (atSec === null) return { kind: "unresolved" };
  const distance = (c: SceneCue): number =>
    atSec < c.startSec ? c.startSec - atSec : atSec >= c.endSec ? atSec - c.endSec : 0;
  let best: SceneCue | null = null;
  for (const c of candidates) {
    if (
      best === null ||
      distance(c) < distance(best) ||
      (distance(c) === distance(best) && c.startSec < best.startSec)
    ) {
      best = c;
    }
  }
  return best !== null && pieceAnchor(best, clock) !== null ? { kind: "piece", piece: best } : { kind: "unresolved" };
}

/**
 * The write units a look control can touch (R6-2, R7-3): `{scale, dx, dy}`
 * is one (`framing`), pip `{x, y}` one (`pipPos`), every other field its own.
 */
export type LookUnit =
  | "framing"
  | "autoZoom"
  | "volume"
  | "pipPos"
  | "cornerRadius"
  | "layout"
  | "captionY"
  | "captionScale";

/** The coalesce key for a look write (S17, R7-3): per piece — its first
 * source second — and per unit, so a scrub of one slider is one undo step
 * and two different controls never merge. */
export const lookCoalesceKey = (ranges: readonly SrcRange[], unit: LookUnit): string =>
  `look:${ranges[0]?.srcIn ?? "none"}:${unit}`;

/**
 * The stage's framing preview, laid over the cue it names (App's
 * `withStagePreviews`, PLAN Task B3). A look-mode preview carries its
 * piece's extent and lands only on the piece that resolves it on `map`, the
 * clock `list` is on (R4-S1, R7-1) — the selection's own rule, so a scrub on
 * the tail never shows on the lead that shares its id. It runs in both memo
 * passes, each on its own clock, and a match in either is correct: source
 * time is the same on both. Without an extent it matches by id, exactly as
 * before (legacy docs and graphics). Always a fresh array.
 */
export function withVideoPreview(
  list: readonly SceneCue[],
  preview: VideoPreview | null,
  map: TimeMap | null,
): SceneCue[] {
  if (preview === null) return [...list];
  const target =
    preview.pieceExtent !== undefined
      ? selectedPiece(list, { sceneId: preview.sceneId, elementId: null, pieceExtent: preview.pieceExtent }, map)
      : undefined;
  return list.map((c) =>
    (preview.pieceExtent !== undefined ? c === target : c.id === preview.sceneId)
      ? { ...c, video: { ...c.video, ...preview.patch } }
      : c,
  );
}
