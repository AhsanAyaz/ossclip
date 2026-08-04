import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { SceneCue, Theme } from "@ossclip/core/browser";
import { graphicSlotFor } from "./stage";
import { fitScale } from "./fit";
import { frameWindow } from "./frames";
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
import { easeOutQuad, entranceExitSec } from "./motion";

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

/**
 * Layouts whose graphic slot sits over LIVE video (R20 §94). Everywhere else
 * the graphic lands on the stage background and the theme guarantees its
 * contrast; here the background is whatever pixels the footage happens to
 * show, and a typographic component (TitleCard, StrikethroughReveal) can land
 * white text on a bright wall. The slot gets a frosted scrim: theme-bg tint
 * over a backdrop blur. Slot-shaped rather than a broadcast bottom-gradient
 * so it FOLLOWS the box when the editor drags or resizes it.
 */
const OVER_VIDEO_LAYOUTS = new Set<SceneCue["layout"]>(["lower-third", "full-bleed"]);
const SCRIM_ALPHA = 0.55;

const scrimColor = (themeBg: string): string => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(themeBg.trim());
  const [r, g, b] = m
    ? [0, 2, 4].map((i) => Number.parseInt(m[1]!.slice(i, i + 2), 16))
    : [0, 0, 0];
  return `rgba(${r}, ${g}, ${b}, ${SCRIM_ALPHA})`;
};

/**
 * Uniform EXIT for every graphic, and an entrance for the SCRIM alone —
 * both at the layer (R16 §69).
 *
 * Components own their content entrances: all nine stagger their elements
 * in through anim.ts's useEnter springs, a fact this file stated correctly
 * for a year, then briefly contradicted when a survey missed the springs
 * and a layer-wide entrance double-animated everything. What never animated
 * was the over-video scrim (R21 §100), which appeared at full opacity on
 * the cue's first frame: "a half black box appears" (spec 2026-08-04). So
 * the entrance here is the scrim's, and only the scrim's.
 *
 * The exit stays layer-wide: it is the cue's END doing the animating, and
 * every component leaving the same way is what makes the cut read as
 * designed. Both ends read their seconds from entranceExitSec, which
 * shrinks the pair together on a cue too short to hold both — the scrim
 * and the exit, that is; the components' content springs (anim.ts) predate
 * the resolver and do not read it, so a long-staggered component can still
 * overlap the exit on a short cue (see the spec's 'Neither end may eat the
 * other' correction). Inside the cue's Sequence, so local frame 0 is the
 * cue's own start.
 */
const wrapperStyle = (ease: number): React.CSSProperties => ({
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: ease,
  // 18px over the exit's ~9 frames. Eased, so the peak step is 3.78px on the
  // first frame, tapering below 0.25px — small enough to read smooth at 30fps
  // without blur, which was the actual ask. (Used only by ExitFade since the
  // entrance was scoped to the scrim; see ./motion for the seconds.)
  transform: ease < 1 ? `translateY(${(1 - ease) * 18}px)` : undefined,
});

const ExitFade: React.FC<{ durationInFrames: number; children: React.ReactNode }> = ({
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { exitSec } = entranceExitSec(durationInFrames / fps);
  const remaining = (durationInFrames - frame) / fps;
  const p = exitSec <= 0 ? 1 : Math.min(1, Math.max(0, remaining / exitSec));
  return <div style={wrapperStyle(easeOutQuad(p))}>{children}</div>;
};

/**
 * The scrim, carrying its own entrance. One div, deliberately: an ancestor
 * wrapper with opacity < 1 forms a Backdrop Root, which empties the
 * backdrop-filter's input — the band rendered as flat tint for the whole
 * entrance and the blur snapped on when the ease hit 1. Opacity on the
 * element itself composites the blurred band at partial alpha instead, so
 * the frost fades in WITH the tint. Positioned absolute so it stays out of
 * ExitFade's flex flow; painted before the content div in tree order, so
 * content keeps painting above it (R21 §100).
 */
const Scrim: React.FC<{ durationInFrames: number; themeBg: string; radiusPx: number }> = ({
  durationInFrames,
  themeBg,
  radiusPx,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { enterSec } = entranceExitSec(durationInFrames / fps);
  const p = enterSec <= 0 ? 1 : Math.min(1, Math.max(0, frame / fps / enterSec));
  const ease = easeOutQuad(p);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: scrimColor(themeBg),
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderRadius: radiusPx,
        opacity: ease,
        transform: ease < 1 ? `translateY(${(1 - ease) * 18}px)` : undefined,
      }}
    />
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
        // §115: from the end TIME — a rounded duration can reach a frame past
        // the cue and put two graphics on screen at once.
        const { from, durationInFrames } = frameWindow(cue.startSec, cue.endSec, fps);
        const slotW = slot.w * width;
        const slotH = slot.h * height;
        // Over-video bands keep breathing room (R21 §100): the scrim fills
        // the slot, the CONTENT solves against an inset box, so type never
        // touches the band's edge. Elsewhere padding stays 0 — those slots
        // sit on the stage background and already carry their own air.
        const overVideo = OVER_VIDEO_LAYOUTS.has(cue.layout);
        const pad = overVideo ? Math.min(24, Math.round(slotH * 0.12)) : 0;
        const contentW = slotW - pad * 2;
        const contentH = slotH - pad * 2;
        // Fill the slot instead of floating at natural size in it (§23). The
        // component lays out at contentW/scale and is then scaled up, so its
        // rendered width is exactly the content width while its type grows.
        const scale = fitScale(cue.component, cue.props, { widthPx: contentW, heightPx: contentH });
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
                {overVideo ? (
                  <Scrim
                    durationInFrames={durationInFrames}
                    themeBg={theme.bg}
                    radiusPx={theme.radiusPx}
                  />
                ) : null}
                {/* position:relative so the content paints (and hit-tests)
                    above the positioned scrim — document order alone loses. */}
                <div style={{ width: contentW / scale, transform: `scale(${scale})`, position: "relative" }}>
                  <Component
                    props={cue.props}
                    theme={theme}
                    widthPx={contentW / scale}
                    heightPx={contentH / scale}
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
