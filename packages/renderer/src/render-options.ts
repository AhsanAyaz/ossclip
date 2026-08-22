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

/**
 * Which of `renderProduction`'s three phases is in flight.
 *
 * Reported to the caller because only the LAST one can be cancelled. Verified
 * against the installed 4.0.499 types (2026-08-19 Ctrl-C dead-window fix):
 * `@remotion/bundler`'s `BundleOptions` has no cancel/abort/signal member at
 * all, and `selectComposition`'s options type carries none either — inside
 * @remotion/renderer, `cancelSignal` appears only on `renderMedia`,
 * `renderStill`, `renderFrames` and `stitchFramesToVideo`. So a signal during
 * "bundling" or "selecting" has NOBODY listening, and the CLI has to know
 * that: it registered a SIGINT handler, which suppresses node's default
 * terminate, and without this phase report Ctrl-C during a cold bundle (tens
 * of seconds, minutes when Chrome is downloaded on first run) did literally
 * nothing while the terminal looked hung. produce.ts's `renderSignalAction`
 * is the other half.
 */
export type RenderPhase = "bundling" | "selecting" | "rendering";

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
  /**
   * Called as each phase STARTS, before the call it names. See `RenderPhase`:
   * the cancel signal above only reaches the third, so a caller that traps
   * signals needs to know which phase it is in to answer for the first two.
   */
  onPhase?: (phase: RenderPhase) => void;
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
  /**
   * Required, not defaulted: this module is the PURE half, so the platform is
   * an input to the decision, not something it reads off the process. Same
   * split as `openCommand(target, platform)` — index.ts passes
   * `process.platform` at the one production call site. Un-defaulted is what
   * makes the platform matrix below assertable at all (§144).
   */
  platform: NodeJS.Platform;
}): RenderMediaOptions {
  const { composition, serveUrl, inputProps, opts, platform } = args;
  return {
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: opts.outPath,
    inputProps,
    browserExecutable: opts.browserExecutable,
    // VideoToolbox on macOS lifts the x264 CPU tax off the encode half of a
    // decode-bound render — that is the 2026-08-17 render-speed pass (83567f1),
    // and it was measured on macOS ONLY.
    //
    // The gate is load-bearing: "if-possible" is a static PLATFORM PREFERENCE,
    // not a capability probe. Remotion's getCodecName (dist/get-codec-name.js,
    // identical in 4.0.499 and 4.0.515) switches on process.platform alone —
    // darwin -> h264_videotoolbox, linux/win32 -> h264_nvenc, with nothing
    // asking whether an NVIDIA encoder exists. The old comment here claimed it
    // "falls back silently to software everywhere else"; it does not, and a box
    // without nvcuda.dll loses the ENTIRE render at 100% when the encoder is
    // opened at stitch time, after every frame has been paid for (#7, §144).
    // "disable" is Remotion's own default, so off-darwin this is upstream
    // behaviour, not a downgrade.
    //
    // Careful if you ever tune quality: setting crf (or encodingMaxRate /
    // encodingBufferSize) makes Remotion silently drop to libx264 even on
    // darwin, which would quietly undo the pass above (get-codec-name.js:5-32).
    hardwareAcceleration: platform === "darwin" ? "if-possible" : "disable",
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
