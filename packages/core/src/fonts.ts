import { fileURLToPath } from "node:url";

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
