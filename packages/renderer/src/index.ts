import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { rename, rm } from "node:fs/promises";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { COMPOSITION_ID } from "./Root";
import { COVER_ID } from "./CoverComposition";
import { SCENE_STILL_ID } from "./SceneStillComposition";
import { SCENE_CLIP_ID } from "./SceneClipComposition";
import { partialClipPath } from "./scene-clip";
import type { SceneClipProps } from "./scene-clip";
import { stillFrame } from "./scene-still";
import type { SceneStillProps } from "./scene-still";
import { clipRenderOptions, renderMediaOptions } from "./render-options";
import type { ClipJobOptions, RenderJobOptions } from "./render-options";
import type { ProductionCompProps } from "./ProductionComposition";
import type { CoverCompProps } from "./CoverComposition";

export type { ProductionCompProps } from "./ProductionComposition";
export type { CoverCompProps } from "./CoverComposition";
export { SCENE_STILL_ID } from "./SceneStillComposition";
export * from "./scene-still";
export { SCENE_CLIP_ID } from "./SceneClipComposition";
export * from "./scene-clip";
export type { ClipJobOptions, RenderJobOptions, RenderPhase } from "./render-options";
export {
  DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES,
  clipRenderOptions,
  renderMediaOptions,
} from "./render-options";
// Re-exported so the CLI can build a cancel signal without depending on
// @remotion/renderer directly — @ossclip/renderer is the only door onto
// Remotion this repo opens (2026-08-19 Ctrl-C fix).
export { makeCancelSignal } from "@remotion/renderer";
export type { CancelSignal } from "@remotion/renderer";
// Drawn scenes (§167): their own bundle per scene, never STUDIO_ENTRY's, so
// nothing above changes for a run that does not draw.
export {
  DRAWN_COMPOSITION_ID,
  drawnEntrySource,
  drawnSceneMetadata,
  drawnStillFrames,
  type DrawnRenderProps,
} from "./drawn/entry-source";
export { DRAW_CSP, injectCsp } from "./drawn/csp";
export { isBlankRgba } from "./drawn/blank";
export {
  bundleDrawnScene,
  renderDrawnClip,
  renderDrawnPreview,
  renderDrawnStills,
  type DrawnBrowserLog,
} from "./drawn/render";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Entry point path — also used by `ossclip studio` to launch Remotion Studio. */
export const STUDIO_ENTRY = join(HERE, "entry.tsx");

export async function renderProduction(
  props: ProductionCompProps,
  opts: RenderJobOptions,
): Promise<void> {
  // The phase report exists because `opts.cancelSignal` only reaches
  // `renderMedia` — neither `bundle()` nor `selectComposition()` accepts one
  // in 4.0.499 (see RenderPhase in render-options.ts for how that was
  // verified). A caller that traps SIGINT must therefore terminate the
  // process ITSELF while these two run, and it can only know to do that if it
  // is told which phase is in flight.
  opts.onPhase?.("bundling");
  const serveUrl = await bundle({
    entryPoint: STUDIO_ENTRY,
    publicDir: opts.publicDir,
  });
  const inputProps = props as unknown as Record<string, unknown>;
  opts.onPhase?.("selecting");
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    browserExecutable: opts.browserExecutable,
  });
  opts.onPhase?.("rendering");
  // Every non-I/O decision lives in renderMediaOptions (render-options.ts) so
  // the memory bound and the cancel signal are testable without a browser.
  // This is the I/O half, so this is where the real platform is read — the
  // builder takes it as an argument so its matrix can be asserted (§144).
  await renderMedia(
    renderMediaOptions({
      composition,
      serveUrl,
      inputProps,
      opts,
      platform: process.platform,
    }),
  );
}

/**
 * Render the cover still (FINDINGS §31). A separate 1080×1920 JPEG rather
 * than a burned-in intro: both platforms take a custom cover, and the opening
 * seconds of the reel are the hook, not a title card.
 */
export async function renderCover(
  props: CoverCompProps,
  opts: { publicDir: string; outPath: string; browserExecutable?: string },
): Promise<void> {
  const serveUrl = await bundle({ entryPoint: STUDIO_ENTRY, publicDir: opts.publicDir });
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl,
    id: COVER_ID,
    inputProps,
    browserExecutable: opts.browserExecutable,
  });
  await renderStill({
    composition,
    serveUrl,
    output: opts.outPath,
    inputProps,
    imageFormat: "jpeg",
    jpegQuality: 90,
    browserExecutable: opts.browserExecutable,
  });
}

/**
 * Bundles the render entry once, serving `publicDir`. Exposed for
 * `pnpm stills`, which renders dozens of stills from ONE bundle — bundling
 * per still would cost tens of seconds each, and every still renders from
 * the same entry anyway (the composition is chosen by id and props).
 */
export async function bundleRenderEntry(publicDir: string): Promise<string> {
  return bundle({ entryPoint: STUDIO_ENTRY, publicDir });
}

/**
 * Render one scene still as PNG (plan Task 3) — `renderCover`'s shape with a
 * frame. `atSec` is seconds into the cue, which starts at 0, so it is also
 * the frame time. Pass `serveUrl` from `bundleRenderEntry(publicDir)` to
 * reuse a bundle; without it this bundles `publicDir` itself. PNG rather
 * than the cover's JPEG: these are looked at for edges and type, and JPEG
 * ringing around thin strokes is exactly what they are meant to show
 * clearly.
 */
export async function renderSceneStill(
  props: SceneStillProps,
  opts: {
    publicDir: string;
    outPath: string;
    atSec: number;
    serveUrl?: string;
    browserExecutable?: string;
  },
): Promise<void> {
  const serveUrl = opts.serveUrl ?? (await bundleRenderEntry(opts.publicDir));
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl,
    id: SCENE_STILL_ID,
    inputProps,
    browserExecutable: opts.browserExecutable,
  });
  await renderStill({
    composition,
    serveUrl,
    output: opts.outPath,
    inputProps,
    frame: stillFrame(opts.atSec, composition.fps),
    imageFormat: "png",
    browserExecutable: opts.browserExecutable,
  });
}

/**
 * Render one kit scene clip (§162, design 3.2): ProRes 4444 with alpha, the
 * scene alone (`SceneClipComposition`, options in `clipRenderOptions`).
 * `renderSceneStill`'s shape: pass `serveUrl` from
 * `bundleRenderEntry(publicDir)` to render a whole kit from one bundle;
 * without it this bundles `publicDir` itself. The public dir must hold the
 * bundled fonts (`stageBundledFonts`), or `<BundledFonts>` 404s to the
 * fallback stack.
 *
 * Written to `partialClipPath(outPath)` and renamed on success, so a render
 * that fails or is cancelled never leaves a file under the clip's own name —
 * the kit reuses a clip whose file exists and whose key matches, and a
 * truncated one must not pass for done. The partial is removed on failure.
 */
export async function renderSceneClip(
  props: SceneClipProps,
  opts: ClipJobOptions & { publicDir: string; serveUrl?: string },
): Promise<void> {
  const serveUrl = opts.serveUrl ?? (await bundleRenderEntry(opts.publicDir));
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl,
    id: SCENE_CLIP_ID,
    inputProps,
    browserExecutable: opts.browserExecutable,
  });
  const partial = partialClipPath(opts.outPath);
  try {
    await renderMedia(
      clipRenderOptions({ composition, serveUrl, inputProps, opts: { ...opts, outPath: partial } }),
    );
    await rename(partial, opts.outPath);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}
