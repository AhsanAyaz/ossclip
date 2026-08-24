/**
 * Browser-safe surface of @ossclip/core — everything the Remotion bundle may
 * import AT RUNTIME. No node built-ins, no SDKs, no fs/child_process anywhere
 * in this module graph (scene-schema + scene-registry + zod only); the rest of
 * core is re-exported as types, which erase at compile time.
 */
export * from "./scene-schema";
export * from "./scene-registry";
export * from "./scene-props-controls";
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
// `mapsClose` rides along since cut review step 4: the editor's playhead
// hand-off across a live re-cut needs "did the clock actually change" to be
// the SAME float-tolerant comparison `livePreviewMap`'s identity gate uses,
// or a 1-ulp drift could seek the player for nothing.
export { mapFromKeptSpans, mapsClose, TimeMap, type KeptSpan } from "./timemap";
// The §35 cover word cap. The editor's CoverPanel shows the trimmed headline
// live as you type, and restating the trimming rules there would drift from
// the one the regenerate endpoint actually renders with. Imported from
// ./cover-headline, NOT ./cover — that module is node all the way down
// (node:fs, ./exec), which is exactly what this surface exists to keep out.
export { COVER_MAX_WORDS, coverHeadline } from "./cover-headline";
// The cleanup veto layer (cut review step 3), VALUE exports and browser-safe:
// cutlist.ts imports nothing but types from ./schema — verified before this
// export, zero node built-ins in its graph. The editor marks vetoed seams
// with the SAME `applyCleanupChoices` produce renders with (the
// buildCoverRender one-implementation-two-callers pattern); a browser copy is
// how the preview and the render would drift. `buildCutlist` itself rides
// along in the module graph but stays unexported here on purpose — the
// editor must never rebuild the proposal, only apply choices to the one
// produce recorded.
export {
  applyCleanupChoices,
  cleanupVetoable,
  vetoedRemovals,
  type CleanupChoices,
} from "./cutlist";
// The live post-veto preview (cut review step 4), VALUE exports and
// browser-safe: retime-preview.ts composes cutlist + recut + timemap — all
// already in this surface's runtime graph (recut.ts imports only overrides
// and timemap, zero node built-ins, verified before this export). The editor
// re-cuts its preview clock with the SAME `applyCleanupChoices` +
// `subtractRangesFromCutlist` sequence produce runs and re-times every prop
// through the SAME `remapPoint` produce re-anchors with — one implementation,
// two callers, so the preview cannot drift from the render.
// `previewClockMappers` rides along (step 4 follow-up): the surfaces that
// speak in single instants — transcript seeks, ghost bands, the cover
// panel's playhead — need the same walk as a point function, identity when
// no re-cut is live, threaded by App so no consumer learns the machinery.
// `cutRangeToOldClock` is the WRITE direction's range half (the follow-up's
// follow-up): a cut gesture's live window converted to the old-clock frame
// `doc.cuts` speaks, shared by the Inspector's button and App's delete
// modal so the shrink/refuse verdict cannot drift between the two.
export {
  cutRangeToOldClock,
  livePreviewMap,
  previewClockMappers,
  retimeForPreview,
  type LivePreviewClocks,
  type OldClockCutRange,
  type PreviewClockMappers,
  type RetimeablePreviewProps,
  type RetimedPreviewFields,
} from "./retime-preview";
export type {
  Probe,
  Production,
  // `RemovalReason` rides along with `Segment` (cut review step 2): the
  // editor's reason→colour map is a `Record<RemovalReason, string>` precisely
  // so a NEW reason in the vocabulary fails typecheck in the editor instead
  // of silently drawing an uncoloured seam. (Since step 3 the schema module
  // is in the runtime graph anyway — ./overrides imports RemovalReasonSchema
  // for the `cleanup` key — but schema.ts is zod + scene-schema only, both
  // already on this surface, so it stays browser-safe.)
  RemovalReason,
  RenderSettings,
  Segment,
  Transcript,
  Word,
} from "./schema";
