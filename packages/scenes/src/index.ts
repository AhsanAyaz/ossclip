export { EdlVideo, type EdlVideoProps } from "./EdlVideo";
export {
  CaptionTrack,
  captionAnchorForLine,
  captionBottomAtFor,
  captionTopAtFor,
  resolveChoreographedAnchor,
  type CaptionGeometryOpts,
  type CaptionTrackProps,
} from "./CaptionTrack";
export * from "./caption-themes";
export { VideoStage } from "./VideoStage";
export { SceneLayer } from "./SceneLayer";
export { Watermark } from "./Watermark";
export { CoverInVideo } from "./CoverInVideo";
export { BundledFonts, browserFontEnv, loadFontFaces, type FontEnv } from "./BundledFonts";
export { SfxTrack } from "./SfxTrack";
export { OverlayTrack, overlayCuesFor, type OverlayCueProps } from "./overlay-track";
export * from "./stage";
export * from "./watermark-layout";
export * from "./cover-in-video";
export * from "./sfx-track";
export * from "./overlay-rect";
export * from "./overlay-room";
export * from "./punch-plan";
export * from "./color-grade";
export * from "./caption-visibility";
// The graphic editor's item rows (graphic-editor-modal §5) show each item's
// time from the renderer's own schedule: an unmatched item is placed by
// `revealFrames`, and a second placement rule in the editor is how the
// modal's estimate and the render would disagree. `isLegacyReveal` with it:
// a graphic on its component's own legacy stagger has no item time to show.
export { isLegacyReveal, revealFrames, type RevealInput } from "./reveal";
