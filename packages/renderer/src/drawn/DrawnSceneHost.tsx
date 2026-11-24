import React from "react";
import { AbsoluteFill, cancelRender } from "remotion";
import { defaultTheme } from "@ossclip/core/browser";
import { BundledFonts } from "@ossclip/scenes";
// The SAME specifier the scene imports, so render.ts's alias maps both to one
// file and webpack makes one module of it: a second copy of the kit would be
// a second React context, and the scene's `useTheme()` would find no provider
// although the host mounted one (§167).
import { DrawProvider, type DrawContextValue } from "@ossclip/scenes/draw";
import type { DrawnRenderProps } from "./entry-source";

// For the generated entry (`drawnEntrySource`), which imports from this file
// alone, so the entry names one path in this package and not two.
export { drawnSceneMetadata } from "./entry-source";

/**
 * What the composition receives: the caller's props, plus a background only
 * the preview sets (`DRAWN_PREVIEW_BACKGROUND`). Absent for stills and the
 * clip, whose frames must keep the scene's own transparency.
 */
export type DrawnHostProps = DrawnRenderProps & { background?: string };

/** Registered defaults; every real render passes its own props. */
export const defaultDrawnProps: DrawnHostProps = {
  durationSec: 3,
  width: 1080,
  height: 1920,
  fps: 30,
  theme: defaultTheme,
  assets: {},
};

/**
 * Turns a scene that throws while rendering into a FAILED render (storyboard
 * design §5 step 4: a version whose render throws is rejected). Without it,
 * what a throw does depends on React's uncaught-error path; with a boundary
 * that only rendered null, the still would be an empty transparent frame that
 * looks like a scene that drew nothing yet. `cancelRender` is Remotion's own
 * render error path: it records the error on the page, the still's wait sees
 * it, and `renderStill` rejects with the scene's message, which is what goes
 * back to the LLM as the repair hint.
 */
class SceneErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    cancelRender(error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * One drawn scene on a transparent frame (storyboard design §5, "New renderer
 * pieces"): the bundled fonts, the kit's context and the scene, and nothing
 * else. Not through `SceneLayer`: that adds its own fit scale, exit fade and
 * panel, and a drawn scene places itself in the safe area the kit gives it.
 *
 * NOTHING behind the scene unless the preview asks for a background: no
 * element at all, so every pixel the scene leaves alone keeps zero alpha into
 * the PNG stills and the ProRes 4444 clip (SceneClipComposition's rule).
 *
 * `<BundledFonts>` holds the render until the theme's faces load, as in every
 * other composition, so no still bakes in the fallback stack. The files are
 * fetched from the bundle's public dir, which the caller of
 * `bundleDrawnScene` stages (see there).
 */
export const DrawnSceneHost: React.FC<
  DrawnHostProps & { scene: React.ComponentType<{ durationSec: number }> }
> = ({ scene: Scene, durationSec, width, height, theme, assets, background }) => {
  const value = React.useMemo<DrawContextValue>(
    () => ({ theme, width, height, assets }),
    [theme, width, height, assets],
  );
  return (
    <AbsoluteFill>
      <BundledFonts theme={theme} />
      {background !== undefined ? <AbsoluteFill style={{ background }} /> : null}
      <DrawProvider value={value}>
        <SceneErrorBoundary>
          <Scene durationSec={durationSec} />
        </SceneErrorBoundary>
      </DrawProvider>
    </AbsoluteFill>
  );
};
