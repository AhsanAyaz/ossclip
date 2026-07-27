import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { SceneCue } from "@ossclip/core/browser";
import { clampTiming } from "./timing";
import type { useEdits } from "./useEdits";
import type { Selection } from "./Overlay";

interface TimelineProps {
  /** The LIVE (override-applied) cues — same array the Player renders from. */
  cues: readonly SceneCue[];
  durationSec: number;
  fps: number;
  playerRef: React.RefObject<PlayerRef | null>;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  edits: ReturnType<typeof useEdits>;
}

interface DragState {
  sceneId: string;
  edge: "start" | "end";
  startX: number;
  origStart: number;
  origEnd: number;
  trackWidth: number;
}

/** Pixel width of the invisible hit zone at each block edge — wider than the
 * visible handle so a slightly-off grab still finds it. */
const EDGE_HIT = 10;

const fmt = (sec: number): string => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${r}`;
};

/**
 * The bottom strip: one block per scene positioned against the clip's
 * duration, a playhead synced to the Player's own clock, click-to-seek, and
 * draggable edges that nudge a scene's timing (through `clampTiming`, so a
 * hand nudge can never overlap a neighbour or shrink below the floor
 * assembly's minimum). Visually it borrows the same panel chrome, monospace
 * labels, and badge shape as the Overlay/Inspector so this reads as one
 * instrument, not a bolted-on second tool.
 */
export const Timeline: React.FC<TimelineProps> = ({
  cues,
  durationSec,
  fps,
  playerRef,
  selection,
  onSelect,
  edits,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frame, setFrame] = useState(0);
  const [dragPreview, setDragPreview] = useState<{
    sceneId: string;
    startSec: number;
    endSec: number;
  } | null>(null);

  // The Player emits `frameupdate` on every frame it renders (play, pause,
  // scrub, or a programmatic seekTo) — subscribing to that keeps the
  // playhead in lockstep without a rAF loop of our own competing with the
  // Player's.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [playerRef]);

  const seekAndSelect = useCallback(
    (cue: SceneCue) => {
      playerRef.current?.seekTo(Math.round(cue.startSec * fps));
      onSelect({ sceneId: cue.id, elementId: null });
    },
    [playerRef, fps, onSelect],
  );

  const seekTrack = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || durationSec <= 0) return;
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      playerRef.current?.seekTo(Math.round(frac * durationSec * fps));
    },
    [playerRef, durationSec, fps],
  );

  const beginEdgeDrag = useCallback(
    (cue: SceneCue, edge: "start" | "end") => (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const track = trackRef.current;
      if (!track) return;
      dragRef.current = {
        sceneId: cue.id,
        edge,
        startX: e.clientX,
        origStart: cue.startSec,
        origEnd: cue.endSec,
        trackWidth: track.getBoundingClientRect().width,
      };
      setDragPreview({ sceneId: cue.id, startSec: cue.startSec, endSec: cue.endSec });
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || durationSec <= 0) return;
      const deltaSec = ((e.clientX - drag.startX) / drag.trackWidth) * durationSec;
      const wantStart = drag.edge === "start" ? drag.origStart + deltaSec : drag.origStart;
      const wantEnd = drag.edge === "end" ? drag.origEnd + deltaSec : drag.origEnd;
      const clamped = clampTiming(cues, drag.sceneId, wantStart, wantEnd, durationSec);
      setDragPreview({ sceneId: drag.sceneId, ...clamped });
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      setDragPreview((preview) => {
        // A mouseup with no intervening mousemove (a click on a handle that
        // never actually moved) leaves `preview` equal to the original
        // timing — skip the dispatch so a stray click can't silently pin an
        // otherwise-tracking scene.
        const moved =
          preview &&
          preview.sceneId === drag.sceneId &&
          (preview.startSec !== drag.origStart || preview.endSec !== drag.origEnd);
        if (moved) {
          edits.patchTiming(drag.sceneId, preview.startSec, preview.endSec);
        }
        return null;
      });
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [cues, durationSec, edits]);

  const playheadPct = durationSec > 0 ? Math.min(1, frame / fps / durationSec) * 100 : 0;

  return (
    <div style={strip}>
      <div style={ruler}>
        <span style={rulerLabel}>0:00</span>
        <span style={rulerLabel}>{fmt(durationSec)}</span>
      </div>
      <div
        ref={trackRef}
        style={track}
        onMouseDown={(e) => {
          // A click that lands on a block or its edge handles is dealt with
          // by that block's own handler (which stops propagation); this
          // fires only for the bare track background, i.e. a gap or the
          // margin around blocks — still worth honouring as a scrub.
          seekTrack(e.clientX);
        }}
      >
        {cues.map((cue) => {
          const isDragging = dragPreview?.sceneId === cue.id;
          const startSec = isDragging ? dragPreview.startSec : cue.startSec;
          const endSec = isDragging ? dragPreview.endSec : cue.endSec;
          const left = durationSec > 0 ? (startSec / durationSec) * 100 : 0;
          const width = durationSec > 0 ? Math.max(0, ((endSec - startSec) / durationSec) * 100) : 0;
          const isSelected = selection?.sceneId === cue.id;
          return (
            <div
              key={cue.id}
              data-testid={`timeline-block-${cue.id}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                seekAndSelect(cue);
              }}
              style={{
                ...block,
                left: `${left}%`,
                width: `${width}%`,
                border: isSelected ? "2px solid #5b8cff" : "1px solid #2A2A33",
                background: isSelected ? "#1c2333" : "#1A1A21",
              }}
            >
              <span style={blockLabel}>{cue.id}</span>
              {cue.pinned ? <span style={pinBadge}>PIN</span> : null}
              <div
                onMouseDown={beginEdgeDrag(cue, "start")}
                style={{ ...edgeHandle, left: 0, cursor: "ew-resize" }}
              />
              <div
                onMouseDown={beginEdgeDrag(cue, "end")}
                style={{ ...edgeHandle, right: 0, cursor: "ew-resize" }}
              />
            </div>
          );
        })}
        <div style={{ ...playhead, left: `${playheadPct}%` }} />
      </div>
    </div>
  );
};

const strip: React.CSSProperties = {
  flexShrink: 0,
  borderTop: "1px solid #1E1E24",
  background: "#111116",
  padding: "10px 20px 14px",
};

const ruler: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 4,
};

const rulerLabel: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#9A9AA3",
};

const track: React.CSSProperties = {
  position: "relative",
  height: 44,
  background: "#0F0F14",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  overflow: "visible",
  userSelect: "none",
};

const block: React.CSSProperties = {
  position: "absolute",
  top: 3,
  bottom: 3,
  borderRadius: 4,
  boxSizing: "border-box",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
};

const blockLabel: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#9A9AA3",
  padding: "0 8px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  pointerEvents: "none",
};

/** Same badge shape as the Overlay's elementId tag — a pinned scene should
 * read as a sibling fact to a selected element, not a new visual idiom. */
const pinBadge: React.CSSProperties = {
  position: "absolute",
  top: 3,
  right: 3,
  fontSize: 9,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#0B0B0E",
  background: "#ffe14d",
  padding: "1px 5px",
  borderRadius: 3,
  pointerEvents: "none",
};

const edgeHandle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: EDGE_HIT,
};

const playhead: React.CSSProperties = {
  position: "absolute",
  top: -4,
  bottom: -4,
  width: 2,
  background: "#FFE14D",
  pointerEvents: "none",
};
