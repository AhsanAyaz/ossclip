import type { Theme } from "./scene-schema";

/**
 * The explainer look's bundled faces (§161): Inter for display type and
 * DejaVu Sans Mono for terminals, so the look renders in the same fonts on a
 * Linux box with neither installed as on the author's Mac. Browser-safe — a
 * type import and constants only — because the render's loader
 * (`BundledFonts` in scenes) needs the list at runtime; the node half that
 * finds the files on disk is `bundledFontFiles()` in fonts.ts, the
 * captions.ts / fonts.ts split the Nastaliq face already follows.
 *
 * `family` is the name the loader registers, and must be the name the
 * explainer stacks lead with (`look.ts`) or no text ever picks the face.
 * fontsource names its DejaVu package "DejaVu Mono"; the registered name is
 * ours to choose and the look asks for "DejaVu Sans Mono".
 *
 * Only Inter 800 and 900: the playbook's display type is all heavy, and a
 * lighter weight asked of `fontDisplay` resolves to 800 by the browser's
 * nearest-weight rule rather than falling off the stack.
 *
 * `rel` is the served path under the render's public dir, POSIX-literal like
 * NASTALIQ_FONT_REL — `staticFile()` splits only on `/`.
 */
export interface BundledFont {
  family: string;
  weight: string;
  rel: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = Object.freeze([
  { family: "Inter", weight: "800", rel: "fonts/Inter-ExtraBold.woff2" },
  { family: "Inter", weight: "900", rel: "fonts/Inter-Black.woff2" },
  { family: "DejaVu Sans Mono", weight: "400", rel: "fonts/DejaVuSansMono.woff2" },
  { family: "DejaVu Sans Mono", weight: "700", rel: "fonts/DejaVuSansMono-Bold.woff2" },
]);

/**
 * The faces a theme needs loaded: all of them when `fonts` is "bundled",
 * none otherwise. ONE predicate for produce (stages the files), the render
 * and the editor (load them) — the `captionsNeedNastaliq` rule: if two sides
 * tested different conditions, one could fetch a file the other never wrote.
 * Takes a partial theme because the composition receives render-props
 * unparsed, and one written before `fonts` existed has no key — which must
 * read as "system", so those renders fetch nothing (plan G6).
 */
export function fontsToLoad(theme: Pick<Partial<Theme>, "fonts">): readonly BundledFont[] {
  return theme.fonts === "bundled" ? BUNDLED_FONTS : [];
}
