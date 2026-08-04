import { SCENE_REGISTRY, type Layout, type SceneCue } from "@ossclip/core/browser";
import {
  CAPTION_HALF_BAND,
  PORTRAIT_FRAME,
  SAFE_AREA,
  freeBands,
  layoutSlots,
  safeAreaFor,
  type FrameSize,
} from "./stage";

/** Occupancy rect reported by the source-text scan (core's `TextRegion`). */
export interface OccupiedRegion {
  y: number;
  h: number;
  /**
   * When the region is on screen, in SOURCE seconds. Burned-in titles are
   * transient — treating them as permanent was what made the first detector
   * reject them outright (FINDINGS §32) — so a region only conflicts with
   * scenes that share its window. Absent means "always" (assumed regions).
   */
  startSec?: number;
  endSec?: number;
}

/** The regions actually on screen during [startSec, endSec]. */
export function regionsDuring(
  regions: readonly OccupiedRegion[],
  startSec: number,
  endSec: number,
): OccupiedRegion[] {
  return regions.filter(
    (r) =>
      (r.startSec ?? Number.NEGATIVE_INFINITY) < endSec &&
      (r.endSec ?? Number.POSITIVE_INFINITY) > startSec,
  );
}

/**
 * Routing around a source's own burned-in text (FINDINGS §26).
 *
 * The rule is asymmetric on purpose. ossclip's graphics must not overlap
 * existing on-screen elements at all — two titles competing, one of them
 * clipped, is worse than one title. Captions are different: they are the
 * accessibility layer and must ALWAYS be present, so they move rather than
 * disappear, and only fall back to their layout anchor if nothing is free.
 */

/** Above this share of a slot covered by source text, the slot is unusable. */
const MAX_GRAPHIC_OVERLAP = 0.12;

export function overlapFraction(
  rect: { y: number; h: number },
  regions: readonly OccupiedRegion[],
): number {
  if (rect.h <= 0) return 0;
  let covered = 0;
  for (const r of regions) {
    const top = Math.max(rect.y, r.y);
    const bottom = Math.min(rect.y + rect.h, r.y + r.h);
    if (bottom > top) covered += bottom - top;
  }
  return Math.min(1, covered / rect.h);
}

/**
 * The video rect a routed graphic must stay clear of, or null when this
 * layout intends the graphic to sit on the picture (R27 §120).
 *
 * Three clauses, all read from the slot table, none naming a layout. Deriving
 * rather than listing is load-bearing twice: §120's own list of three missed
 * `pip-bubble`, whose fully visible bubble sits 0.1 below its graphic; and
 * clause 2's "in THIS frame" is what sends the landscape splits — which
 * separate by X, with a full-height video — to clause 3 instead of skipping
 * every scene in 16:9.
 *
 * No startSec/endSec: those exist on OccupiedRegion because burned-in titles
 * are transient (§32) and the video slot is not. Absent already means
 * "always" to `regionsDuring`.
 */
export function videoObstacleFor(
  layout: Layout,
  frame: FrameSize = PORTRAIT_FRAME,
): OccupiedRegion | null {
  const slots = layoutSlots(layout, undefined, [], frame);
  // A layout with no graphic slot never reaches the placer at all.
  if (!slots.graphic) return null;
  // Clause 1 — graphic-only parks the pip rect at zero opacity.
  if (slots.video.opacity === 0) return null;
  const g = slots.graphic;
  const v = slots.video.rect;
  const overlap = Math.min(g.y + g.h, v.y + v.h) - Math.max(g.y, v.y);
  // Clause 3 — they already share vertical space, so the layout means it.
  // `> 0` rather than `>= 0`: touching edges count as clear, matching the
  // `toBeLessThanOrEqual(0)` the §120 test asserts.
  if (overlap > 0) return null;
  // Clause 2 — authored apart, so routing must keep them apart.
  return { y: v.y, h: v.h };
}

/**
 * Slide a graphic rect into the tallest band that the source's text leaves
 * free, keeping its size. Returns null when no free band can hold it — the
 * only case where a scene is genuinely skipped.
 */
export function placeInFreeBand(
  rect: { x: number; y: number; w: number; h: number },
  regions: readonly OccupiedRegion[],
  /**
   * The picture, when this layout authored the graphic clear of it (§120).
   * Optional and defaulted so every existing caller keeps its behaviour;
   * `videoObstacleFor` returns null for the layouts that intend the overlap.
   */
  videoObstacle?: OccupiedRegion | null,
): { x: number; y: number; w: number; h: number } | null {
  // freeBands merges overlapping blocked rects itself, so the obstacle can
  // simply join the text regions rather than needing to be reconciled.
  const blocked = videoObstacle ? [...regions, videoObstacle] : regions;
  const [tallest] = freeBands({ start: SAFE_AREA.top, end: 1 - SAFE_AREA.bottom }, blocked);
  if (!tallest) return null;
  const bandHeight = tallest.end - tallest.start;
  if (bandHeight < MIN_ROUTED_SLOT_H) return null;
  // Reserve room for captions inside the band before the graphic takes it.
  // Captions are mandatory and the graphic is not, so the graphic is what
  // yields — otherwise a routed graphic swallows the only free band and the
  // captions fall back on top of the source's own text.
  const reserved = CAPTION_BAND_H;
  const usable = bandHeight - reserved >= MIN_ROUTED_SLOT_H ? bandHeight - reserved : bandHeight;
  // Shrink to the band when the slot does not fit. A smaller graphic beats no
  // graphic, and since §23 every component scales its type to whatever slot it
  // is handed — so a shorter slot renders correctly rather than overflowing.
  const h = Math.min(rect.h, usable);
  return { ...rect, y: tallest.start + (usable - h) / 2, h };
}

/** Vertical room a caption line needs, with a little breathing space. */
const CAPTION_BAND_H = CAPTION_HALF_BAND * 2 + 0.02;

/** Below this a routed graphic is too small to read — skip the scene instead. */
const MIN_ROUTED_SLOT_H = 0.14;

export interface SourceTextPlan {
  cues: SceneCue[];
  /** Scenes moved to a layout whose slot is clear. */
  relayouts: Array<{ id: string; from: Layout; to: Layout }>;
  /** Scenes whose graphic was repositioned into a free band. */
  moved: Array<{ id: string; y: number; h: number }>;
  /** Scenes dropped because no layout had a free slot. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Re-place or drop each cue so no graphic lands on the source's own text.
 * Tries the cue's layout first, then the component's alternates; a component
 * with nowhere free is skipped rather than stacked.
 */
export function routeAroundSourceText(
  cues: readonly SceneCue[],
  regions: readonly OccupiedRegion[],
): SourceTextPlan {
  if (regions.length === 0) {
    return { cues: [...cues], relayouts: [], moved: [], skipped: [] };
  }
  const out: SceneCue[] = [];
  const relayouts: SourceTextPlan["relayouts"] = [];
  const moved: SourceTextPlan["moved"] = [];
  const skipped: SourceTextPlan["skipped"] = [];

  for (const cue of cues) {
    // A cue with no graphic (a plain take) has nothing to route.
    if (cue.component === undefined) {
      out.push(cue);
      continue;
    }
    // Only the text actually up while this scene is on screen can conflict.
    const active = regionsDuring(regions, cue.startSec, cue.endSec);
    if (active.length === 0) {
      out.push(cue);
      continue;
    }
    const meta = SCENE_REGISTRY[cue.component];
    // The cue's own layout first (§20's variety pass may have moved it off the
    // default), then the default, then the alternates — every placement the
    // component is known to render correctly in.
    const candidates: Layout[] = [
      ...new Set<Layout>([cue.layout, meta?.defaultLayout, ...(meta?.altLayouts ?? [])].filter(
        Boolean,
      ) as Layout[]),
    ];
    let placed: Layout | null = null;
    for (const layout of candidates) {
      const slot = layoutSlots(layout).graphic;
      if (!slot) continue;
      if (overlapFraction(slot, active) <= MAX_GRAPHIC_OVERLAP) {
        placed = layout;
        break;
      }
    }
    if (placed !== null) {
      if (placed !== cue.layout) relayouts.push({ id: cue.id, from: cue.layout, to: placed });
      out.push(placed === cue.layout ? cue : { ...cue, layout: placed });
      continue;
    }

    // No layout is clear where it stands — so move the slot instead of losing
    // the scene. "Route around them, or skip" is the rule, and routing comes
    // first: the graphic keeps its size and slides into the largest free band.
    const base = layoutSlots(cue.layout).graphic ?? layoutSlots(meta.defaultLayout).graphic;
    const shifted = base ? placeInFreeBand(base, active) : null;
    if (shifted) {
      moved.push({ id: cue.id, y: shifted.y, h: shifted.h });
      out.push({ ...cue, graphicRect: shifted });
      continue;
    }
    skipped.push({ id: cue.id, reason: "source already has on-screen text here" });
  }
  return { cues: out, relayouts, moved, skipped };
}

/**
 * A caption anchor clear of the source's text, the active graphic and the
 * platform chrome — searched outward from the layout's own anchor so captions
 * stay where the design put them whenever that is free.
 *
 * Never returns null: a caption that cannot find a clear band still renders at
 * its layout anchor, because a missing caption is a worse failure than a
 * crowded one (BRAINSTORM §4.5, "muted-viewing complete").
 */
export function captionAnchorAvoiding(
  layout: Layout,
  regions: readonly OccupiedRegion[],
  /** The cue's actual graphic rect, which routing may have moved (§26). */
  graphic?: { y: number; h: number } | null,
  /** The output frame — anchors and safe margins follow its shape (R15). */
  frame: FrameSize = PORTRAIT_FRAME,
): number {
  const slots = layoutSlots(layout, undefined, [], frame);
  const safe = safeAreaFor(frame);
  const base = slots.captionAnchor;
  // NO empty-regions early-out (R11 Task 2b): a hand-moved graphic rect must
  // be able to move the anchor on a CLEAN source too. When the rect equals
  // the layout default this stays the base anchor — every layout's default
  // anchor is clear of its own slot (the stage.test.ts invariant) — so the
  // behaviour change is confined to rects that actually moved.

  const clear = (anchor: number): boolean => {
    const band = { y: anchor - CAPTION_HALF_BAND, h: CAPTION_HALF_BAND * 2 };
    if (band.y < safe.top || band.y + band.h > 1 - safe.bottom) return false;
    if (overlapFraction(band, regions) > 0) return false;
    const g = graphic ?? slots.graphic;
    if (g && Math.min(band.y + band.h, g.y + g.h) - Math.max(band.y, g.y) > 0) return false;
    return true;
  };

  if (clear(base)) return base;
  for (let step = 0.02; step <= 0.6; step += 0.02) {
    for (const candidate of [base - step, base + step]) {
      if (clear(candidate)) return candidate;
    }
  }
  return base;
}
