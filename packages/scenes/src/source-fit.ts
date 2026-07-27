import { SCENE_REGISTRY, type Layout, type SceneCue } from "@ossclip/core/browser";
import { CAPTION_HALF_BAND, SAFE_AREA, layoutSlots } from "./stage";

/** Occupancy rect reported by the source-text scan (core's `TextRegion`). */
export interface OccupiedRegion {
  y: number;
  h: number;
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
 * Slide a graphic rect into the tallest band that the source's text leaves
 * free, keeping its size. Returns null when no free band can hold it — the
 * only case where a scene is genuinely skipped.
 */
export function placeInFreeBand(
  rect: { x: number; y: number; w: number; h: number },
  regions: readonly OccupiedRegion[],
): { x: number; y: number; w: number; h: number } | null {
  const top = SAFE_AREA.top;
  const bottom = 1 - SAFE_AREA.bottom;
  const blocked = [...regions]
    .map((r) => ({ start: Math.max(top, r.y), end: Math.min(bottom, r.y + r.h) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const free: Array<{ start: number; end: number }> = [];
  let cursor = top;
  for (const b of blocked) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < bottom) free.push({ start: cursor, end: bottom });

  const tallest = free.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
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
      if (overlapFraction(slot, regions) <= MAX_GRAPHIC_OVERLAP) {
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
    const shifted = base ? placeInFreeBand(base, regions) : null;
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
): number {
  const slots = layoutSlots(layout);
  const base = slots.captionAnchor;
  if (regions.length === 0) return base;

  const clear = (anchor: number): boolean => {
    const band = { y: anchor - CAPTION_HALF_BAND, h: CAPTION_HALF_BAND * 2 };
    if (band.y < SAFE_AREA.top || band.y + band.h > 1 - SAFE_AREA.bottom) return false;
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
