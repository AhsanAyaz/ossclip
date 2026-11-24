/**
 * The content security policy every drawn-scene bundle is served with (§167,
 * storyboard design §5 "Where the code runs"). Pure: render.ts writes the
 * result into the bundle's index.html.
 *
 * Why a policy at all: a drawn scene is LLM-written code, and the static check
 * is a filter, not a sandbox: `globalThis["fe"+"tch"]` hides a name from the
 * parser. Remotion's browser options have no switch that takes the page off
 * the network, and the editor server trusts every loopback origin
 * (apps/cli/src/edit-origin.ts), which the render page is one of. Measured in
 * the 2026-11-20 spike: a scene's `fetch`, `<img>`, `new Image()` and CSS
 * `url()` reached a probe server 4 times without this policy and 0 with it.
 *
 * Each directive, and why it is not tighter:
 * - `default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:` — the
 *   bundle's own scripts and Remotion's runtime, as the spike ran them. The
 *   inline and eval allowances stay because a tighter script policy was never
 *   tried against Remotion's page; they open no network path, and every
 *   directive below that does is narrowed on its own.
 * - `connect-src 'self'` — fetch, XHR, WebSocket and EventSource reach only
 *   the bundle's own port. Not the editor's port: that is the write endpoint
 *   this closes.
 * - `img-src`, `media-src` — the bundle's public dir (`Asset`'s staticFile)
 *   and inline data, nothing remote.
 * - `font-src 'self' data:` — the staged bundled fonts (`BundledFonts`).
 * - `frame-src 'none'; object-src 'none'` — no nested documents or plugins.
 *
 * A policy does not stop navigation, which is why the static check rejects
 * `location` and `open` as well.
 */
export const DRAW_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; frame-src 'none'; object-src 'none'";

const HEAD = "<head>";

/**
 * `indexHtml` with the policy as the first child of `<head>`. First, because a
 * `<meta>` policy only governs what loads after the parser reaches it; a
 * script tag ahead of it would load unguarded.
 *
 * Matches the literal `<head>` Remotion's template writes
 * (`@remotion/studio-shared` studio-html.js in 4.0.499) and throws when it is
 * missing: if an upgrade changes the template, the render must fail by name
 * here rather than serve LLM-written code on an unguarded page.
 */
export function injectCsp(indexHtml: string): string {
  const at = indexHtml.indexOf(HEAD);
  if (at === -1) {
    throw new Error("drawn-scene bundle: index.html has no <head>; refusing to serve it without the content security policy");
  }
  const end = at + HEAD.length;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${DRAW_CSP}">`;
  return indexHtml.slice(0, end) + meta + indexHtml.slice(end);
}
