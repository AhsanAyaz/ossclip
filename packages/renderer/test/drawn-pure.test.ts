import { describe, expect, it } from "vitest";
import { defaultTheme } from "@ossclip/core/browser";
import { DRAW_CSP, injectCsp } from "../src/drawn/csp";
import {
  DRAWN_COMPOSITION_ID,
  drawnEntrySource,
  drawnSceneMetadata,
  drawnStillFrames,
  type DrawnRenderProps,
} from "../src/drawn/entry-source";
import { isBlankRgba } from "../src/drawn/blank";
import {
  DRAWN_PREVIEW_BACKGROUND,
  DRAWN_PREVIEW_SCALE,
  drawnPreviewOptions,
  drawnPreviewProps,
} from "../src/drawn/preview-options";

/**
 * The pure halves of the drawn-scene renderer (§167): the policy written into
 * the bundle, the generated entry, the still frames and the blank test. The
 * browser half is drawn-render.test.ts.
 */

describe("injectCsp", () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${DRAW_CSP}">`;

  it("puts the policy directly after <head>, before anything the page loads", () => {
    const html = '<!DOCTYPE html><html><head><script src="bundle.js"></script></head><body></body></html>';
    expect(injectCsp(html)).toBe(
      `<!DOCTYPE html><html><head>${meta}<script src="bundle.js"></script></head><body></body></html>`,
    );
  });

  it("throws on a page with no <head>: an unguarded bundle must never be rendered", () => {
    expect(() => injectCsp("<html><body></body></html>")).toThrow(/<head>/);
  });

  it("is the spike's policy verbatim", () => {
    expect(DRAW_CSP).toBe(
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; frame-src 'none'; object-src 'none'",
    );
  });
});

describe("drawnEntrySource", () => {
  it("imports both files by their path as one JSON string literal each", () => {
    const scenePath = '/w/storyboard/s"1\\x/v1.tsx';
    const hostPath = "C:\\repo\\packages\\renderer\\src\\drawn\\DrawnSceneHost.tsx";
    const src = drawnEntrySource({ scenePath, hostPath });
    // A quote or a backslash in a path stays inside ONE literal: the
    // JSON-escaped form appears, and the raw form (which would end the
    // string early or start an escape) does not.
    expect(src).toContain(`from ${JSON.stringify(scenePath)}`);
    expect(src).toContain(`from ${JSON.stringify(hostPath)}`);
    expect(src).not.toContain(`"${scenePath}"`);
    expect(src).toContain("registerRoot(");
    expect(src).toContain(JSON.stringify(DRAWN_COMPOSITION_ID));
    expect(DRAWN_COMPOSITION_ID).toBe("drawn-scene");
  });
});

describe("drawnStillFrames", () => {
  it("25%, 60% and the last frame", () => {
    expect(drawnStillFrames(4, 30)).toEqual([30, 72, 119]);
    expect(drawnStillFrames(2, 30)).toEqual([15, 36, 59]);
  });

  it("stays inside a one-frame composition", () => {
    expect(drawnStillFrames(0, 30)).toEqual([0, 0, 0]);
  });
});

describe("drawnSceneMetadata", () => {
  it("size, rate and length come from the props", () => {
    const p: DrawnRenderProps = { durationSec: 3, width: 1080, height: 1920, fps: 25, theme: defaultTheme, assets: {} };
    expect(drawnSceneMetadata(p)).toEqual({ width: 1080, height: 1920, fps: 25, durationInFrames: 75 });
    expect(drawnSceneMetadata({ ...p, durationSec: 0 }).durationInFrames).toBe(1);
  });
});

describe("isBlankRgba", () => {
  it("true when every alpha byte is 0, whatever the colour bytes", () => {
    expect(isBlankRgba(new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0]))).toBe(true);
  });

  it("false when one alpha byte is not 0", () => {
    expect(isBlankRgba(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(false);
  });

  it("refuses a buffer that is not whole RGBA pixels", () => {
    expect(() => isBlankRgba(new Uint8Array([0, 0, 0]))).toThrow(/RGBA/);
  });
});

describe("the preview", () => {
  it("is VP8 at a quarter of the frame in each dimension, silent", () => {
    const composition = { id: "drawn-scene", width: 1080, height: 1920, fps: 30, durationInFrames: 90 } as never;
    const o = drawnPreviewOptions({ composition, serveUrl: "/b", inputProps: { a: 1 }, outPath: "/o/p.webm" });
    expect(o).toMatchObject({ codec: "vp8", scale: 0.25, muted: true, outputLocation: "/o/p.webm", inputProps: { a: 1 } });
    expect(DRAWN_PREVIEW_SCALE).toBe(0.25);
  });

  it("draws over mid-grey, through the props the composition is selected with", () => {
    const p: DrawnRenderProps = { durationSec: 3, width: 1080, height: 1920, fps: 30, theme: defaultTheme, assets: {} };
    expect(drawnPreviewProps(p)).toEqual({ ...p, background: DRAWN_PREVIEW_BACKGROUND });
    expect(DRAWN_PREVIEW_BACKGROUND).toBe("#808080");
  });
});
