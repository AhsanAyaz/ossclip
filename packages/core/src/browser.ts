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
export { lineDirection, type CaptionLine, type CaptionWord } from "./captions";
export type { KeptSpan } from "./timemap";
export type { Probe, Production, RenderSettings, Segment, Transcript, Word } from "./schema";
