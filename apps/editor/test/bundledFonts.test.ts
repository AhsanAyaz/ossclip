// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_FONTS, defaultTheme, type Theme } from "@ossclip/core/browser";
import { editorFontUrl, useBundledFonts } from "../src/bundledFonts";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

describe("editorFontUrl", () => {
  it("points a served rel at the workdir mount, where produce staged it", () => {
    expect(editorFontUrl("fonts/Inter-Black.woff2")).toBe("/media/fonts/Inter-Black.woff2");
  });
});

describe("useBundledFonts", () => {
  function mount(themes: Pick<Partial<Theme>, "fonts">[]): string[] {
    const sources: string[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(_family: string, src: string) {
          sources.push(src);
        }
        load() {
          return Promise.resolve(this);
        }
      },
    );
    Object.defineProperty(document, "fonts", { value: { add: vi.fn() }, configurable: true });
    const Probe: React.FC<{ theme: Pick<Partial<Theme>, "fonts"> }> = ({ theme }) => {
      useBundledFonts(theme);
      return null;
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    for (const theme of themes) act(() => root.render(React.createElement(Probe, { theme })));
    act(() => root.unmount());
    return sources;
  }

  it("fetches nothing without the look", () => {
    expect(mount([defaultTheme, {}])).toEqual([]);
  });

  it("fetches every face through /media/ with the look", () => {
    expect(mount([{ ...defaultTheme, fonts: "bundled" }])).toEqual(
      BUNDLED_FONTS.map((f) => `url("/media/${f.rel}") format("woff2")`),
    );
  });

  it("a theme edit that keeps the look does not fetch again", () => {
    const look = { ...defaultTheme, fonts: "bundled" as const };
    expect(mount([look, { ...look, accent: "#00FF00" }])).toHaveLength(BUNDLED_FONTS.length);
  });
});
