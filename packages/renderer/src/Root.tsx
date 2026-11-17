import React from "react";
import { Composition } from "remotion";
import {
  ProductionComposition,
  defaultProductionProps,
  type ProductionCompProps,
} from "./ProductionComposition";
import {
  COVER_ID,
  CoverComposition,
  defaultCoverProps,
  type CoverCompProps,
} from "./CoverComposition";
import {
  SCENE_STILL_ID,
  SceneStillComposition,
  defaultSceneStillProps,
  type SceneStillProps,
} from "./SceneStillComposition";
import { STILL_FPS } from "./scene-still";
import {
  SCENE_CLIP_ID,
  SceneClipComposition,
  defaultSceneClipProps,
  type SceneClipProps,
} from "./SceneClipComposition";
import { sceneClipMetadata } from "./scene-clip";

export const COMPOSITION_ID = "production";

export const RemotionRoot: React.FC = () => {
  return (
    <>
    <Composition
      id={COVER_ID}
      component={CoverComposition as unknown as React.FC<Record<string, unknown>>}
      defaultProps={defaultCoverProps as unknown as Record<string, unknown>}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      // The cover follows the OUTPUT frame (R16 §76). Without this it stayed
      // at the registered 1080×1920 while the production composition tracked
      // `settings` — so a landscape render shipped a portrait thumbnail, its
      // 16:9 still centre-cropped back to 9:16 by `objectFit: cover`.
      calculateMetadata={({ props }) => {
        const p = props as unknown as CoverCompProps;
        return {
          width: p.frame?.width ?? 1080,
          height: p.frame?.height ?? 1920,
        };
      }}
    />
    <Composition
      id={COMPOSITION_ID}
      component={ProductionComposition as unknown as React.FC<Record<string, unknown>>}
      defaultProps={defaultProductionProps as unknown as Record<string, unknown>}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      calculateMetadata={({ props }) => {
        const p = props as unknown as ProductionCompProps;
        return {
          durationInFrames: Math.max(1, Math.round(p.outputDurationSec * p.settings.fps)),
          fps: p.settings.fps,
          width: p.settings.width,
          height: p.settings.height,
        };
      }}
    />
    <Composition
      id={SCENE_STILL_ID}
      component={SceneStillComposition as unknown as React.FC<Record<string, unknown>>}
      defaultProps={defaultSceneStillProps as unknown as Record<string, unknown>}
      width={1080}
      height={1920}
      fps={STILL_FPS}
      durationInFrames={90}
      // Sized from the props like the other two: one bundle serves every
      // aspect and every fixture's length, so `pnpm stills` bundles once.
      calculateMetadata={({ props }) => {
        const p = props as unknown as SceneStillProps;
        return {
          width: p.frame.width,
          height: p.frame.height,
          durationInFrames: Math.max(1, Math.round(p.durationSec * STILL_FPS)),
        };
      }}
    />
    <Composition
      id={SCENE_CLIP_ID}
      component={SceneClipComposition as unknown as React.FC<Record<string, unknown>>}
      defaultProps={defaultSceneClipProps as unknown as Record<string, unknown>}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={90}
      // A kit clip (§162) is one scene at the OUTPUT frame and rate, for
      // exactly the scene's window — all from the props, so one bundle
      // renders every clip of a kit.
      calculateMetadata={({ props }) => sceneClipMetadata(props as unknown as SceneClipProps)}
    />
    </>
  );
};
