import React from "react";
import { Composition } from "remotion";
import {
  ProductionComposition,
  defaultProductionProps,
  type ProductionCompProps,
} from "./ProductionComposition";
import { COVER_ID, CoverComposition, defaultCoverProps } from "./CoverComposition";

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
    </>
  );
};
