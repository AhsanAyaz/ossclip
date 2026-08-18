/**
 * The `renderMedia` options object, built as pure data (house split: the
 * decisions here, the browser/ffmpeg I/O in index.ts). Extracted from
 * `renderProduction` on 2026-08-19 so the memory bound and the cancel signal
 * the field case below forced can be asserted in a test — importing
 * index.ts would drag @remotion/bundler and the Rust compositor binary into
 * the suite. Only TYPE imports from @remotion/renderer here, so this module
 * stays free of that at runtime.
 */
import type { CancelSignal, RenderMediaOptions } from "@remotion/renderer";

export interface RenderJobOptions {
  /** Directory served as the bundle's public dir (must contain the video). */
  publicDir: string;
  outPath: string;
  browserExecutable?: string;
  concurrency?: number;
  /**
   * Ceiling on Remotion's offthread frame cache, in bytes. Defaults to
   * DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES; exposed so a machine that can afford
   * more (or less) can say so.
   */
  offthreadVideoCacheSizeInBytes?: number;
  /**
   * `makeCancelSignal().cancelSignal` — firing its `cancel()` tears the
   * browser and the ffmpeg children down instead of orphaning them. The CLI
   * wires this to SIGINT/SIGTERM around the render phase (produce.ts).
   */
  cancelSignal?: CancelSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * 512 MiB. Remotion's own default is `null`, which lets the Rust compositor
 * size its frame cache from available system memory — and that is what let a
 * render eat the machine in the 2026-08-19 field case: a 14-core / 36GB Mac
 * resolved to 12 concurrent tabs, each decoding a 1080×1920 OffthreadVideo
 * beside a multi-gigabyte frame cache, and Chrome died WHOLE. The logs are
 * unmistakable — bursts of exactly 12 "The browser crashed while rendering
 * frame N" lines (one per in-flight tab) followed by "Killed previous browser
 * and making new one"; Remotion retried and the render limped on at a
 * fraction of the speed. A fixed bound trades some cache hits for a render
 * that finishes.
 */
export const DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES = 512 * 1024 * 1024;

export function renderMediaOptions(args: {
  composition: RenderMediaOptions["composition"];
  serveUrl: string;
  inputProps: Record<string, unknown>;
  opts: RenderJobOptions;
}): RenderMediaOptions {
  const { composition, serveUrl, inputProps, opts } = args;
  return {
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: opts.outPath,
    inputProps,
    browserExecutable: opts.browserExecutable,
    // VideoToolbox on macOS lifts the x264 CPU tax off the encode half of a
    // decode-bound render; "if-possible" falls back silently to software
    // everywhere else (2026-08-17 render-speed pass; option name and values
    // verified against @remotion/renderer 4.0.499's HardwareAccelerationOption).
    hardwareAcceleration: "if-possible",
    // Screenshot TRANSPORT only — the ENCODED output's quality is set by the
    // codec settings above. The PNG default was lossless but 3-5x slower to
    // screenshot and pipe per frame, for fidelity h264 then threw away.
    imageFormat: "jpeg",
    jpegQuality: 90,
    concurrency: opts.concurrency,
    // See DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES for the whole-browser OOM this
    // bounds (option name verified against @remotion/renderer 4.0.499, which
    // forwards it to the compositor as maximum_frame_cache_size_in_bytes).
    offthreadVideoCacheSizeInBytes:
      opts.offthreadVideoCacheSizeInBytes ?? DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES,
    cancelSignal: opts.cancelSignal,
    onProgress: opts.onProgress
      ? ({ progress }) => opts.onProgress!(progress)
      : undefined,
  };
}
