import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { SceneCue } from "@ossclip/core/browser";
import { clampTiming, moveTiming, timeAtX } from "./timing";
import type { useEdits } from "./useEdits";
import type { Selection } from "./Overlay";

interface TimelineProps {
  /** The LIVE (override-applied) cues — same array the Player renders from. */
  cues: readonly SceneCue[];
  /** Deleted scenes at their base timing — drawn as restorable ghosts. */
  ghosts: readonly SceneCue[];
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

/**
 * A press on a block body, before we know whether it is a click or a drag.
 * Below `MOVE_THRESHOLD_PX` of travel it stays a click (select + seek to the
 * CLICKED time — Task 4); past it, it becomes a move drag that shifts the
 * whole block (Task 6). The threshold is what keeps a click that wobbles a
 * pixel from silently writing a `timing` override and pinning the scene.
 */
interface BlockPress {
  sceneId: string;
  startX: number;
  moved: boolean;
}

/** Pixel width of the invisible hit zone at each block edge — wider than the
 * visible handle so a slightly-off grab still finds it. */
const EDGE_HIT = 10;

/** Travel before a block press commits to being a move drag. */
const MOVE_THRESHOLD_PX = 4;

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
  ghosts,
  durationSec,
  fps,
  playerRef,
  selection,
  onSelect,
  edits,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);
  const blockPressRef = useRef<BlockPress | null>(null);
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

  const seekTrack = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || durationSec <= 0) return;
      const r = track.getBoundingClientRect();
      playerRef.current?.seekTo(Math.round(timeAtX(clientX, r.left, r.width, durationSec) * fps));
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
      // A track scrub follows the pointer continuously (Task 3) — like any
      // video player's seek bar, not click-only.
      if (scrubbingRef.current) {
        seekTrack(e.clientX);
        return;
      }
      const press = blockPressRef.current;
      if (press && durationSec > 0) {
        if (!press.moved && Math.abs(e.clientX - press.startX) < MOVE_THRESHOLD_PX) return;
        press.moved = true;
        const track = trackRef.current;
        const deltaSec = track
          ? ((e.clientX - press.startX) / track.getBoundingClientRect().width) * durationSec
          : 0;
        const shifted = moveTiming(cues, press.sceneId, deltaSec, durationSec);
        if (shifted) setDragPreview({ sceneId: press.sceneId, ...shifted });
        return;
      }
      const drag = dragRef.current;
      if (!drag || durationSec <= 0) return;
      const deltaSec = ((e.clientX - drag.startX) / drag.trackWidth) * durationSec;
      const wantStart = drag.edge === "start" ? drag.origStart + deltaSec : drag.origStart;
      const wantEnd = drag.edge === "end" ? drag.origEnd + deltaSec : drag.origEnd;
      const clamped = clampTiming(cues, drag.sceneId, wantStart, wantEnd, durationSec);
      setDragPreview({ sceneId: drag.sceneId, ...clamped });
    };
    const onUp = (e: MouseEvent) => {
      scrubbingRef.current = false;
      const press = blockPressRef.current;
      if (press) {
        blockPressRef.current = null;
        if (press.moved) {
          // The drag became a move (Task 6): commit it. Like an edge drag,
          // this writes `timing` and pins the scene — the badge appears via
          // the same patch path.
          setDragPreview((preview) => {
            if (preview && preview.sceneId === press.sceneId) {
              edits.patchTiming(press.sceneId, preview.startSec, preview.endSec);
            }
            return null;
          });
        } else {
          // It stayed a click: seek to the CLICKED time, not the scene's
          // start (Task 4) — a plain click never writes a timing override.
          seekTrack(e.clientX);
        }
        return;
      }
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
  }, [cues, durationSec, edits, seekTrack]);

  const playheadPct = durationSec > 0 ? Math.min(1, frame / fps / durationSec) * 100 : 0;

  return (
    <div style={strip}>
      <div
        data-testid="ruler"
        style={ruler}
        onMouseDown={(e) => {
          // The ruler seeks (PLAN Task 3) with the same press-and-drag scrub
          // as the track — one `timeAtX` mapping for every seek gesture — and
          // NEVER changes the selection: seeking near a scene boundary should
          // not require aiming at (and thereby selecting) a block.
          e.preventDefault();
          seekTrack(e.clientX);
          scrubbingRef.current = true;
        }}
      >
        <span style={rulerLabel}>0:00</span>
        <span style={rulerLabel}>{fmt(durationSec)}</span>
      </div>
      <div
        ref={trackRef}
        style={track}
        onMouseDown={(e) => {
          // A press on a block or its edge handles is dealt with by that
          // block's own handler (which stops propagation); this fires only
          // for the bare track background. Seek immediately AND begin a
          // scrub, so press-and-drag follows the pointer like any player's
          // seek bar (Task 3).
          e.preventDefault();
          seekTrack(e.clientX);
          scrubbingRef.current = true;
        }}
      >
        {cues.map((cue) => {
          const isPlain = cue.kind === "plain";
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
                e.preventDefault();
                // Select right away for feedback. A GRAPHIC block then waits
                // on travel to decide click-seek vs move-drag (see the window
                // mousemove/mouseup pair above). A PLAIN block's window is
                // derived, not stored — it can't move, so its press seeks
                // immediately and drags as a scrub: the takes now cover most
                // of the track, and losing press-and-drag seeking over them
                // would regress the very gesture the track was given.
                onSelect({ sceneId: cue.id, elementId: null });
                if (isPlain) {
                  seekTrack(e.clientX);
                  scrubbingRef.current = true;
                  return;
                }
                blockPressRef.current = { sceneId: cue.id, startX: e.clientX, moved: false };
              }}
              style={{
                ...block,
                left: `${left}%`,
                width: `${width}%`,
                border: isSelected
                  ? "2px solid #5b8cff"
                  : isPlain
                    ? "1px solid #22222a"
                    : "1px solid #2A2A33",
                background: isSelected ? "#1c2333" : isPlain ? "#131318" : "#1A1A21",
              }}
            >
              <span style={isPlain ? { ...blockLabel, color: "#55555f" } : blockLabel}>
                {cue.id}
              </span>
              {!isPlain && cue.pinned ? <span style={pinBadge}>PIN</span> : null}
              {!isPlain ? (
                <>
                  <div
                    onMouseDown={beginEdgeDrag(cue, "start")}
                    style={{ ...edgeHandle, left: 0, cursor: "ew-resize" }}
                  />
                  <div
                    onMouseDown={beginEdgeDrag(cue, "end")}
                    style={{ ...edgeHandle, right: 0, cursor: "ew-resize" }}
                  />
                </>
              ) : null}
            </div>
          );
        })}
        {ghosts.map((cue) => {
          // A deleted scene (PLAN Task C5): dashed, hollow, painted ABOVE the
          // plain take that took over its window (DOM order stacks it later).
          // Same testid shape as a live block so selection — and the e2e —
          // keep working; clicking it is how the Inspector offers Restore.
          const left = durationSec > 0 ? (cue.startSec / durationSec) * 100 : 0;
          const width =
            durationSec > 0 ? Math.max(0, ((cue.endSec - cue.startSec) / durationSec) * 100) : 0;
          const isSelected = selection?.sceneId === cue.id;
          return (
            <div
              key={`ghost-${cue.id}`}
              data-testid={`timeline-block-${cue.id}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onSelect({ sceneId: cue.id, elementId: null });
              }}
              style={{
                ...block,
                left: `${left}%`,
                width: `${width}%`,
                border: isSelected ? "2px dashed #5b8cff" : "1px dashed #6a6a75",
                background: "transparent",
              }}
            >
              <span style={{ ...blockLabel, color: "#6a6a75", textDecoration: "line-through" }}>
                {cue.id}
              </span>
            </div>
          );
        })}
        <div data-testid="playhead" style={{ ...playhead, left: `${playheadPct}%` }}>
          {/* The playhead itself is grabbable (Task 3): pressing it starts
              the same scrub as the track, WITHOUT the initial jump-seek —
              grabbing the needle shouldn't move it until the hand does. The
              hit zone is wider than the 2px needle so it's actually
              catchable. */}
          <div
            data-testid="playhead-grab"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              scrubbingRef.current = true;
            }}
            style={playheadGrab}
          />
        </div>
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
  alignItems: "center",
  // Tall enough to press, and visibly a surface rather than two floating
  // labels — it seeks now, and it should look like it does.
  height: 18,
  padding: "0 2px",
  marginBottom: 4,
  borderBottom: "1px solid #1E1E24",
  cursor: "ew-resize",
  userSelect: "none",
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
  // Reaches up across the ruler (18px + its 4px gap): the ruler is a seek
  // surface now, so the playhead must be visible against it.
  top: -26,
  bottom: -4,
  width: 2,
  background: "#FFE14D",
  // The needle paints but doesn't intercept; its grab zone (child) does.
  pointerEvents: "none",
};

const playheadGrab: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: -4,
  width: 10,
  pointerEvents: "auto",
  cursor: "ew-resize",
};
