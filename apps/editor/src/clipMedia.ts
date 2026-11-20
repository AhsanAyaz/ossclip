import type { SceneCue } from "@ossclip/core/browser";

/**
 * A `ClipScene` cue's `src`, pointed at the edit server's `/media/` mount for
 * the Player (explainer plan Task 8, "Editor preview").
 *
 * The clip import writes `clips/<hash>.webm` into the workdir, and the cue
 * carries that public-dir-relative path because the RENDER resolves it through
 * `staticFile()` against its public dir. In the editor the page is served from
 * the editor bundle and only `/media/*` reaches the workdir, so the bare path
 * 404'd and the preview showed nothing where the clip should be. Rewritten the
 * way `videoFileName` is: `staticFile()` leaves an already-rooted path alone.
 *
 * Player-only, applied where the Player's props are built and nowhere else:
 * the Inspector and the timeline keep the stored `src`, so nothing written
 * back from the editor can carry a `/media/` path into overrides.json. An
 * http(s) URL or an already-rooted path is left as it is, and a list with no
 * clip to rewrite comes back as the SAME array, so every project without a
 * clip hands the Player exactly the object it got before this existed.
 */
export function withMediaClipSrc(cues: SceneCue[]): SceneCue[] {
  const needs = (c: SceneCue): boolean => {
    const src = c.component === "ClipScene" ? c.props?.src : undefined;
    return typeof src === "string" && src.length > 0 && !/^https?:\/\//.test(src) && !src.startsWith("/");
  };
  if (!cues.some(needs)) return cues;
  return cues.map((c) => (needs(c) ? { ...c, props: { ...c.props, src: `/media/${c.props!.src as string}` } } : c));
}
