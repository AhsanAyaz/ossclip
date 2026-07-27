import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { SceneCue, Theme } from "@ossclip/core/browser";
import { layoutSlots } from "./stage";
import { fitScale } from "./fit";
import { TitleCard } from "./components/TitleCard";
import { StatCard } from "./components/StatCard";
import { RuleCard } from "./components/RuleCard";
import { StrikethroughReveal } from "./components/StrikethroughReveal";
import { FlowDiagram } from "./components/FlowDiagram";
import { TerminalMock } from "./components/TerminalMock";
import { ChatMock } from "./components/ChatMock";
import { ScreenshotFrame } from "./components/ScreenshotFrame";
import type { ElementEdits } from "./editable";

/* eslint-disable @typescript-eslint/no-explicit-any -- props are registry-validated upstream */
const COMPONENTS: Record<
  SceneCue["component"],
  React.FC<{ props: any; theme: Theme; widthPx?: number; heightPx?: number; edits?: ElementEdits }>
> = {
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
  const { fps, width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {cues.map((cue) => {
        // A cue may carry its own rect when the source's burned-in text made
        // the layout's slot unusable (FINDINGS §26).
        const slot = cue.graphicRect ?? layoutSlots(cue.layout).graphic;
        if (!slot) return null;
        const Component = COMPONENTS[cue.component];
        const from = Math.round(cue.startSec * fps);
        const durationInFrames = Math.max(1, Math.round((cue.endSec - cue.startSec) * fps));
        const slotW = slot.w * width;
        const slotH = slot.h * height;
        // Fill the slot instead of floating at natural size in it (§23). The
        // component lays out at slotW/scale and is then scaled up, so its
        // rendered width is exactly the slot width while its type grows.
        const scale = fitScale(cue.component, cue.props, { widthPx: slotW, heightPx: slotH });
        return (
          <Sequence key={cue.id} from={from} durationInFrames={durationInFrames}>
            <div
              data-edit-scene={cue.id}
              style={{
                position: "absolute",
                left: `${slot.x * 100}%`,
                top: `${slot.y * 100}%`,
                width: `${slot.w * 100}%`,
                height: `${slot.h * 100}%`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // The parent AbsoluteFill is `pointer-events: none` so
                // scrubbing/other player controls pass through the graphic
                // layer everywhere else; re-enable it just for this cue's
                // box so the editor's `elementFromPoint` hit-test can reach
                // its `data-edit-id` leaves at all.
                pointerEvents: "auto",
                // Content that cannot fit even at MIN_SCALE is clipped here
                // rather than bleeding outside the platform safe area, which
                // is what it did silently before (§6a).
                overflow: "hidden",
              }}
            >
              <div style={{ width: slotW / scale, transform: `scale(${scale})` }}>
                <Component
                  props={cue.props}
                  theme={theme}
                  widthPx={slotW / scale}
                  heightPx={slotH / scale}
                  edits={cue.elements}
                />
              </div>
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
