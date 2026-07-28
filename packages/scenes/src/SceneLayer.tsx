import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { SceneCue, Theme } from "@ossclip/core/browser";
import { graphicSlotFor } from "./stage";
import { fitScale } from "./fit";
import { TitleCard } from "./components/TitleCard";
import { StatCard } from "./components/StatCard";
import { RuleCard } from "./components/RuleCard";
import { StrikethroughReveal } from "./components/StrikethroughReveal";
import { FlowDiagram } from "./components/FlowDiagram";
import { TerminalMock } from "./components/TerminalMock";
import { ChatMock } from "./components/ChatMock";
import { ScreenshotFrame } from "./components/ScreenshotFrame";
import { BulletList } from "./components/BulletList";
import { compensateEdits, type ElementEdits } from "./editable";

/* eslint-disable @typescript-eslint/no-explicit-any -- props are registry-validated upstream */
const COMPONENTS: Record<
  NonNullable<SceneCue["component"]>,
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
  BulletList,
};

/** Seconds a graphic spends leaving. Matches LAYOUT_TRANSITION_SEC's order of
 * magnitude so the graphic departs WITH the video slot's morph — the reported
 * failure was the split view closing first and the card then blinking out. */
const EXIT_SEC = 0.3;

/**
 * Uniform exit for every graphic (R16 §69). Components own their ENTRANCES
 * (staggered rises, per element); the exit lives here at the layer because it
 * is the cue's END doing the animating, and every component leaving the same
 * way is what makes the cut read as designed. Inside the cue's Sequence, so
 * frame 0 is the cue's own start.
 */
const ExitFade: React.FC<{ durationInFrames: number; children: React.ReactNode }> = ({
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const remaining = (durationInFrames - frame) / fps;
  const p = Math.min(1, Math.max(0, remaining / EXIT_SEC));
  const ease = p * (2 - p);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: ease,
        transform: ease < 1 ? `translateY(${(1 - ease) * 18}px)` : undefined,
      }}
    >
      {children}
    </div>
  );
};

/** Renders each cue's graphic into its layout's graphic slot, scene-local time. */
export const SceneLayer: React.FC<{ cues: SceneCue[]; theme: Theme }> = ({ cues, theme }) => {
  const { fps, width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {cues.map((cue) => {
        // Plain cues (derived timeline filler) carry no graphic and no
        // `data-edit-scene` — the talking head IS the scene. The component/
        // props guards double as the type narrowing their optionality forces.
        if (cue.kind === "plain" || !cue.component || !cue.props) return null;
        // A cue may carry its own rect — routed there by source-text
        // avoidance (FINDINGS §26) or set by hand in the editor (R11 Task
        // 2). Never null (R13): a layout with no slot of its own
        // (full-bleed) falls back to `FULL_BLEED_GRAPHIC_SLOT` rather than
        // silently dropping the graphic — layout places the video, it does
        // not veto the component.
        const slot = graphicSlotFor(cue, { width, height });
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
              <ExitFade durationInFrames={durationInFrames}>
                <div style={{ width: slotW / scale, transform: `scale(${scale})` }}>
                  <Component
                    props={cue.props}
                    theme={theme}
                    widthPx={slotW / scale}
                    heightPx={slotH / scale}
                    // Stored nudges are composition px; this wrapper scales by
                    // `scale`, so they are counter-divided here or a drag lands
                    // `scale`× past where it was dropped (PLAN Task 1).
                    edits={compensateEdits(cue.elements, scale)}
                  />
                </div>
              </ExitFade>
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
