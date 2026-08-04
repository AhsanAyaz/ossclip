import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { KeptSpan, SceneCue } from "@ossclip/core/browser";
import {
  applySnap,
  clampTiming,
  clampZoom,
  formatTimecode,
  moveTiming,
  snapTargets,
  sourceToOutputClamped,
  timeAtX,
  zoomedScrollLeft,
} from "./timing";
import type { useEdits } from "./useEdits";
import { blurTypingElement, type Selection } from "./Overlay";

/** One `doc.cuts` entry, as far as the Timeline needs it — mirrors
 * `OverrideDoc["cuts"][number]` structurally without importing the whole
 * schema module into a presentation component. */
interface CutEntry {
  startSec: number;
  endSec: number;
  /** Present once produce has actually resolved and applied this cut (PLAN
   * 2026-08-04 Task 4c fix wave, review finding 1) — see the two rendering
   * modes below `cuts.map` for why this key changes what gets drawn. */
  src?: { startSec: number; endSec: number };
}

interface TimelineProps {
  /** The LIVE (override-applied) cues — same array the Player renders from. */
  cues: readonly SceneCue[];
  /** Deleted scenes at their base timing — drawn as restorable ghosts. */
  ghosts: readonly SceneCue[];
  /**
   * User cuts (`doc.cuts`, PLAN 2026-08-04 Task 4c). Two rendering modes,
   * keyed on `src` (review fix wave, finding 1) — see the `cuts.map` below
   * for the full reasoning. Optional and defaulted so every existing caller
   * (and test) that predates this prop keeps compiling unchanged.
   */
  cuts?: readonly CutEntry[];
  /**
   * The CURRENT render-props' spans (source↔output mapping) — needed only to
   * place an ALREADY-APPLIED cut's seam marker at its true position in
   * today's output via `sourceToOutputClamped`. Optional/defaulted to `[]`
   * for the same back-compat reason as `cuts`; harmless when omitted (an
   * applied cut with no spans to place it against simply doesn't draw its
   * seam — there's nothing else honest to draw).
   */
  spans?: readonly KeptSpan[];
  durationSec: number;
  fps: number;
  playerRef: React.RefObject<PlayerRef | null>;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  edits: ReturnType<typeof useEdits>;
  /** The served video URL (R20 §97) — feeds the take filmstrips. Optional:
   * without it (or when the file 404s) blocks simply stay flat panels. */
  videoSrc?: string;
  /** Output→source time, through the spans — a filmstrip frame must come
   * from the SOURCE second actually playing at that point of the cut. */
  toSourceSec?: (outSec: number) => number;
}

interface DragState {
  sceneId: string;
  edge: "start" | "end";
  /**
   * The pointer's start position in CONTENT space (clientX minus the track's
   * live left edge), not viewport space (R15 §58): edge paging scrolls the
   * track under a stationary pointer, and a viewport-space delta would read
   * that as "no movement" — the page would advance the view but not the drag.
   */
  startContentX: number;
  origStart: number;
  origEnd: number;
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
  /** Viewport-space start, for the click-vs-drag travel threshold only. */
  startX: number;
  /** Content-space start — the delta the move actually uses (see DragState). */
  startContentX: number;
  moved: boolean;
}

/** Pixel width of the invisible hit zone at each block edge — wider than the
 * visible handle so a slightly-off grab still finds it. */
const EDGE_HIT = 10;

/** Travel before a block press commits to being a move drag. */
const MOVE_THRESHOLD_PX = 4;

/** Snap catch radius in SCREEN pixels (precision-editing design, "Timeline
 * snapping") — converted to seconds per pointer-move via the track's live
 * px-per-second, so zoom changes what snaps without a separate constant. */
const SNAP_PX = 8;

/** Edge paging (R15 §58): a live gesture within this many px of the
 * scroller's bound pages the view by one viewport width in that direction. */
const PAGE_EDGE_PX = 8;

/** Floor between pages, so hovering at the bound doesn't machine-gun the
 * scroll — one page per deliberate return to the edge. */
const PAGE_COOLDOWN_MS = 300;

/** Tick labels drop the decimal — a ruler mark is a landmark, not a readout. */
const tickFmt = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Take filmstrips (R20 §97, the Filmora look): one frame per plain take,
 * seeked out of a detached <video> and drawn to a small canvas. Purely
 * decorative — any failure (missing file, codec, abort) leaves the flat
 * block exactly as it was, and nothing here sits in a gesture's path.
 * Sequential on ONE element: N parallel videos of the same file would cost
 * more than the thumbnails are worth.
 */
const useTakeThumbs = (
  videoSrc: string | undefined,
  times: readonly number[],
): Record<string, string> => {
  const [thumbs, setThumbs] = React.useState<Record<string, string>>({});
  const cacheRef = React.useRef<Record<string, string>>({});
  const key = times.map((t) => t.toFixed(1)).join(",");
  React.useEffect(() => {
    if (!videoSrc || times.length === 0) return;
    const missing = [...new Set(times.map((t) => t.toFixed(1)))].filter(
      (t) => cacheRef.current[t] === undefined,
    );
    if (missing.length === 0) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.src = videoSrc;
    video.muted = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    const run = async (): Promise<void> => {
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error("no video for thumbnails"));
      });
      canvas.width = 168;
      canvas.height = Math.max(
        1,
        Math.round((168 * video.videoHeight) / Math.max(1, video.videoWidth)),
      );
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      for (const t of missing) {
        if (cancelled) return;
        await new Promise<void>((res) => {
          video.onseeked = () => res();
          video.currentTime = Math.max(0, Number(t));
        });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        cacheRef.current[t] = canvas.toDataURL("image/jpeg", 0.6);
      }
      if (!cancelled) setThumbs({ ...cacheRef.current });
    };
    void run().catch(() => {});
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `times`
  }, [videoSrc, key]);
  return thumbs;
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
  cuts = [],
  spans = [],
  durationSec,
  fps,
  playerRef,
  selection,
  onSelect,
  edits,
  videoSrc,
  toSourceSec,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);
  const blockPressRef = useRef<BlockPress | null>(null);
  const [frame, setFrame] = useState(0);
  // Live playhead frame for the mousemove listener below (attached once,
  // re-attached only on [cues, durationSec, edits, seekTrack, fps] — same
  // ref trick as `zoomRef`, so a stale closure can't hand `snapTargets` a
  // frame count from whenever the listener last (re)attached.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [dragPreview, setDragPreview] = useState<{
    sceneId: string;
    startSec: number;
    endSec: number;
    /** The snap target the drag is currently resting on, or null — carries
     * the tick and readout (precision-editing design, "Timeline snapping"),
     * extending this existing channel rather than adding a parallel one. */
    snapped: number | null;
  } | null>(null);
  // Timeline zoom (R14 §53): 1 = the clip fits the viewport; above it the
  // track widens inside the scroller and gestures get proportionally finer —
  // the existing drag math divides by the track's OWN bounding width, so it
  // calibrates itself. The anchor ref carries "keep this viewport x still"
  // from the gesture to the layout effect that runs once the wider track has
  // actually rendered — setting scrollLeft before that would clamp against
  // the old width.
  const [zoom, setZoom] = useState(1);
  // One filmstrip frame per plain take (R20 §97), at the take's midpoint in
  // SOURCE time — graphic scenes keep their flat card look on purpose: the
  // block for a card is not footage, and painting footage under it would say
  // otherwise. Keyed per cue id at render below.
  const takeThumbTimes = React.useMemo(
    () =>
      toSourceSec
        ? cues
            .filter((c) => c.kind === "plain")
            .map((c) => toSourceSec((c.startSec + c.endSec) / 2))
        : [],
    [cues, toSourceSec],
  );
  const takeThumbs = useTakeThumbs(videoSrc, takeThumbTimes);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const zoomAnchorRef = useRef<{ prevZoom: number; anchorX: number } | null>(null);

  const applyZoom = useCallback((next: number, anchorClientX?: number) => {
    const scroller = scrollerRef.current;
    setZoom((prev) => {
      const clamped = clampZoom(next);
      if (clamped === prev || !scroller) return clamped;
      const r = scroller.getBoundingClientRect();
      zoomAnchorRef.current = {
        prevZoom: prev,
        anchorX: anchorClientX !== undefined ? anchorClientX - r.left : r.width / 2,
      };
      return clamped;
    });
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = zoomAnchorRef.current;
    if (!scroller || !anchor) return;
    zoomAnchorRef.current = null;
    scroller.scrollLeft = zoomedScrollLeft(
      anchor.prevZoom,
      zoom,
      scroller.clientWidth,
      scroller.scrollLeft,
      anchor.anchorX,
    );
  }, [zoom]);

  // The wheel listener below is attached once; it reads the live zoom
  // through this ref instead of re-attaching on every zoom change.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Ctrl/Cmd+wheel zooms about the cursor (the standard editor gesture, and
  // the same modifier the stage will never claim); a bare wheel PANS while
  // zoomed, because the strip has no vertical scroll to give the wheel to.
  // A NATIVE non-passive listener, not React's onWheel: browsers register
  // wheel listeners passively by default, and a passive listener cannot
  // preventDefault the browser's own pinch-zoom.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Multiplicative, so trackpad pinches (many small deltas) glide and
        // discrete wheel notches step visibly.
        applyZoom(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX);
      } else if (scroller.scrollWidth > scroller.clientWidth) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

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

  // The view follows the cursor (R16 §72) — the author's stated GENERAL
  // principle: whenever the playhead leaves the visible window (playback at
  // zoom, a ⌘-arrow jump, a frame step), the timeline scrolls to it. Landing
  // at 10% from the left edge keeps what's coming next on screen. Gestures
  // that move the view under a stationary pointer (edge paging) re-seek to
  // the pointer, so the playhead is back in view before this could fight.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || durationSec <= 0) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    const x = (frame / fps / durationSec) * scroller.scrollWidth;
    const { scrollLeft, clientWidth } = scroller;
    if (x < scrollLeft || x > scrollLeft + clientWidth) {
      scroller.scrollLeft = Math.max(
        0,
        Math.min(scroller.scrollWidth - clientWidth, x - clientWidth * 0.1),
      );
    }
  }, [frame, fps, durationSec]);

  // Same principle for SELECTION: a block selected from the keyboard
  // (⌥/⌘+arrows) may live outside the zoomed view — bring it in, minimally.
  useEffect(() => {
    if (!selection) return;
    const block = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-testid="timeline-block-${selection.sceneId}"]`,
    );
    block?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [selection]);

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
        startContentX: e.clientX - track.getBoundingClientRect().left,
        origStart: cue.startSec,
        origEnd: cue.endSec,
      };
      setDragPreview({ sceneId: cue.id, startSec: cue.startSec, endSec: cue.endSec, snapped: null });
    },
    [],
  );

  const lastPageRef = useRef(0);
  useEffect(() => {
    // Edge paging (R15 §58): while a gesture is live and the pointer reaches
    // the scroller's bound, advance by one viewport width — the content that
    // was at the bound becomes the new starting edge, both directions. The
    // gesture math survives because everything below reads the track's LIVE
    // bounding rect: paging shifts that rect, so the same clientX maps to
    // later content, which is exactly what "the drag continues" means.
    const pageAtEdge = (clientX: number): void => {
      const scroller = scrollerRef.current;
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
      const now = Date.now();
      if (now - lastPageRef.current < PAGE_COOLDOWN_MS) return;
      const r = scroller.getBoundingClientRect();
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (clientX >= r.right - PAGE_EDGE_PX && scroller.scrollLeft < max) {
        scroller.scrollLeft = Math.min(max, scroller.scrollLeft + scroller.clientWidth);
        lastPageRef.current = now;
      } else if (clientX <= r.left + PAGE_EDGE_PX && scroller.scrollLeft > 0) {
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft - scroller.clientWidth);
        lastPageRef.current = now;
      }
    };
    const onMove = (e: MouseEvent) => {
      const gestureLive =
        scrubbingRef.current || blockPressRef.current?.moved === true || dragRef.current !== null;
      if (gestureLive) pageAtEdge(e.clientX);
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
        const r = track?.getBoundingClientRect();
        // CONTENT-space delta (see DragState.startContentX): after a page,
        // the same pointer position is over later content and the block
        // follows it there.
        const deltaSec = r
          ? ((e.clientX - r.left - press.startContentX) / r.width) * durationSec
          : 0;
        // Snap (precision-editing design, "Timeline snapping"): propose both
        // edges shifted by the raw delta, snap each independently, and take
        // whichever correction is smaller — the nearer edge wins and the
        // WHOLE block still moves by one corrected delta, so duration stays
        // exact through `moveTiming` below. Alt/Option is the escape hatch,
        // read here at the call site — the pure core never sees it.
        let correctedDelta = deltaSec;
        let snappedAt: number | null = null;
        const cue = r && r.width > 0 && !e.altKey ? cues.find((c) => c.id === press.sceneId) : undefined;
        if (cue && r) {
          const thresholdSec = SNAP_PX / (r.width / durationSec);
          const targets = snapTargets(cues, press.sceneId, frameRef.current / fps, durationSec);
          const wantStart = cue.startSec + deltaSec;
          const wantEnd = cue.endSec + deltaSec;
          const snapStart = applySnap(wantStart, targets, thresholdSec);
          const snapEnd = applySnap(wantEnd, targets, thresholdSec);
          const distStart = snapStart.snapped === null ? Infinity : Math.abs(snapStart.sec - wantStart);
          const distEnd = snapEnd.snapped === null ? Infinity : Math.abs(snapEnd.sec - wantEnd);
          // On an exact tie, the START edge wins — arbitrary but fixed, same
          // "earlier wins" spirit as applySnap's own tie-break in timing.ts,
          // so the outcome never depends on which edge a scan visits first.
          if (distStart <= distEnd && snapStart.snapped !== null) {
            correctedDelta = deltaSec + (snapStart.sec - wantStart);
            snappedAt = snapStart.snapped;
          } else if (snapEnd.snapped !== null) {
            correctedDelta = deltaSec + (snapEnd.sec - wantEnd);
            snappedAt = snapEnd.snapped;
          }
        }
        const shifted = moveTiming(cues, press.sceneId, correctedDelta, durationSec);
        if (shifted) {
          // moveTiming is the authority on where the block actually lands —
          // a neighbour or the clip bounds can override the snapped delta
          // entirely. A tick drawn at a target the block does not sit on is
          // a lie, so it only survives if an ACHIEVED edge still matches the
          // target within float noise.
          const achievedSnap =
            snappedAt !== null &&
            (Math.abs(shifted.startSec - snappedAt) < 1e-6 ||
              Math.abs(shifted.endSec - snappedAt) < 1e-6)
              ? snappedAt
              : null;
          setDragPreview({ sceneId: press.sceneId, ...shifted, snapped: achievedSnap });
        }
        return;
      }
      const drag = dragRef.current;
      if (!drag || durationSec <= 0) return;
      const track = trackRef.current;
      if (!track) return;
      const r = track.getBoundingClientRect();
      const deltaSec = ((e.clientX - r.left - drag.startContentX) / r.width) * durationSec;
      let wantStart = drag.edge === "start" ? drag.origStart + deltaSec : drag.origStart;
      let wantEnd = drag.edge === "end" ? drag.origEnd + deltaSec : drag.origEnd;
      // Edge drag: snap the dragged edge only, then the existing clamp — snap
      // is a pre-pass, the clamp remains the single authority on legality.
      let snappedAt: number | null = null;
      if (!e.altKey && r.width > 0) {
        const thresholdSec = SNAP_PX / (r.width / durationSec);
        const targets = snapTargets(cues, drag.sceneId, frameRef.current / fps, durationSec);
        if (drag.edge === "start") {
          const snap = applySnap(wantStart, targets, thresholdSec);
          wantStart = snap.sec;
          snappedAt = snap.snapped;
        } else {
          const snap = applySnap(wantEnd, targets, thresholdSec);
          wantEnd = snap.sec;
          snappedAt = snap.snapped;
        }
      }
      const clamped = clampTiming(cues, drag.sceneId, wantStart, wantEnd, durationSec);
      // Same rule as the body-drag path above: clampTiming is the authority
      // (e.g. a start snapped to `prev.endSec` gets pushed to
      // `prev.endSec + GAP` by the clamp) — null the tick unless an achieved
      // edge still matches the target within float noise, so it never lights
      // up somewhere the block does not actually sit.
      const achievedSnap =
        snappedAt !== null &&
        (Math.abs(clamped.startSec - snappedAt) < 1e-6 ||
          Math.abs(clamped.endSec - snappedAt) < 1e-6)
          ? snappedAt
          : null;
      setDragPreview({ sceneId: drag.sceneId, ...clamped, snapped: achievedSnap });
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
  }, [cues, durationSec, edits, seekTrack, fps]);

  const playheadPct = durationSec > 0 ? Math.min(1, frame / fps / durationSec) * 100 : 0;

  return (
    <div
      style={strip}
      // Timeline mousedown (bug 6, PLAN 2026-08-04 Task 2): CAPTURE phase,
      // on the whole strip, so it runs BEFORE the ruler/track/block's own
      // bubble-phase handlers below — a scrub or a block select must not
      // itself land the first keystroke of the gesture into a still-focused
      // Inspector field. One listener up here covers every mousedown surface
      // in the strip (ruler, track background, blocks, ghosts, playhead
      // grab) instead of repeating the same call in each of their handlers.
      onMouseDownCapture={blurTypingElement}
    >
      <div style={zoomBar}>
        {/* Zoom controls (R14 §53), always visible so the feature is
            discoverable — buttons anchor about the viewport centre,
            ctrl/cmd+wheel about the cursor. */}
        <span style={zoomHint}>ctrl+scroll to zoom</span>
        <button
          data-testid="zoom-out"
          style={zoomButton}
          onClick={() => applyZoom(zoom / 2)}
          disabled={zoom <= 1}
          title="Zoom out (ctrl/cmd + scroll on the timeline)"
        >
          −
        </button>
        <span data-testid="zoom-level" style={zoomLabel}>
          {Math.round(zoom * 10) / 10}×
        </span>
        <button
          data-testid="zoom-in"
          style={zoomButton}
          onClick={() => applyZoom(zoom * 2)}
          disabled={zoom >= 16}
          title="Zoom in (ctrl/cmd + scroll on the timeline)"
        >
          +
        </button>
        <button
          data-testid="zoom-fit"
          style={{ ...zoomButton, width: "auto", padding: "0 8px" }}
          onClick={() => applyZoom(1)}
          disabled={zoom <= 1}
          title="Fit the whole clip in view"
        >
          fit
        </button>
      </div>
      <div ref={scrollerRef} data-testid="timeline-scroller" style={scroller}>
        <div style={{ width: `${zoom * 100}%`, minWidth: "100%", paddingBottom: 6 }}>
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
            {(() => {
              // Graduated ticks (R20 §97): interval picked so labels keep
              // ~70px of air at the current zoom, minors at a fifth of it.
              // Everything inside is pointer-inert — the ruler div itself
              // owns the seek gesture above.
              if (durationSec <= 0) return <span style={rulerLabel}>0:00</span>;
              const viewportW = scrollerRef.current?.clientWidth ?? 1200;
              const pxPerSec = (viewportW * zoom) / durationSec;
              const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
              let major = steps.find((s) => s * pxPerSec >= 70) ?? 600;
              while (durationSec / (major / 5) > 600) major *= 2; // DOM cap
              const minor = major / 5;
              const ticks: React.ReactNode[] = [];
              for (let t = 0; t <= durationSec + 1e-6; t += minor) {
                const isMajor = Math.round(t / minor) % 5 === 0;
                const left = `${(t / durationSec) * 100}%`;
                ticks.push(
                  <div
                    key={t.toFixed(3)}
                    style={{
                      position: "absolute",
                      left,
                      bottom: 0,
                      width: 1,
                      height: isMajor ? 8 : 4,
                      background: isMajor ? "#3A3A44" : "#26262e",
                      pointerEvents: "none",
                    }}
                  />,
                );
                if (isMajor && t + minor <= durationSec) {
                  ticks.push(
                    <span
                      key={`l${t.toFixed(3)}`}
                      style={{
                        ...rulerLabel,
                        position: "absolute",
                        left,
                        top: 0,
                        transform: t === 0 ? undefined : "translateX(-50%)",
                        pointerEvents: "none",
                      }}
                    >
                      {tickFmt(t)}
                    </span>,
                  );
                }
              }
              return (
                <>
                  {ticks}
                  <span
                    style={{
                      ...rulerLabel,
                      position: "absolute",
                      right: 2,
                      top: 0,
                      pointerEvents: "none",
                    }}
                  >
                    {formatTimecode(durationSec, fps)}
                  </span>
                </>
              );
            })()}
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
              const thumb =
                isPlain && toSourceSec
                  ? takeThumbs[toSourceSec((cue.startSec + cue.endSec) / 2).toFixed(1)]
                  : undefined;
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
                    blockPressRef.current = {
                  sceneId: cue.id,
                  startX: e.clientX,
                  startContentX:
                    e.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0),
                  moved: false,
                };
                  }}
                  style={{
                    ...block,
                    left: `${left}%`,
                    width: `${width}%`,
                    // Explicit stacking (PLAN R11 Task 1) — paint order used to
                    // be DOM order, which is time order, so a later take always
                    // clipped the selected block's border and an end-edge drag
                    // grew UNDERNEATH its neighbour. Levels: block 1, ghost 2,
                    // selected 3, dragging 4, playhead 5.
                    zIndex: isDragging ? 4 : isSelected ? 3 : 1,
                    border: isSelected
                      ? "2px solid #5b8cff"
                      : isPlain
                        ? "1px solid #22222a"
                        : "1px solid #2A2A33",
                    backgroundColor: isSelected ? "#1c2333" : isPlain ? "#131318" : "#1A1A21",
                    // The filmstrip (R20 §97): the take's own frame repeated
                    // across the block, dimmed under a gradient so the label
                    // stays readable. Missing thumb → the flat panel above.
                    ...(thumb
                      ? {
                          backgroundImage:
                            "linear-gradient(rgba(10,10,14,0.35), rgba(10,10,14,0.6)), " +
                            `url(${thumb})`,
                          backgroundSize: "auto 100%, auto 100%",
                          backgroundRepeat: "repeat-x",
                        }
                      : {}),
                  }}
                >
                  <span
                    style={
                      isPlain
                        ? thumb
                          ? { ...blockLabel, color: "#D8D8DE", textShadow: "0 1px 2px rgba(0,0,0,0.9)" }
                          : { ...blockLabel, color: "#55555f" }
                        : blockLabel
                    }
                  >
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
                    // Level 2: "the ghost paints above the take that took over
                    // its window" is now a stated rule, not an accident of DOM
                    // order (PLAN R11 Task 1). Selected ghosts join level 3.
                    zIndex: isSelected ? 3 : 2,
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
            {cuts.map((cut, i) => {
              // User cuts (PLAN 2026-08-04 Task 4c): TWO rendering modes,
              // keyed on `src` (review fix wave, finding 1). A cut's own
              // `startSec`/`endSec` describe the render-props frame the user
              // was looking at when they cut — the schema comment on
              // `OverrideDocSchema.cuts` (packages/core/src/overrides.ts)
              // says outright that once produce resolves `src`, those two
              // numbers are a historical record, "never authoritative
              // again". Drawing a struck band at them regardless would, once
              // Render has actually applied the cut, paint a dead region
              // over LIVE content of the new, SHORTER timeline — the exact
              // bug the review caught (and could even mismatch a live block
              // it happens to still overlap, offering a Restore that deletes
              // the wrong entry's meaning).
              const pct = (t: number): number =>
                durationSec > 0 ? Math.min(100, Math.max(0, (t / durationSec) * 100)) : 0;

              if (!cut.src) {
                // NOT YET APPLIED: the material is genuinely still on
                // screen, at `startSec`/`endSec` in THIS render-props' own
                // frame — today's struck band + Restore, unchanged. Both
                // ends clamp into [0, durationSec] (the review's "clamp all
                // cut visuals to the timeline width regardless") in case an
                // EARLIER produce run already shortened the timeline out
                // from under a cut nobody has restored yet.
                const clampedStart = Math.min(Math.max(cut.startSec, 0), durationSec);
                const clampedEnd = Math.min(Math.max(cut.endSec, 0), durationSec);
                const left = pct(clampedStart);
                const width =
                  durationSec > 0
                    ? Math.max(0, ((clampedEnd - clampedStart) / durationSec) * 100)
                    : 0;
                return (
                  <div
                    key={`cut-${i}-${cut.startSec}-${cut.endSec}`}
                    data-testid={`timeline-cut-${cut.startSec}-${cut.endSec}`}
                    style={{ ...cutOverlay, left: `${left}%`, width: `${width}%` }}
                  >
                    <div style={cutStrike} />
                  </div>
                );
              }

              // ALREADY APPLIED: the window at `startSec`/`endSec` no longer
              // exists in THIS output at all — produce removed it and
              // shifted everything after it (Task 4b). There is no live
              // block left underneath to strike through, so this draws a
              // SEAM instead of a band, positioned by mapping `src.startSec`
              // (the SOURCE range produce actually removed — the one value
              // that's still true) through the CURRENT render-props' own
              // `spans` via `sourceToOutputClamped` — a small pure position
              // LOOKUP over data the editor already has, not a rebuilt
              // cutlist: it answers "where does this source instant land
              // TODAY", nothing about reshaping the timeline (the DECIDE
              // above `live` in App.tsx still holds). Clicking the seam
              // offers Restore directly — there is no cue to select instead.
              const seamPct = pct(sourceToOutputClamped(spans, cut.src.startSec));
              return (
                <div
                  key={`cut-${i}-${cut.startSec}-${cut.endSec}`}
                  data-testid={`timeline-cut-seam-${cut.startSec}-${cut.endSec}`}
                  title="Restore cut — the material returns on the next produce/Render"
                  onMouseDown={(e) => {
                    // Same "select/act on mousedown" idiom every other
                    // Timeline gesture uses (blocks, ghosts, the track
                    // itself) — stopPropagation keeps this from ALSO
                    // triggering the track's own seek-and-scrub underneath.
                    // Blur discipline comes free from the strip's own
                    // capture-phase `blurTypingElement` above; no separate
                    // call needed here.
                    e.stopPropagation();
                    e.preventDefault();
                    edits.restoreChunk(cut.startSec, cut.endSec);
                  }}
                  style={{ ...cutSeamHit, left: `${seamPct}%` }}
                >
                  <div style={cutSeamLine} />
                </div>
              );
            })}
            {dragPreview ? (
              // The drag readout (precision-editing design, "The frames
              // readout"): m:ss:ff in the same units the transport shows,
              // so a landing spot reads in the units the user is judging it
              // by. Rendered for every live drag, snapped or not — the tick
              // below is the snap-only indicator.
              //
              // A late block (start past ~85% of the track) flips the
              // anchor to its RIGHT edge (translateX(-100%) instead of the
              // default -4px, which extends rightward): left-anchored, its
              // ~110px nowrap width would overflow past the track's right
              // edge into the scroller's own scrollable range, making
              // `scrollWidth > clientWidth` true even at zoom 1 — which
              // silently arms `pageAtEdge` (view paging is meant to be a
              // ZOOMED-in behaviour) and can jump the view mid edge-drag.
              // (corrected) The flip only guarantees the readout stays fully
              // inside the track on tracks wider than ~733px (110px / 15%);
              // below that width it can still overflow slightly — a
              // pre-existing shape of the 85% constant, deferred rather than
              // fixed here.
              <div
                data-testid="drag-readout"
                style={{
                  ...dragReadout,
                  left: `${durationSec > 0 ? (dragPreview.startSec / durationSec) * 100 : 0}%`,
                  transform:
                    durationSec > 0 && dragPreview.startSec / durationSec > 0.85
                      ? "translateX(-100%)"
                      : dragReadout.transform,
                }}
              >
                {formatTimecode(dragPreview.startSec, fps)} – {formatTimecode(dragPreview.endSec, fps)}
              </div>
            ) : null}
            {dragPreview?.snapped !== null && dragPreview?.snapped !== undefined ? (
              // The snap tick (precision-editing design, "Timeline
              // snapping"): a 1px landmark at the target the drag is
              // currently resting on, carried through the existing
              // `dragPreview` channel rather than a parallel state.
              <div
                data-testid="snap-tick"
                style={{
                  ...snapTick,
                  left: `${durationSec > 0 ? (dragPreview.snapped / durationSec) * 100 : 0}%`,
                }}
              />
            ) : null}
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
      </div>
    </div>
  );
};

const strip: React.CSSProperties = {
  flexShrink: 0,
  borderTop: "1px solid #1E1E24",
  background: "#111116",
  padding: "6px 20px 8px",
};

const zoomBar: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: 6,
  marginBottom: 4,
};

const zoomButton: React.CSSProperties = {
  width: 22,
  height: 18,
  fontSize: 12,
  lineHeight: 1,
  color: "#EDEDF2",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 4,
  cursor: "pointer",
  padding: 0,
};

const zoomLabel: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#9A9AA3",
  minWidth: 26,
  textAlign: "center",
};

const zoomHint: React.CSSProperties = {
  fontSize: 10,
  color: "#55555f",
  marginRight: 4,
  userSelect: "none",
};

/** The zoomed track lives inside this; at zoom 1 it is invisible plumbing. */
const scroller: React.CSSProperties = {
  overflowX: "auto",
  overflowY: "hidden",
};

const ruler: React.CSSProperties = {
  // Positioned canvas for the graduated ticks (R20 §97).
  position: "relative",
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

/** User-cut dead region — NOT YET APPLIED mode only (PLAN 2026-08-04 Task
 * 4c; two-mode split is the review fix wave's finding 1). A hatched red band
 * above every other block level (3, matching "selected") so the
 * strike-through always reads even over a selected block — it's decorative
 * and inert (`pointerEvents: none` on the caller), so winning the paint
 * order costs nothing real. */
const cutOverlay: React.CSSProperties = {
  position: "absolute",
  top: 3,
  bottom: 3,
  zIndex: 3,
  pointerEvents: "none",
  borderRadius: 4,
  border: "1px solid rgba(255,92,92,0.6)",
  background:
    "repeating-linear-gradient(135deg, rgba(255,92,92,0.22), rgba(255,92,92,0.22) 6px, transparent 6px, transparent 12px)",
};

/** The literal "struck through" line — a hatch alone reads as "selected" or
 * "dragging" at a glance; a horizontal line through the middle is the same
 * mark the ghost ROW already uses on its own label text. */
const cutStrike: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: "50%",
  height: 2,
  background: "rgba(255,92,92,0.8)",
};

/** Seam marker's clickable hit zone — ALREADY-APPLIED mode only. Wider than
 * the visual line so it's actually catchable (same "wide hit / thin paint"
 * split as `playheadGrab` below `playhead`). `pointerEvents: "auto"`
 * deliberately breaks from the struck band's `"none"` above: there is no
 * live block underneath a seam for a click to fall through to instead (the
 * material's actually gone) — the seam has to be its own click target. */
const cutSeamHit: React.CSSProperties = {
  position: "absolute",
  top: -4,
  bottom: -4,
  width: 12,
  marginLeft: -6,
  zIndex: 4,
  cursor: "pointer",
  pointerEvents: "auto",
};

/** The seam's actual paint — a thin tick, visually distinct from the struck
 * band's filled hatch on purpose: "already gone, click to restore" is a
 * different fact from "still here, marked dead" and should not look like the
 * same mark at a glance. */
const cutSeamLine: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: 0,
  bottom: 0,
  width: 2,
  background: "#FF5C5C",
  pointerEvents: "none",
};

const edgeHandle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: EDGE_HIT,
};

/** 1px landmark at the drag's current snap target (accent yellow, matching
 * the playhead — both are "a time worth noticing" marks on the track). */
const snapTick: React.CSSProperties = {
  position: "absolute",
  top: -4,
  bottom: -4,
  width: 1,
  zIndex: 6,
  background: "#FFE14D",
  pointerEvents: "none",
};

/** The live drag readout, floated above the track so it never fights the
 * block's own label for room. */
const dragReadout: React.CSSProperties = {
  position: "absolute",
  bottom: "100%",
  marginBottom: 3,
  transform: "translateX(-4px)",
  whiteSpace: "nowrap",
  fontSize: 10,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#0B0B0E",
  background: "#FFE14D",
  padding: "1px 5px",
  borderRadius: 3,
  zIndex: 6,
  pointerEvents: "none",
};

const playhead: React.CSSProperties = {
  position: "absolute",
  // Reaches up across the ruler (18px + its 4px gap): the ruler is a seek
  // surface now, so the playhead must be visible against it.
  top: -26,
  bottom: -4,
  width: 2,
  // Top of the timeline's stacking levels — the needle reads over any block.
  zIndex: 5,
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
