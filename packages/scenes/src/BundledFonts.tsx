import React from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { fontsToLoad, type BundledFont, type Theme } from "@ossclip/core/browser";

/**
 * What a font load needs from the browser, injected so the load can be tested
 * without a DOM (this package carries no jsdom). Both fields are optional
 * because jsdom and older engines have neither — and a missing FontFace must
 * read as "fonts failed", never as a throw that leaves the render held.
 */
export interface FontEnv {
  FontFace?: new (family: string, source: string, descriptors?: FontFaceDescriptors) => FontFace;
  add?: (face: FontFace) => void;
}

/** The running browser's FontFace and `document.fonts`, or `{}` where absent. */
export function browserFontEnv(): FontEnv {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
    return {};
  }
  return { FontFace, add: (face) => document.fonts.add(face) };
}

/**
 * Loads `fonts` from `urlFor(rel)` and registers each face that arrives.
 * NEVER rejects: `allSettled` over every face, and a constructor that throws
 * is just one more failed face. A missing file must leave the render on the
 * theme's fallback stack (each explainer stack ends in the old system fonts),
 * not cancel it and not hold its `delayRender` — Review Focus 5. One failed
 * face does not cost the others: a lost Black weight still leaves ExtraBold
 * for the browser's nearest-weight match.
 *
 * `urlFor` is the one seam between the two callers: the render resolves the
 * rel against its public dir (`staticFile`), the editor against the edit
 * server's `/media/` mount, where produce staged the same files.
 */
export async function loadFontFaces(
  fonts: readonly BundledFont[],
  env: FontEnv,
  urlFor: (rel: string) => string,
): Promise<{ loaded: number; failed: number }> {
  const { FontFace: Ctor, add } = env;
  if (!Ctor || !add) return { loaded: 0, failed: fonts.length };
  const results = await Promise.allSettled(
    fonts.map(async (f) => {
      const face = new Ctor(f.family, `url("${urlFor(f.rel)}") format("woff2")`, {
        weight: f.weight,
      });
      add(await face.load());
    }),
  );
  const loaded = results.filter((r) => r.status === "fulfilled").length;
  return { loaded, failed: results.length - loaded };
}

/**
 * Registers the explainer look's bundled faces for this render, on the
 * pattern of CaptionTrack's NastaliqFontLoader: FontFace + delayRender rather
 * than a stylesheet `@font-face`, because the render seeks and screenshots
 * and a lazily-fetched font can miss the first frames it is needed on.
 *
 * ONE handle for all four faces, released exactly once — when the loads
 * settle, success or not, or on unmount, whichever comes first. A render
 * whose font files failed draws in the fallback stack; a render held on a
 * handle nobody releases times out and dies, which is strictly worse.
 */
const BundledFontLoader: React.FC<{ fonts: readonly BundledFont[] }> = ({ fonts }) => {
  const [handle] = React.useState(() => delayRender("load bundled fonts"));
  React.useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    loadFontFaces(fonts, browserFontEnv(), staticFile).then(finish, finish);
    return finish;
  }, [fonts, handle]);
  return null;
};

/**
 * Mount point for the bundled fonts; renders nothing either way. With
 * `theme.fonts` anything but "bundled" — the default, and every render-props
 * written before the key existed — it does not call `delayRender` and fetches
 * nothing, so runs without the explainer look render as before (plan G6).
 * Keyed on `fontsToLoad`, the predicate produce stages the files by, so the
 * render never asks for a file produce did not copy.
 */
export const BundledFonts: React.FC<{ theme: Pick<Partial<Theme>, "fonts"> }> = ({ theme }) => {
  const fonts = fontsToLoad(theme);
  return fonts.length > 0 ? <BundledFontLoader fonts={fonts} /> : null;
};
