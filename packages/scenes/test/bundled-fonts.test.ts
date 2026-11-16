import { describe, expect, it, vi } from "vitest";
import { BUNDLED_FONTS } from "@ossclip/core/browser";
import { loadFontFaces, type FontEnv } from "../src/BundledFonts";

// The load half of the explainer look's font loader, with the browser's
// FontFace and `document.fonts` injected: this package carries no jsdom, and
// the delayRender wiring around it is exercised by the editor's
// bundled-fonts-loader.test.ts. What this pins is Review Focus 5 — a missing or
// broken font file resolves, it never rejects and never hangs, so the render
// continues on the fallback stack.

/** A FontFace stand-in whose `load()` outcome is chosen per source URL. */
function fakeFontFace(fail: (src: string) => boolean) {
  const made: { family: string; src: string; weight: string | undefined }[] = [];
  class Fake {
    family: string;
    src: string;
    constructor(family: string, src: string, desc?: { weight?: string }) {
      this.family = family;
      this.src = src;
      made.push({ family, src, weight: desc?.weight });
    }
    load(): Promise<Fake> {
      return fail(this.src) ? Promise.reject(new Error("404")) : Promise.resolve(this);
    }
  }
  return { Ctor: Fake as unknown as NonNullable<FontEnv["FontFace"]>, made };
}

const urlFor = (rel: string) => `/static/${rel}`;

describe("loadFontFaces", () => {
  it("registers every face under its family and weight, from the url it is given", async () => {
    const { Ctor, made } = fakeFontFace(() => false);
    const add = vi.fn();
    const result = await loadFontFaces(BUNDLED_FONTS, { FontFace: Ctor, add }, urlFor);
    expect(made).toEqual(
      BUNDLED_FONTS.map((f) => ({
        family: f.family,
        src: `url("/static/${f.rel}") format("woff2")`,
        weight: f.weight,
      })),
    );
    expect(add).toHaveBeenCalledTimes(BUNDLED_FONTS.length);
    expect(result).toEqual({ loaded: BUNDLED_FONTS.length, failed: 0 });
  });

  it("resolves when every file is missing, adding nothing", async () => {
    const { Ctor } = fakeFontFace(() => true);
    const add = vi.fn();
    const result = await loadFontFaces(BUNDLED_FONTS, { FontFace: Ctor, add }, urlFor);
    expect(add).not.toHaveBeenCalled();
    expect(result).toEqual({ loaded: 0, failed: BUNDLED_FONTS.length });
  });

  it("one failed face does not cost the others", async () => {
    const { Ctor } = fakeFontFace((src) => src.includes("Inter-Black"));
    const add = vi.fn();
    const result = await loadFontFaces(BUNDLED_FONTS, { FontFace: Ctor, add }, urlFor);
    expect(add).toHaveBeenCalledTimes(BUNDLED_FONTS.length - 1);
    expect(result).toEqual({ loaded: BUNDLED_FONTS.length - 1, failed: 1 });
  });

  it("a constructor that throws is a failed face, not a rejected load", async () => {
    const Throws = class {
      constructor() {
        throw new SyntaxError("bad descriptor");
      }
    } as unknown as NonNullable<FontEnv["FontFace"]>;
    await expect(
      loadFontFaces(BUNDLED_FONTS, { FontFace: Throws, add: vi.fn() }, urlFor),
    ).resolves.toEqual({ loaded: 0, failed: BUNDLED_FONTS.length });
  });

  it("resolves at once when the environment has no FontFace (jsdom, an old engine)", async () => {
    await expect(loadFontFaces(BUNDLED_FONTS, {}, urlFor)).resolves.toEqual({
      loaded: 0,
      failed: BUNDLED_FONTS.length,
    });
  });

  it("an empty list loads nothing and resolves", async () => {
    const { Ctor, made } = fakeFontFace(() => false);
    await expect(loadFontFaces([], { FontFace: Ctor, add: vi.fn() }, urlFor)).resolves.toEqual({
      loaded: 0,
      failed: 0,
    });
    expect(made).toEqual([]);
  });
});
