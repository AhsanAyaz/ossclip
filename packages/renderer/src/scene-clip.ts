/**
 * The pure half of a kit scene clip (§162, design 3.2): the composition's
 * props, its metadata, and the file the render writes before it is done. No
 * React, no Remotion runtime, no filesystem — the composition
 * (SceneClipComposition.tsx) and the render call (`renderSceneClip` in
 * index.ts) are the I/O around it, the scene-still.ts split.
 */
import type { SceneCue, Theme } from "@ossclip/core/browser";

/**
 * The composition's input props: one scene, alone on a transparent frame.
 *
 * `cue` is the REBASED cue (`rebaseCue`, core): it starts at 0 and ends on
 * the scene's frame window in the full render. Typed, never parsed with
 * `SceneCueSchema` — rebasing can leave a `reveal.itemAtSec` or
 * `entryAtSec` negative (an item spoken before the scene's final start),
 * which the schema's nonnegative bounds would reject although reveal.ts
 * places it correctly.
 */
export interface SceneClipProps {
  cue: SceneCue;
  theme: Theme;
  settings: { width: number; height: number; fps: number };
}

/**
 * The clip's size, rate and length: the output frame and fps, for as many
 * frames as the rebased cue ends on. `round(endSec × fps)` is the cue's own
 * `frameWindow(0, endSec)`, so the clip and the scene's `<Sequence>` inside it
 * end on the same frame, and that is the scene's window in the full render
 * because rebaseCue set `endSec` from it. At least one frame, as Remotion
 * rejects an empty composition.
 */
export function sceneClipMetadata(p: SceneClipProps): {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
} {
  return {
    width: p.settings.width,
    height: p.settings.height,
    fps: p.settings.fps,
    durationInFrames: Math.max(1, Math.round(p.cue.endSec * p.settings.fps)),
  };
}

/**
 * Where the render writes until it succeeds: `clip.mov` → `clip.partial.mov`.
 * The suffix goes BEFORE the extension because renderMedia checks the output
 * name's extension against the codec (validate-output-filename.js in 4.0.499:
 * prores wants `.mov`), so `clip.mov.partial` is refused before a frame is
 * drawn. A half-written clip under its final name would look reusable to the
 * kit's file-exists check; under this name it never does.
 */
export function partialClipPath(outPath: string): string {
  const slash = Math.max(outPath.lastIndexOf("/"), outPath.lastIndexOf("\\"));
  const dot = outPath.lastIndexOf(".");
  if (dot <= slash + 1) return `${outPath}.partial`;
  return `${outPath.slice(0, dot)}.partial${outPath.slice(dot)}`;
}
