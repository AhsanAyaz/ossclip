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
const base = { composition, serveUrl: "http://localhost:3000", inputProps: {} };

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
    expect(o.hardwareAcceleration).toBe("if-possible");
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
