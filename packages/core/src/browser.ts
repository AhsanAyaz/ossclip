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
} from "./content-rect";
// lineDirection is a VALUE export but stays browser-safe: captions.ts
// imports types only. CaptionTrack needs it at render time (Urdu field test
// 2026-08-05 — RTL lines were laying out LTR).
// `backfillSrcStart` rides along for the same reason: the EDITOR is the load
// path that has to repair a pre-§137 render-props.json before anything derives
// a caption key from it (§137), and the editor imports this surface. Pure, and
// captions.ts stays browser-safe — it imports types plus timemap, which is
// itself type-only against ./schema.
export {
  backfillSrcStart,
  lineDirection,
  type CaptionLine,
  type CaptionWord,
} from "./captions";
// `mapFromKeptSpans` is a VALUE export and browser-safe (timemap.ts imports
// types only). The editor's load-path repair needs the MAP, not the raw span
// array, to decide whether a repair is possible at all — see
// `anchorCaptionLines` (§137): a non-empty array can still build an empty map.
export { mapFromKeptSpans, TimeMap, type KeptSpan } from "./timemap";
export type { Probe, Production, RenderSettings, Segment, Transcript, Word } from "./schema";
