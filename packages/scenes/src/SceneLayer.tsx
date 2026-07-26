import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { SceneCue, Theme } from "@ossclip/core/browser";
import { layoutSlots } from "./stage";
import { TitleCard } from "./components/TitleCard";
import { StatCard } from "./components/StatCard";
import { RuleCard } from "./components/RuleCard";
import { StrikethroughReveal } from "./components/StrikethroughReveal";
import { FlowDiagram } from "./components/FlowDiagram";
import { TerminalMock } from "./components/TerminalMock";
import { ChatMock } from "./components/ChatMock";
import { ScreenshotFrame } from "./components/ScreenshotFrame";

/* eslint-disable @typescript-eslint/no-explicit-any -- props are registry-validated upstream */
const COMPONENTS: Record<SceneCue["component"], React.FC<{ props: any; theme: Theme }>> = {
  TitleCard,
  StatCard,
  RuleCard,
  StrikethroughReveal,
  FlowDiagram,
  TerminalMock,
  ChatMock,
  ScreenshotFrame,
};

/** Renders each cue's graphic into its layout's graphic slot, scene-local time. */
export const SceneLayer: React.FC<{ cues: SceneCue[]; theme: Theme }> = ({ cues, theme }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {cues.map((cue) => {
        const slot = layoutSlots(cue.layout).graphic;
        if (!slot) return null;
        const Component = COMPONENTS[cue.component];
        const from = Math.round(cue.startSec * fps);
        const durationInFrames = Math.max(1, Math.round((cue.endSec - cue.startSec) * fps));
        return (
          <Sequence key={cue.id} from={from} durationInFrames={durationInFrames}>
            <div
              style={{
                position: "absolute",
                left: `${slot.x * 100}%`,
                top: `${slot.y * 100}%`,
                width: `${slot.w * 100}%`,
                height: `${slot.h * 100}%`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Component props={cue.props} theme={theme} />
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
