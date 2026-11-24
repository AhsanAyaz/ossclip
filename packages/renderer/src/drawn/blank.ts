/**
 * The "drew nothing" still check (§167, storyboard design §5 step 4): a
 * version whose three stills are all fully transparent is rejected without an
 * AI looking at it. Pure, on decoded pixels, so the caller picks the decoder
 * and this is testable without a PNG.
 */

/**
 * True when every pixel's alpha is 0. Only alpha counts: the background is
 * transparent by rule (design §3), so a scene that paints anything at all
 * leaves a non-zero alpha somewhere, and the colour bytes under alpha 0 are
 * whatever the encoder left there.
 *
 * Throws on a length that is not whole RGBA pixels: that is a decoder handing
 * over some other layout (RGB, a row stride), and reading every fourth byte of
 * it would answer a question about the wrong bytes.
 */
export function isBlankRgba(pixels: Uint8Array | Uint8ClampedArray): boolean {
  if (pixels.length % 4 !== 0) {
    throw new Error(`isBlankRgba: ${pixels.length} bytes is not whole RGBA pixels`);
  }
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 0) return false;
  }
  return true;
}
