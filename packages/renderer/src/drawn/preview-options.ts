/**
 * The preview's props and `renderMedia` options for a drawn scene (§167,
 * storyboard design §7), as pure data: render-options.ts's split, and for its
 * reason — render.ts imports @remotion/bundler at runtime, this file only
 * Remotion's types, so the decisions below are testable without the bundler.
 */
import type { RenderMediaOptions } from "@remotion/renderer";
import type { DrawnRenderProps } from "./entry-source";

/**
 * A quarter of the frame in each dimension. Remotion's `scale` shrinks the
 * whole viewport, so the scene lays out at the full frame size it was drawn
 * for and is photographed small; the composition is not re-laid-out at
 * 270×480. VP8 is not in Remotion's even-dimension list
 * (validate-even-dimensions-with-codec.js, 4.0.499), so a frame whose quarter
 * is odd is encoded as is rather than trimmed.
 */
export const DRAWN_PREVIEW_SCALE = 0.25;

/**
 * Mid-grey behind the scene. The preview carries no alpha (VP8 here, JPEG
 * frames), and a drawn scene's background is transparent by rule (design §3):
 * flattened, that is black, and a dark scene would vanish into it. Grey shows
 * dark and light scenes well enough to judge motion, which is all a preview
 * is for.
 */
export const DRAWN_PREVIEW_BACKGROUND = "#808080";

/**
 * The preview's input props: the caller's, plus the host's `background`.
 * Used for `selectComposition` AND `renderMedia` alike. The component draws
 * from the props the COMPOSITION was resolved with, not from renderMedia's
 * `inputProps` (render-media.js in 4.0.499 serialises `composition.props` as
 * the resolved props; seen 2026-11-20, when a background passed to
 * renderMedia alone left every preview frame black).
 */
export function drawnPreviewProps(props: DrawnRenderProps): Record<string, unknown> {
  return { ...props, background: DRAWN_PREVIEW_BACKGROUND };
}

export function drawnPreviewOptions(args: {
  composition: RenderMediaOptions["composition"];
  serveUrl: string;
  /** `drawnPreviewProps(…)`, the same object the composition was selected with. */
  inputProps: Record<string, unknown>;
  outPath: string;
  browserExecutable?: string;
}): RenderMediaOptions {
  return {
    composition: args.composition,
    serveUrl: args.serveUrl,
    codec: "vp8",
    // JPEG transport: there is no alpha to keep, and it is the cheaper
    // screenshot (renderMediaOptions' reasoning).
    imageFormat: "jpeg",
    jpegQuality: 80,
    scale: DRAWN_PREVIEW_SCALE,
    // A drawn scene is silent; no audio track to write.
    muted: true,
    outputLocation: args.outPath,
    inputProps: args.inputProps,
    browserExecutable: args.browserExecutable,
  };
}
