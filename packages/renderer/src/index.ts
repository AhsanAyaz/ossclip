import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { COMPOSITION_ID } from "./Root";
import { COVER_ID } from "./CoverComposition";
import { renderMediaOptions } from "./render-options";
import type { RenderJobOptions } from "./render-options";
import type { ProductionCompProps } from "./ProductionComposition";
import type { CoverCompProps } from "./CoverComposition";

export type { ProductionCompProps } from "./ProductionComposition";
export type { CoverCompProps } from "./CoverComposition";
export type { RenderJobOptions, RenderPhase } from "./render-options";
export { DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES, renderMediaOptions } from "./render-options";
// Re-exported so the CLI can build a cancel signal without depending on
// @remotion/renderer directly — @ossclip/renderer is the only door onto
// Remotion this repo opens (2026-08-19 Ctrl-C fix).
export { makeCancelSignal } from "@remotion/renderer";
export type { CancelSignal } from "@remotion/renderer";

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
