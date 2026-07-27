import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { COMPOSITION_ID } from "./Root";
import { COVER_ID } from "./CoverComposition";
import type { ProductionCompProps } from "./ProductionComposition";
import type { CoverCompProps } from "./CoverComposition";

export type { ProductionCompProps } from "./ProductionComposition";
export type { CoverCompProps } from "./CoverComposition";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Entry point path — also used by `ossclip studio` to launch Remotion Studio. */
export const STUDIO_ENTRY = join(HERE, "entry.tsx");

export interface RenderJobOptions {
  /** Directory served as the bundle's public dir (must contain the video). */
  publicDir: string;
  outPath: string;
  browserExecutable?: string;
  concurrency?: number;
  onProgress?: (fraction: number) => void;
}

export async function renderProduction(
  props: ProductionCompProps,
  opts: RenderJobOptions,
): Promise<void> {
  const serveUrl = await bundle({
    entryPoint: STUDIO_ENTRY,
    publicDir: opts.publicDir,
  });
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    browserExecutable: opts.browserExecutable,
  });
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: opts.outPath,
    inputProps,
    browserExecutable: opts.browserExecutable,
    concurrency: opts.concurrency,
    onProgress: opts.onProgress
      ? ({ progress }) => opts.onProgress!(progress)
      : undefined,
  });
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
