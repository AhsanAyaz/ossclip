/**
 * Browser-safe surface of @ossclip/core — everything the Remotion bundle may
 * import AT RUNTIME. No node built-ins, no SDKs, no fs/child_process anywhere
 * in this module graph (scene-schema + scene-registry + zod only); the rest of
 * core is re-exported as types, which erase at compile time.
 */
export * from "./scene-schema";
export * from "./scene-registry";
export { ZOOM_MAX_SCALE, zoomScaleAt, type ZoomSegment } from "./zoom";
export type { CaptionLine, CaptionWord } from "./captions";
export type { KeptSpan } from "./timemap";
export type { Probe, Production, RenderSettings, Segment, Transcript, Word } from "./schema";
