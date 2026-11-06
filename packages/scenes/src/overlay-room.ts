import type { CaptionLine, SceneCue } from "@ossclip/core/browser";
import { showCaptions } from "./caption-visibility";
import { captionBottomAtFor, captionTopAtFor } from "./CaptionTrack";
import { graphicRectAtFor, overlayBoxForCue, overlayFits } from "./overlay-rect";
import type { OccupiedRegion } from "./source-fit";
import type { FrameSize, Rect } from "./stage";

/** The three lookups an automatic overlay box is placed against. */
export interface OverlayGeometry {
  captionTopAt: (tSec: number) => number | null;
  captionBottomAt: (tSec: number) => number | null;
  graphicRectAt: (tSec: number) => Rect | undefined;
}

/**
 * Built ONCE, here, for every consumer — the composition that draws the
 * overlays, produce that drops the ones with no room, and the editor preview
 * that must drop the same ones. Three hand-rolled copies are how a logo the
 * render dropped would still pop in the preview, or the reverse.
 */
export function overlayGeometryFor(args: {
  captionLines: readonly CaptionLine[];
  sceneCues: readonly SceneCue[];
  sourceTextRegions?: readonly OccupiedRegion[];
  captionsHidden?: unknown;
  frame: FrameSize;
}): OverlayGeometry {
  const opts = { cues: args.sceneCues, sourceTextRegions: args.sourceTextRegions ?? [], frame: args.frame };
  const visible = showCaptions(args.captionsHidden);
  return {
    captionTopAt: visible ? captionTopAtFor(args.captionLines, opts) : () => null,
    captionBottomAt: visible ? captionBottomAtFor(args.captionLines, opts) : () => null,
    graphicRectAt: graphicRectAtFor(args.sceneCues, args.frame),
  };
}

/**
 * The automatically placed overlays that have no room to show (final review
 * I3, ruling R19). When one overlay's window spans a caption the user moved
 * high AND a low one, neither the band above nor the band below the captions
 * is tall enough, and `overlayRect`'s last resort shrinks the box to a sliver
 * or to nothing. The picture then vanished while its pop still played, with
 * no ⚠ anywhere. Callers drop each id returned here together with its pop
 * and say so.
 *
 * A hand-placed box (`rect`) always shows, since the user put it there and it
 * dodges nothing. A card always has the whole frame.
 */
export function overlaysWithoutRoom(
  cues: readonly { id: string; look: "overlay" | "card"; rect?: unknown; atSec: number; endSec: number }[],
  geometry: OverlayGeometry,
  frame: FrameSize,
  fps: number,
): Set<string> {
  const out = new Set<string>();
  for (const cue of cues) {
    if (cue.look !== "overlay" || cue.rect) continue;
    const box = overlayBoxForCue(cue, fps, frame, geometry.captionTopAt, geometry.graphicRectAt, geometry.captionBottomAt);
    if (!overlayFits(box, frame)) out.add(cue.id);
  }
  return out;
}
