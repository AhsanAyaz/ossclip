/**
 * The pure half of a drawn-scene bundle (§167, storyboard design §5): the
 * generated entry's source, the composition's props and metadata, and the
 * frames the stills are taken at. No filesystem and no node imports, because
 * DrawnSceneHost.tsx imports `drawnSceneMetadata` from here and so this file
 * is bundled into the browser page as well; render.ts is the I/O around it.
 */
import type { Theme } from "@ossclip/core/browser";

export const DRAWN_COMPOSITION_ID = "drawn-scene";

/**
 * What the caller renders a drawn scene with. `assets` maps an asset name to
 * its path under the bundle's public dir (the kit's `Asset` passes it to
 * `staticFile`). Typed, not parsed: the CLI builds these from values it has
 * already parsed (theme, frame, shot length), none come from a user raw.
 */
export interface DrawnRenderProps {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  theme: Theme;
  assets: Record<string, string>;
}

/**
 * The composition's size, rate and length, all from the props, so one bundle
 * renders the scene at any length (a shot's length changes with the cut,
 * design §8). At least one frame: Remotion rejects an empty composition.
 */
export function drawnSceneMetadata(p: Pick<DrawnRenderProps, "durationSec" | "width" | "height" | "fps">): {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
} {
  return {
    width: p.width,
    height: p.height,
    fps: p.fps,
    durationInFrames: Math.max(1, Math.round(p.durationSec * p.fps)),
  };
}

/**
 * The three still frames (plan Global Constraints): 25% and 60% of the
 * duration, and the last frame, where the scene's held end state is. Fractions
 * of the composition's own frame count, clamped into it, so a still never asks
 * Remotion for a frame past the end.
 */
export function drawnStillFrames(durationSec: number, fps: number): [number, number, number] {
  const frames = drawnSceneMetadata({ durationSec, fps, width: 0, height: 0 }).durationInFrames;
  const last = frames - 1;
  const at = (frac: number) => Math.min(last, Math.round(frac * frames));
  return [at(0.25), at(0.6), last];
}

/**
 * The entry file one bundle is built from: the host and ONE scene, registered
 * as the one composition `DRAWN_COMPOSITION_ID`.
 *
 * Both files are imported by absolute path, written through `JSON.stringify`
 * so a quote or a backslash in a path (a Windows workdir, a folder named by
 * the author) stays one string literal instead of ending it early. The scene
 * lives in a workdir outside this repo; `react`, `remotion` and the kit
 * resolve through render.ts's resolve rule and alias, not from beside it.
 *
 * `createElement`, not JSX: this file is source text, and the entry should
 * not depend on which JSX runtime the bundler is configured with.
 */
export function drawnEntrySource(a: { scenePath: string; hostPath: string }): string {
  return [
    `import React from "react";`,
    `import { Composition, registerRoot } from "remotion";`,
    `import { DrawnSceneHost, drawnSceneMetadata, defaultDrawnProps } from ${JSON.stringify(a.hostPath)};`,
    `import Scene from ${JSON.stringify(a.scenePath)};`,
    ``,
    `const Component = (props) => React.createElement(DrawnSceneHost, { ...props, scene: Scene });`,
    ``,
    `const Root = () =>`,
    `  React.createElement(Composition, {`,
    `    id: ${JSON.stringify(DRAWN_COMPOSITION_ID)},`,
    `    component: Component,`,
    `    defaultProps: defaultDrawnProps,`,
    `    width: defaultDrawnProps.width,`,
    `    height: defaultDrawnProps.height,`,
    `    fps: defaultDrawnProps.fps,`,
    `    durationInFrames: 1,`,
    `    calculateMetadata: ({ props }) => drawnSceneMetadata(props),`,
    `  });`,
    ``,
    `registerRoot(Root);`,
    ``,
  ].join("\n");
}
