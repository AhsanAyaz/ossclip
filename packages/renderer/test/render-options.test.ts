import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES,
  renderMediaOptions,
} from "../src/render-options";

/**
 * The two options the 2026-08-19 field case added — a bounded offthread video
 * cache and a cancel signal — reach `renderMedia` or they do nothing at all,
 * and a render is far too expensive a place to find that out. Asserted on the
 * options OBJECT (render-options.ts holds no Remotion runtime import), which
 * is why the builder was split out of renderProduction in the first place.
 */

// Only the fields renderMediaOptions passes straight through are real here;
// composition is Remotion's VideoConfig and the builder never reads into it.
const composition = { id: "Production", width: 1080, height: 1920 } as never;
// `platform` is required, so every case has to say which machine it speaks for.
// darwin is the default here only because these cases are not about the gate;
// the gate has its own matrix below.
const base = {
  composition,
  serveUrl: "http://localhost:3000",
  inputProps: {},
  platform: "darwin" as NodeJS.Platform,
};

describe("renderMediaOptions", () => {
  it("bounds the offthread video cache by default", () => {
    const o = renderMediaOptions({ ...base, opts: { publicDir: "/pub", outPath: "/o.mp4" } });
    // Remotion's own default is null = size it from system memory, which is
    // what let 12 tabs balloon until Chrome died whole.
    expect(o.offthreadVideoCacheSizeInBytes).toBe(DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES);
    expect(DEFAULT_OFFTHREAD_VIDEO_CACHE_BYTES).toBe(512 * 1024 * 1024);
  });

  it("lets the caller override the cache bound", () => {
    const o = renderMediaOptions({
      ...base,
      opts: { publicDir: "/pub", outPath: "/o.mp4", offthreadVideoCacheSizeInBytes: 1234 },
    });
    expect(o.offthreadVideoCacheSizeInBytes).toBe(1234);
  });

  it("threads the cancel signal through", () => {
    const cancelSignal = () => {};
    const o = renderMediaOptions({
      ...base,
      opts: { publicDir: "/pub", outPath: "/o.mp4", cancelSignal },
    });
    expect(o.cancelSignal).toBe(cancelSignal);
  });

  it("leaves cancelSignal undefined when the caller passes none", () => {
    const o = renderMediaOptions({ ...base, opts: { publicDir: "/pub", outPath: "/o.mp4" } });
    expect(o.cancelSignal).toBeUndefined();
  });

  it("carries the resolved concurrency and the render settings", () => {
    const o = renderMediaOptions({
      ...base,
      opts: { publicDir: "/pub", outPath: "/o.mp4", concurrency: 4 },
    });
    expect(o.concurrency).toBe(4);
    expect(o.outputLocation).toBe("/o.mp4");
    expect(o.codec).toBe("h264");
    expect(o.imageFormat).toBe("jpeg");
  });

  it("does not pass onPhase to renderMedia — it is the CALLER's, not Remotion's", () => {
    // `onPhase` exists because bundle() and selectComposition() take no
    // cancelSignal in 4.0.499, so the CLI has to answer for a signal itself
    // during those two (RenderPhase's comment has the verification). Remotion
    // has no such option; leaking it into the options object would be a
    // silently-ignored key at best.
    const o = renderMediaOptions({
      ...base,
      opts: { publicDir: "/pub", outPath: "/o.mp4", onPhase: () => {} },
    });
    expect(o).not.toHaveProperty("onPhase");
  });

  it("maps Remotion's progress payload down to a fraction", () => {
    const seen: number[] = [];
    const o = renderMediaOptions({
      ...base,
      opts: { publicDir: "/pub", outPath: "/o.mp4", onProgress: (f) => seen.push(f) },
    });
    o.onProgress?.({ progress: 0.42 } as never);
    expect(seen).toEqual([0.42]);
  });
});

/**
 * The hardware-acceleration platform matrix (§144). The whole cross-platform
 * decision asserted here, the picker/openCommand convention (§136): a Linux or
 * Windows user must never be the one who discovers the setting was wrong.
 *
 * The old test asserted `hardwareAcceleration === "if-possible"` unconditionally
 * while running on ONE platform, so it passed everywhere and proved nothing —
 * that is exactly how #7 shipped. Platforms are passed as literal strings, never
 * stubbed onto `process`; nothing in this repo stubs process.platform.
 *
 * Facts pinned below were read out of the installed @remotion/renderer, not
 * assumed (dist/get-codec-name.js, identical in 4.0.499 and 4.0.515).
 */
describe("renderMediaOptions — hardware acceleration is gated to darwin", () => {
  const optsFor = (platform: NodeJS.Platform) =>
    renderMediaOptions({
      ...base,
      platform,
      opts: { publicDir: "/pub", outPath: "/o.mp4" },
    });

  it("darwin: if-possible — h264_videotoolbox is the 2026-08-17 render-speed win", () => {
    expect(optsFor("darwin").hardwareAcceleration).toBe("if-possible");
  });

  it("win32: disable — if-possible picks h264_nvenc with no probe, and a box without nvcuda.dll loses the whole render at 100%", () => {
    expect(optsFor("win32").hardwareAcceleration).toBe("disable");
  });

  it("linux: disable — same unconditional nvenc selection as win32", () => {
    expect(optsFor("linux").hardwareAcceleration).toBe("disable");
  });

  it("no crf/encodingMaxRate/encodingBufferSize — any of them silently disables hwaccel, even on darwin", () => {
    // getCodecName drops to libx264 when one of these is set, which would undo
    // the darwin case above without changing the line that sets it.
    const o = optsFor("darwin");
    expect(o).not.toHaveProperty("crf");
    expect(o).not.toHaveProperty("encodingMaxRate");
    expect(o).not.toHaveProperty("encodingBufferSize");
  });
});
