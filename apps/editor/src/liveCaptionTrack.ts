import {
  applyCaptionEdits,
  applyCaptionLineTiming,
  applyCaptionRangeEdits,
  applyCaptionWordHides,
  buildCaptionLines,
  captionPackingFor,
  type AppliedCaptionEdits,
  type CaptionLine,
  type OverrideDoc,
  type TimeMap,
  type Transcript,
} from "@ossclip/core/browser";
import { sourceKeyedCaptionEdits } from "./captionAnchors";

/**
 * Every stop of the caption chain the live memo needs, not just its end.
 *
 * The Transcript panel consumes THREE of them (`TranscriptPanel`'s prop docs:
 * pristine / post-range pre-hide / post-hide) and the Player consumes the
 * fourth, which is exactly why this returns the intermediates instead of the
 * final lines alone: the old-clock chain in App.tsx hands the panel three
 * SEPARATE memos, and a rebuilt track that returned only `lines` would leave
 * the panel on the old-clock streams — the field bug (words inside revived
 * material are invisible to retype/hide/word-delete) this exists to close.
 */
export interface LiveCaptionTrack {
  /** Pristine, pre-edit-layer — the retype guard's `was` truth, the rebuilt
   * analogue of `renderProps.baseCaptionLines`. */
  baseLines: CaptionLine[];
  /** Post-retype, post-range, PRE-hide — what the panel RENDERS (a hidden
   * word stays on screen struck through; App.tsx's `appliedCaptionRanges`
   * comment owns the full why). */
  liveLines: CaptionLine[];
  /** Post-hide — the exact track `applyCaptionLineTiming` runs on, which is
   * what the panel's timing surfaces must key against
   * (`postHideLineIndices`). */
  timingLines: CaptionLine[];
  /** Post-timing — what the Player renders. */
  lines: CaptionLine[];
  /**
   * The TIMING layer's unplaced nudges. Re-packing is why this must leave the
   * function: the rebuilt track is packed fresh from the transcript over
   * material the last render never had, so a stored nudge's key can stop
   * being any line's FIRST word even though its word is still on screen. The
   * nudge is dropped either way — but with a report (App's §137 channel),
   * never silently, which is the rule §137 established for retypes.
   */
  dropped: AppliedCaptionEdits["dropped"];
}

/**
 * Rebuild the whole caption track on a clock the last render never had, then
 * re-run the caption edit layers over it.
 *
 * Produce's own builder and packing matrix (`buildCaptionLines` +
 * `captionPackingFor`, one implementation with two callers) so the preview
 * cannot pack differently from the render. The edit layers run in
 * `applyCaptionLayers`' one authoritative order — edits → ranges → hides →
 * timing — composed manually here for the same two reasons App.tsx composes
 * the old-clock chain manually: the edits layer must be the SOURCE-KEYED
 * subset (legacy positional keys address no word and would report as stale on
 * every render), and the panel needs the intermediates, which the composer
 * does not return. Every key is source-anchored (§137), so a retype, a range
 * rewrite or a hide made against the old clock lands on the rebuilt lines
 * too — including on words the last render cut away.
 *
 * Pure by design: App.tsx owns the transcript fetch, the clock and the cue
 * carve, and hands this the finished inputs, so the revived-material case is
 * testable without a TTY, a player or a workdir.
 */
export function rebuildCaptionTrack(
  transcript: Transcript,
  map: TimeMap,
  doc: OverrideDoc,
  opts: {
    /** Output times a line must not span — the post-carve scene-cue edges
     * (`CaptionOptions.breakpoints`, FINDINGS §6b). */
    breakpoints: number[];
    /** Landscape packs 6 words over 2.4s against portrait's 3 over 1.2
     * (`captionPackingFor`) — the render's own matrix, asked here so the
     * caller keeps the render-settings lookup. */
    landscape: boolean;
  },
): LiveCaptionTrack {
  const baseLines = buildCaptionLines(transcript, map, {
    breakpoints: opts.breakpoints,
    ...captionPackingFor(opts.landscape),
  });
  const edited = applyCaptionEdits(baseLines, sourceKeyedCaptionEdits(doc.captions)).lines;
  const liveLines = applyCaptionRangeEdits(edited, doc.captionRangeEdits).lines;
  const timingLines = applyCaptionWordHides(liveLines, doc.captionWordsHidden).lines;
  const timed = applyCaptionLineTiming(timingLines, doc.captionLineTiming);
  return { baseLines, liveLines, timingLines, lines: timed.lines, dropped: timed.dropped };
}
