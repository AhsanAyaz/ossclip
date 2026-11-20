// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_FONTS, defaultTheme } from "@ossclip/core/browser";

/**
 * The delayRender contract of the explainer look's font loader (Review
 * Focus 5): ONE handle, released exactly once whether the fonts load, fail,
 * or the environment has no FontFace at all — and no handle at all without
 * the look. The scenes package has no DOM to mount it in (its
 * bundled-fonts.test.ts covers the load itself), so it is mounted here, the
 * caption-direction.test.ts arrangement, against a mocked `remotion` that
 * records the handle traffic. Imported from the module directly for the
 * scene-layer-structure.test.ts reason: the barrel needs far more of
 * remotion than this mock offers.
 */
const remotion = vi.hoisted(() => ({
  delayRender: vi.fn((_label?: string) => 42),
  continueRender: vi.fn((_handle: number) => {}),
}));
vi.mock("remotion", () => ({
  delayRender: remotion.delayRender,
  continueRender: remotion.continueRender,
  staticFile: (path: string) => `/static/${path}`,
}));

const { BundledFonts } = await import("../../../packages/scenes/src/BundledFonts");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bundled = { ...defaultTheme, fonts: "bundled" as const };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  remotion.delayRender.mockClear();
  remotion.continueRender.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

/** Lets the loader's promise chain settle inside act. */
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

/** A FontFace whose load resolves or rejects, recording each source. */
function stubFontFace(outcome: "load" | "fail"): string[] {
  const sources: string[] = [];
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(_family: string, src: string) {
        sources.push(src);
      }
      load() {
        return outcome === "load" ? Promise.resolve(this) : Promise.reject(new Error("404"));
      }
    },
  );
  return sources;
}

function stubDocumentFonts(): ReturnType<typeof vi.fn> {
  const add = vi.fn();
  Object.defineProperty(document, "fonts", { value: { add }, configurable: true });
  return add;
}

describe("BundledFonts", () => {
  it("without the look: no handle, no fetch, no DOM", async () => {
    const sources = stubFontFace("load");
    act(() => root.render(React.createElement(BundledFonts, { theme: defaultTheme })));
    await settle();
    expect(remotion.delayRender).not.toHaveBeenCalled();
    expect(sources).toEqual([]);
    expect(host.innerHTML).toBe("");
  });

  it("a theme with no `fonts` key (pre-§161 render-props) is the same as system", async () => {
    act(() => root.render(React.createElement(BundledFonts, { theme: {} })));
    await settle();
    expect(remotion.delayRender).not.toHaveBeenCalled();
  });

  it("jsdom has no FontFace: the one handle is still released", async () => {
    act(() => root.render(React.createElement(BundledFonts, { theme: bundled })));
    await settle();
    expect(remotion.delayRender).toHaveBeenCalledTimes(1);
    expect(remotion.continueRender).toHaveBeenCalledTimes(1);
    expect(remotion.continueRender).toHaveBeenCalledWith(42);
  });

  it("missing font files: released once, and the render goes on", async () => {
    stubDocumentFonts();
    const sources = stubFontFace("fail");
    act(() => root.render(React.createElement(BundledFonts, { theme: bundled })));
    await settle();
    expect(sources).toHaveLength(BUNDLED_FONTS.length);
    expect(remotion.delayRender).toHaveBeenCalledTimes(1);
    expect(remotion.continueRender).toHaveBeenCalledTimes(1);
  });

  it("fonts that load: each face registered from the public dir, handle released once", async () => {
    const add = stubDocumentFonts();
    const sources = stubFontFace("load");
    act(() => root.render(React.createElement(BundledFonts, { theme: bundled })));
    await settle();
    expect(sources).toEqual(BUNDLED_FONTS.map((f) => `url("/static/${f.rel}") format("woff2")`));
    expect(add).toHaveBeenCalledTimes(BUNDLED_FONTS.length);
    expect(remotion.continueRender).toHaveBeenCalledTimes(1);
  });

  it("unmounted mid-load: released on unmount and never twice", async () => {
    stubDocumentFonts();
    let release!: () => void;
    vi.stubGlobal(
      "FontFace",
      class {
        load() {
          return new Promise((r) => {
            release = () => r(this);
          });
        }
      },
    );
    act(() => root.render(React.createElement(BundledFonts, { theme: bundled })));
    act(() => root.render(React.createElement(BundledFonts, { theme: defaultTheme })));
    expect(remotion.continueRender).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(remotion.continueRender).toHaveBeenCalledTimes(1);
  });
});
