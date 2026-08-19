/**
 * Browser-safe surface of @ossclip/core — everything the Remotion bundle may
 * import AT RUNTIME. No node built-ins, no SDKs, no fs/child_process anywhere
 * in this module graph (scene-schema + scene-registry + zod only); the rest of
 * core is re-exported as types, which erase at compile time.
 */
export * from "./scene-schema";
export * from "./scene-registry";
export * from "./overrides";
// The editor derives its plain takes with the SAME function the pipeline
// uses — a copy would drift and the two timelines would disagree.
export * from "./fill";
export { ZOOM_MAX_SCALE, zoomScaleAt, type ZoomSegment } from "./zoom";
// Pure geometry only — the ffmpeg/cache half lives in ./content-rect-detect
// and must never enter the Remotion bundle.
export {
  contentRectAt,
  cropFilter,
  type ContentRect,
  type ContentRectSegment,
  type FramingSegment,
} from "./content-rect";
// lineDirection is a VALUE export but stays browser-safe: captions.ts
// imports types only. CaptionTrack needs it at render time (Urdu field test
// 2026-08-05 — RTL lines were laying out LTR).
// `backfillSrcStart` rides along for the same reason: the EDITOR is the load
// path that has to repair a pre-§137 render-props.json before anything derives
// a caption key from it (§137), and the editor imports this surface. Pure, and
// captions.ts stays browser-safe — it imports types plus timemap, which is
// itself type-only against ./schema.
// The Nastaliq trio rides the same browser-safe surface: CaptionTrack needs
// the family name + served path for its @font-face, and `captionsNeedNastaliq`
// is the ONE predicate produce and the render share for "does this caption
// set need the bundled font" (2026-08-17 — two conditions would drift).
export {
  backfillSrcStart,
  captionsNeedNastaliq,
  lineDirection,
  NASTALIQ_FONT_NAME,
  NASTALIQ_FONT_REL,
  type CaptionLine,
  type CaptionWord,
} from "./captions";
// `mapFromKeptSpans` is a VALUE export and browser-safe (timemap.ts imports
// types only). The editor's load-path repair needs the MAP, not the raw span
// array, to decide whether a repair is possible at all — see
// `anchorCaptionLines` (§137): a non-empty array can still build an empty map.
export { mapFromKeptSpans, TimeMap, type KeptSpan } from "./timemap";
// The §35 cover word cap. The editor's CoverPanel shows the trimmed headline
// live as you type, and restating the trimming rules there would drift from
// the one the regenerate endpoint actually renders with. Imported from
// ./cover-headline, NOT ./cover — that module is node all the way down
// (node:fs, ./exec), which is exactly what this surface exists to keep out.
export { COVER_MAX_WORDS, coverHeadline } from "./cover-headline";
export type {
  Probe,
  Production,
  // `RemovalReason` rides along with `Segment` (cut review step 2): the
  // editor's reason→colour map is a `Record<RemovalReason, string>` precisely
  // so a NEW reason in the vocabulary fails typecheck in the editor instead
  // of silently drawing an uncoloured seam. Type-only — erases at compile
  // time, so this surface stays free of the schema module at runtime.
  RemovalReason,
  RenderSettings,
  Segment,
  Transcript,
  Word,
} from "./schema";
