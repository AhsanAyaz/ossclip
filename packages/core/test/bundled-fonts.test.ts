import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTheme } from "../src/scene-schema";
import { lookTheme } from "../src/look";
import { BUNDLED_FONTS, fontsToLoad } from "../src/bundled-fonts";
import { bundledFontFiles, stageBundledFonts } from "../src/fonts";

describe("fontsToLoad — the one predicate produce, the render and the editor share", () => {
  it("loads nothing for a system-fonts theme (every run without --look)", () => {
    expect(fontsToLoad(defaultTheme)).toEqual([]);
  });

  it("loads nothing for a pre-§161 theme that has no `fonts` key at all", () => {
    // render-props.json written before Task 1 carries a theme without the
    // key; the composition receives it unparsed.
    expect(fontsToLoad({})).toEqual([]);
  });

  it("loads all four faces for the explainer look", () => {
    const faces = fontsToLoad({ ...defaultTheme, ...lookTheme("explainer") });
    expect(faces).toBe(BUNDLED_FONTS);
    expect(faces.map((f) => `${f.family} ${f.weight}`)).toEqual([
      "Inter 800",
      "Inter 900",
      "DejaVu Sans Mono 400",
      "DejaVu Sans Mono 700",
    ]);
  });

  it("names exactly the families the explainer font stacks lead with", () => {
    // A FontFace registered under any other name is never picked by the
    // theme's `font-family`, and the render silently draws the fallback.
    const look = lookTheme("explainer");
    for (const f of BUNDLED_FONTS) {
      const stack = f.family === "Inter" ? look.fontDisplay : look.fontMono;
      expect(stack?.startsWith(`'${f.family}',`)).toBe(true);
    }
  });

  it("serves every face from a POSIX-literal path under fonts/", () => {
    for (const f of BUNDLED_FONTS) expect(f.rel).toMatch(/^fonts\/[A-Za-z-]+\.woff2$/);
  });
});

describe("stageBundledFonts", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "ossclip-fonts-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("copies nothing for a system-fonts theme", () => {
    const dir = tmp();
    expect(stageBundledFonts(defaultTheme, [dir])).toEqual([]);
    expect(existsSync(join(dir, "fonts"))).toBe(false);
  });

  it("copies every face into every dir, byte for byte, for a bundled theme", () => {
    const a = tmp();
    const b = tmp();
    const staged = stageBundledFonts({ fonts: "bundled" }, [a, b]);
    expect(staged).toEqual(BUNDLED_FONTS.map((f) => f.rel));
    for (const dir of [a, b]) {
      for (const f of bundledFontFiles()) {
        expect(readFileSync(join(dir, f.rel)).equals(readFileSync(f.abs))).toBe(true);
      }
    }
  });
});
