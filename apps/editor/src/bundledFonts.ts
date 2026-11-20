import { useEffect } from "react";
import { fontsToLoad, type Theme } from "@ossclip/core/browser";
import { browserFontEnv, loadFontFaces } from "@ossclip/scenes";

/**
 * Where the editor fetches a bundled face: the edit server's `/media/` mount
 * over the workdir, where produce stages the files beside the render's copy
 * (`stageBundledFonts`). The Player's own `BundledFonts` resolves the same
 * rel through `staticFile()`, which in the editor page is `/fonts/…` — the
 * editor bundle, not the workdir — so that load 404s and releases its
 * handle; this registration is the one that lands. The Nastaliq face reaches
 * the editor the same way (TranscriptPanel's registration).
 */
export const editorFontUrl = (rel: string): string => `/media/${rel}`;

/**
 * Registers the explainer look's faces for the editor's preview when the
 * live theme asks for them. Keyed on `fontsToLoad`'s result, which is the
 * same frozen list for every bundled theme, so a colour edit does not
 * re-fetch. A failed load (a workdir produced before the look, a hand-built
 * one) leaves the fallback stack — `loadFontFaces` never rejects — and no
 * `delayRender`: the Player does not seek-and-screenshot.
 */
export function useBundledFonts(theme: Pick<Partial<Theme>, "fonts">): void {
  const fonts = fontsToLoad(theme);
  useEffect(() => {
    if (fonts.length === 0) return;
    void loadFontFaces(fonts, browserFontEnv(), editorFontUrl);
  }, [fonts]);
}
