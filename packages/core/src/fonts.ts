import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_FONTS, fontsToLoad } from "./bundled-fonts";
import type { Theme } from "./scene-schema";

/**
 * Node-side half of the bundled caption font (see `captions.ts` for the
 * browser-safe constants and the reason the font ships at all): the absolute
 * path produce copies into the render's public dir. Split from captions.ts
 * because `node:url` must never enter the Remotion bundle — captions.ts is
 * on the `@ossclip/core/browser` surface.
 *
 * The URL below is face.ts's pico-cascade load shape, and the packaging test
 * (R22 §111) scans this source for exactly that shape to assert the tarball
 * carries the file — which is also why this comment doesn't spell the
 * pattern out literally: the scanner reads comments too.
 */
export function nastaliqFontFile(): string {
  return fileURLToPath(new URL("../assets/fonts/NotoNastaliqUrdu-Bold.ttf", import.meta.url));
}

/**
 * The explainer look's faces on disk, keyed by their served `rel`. Spelled
 * out one literal per file rather than built from BUNDLED_FONTS in a loop:
 * the packaging scanner (R22 §111) only sees literal paths, and a templated
 * one would hide all four files from the tarball check.
 */
const BUNDLED_FONT_URLS: Readonly<Record<string, URL>> = {
  "fonts/Inter-ExtraBold.woff2": new URL("../assets/fonts/Inter-ExtraBold.woff2", import.meta.url),
  "fonts/Inter-Black.woff2": new URL("../assets/fonts/Inter-Black.woff2", import.meta.url),
  "fonts/DejaVuSansMono.woff2": new URL("../assets/fonts/DejaVuSansMono.woff2", import.meta.url),
  "fonts/DejaVuSansMono-Bold.woff2": new URL(
    "../assets/fonts/DejaVuSansMono-Bold.woff2",
    import.meta.url,
  ),
};

/** Each BUNDLED_FONTS face's served `rel` and the absolute file it comes from. */
export function bundledFontFiles(): { rel: string; abs: string }[] {
  return BUNDLED_FONTS.map((f) => {
    const url = BUNDLED_FONT_URLS[f.rel];
    // A face added to BUNDLED_FONTS without its file entry above: fail where
    // it is staged, by name, not as a 404 the loader quietly falls back on.
    if (!url) throw new Error(`no bundled file for ${f.rel}`);
    return { rel: f.rel, abs: fileURLToPath(url) };
  });
}

/**
 * Copies the theme's bundled faces (`fontsToLoad`) into each dir under their
 * served `rel`, returning the rels staged; a system-fonts theme copies
 * nothing and returns `[]`. Produce stages into the render's public dir AND
 * the workdir (the Nastaliq staging's reason: `ossclip edit` serves the
 * workdir at `/media/`), and the cover stages into its own public dir, so
 * every surface that draws with the look can fetch the files. An existing
 * copy is kept, as the Nastaliq staging does. `join` on the filesystem side,
 * the rel itself stays POSIX-literal (sideImageDestRel's Windows lesson).
 */
export function stageBundledFonts(
  theme: Pick<Partial<Theme>, "fonts">,
  dirs: Iterable<string>,
): string[] {
  const wanted = new Set(fontsToLoad(theme).map((f) => f.rel));
  if (wanted.size === 0) return [];
  const files = bundledFontFiles().filter((f) => wanted.has(f.rel));
  for (const dir of new Set(dirs)) {
    for (const f of files) {
      const dest = join(dir, f.rel);
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(f.abs, dest);
      }
    }
  }
  return files.map((f) => f.rel);
}
