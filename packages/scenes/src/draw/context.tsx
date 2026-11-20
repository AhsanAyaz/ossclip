import React, { createContext, useContext } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "@ossclip/core/browser";
import { safeAreaFor, type FrameSize } from "../stage";

/**
 * What the drawn-scene host hands every drawn scene (§167). Today's parts
 * take the theme as a prop, and a drawn scene has no props to carry one
 * (storyboard design §4), so the host provides it once through context and
 * the kit's hooks and part wrappers read it from there.
 */
export interface DrawContextValue {
  theme: Theme;
  /** The frame in pixels. */
  width: number;
  height: number;
  /** Asset name → the path to pass to `staticFile`. */
  assets: Record<string, string>;
}

const DrawContext = createContext<DrawContextValue | null>(null);

export const DrawProvider: React.FC<{ value: DrawContextValue; children: React.ReactNode }> = ({ value, children }) => (
  <DrawContext.Provider value={value}>{children}</DrawContext.Provider>
);

// The pure halves of the hooks below. This package has no react-dom to render
// a hook in a test (caption-track.test.ts), so the behaviour lives here and
// each hook is one context read plus one of these.

/**
 * The context value, or an error that names the provider. Without one a
 * missing host reads as `Cannot read properties of null` from deep inside a
 * part; a render error goes back to the LLM with the code (storyboard design
 * §5), and only a message naming DrawProvider says the host, not the scene,
 * is what is wrong.
 */
export function requireDrawContext(value: DrawContextValue | null, caller: string): DrawContextValue {
  if (value === null) {
    throw new Error(`${caller} is used outside <DrawProvider>; the drawn-scene host must wrap the scene in one`);
  }
  return value;
}

/** Seconds since the scene started, the unit every kit motion helper takes. */
export function sceneSeconds(frame: number, fps: number): number {
  return frame / fps;
}

/**
 * The stage's safe area (`safeAreaFor`, FINDINGS §6a) as a pixel rect, the
 * shape a drawn scene positions with. `{ x, y, width, height }` and not the
 * insets' left/top/right/bottom: `top` is a name the static check rejects
 * (§167), and a scene destructuring the rect must pass it.
 *
 * Rounded INWARD to whole pixels, so content laid flush to an edge is still
 * inside the fractional area; the epsilon keeps an edge that is a whole
 * pixel up to float error (0.05 × 1920) from being pushed one pixel in.
 */
export function safeAreaPx(frame: FrameSize): { x: number; y: number; width: number; height: number } {
  const a = safeAreaFor(frame);
  const eps = 1e-9;
  const left = Math.ceil(a.left * frame.width - eps);
  const top = Math.ceil(a.top * frame.height - eps);
  const right = Math.floor(frame.width - a.right * frame.width + eps);
  const bottom = Math.floor(frame.height - a.bottom * frame.height + eps);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The `staticFile` path for an asset, or null for a name the author has no
 * file for. Own keys only: `assets["toString"]` is a function on every
 * object, and a scene naming it would otherwise hand `staticFile` garbage.
 */
export function assetFile(assets: Record<string, string>, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(assets, name) ? (assets[name] ?? null) : null;
}

/** Kit-internal: the context for a part or hook, named in the error when missing. */
export function useDrawContext(caller: string): DrawContextValue {
  return requireDrawContext(useContext(DrawContext), caller);
}

/**
 * Seconds since the scene started. Also requires the provider, though it
 * reads only Remotion's frame: every kit hook failing the same way outside
 * the host is one rule for whoever wires a host, not four.
 */
export function useSceneTime(): number {
  useDrawContext("useSceneTime()");
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return sceneSeconds(frame, fps);
}

export function useTheme(): Theme {
  return useDrawContext("useTheme()").theme;
}

export function useFrameSize(): { width: number; height: number } {
  const { width, height } = useDrawContext("useFrameSize()");
  return { width, height };
}

export function useSafeArea(): { x: number; y: number; width: number; height: number } {
  const { width, height } = useDrawContext("useSafeArea()");
  return safeAreaPx({ width, height });
}
