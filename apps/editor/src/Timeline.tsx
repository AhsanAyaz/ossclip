import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { KeptSpan, SceneCue, Segment } from "@ossclip/core/browser";
import { chipMenuLabels, removalSeams, type RemovalSeam } from "./cleanup";
import { ContextMenu } from "./ContextMenu";
import {
  applySnap,
  clampTiming,
  clampZoom,
  formatTimecode,
  moveTiming,
  pinTiming,
  snapTargets,
  sourceToOutputClamped,
  timeAtX,
  zoomedScrollLeft,
} from "./timing";
import type { useEdits } from "./useEdits";
import { nearestSfxWord, sfxAudioUrl, type SfxMarker, type SfxWordAnchor } from "./sfxLane";
import {
  previewVolume,
  sfxPreloadIds,
  sfxToFire,
  type SfxPlaybackMarker,
} from "./sfxPlayback";
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
   * for the same back-compat reason as `cuts`; harmless when omitted — an
   * applied cut with no spans to place it against draws NO seam at all
   * (the `cuts.map` guard below skips it outright), never a misleading one
   * at `sourceToOutputClamped`'s empty-array fallback position (0%, the
   * timeline's very start — not a real answer, just where the lookup gives
   * up; a clickable Restore target there would be actively wrong, worse
   * than no seam, per the re-review's Minor).
   */
  spans?: readonly KeptSpan[];
  /**
   * Produce's labeled cutlist PROPOSAL (`production.cutlistProposed`, via
   * GET /api/cleanup) — cut review step 2's seams, toggleable since step 3.
   * Every `remove` span draws as a reason-coloured seam marker at its output
   * position; clicking a vetoable one toggles its veto (`edits.toggleKept`),
   * and a vetoed seam renders hollow. Since step 4 the `spans`/`durationSec`
   * this component receives are the LIVE (post-veto) ones, so a vetoed
   * seam's position is inside the revived material the player now plays.
   * Optional/defaulted like `cuts`/`spans` so existing callers keep
   * compiling unchanged.
   */
  cleanup?: readonly Segment[];
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
  /**
   * LIVE-clock output seconds → SOURCE seconds, for the timing PIN a drag
   * commits (`SceneTimingSchema`; Inspector's prop of the same name is the
   * cut writers' version of this). App threads
   * `previewClockMappers(liveRecut).toSourceSec`, which is exact under a
   * live veto and the spans' own conversion without one.
   *
   * Deliberately NOT `toSourceSec` above, close as the two look: that one is
   * the FILMSTRIP's lookup and answers the first span's `srcIn` for any time
   * outside the spans, because a thumbnail is allowed to fall back to
   * something plausible. A pin is the doc's authoritative anchor, so it gets
   * the clock's own conversion or none at all (`pinTiming` falls back to a
   * legacy old-clock write when this is absent).
   */
  pinSourceSec?: ((sec: number) => number) | null;
  /**
   * OLD-clock output seconds → the live (player) clock this ruler draws
   * (cut review step 4 follow-up, the struck band's DISPLAY half): a
   * NOT-YET-APPLIED cut's `startSec`/`endSec` speak the LAST RENDER's own
   * output seconds (the `OverrideDocSchema.cuts` contract the writers now
   * hold to), but under a live cleanup veto `durationSec`/`spans` here are
   * the re-cut NEW clock — unmapped, a band past a revived pause strikes
   * through content the revived seconds off its true window. App threads
   * `previewClockMappers(liveRecut).toLive`, exact for every live veto
   * (vetoes only ADD time back). Identity default, same back-compat rule as
   * `toSourceSec`; the APPLIED-cut seam never needs it — that one places by
   * `src` through the live `spans` already.
   */
  toLive?: (sec: number) => number;
  /**
   * "This source range is now playing again" (Phase A, 2026-08-26) — called
   * AFTER the keep/dismiss dispatch that revived it, so App can re-decode
   * the span and correct the caption stamps whisper got wrong over material
   * the first pass had cut.
   *
   * ONLY WHEN MATERIAL CAME BACK. A click on an ALREADY-vetoed seam
   * re-removes it, and re-decoding audio that is about to leave the cut
   * again is work whose result nothing can display — worse, it would fire a
   * request on every toggle of a chip the user is flipping back and forth.
   * The `seam.vetoed` guard at the call sites is that rule.
   * Optional/defaulted, the `toSourceSec` back-compat rule: every existing
   * caller (and test) predating it keeps compiling.
   */
  onRevived?: (srcIn: number, srcOut: number) => void;
  /**
   * The sound-effect lane (Phase 4, 2026-08-29): the plan ∩ overrides merge,
   * already resolved to output instants (`sfxLaneMarkers`).
   *
   * NULL/absent means this production has no `sfx` plan at all, and the lane
   * is not drawn — no row, no palette, nothing: produce only applies the
   * override layer when a plan exists (`if (sfxPlan)`, produce.ts), so an
   * effect added here would be silently dropped at render time. An EMPTY array
   * is a different fact — a plan whose placements are all on cut words — and
   * still draws the (empty) lane, so the feature stays where the user left it.
   */
  sfxMarkers?: readonly SfxMarker[] | null;
  /** Snap targets for a marker drag: every transcript word still in the
   * output, at its output instant (`sfxWordAnchors`). A drag with none of
   * these to land on writes nothing — a marker is anchored to a WORD, never to
   * a second. */
  sfxWords?: readonly SfxWordAnchor[];
  /** The selected marker's doc key, or null — the SFX namespace's half of the
   * one-selection-at-a-time rule App owns. */
  sfxSelected?: string | null;
  onSelectSfx?: (key: string | null) => void;
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
 * Below `MOVE_THRESHOLD_PX` of travel it stays a click (select ONLY — the
 * seek-on-click Task 4 added moved the playhead every time a scene was
 * selected for editing, field report 2026-08-07); past it, it becomes a
 * move drag that shifts the whole block (Task 6). The threshold is what
 * keeps a click that wobbles a pixel from silently writing a `timing`
 * override and pinning the scene.
 */
interface BlockPress {
  sceneId: string;
  /** Viewport-space start, for the click-vs-drag travel threshold only. */
  startX: number;
  /** Content-space start — the delta the move actually uses (see DragState). */
  startContentX: number;
  moved: boolean;
  /**
   * A press on a PLAIN take: past the travel threshold it SCRUBS (the takes
   * cover most of the track, and they can't move — their window is derived)
   * instead of move-dragging. Threshold-gated like every other press so a
   * bare click selects WITHOUT seeking (field report 2026-08-07) — the old
   * seek-on-mousedown moved the playhead on every take selection.
   */
  scrub?: boolean;
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
 * Sound effects PLAYING with the preview (Phase 4 follow-up, 2026-08-29), so a
 * placement can be judged where it lands instead of only through the
 * Inspector's click-to-hear.
 *
 * The I/O half of `sfxPlayback.ts` — every decision (crossed, muted, a seek
 * rather than playback, the volume) is made there, and this owns only the
 * elements and the subscription, `useTakeThumbs`' shape and the
 * `openCommand`/`openInBrowser` rule.
 *
 * SUBSCRIBED TO THE PLAYER, not to a rAF loop of our own: `frameupdate` is the
 * clock every other live surface in the editor follows (the playhead, the
 * transcript's current line), and a second loop racing it would put the sounds
 * on a different time than the picture they are being judged against.
 *
 * The markers arrive through a ref rather than the effect's deps so a drag, a
 * mute or an add previews at its edited position WITHOUT tearing down the
 * listener — App re-derives `sfxLaneMarkers` on every doc change, and
 * re-subscribing per keystroke is the cost the `zoomRef` trick exists to
 * avoid.
 */
const useSfxPreview = (
  playerRef: React.RefObject<PlayerRef | null>,
  fps: number,
  markers: readonly SfxPlaybackMarker[] | null,
  enabled: boolean,
): void => {
  const liveRef = useRef<{ markers: readonly SfxPlaybackMarker[]; enabled: boolean }>({
    markers: [],
    enabled: false,
  });
  // Off, or no lane at all, is simply an empty schedule — one gate, read per
  // sample, instead of a listener that comes and goes with the toggle.
  liveRef.current = { markers: markers ?? [], enabled: enabled && markers !== null };
  const poolRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Preload one element per DISTINCT sound the lane can fire. Lazy — nothing
  // is fetched for a production whose lane is hidden or whose preview is
  // off — and re-run as the lane changes, so a sound swapped in this session
  // is warm by the time the playhead reaches it. Failures are swallowed
  // (Inspector's `previewSound` rule): a missing pack file, or an environment
  // with no `Audio` at all, must cost the preview, never the playback.
  const preload = markers === null || !enabled ? [] : sfxPreloadIds(markers);
  const preloadKey = preload.join(",");
  useEffect(() => {
    const pool = poolRef.current;
    for (const id of preloadKey === "" ? [] : preloadKey.split(",")) {
      if (pool.has(id)) continue;
      try {
        const el = new Audio(sfxAudioUrl(id));
        el.preload = "auto";
        pool.set(id, el);
      } catch {
        // no Audio in this environment — the fire below no-ops for this id
      }
    }
  }, [preloadKey]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    // ONLY WHILE PLAYING, mirrored off the player's own play/pause events —
    // App's `data-playing` rule ("the PLAYER's intent, straight from its own
    // events"). `frameupdate` also fires for a scrub, a frame step and a
    // programmatic `seekTo`, and a sound on every ruler drag would make the
    // timeline unusable. Seeded from the player in case this ever re-attaches
    // mid-playback (an fps change), tolerating a ref stub without the method.
    let playing = player.isPlaying?.() ?? false;
    // The previous sample, or null for "no baseline yet". Reset on BOTH
    // transport events: a seek made while paused moves the playhead under a
    // stale `prev`, and pressing play would then fire everything between the
    // two positions whenever that gap slipped under the seek threshold.
    // Seeding on the first frame after play costs at most that one frame's
    // markers (33ms at 30fps) — cheaper than a phantom volley.
    let prevSec: number | null = null;
    const onFrame = (e: { detail: { frame: number } }): void => {
      if (!playing) return;
      const curSec = e.detail.frame / fps;
      const prev = prevSec;
      // Advanced even when the toggle is OFF (below), so flipping it on
      // mid-playback resumes from HERE rather than replaying the stretch it
      // spent muted.
      prevSec = curSec;
      const { markers: live, enabled: on } = liveRef.current;
      if (prev === null || !on) return;
      for (const m of sfxToFire(prev, curSec, live)) {
        const el = poolRef.current.get(m.soundId);
        if (!el) continue;
        try {
          el.volume = previewVolume(m.gain);
          // Restart the SAME element rather than mixing a clone: two
          // placements of one sound closer together than its own length
          // retrigger instead of overlapping, which the render (an ffmpeg
          // mix) would layer. The gain clamp's rule — a preview-fidelity
          // limit of `HTMLAudioElement`, not a bug.
          el.currentTime = 0;
          void el.play()?.catch(() => {});
        } catch {
          // a pack file deleted since the library loaded, an element the
          // browser refuses to start — never at the cost of the playback
        }
      }
    };
    const onPlay = (): void => {
      playing = true;
      prevSec = null;
    };
    const onPause = (): void => {
      playing = false;
      prevSec = null;
    };
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [playerRef, fps]);
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
  cuts = [],
  spans = [],
  cleanup = [],
  durationSec,
  fps,
  playerRef,
  selection,
  onSelect,
  edits,
  videoSrc,
  toSourceSec,
  pinSourceSec = null,
  toLive = (sec: number): number => sec,
  onRevived,
  sfxMarkers = null,
  sfxWords = [],
  sfxSelected = null,
  onSelectSfx,
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
  // The marker chip's right-click menu (cut-review rework): the seam it
  // opened on plus the click's viewport point; null = closed. Rendered at
  // the strip's end so it floats above everything.
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; seam: RemovalSeam } | null>(
    null,
  );
  // A press on an SFX diamond, threshold-gated like every other press on this
  // strip (BlockPress' rule): below `MOVE_THRESHOLD_PX` it stays a bare
  // SELECT, so clicking a marker to edit it in the Inspector can never
  // silently retime it by a pixel of hand wobble.
  const sfxPressRef = useRef<{ marker: SfxMarker; startX: number; moved: boolean } | null>(null);
  /** The word a live marker drag is currently resting on — its own channel, so
   * the diamond can follow the pointer without touching the doc until the
   * mouseup commits. */
  const [sfxDrag, setSfxDrag] = useState<{ key: string; word: number; atSec: number } | null>(null);
  // …mirrored into a ref, read by the mouseup commit below. The `zoomRef`
  // trick, for a different reason: reading the live value out of a
  // `setSfxDrag(prev => …)` updater would run the COMMIT during React's
  // render phase (a dispatch into the parent's reducer from inside a child's
  // render — React warns, and the warning is right).
  const sfxDragRef = useRef(sfxDrag);
  sfxDragRef.current = sfxDrag;
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
  // "SFX in preview", default ON — the sounds are the point of the lane, and a
  // feature that has to be switched on to be noticed is a feature nobody
  // finds. SESSION-LOCAL on purpose (plain state, no localStorage): this is a
  // monitoring choice like a soloed track, not an edit, and nothing it does
  // reaches the doc or the render.
  const [sfxPreview, setSfxPreview] = useState(true);
  useSfxPreview(playerRef, fps, sfxMarkers, sfxPreview);
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
    // Never while a pointer gesture is live (field report 2026-08-26): a
    // scroll here shifts the track under an in-flight press whose
    // content-space anchor (`startContentX`) was captured against the
    // pre-scroll rect — at zoom, the block then leaps by exactly the
    // scrolled distance. Playback moving the playhead off-screen mid-drag
    // is the case this used to fire on.
    if (scrubbingRef.current || blockPressRef.current !== null || dragRef.current !== null) return;
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
    // Same gesture guard as the playhead-follow above (field report
    // 2026-08-26): a BLOCK PRESS selects on mousedown, this effect then
    // scrolled the (wider-than-viewport, at zoom) block "into view", and the
    // drag that followed measured its delta against a track that had just
    // moved — the block landed wherever the scroll put it, not where the
    // pointer did. The follow is for selections made WITHOUT a pointer on
    // the strip (⌥/⌘+arrows); a pressed block is already under the pointer.
    if (scrubbingRef.current || blockPressRef.current !== null || dragRef.current !== null) return;
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
        scrubbingRef.current ||
        blockPressRef.current?.moved === true ||
        sfxPressRef.current?.moved === true ||
        dragRef.current !== null;
      if (gestureLive) pageAtEdge(e.clientX);
      // The SFX marker drag, BEFORE the scrub/block branches: a press that
      // started on a diamond owns the gesture (its own mousedown already
      // stopped propagation), and the lane sits outside the track, so nothing
      // below could claim it anyway.
      const sfxPress = sfxPressRef.current;
      if (sfxPress) {
        if (!sfxPress.moved && Math.abs(e.clientX - sfxPress.startX) < MOVE_THRESHOLD_PX) return;
        sfxPress.moved = true;
        const track = trackRef.current;
        const r = track?.getBoundingClientRect();
        if (!r || durationSec <= 0) return;
        // SNAP TO A WORD, always — there is no free-time position for a sound
        // effect to hold: the doc stores a word INDEX (recut-immune by
        // construction, `OverrideDocSchema.sfx`), and the output second is
        // re-derived through the new TimeMap on every run. A pointer over a
        // stretch with no words left (all cut) simply keeps the last landing.
        const word = nearestSfxWord(sfxWords, timeAtX(e.clientX, r.left, r.width, durationSec));
        if (word === null) return;
        const atSec = sfxWords.find((w) => w.word === word)?.atSec;
        if (atSec === undefined) return;
        setSfxDrag({ key: sfxPress.marker.key, word, atSec });
        return;
      }
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
        if (press.scrub) {
          // A plain take's press past the threshold is a scrub, not a block
          // move — follow the pointer like the ruler does (field report
          // 2026-08-07: the seek now waits for real travel, so a click
          // selects without touching the playhead).
          seekTrack(e.clientX);
          return;
        }
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
      const sfxPress = sfxPressRef.current;
      if (sfxPress) {
        sfxPressRef.current = null;
        const drag = sfxDragRef.current;
        setSfxDrag(null);
        // A press that never travelled stays a select (the mousedown already
        // did that), and a drag that landed back on the marker's own word
        // writes nothing — the reducer's no-op guard would refuse it anyway,
        // but not dispatching keeps the undo stack honest at the call site too.
        if (sfxPress.moved && drag && drag.key === sfxPress.marker.key) {
          const m = sfxPress.marker;
          if (drag.word !== m.word) {
            // The two namespaces write through different doors: a PLANNED
            // placement patches its `sfx.edits` entry against the plan (so a
            // drag back onto the planned word clears the override), an ADDED
            // one just moves its own record.
            //
            // Dragging a SCENE-ANCHORED marker (`m.sceneId`) writes a `word`
            // through this same door, which BREAKS the link
            // (`applySfxOverrides` clears `sceneId` on any edit carrying a
            // word) — the marker then stays where it was dropped instead of
            // following the graphic. That is the intent: the user has just
            // said where this fires, and an explicit position outranks the
            // model's sync. The one way back is dragging it onto the PLANNED
            // word, which clears the override entirely and so restores the
            // plan whole — scene link included, so the marker returns to the
            // graphic rather than to that word.
            if (m.kind === "added") edits.patchSfxAdded(m.key, { word: drag.word });
            else if (m.planned) edits.patchSfx(m.key, { word: drag.word }, m.planned);
          }
        }
        return;
      }
      const press = blockPressRef.current;
      if (press) {
        blockPressRef.current = null;
        if (press.moved && !press.scrub) {
          // The drag became a move (Task 6): commit it. Like an edge drag,
          // this writes `timing` and pins the scene — the badge appears via
          // the same patch path. (A scrub press never has a preview to
          // commit — the guard just makes that explicit.)
          setDragPreview((preview) => {
            if (preview && preview.sceneId === press.sceneId) {
              // `pinTiming`, not the raw preview numbers: the preview speaks
              // the clock this timeline draws, which under a live veto is
              // NOT the clock `timing` used to be stored in (the field bug —
              // a dragged block landed seconds away and snapped back).
              edits.patchTiming(
                press.sceneId,
                pinTiming(preview.startSec, preview.endSec, pinSourceSec),
              );
            }
            return null;
          });
        }
        // It stayed a click: the mousedown already selected the block, and
        // that is ALL a click on a block does. It used to also seek to the
        // clicked time (Task 4), but selecting a scene to edit it kept
        // yanking the playhead away from wherever the user had parked it
        // (field report 2026-08-07). Seeking lives on the intentional
        // surfaces only: the ruler and the bare track background.
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
          // Source-anchored like the body-drag commit above, same reasoning.
          edits.patchTiming(
            drag.sceneId,
            pinTiming(preview.startSec, preview.endSec, pinSourceSec),
          );
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
  }, [cues, durationSec, edits, seekTrack, fps, pinSourceSec, sfxWords]);

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
      {chipMenu !== null
        ? (() => {
            const labels = chipMenuLabels(chipMenu.seam);
            const { srcIn, srcOut } = chipMenu.seam;
            return (
              <ContextMenu
                x={chipMenu.x}
                y={chipMenu.y}
                onClose={() => setChipMenu(null)}
                items={[
                  {
                    label: labels.keep,
                    onPick: () => {
                      edits.toggleKept(srcIn, srcOut);
                      // The chip's own rule: this item RE-REMOVES an already
                      // vetoed seam, and only the keep direction revives
                      // material worth re-decoding (`onRevived`).
                      if (!chipMenu.seam.vetoed) onRevived?.(srcIn, srcOut);
                    },
                  },
                  {
                    label: labels.dismiss,
                    onPick: () => {
                      edits.dismissRemoval(srcIn, srcOut);
                      // A dismissal ("not a retake") always keeps the
                      // material — there is no direction to guard here.
                      onRevived?.(srcIn, srcOut);
                    },
                  },
                ]}
              />
            );
          })()
        : null}
      <div style={zoomBar}>
        {sfxMarkers === null ? null : (
          // "SFX in preview" — the lane's own chrome, so it lives with the
          // lane: no plan, no lane, no toggle (the `sfxMarkers === null` rule
          // the row itself follows). Pushed to the LEFT of the zoom controls
          // by its own margin, over the diamonds it governs, rather than
          // joining the view controls it has nothing to do with.
          <button
            data-testid="sfx-preview-toggle"
            style={{
              ...zoomButton,
              marginRight: "auto",
              width: "auto",
              padding: "0 6px",
              // Off reads as OFF at a glance: the lane's colour when live, the
              // zoom controls' muted grey when it is not.
              color: sfxPreview ? SFX_COLOR : "#9A9AA3",
              borderColor: sfxPreview ? SFX_COLOR : "#2A2A33",
            }}
            aria-pressed={sfxPreview}
            onClick={() => setSfxPreview((v) => !v)}
            title={
              sfxPreview
                ? "Sound effects play with the preview — click to mute them"
                : "Sound effects are muted in the preview — click to hear them"
            }
          >
            {/* A glyph, not an emoji — the strip's own vocabulary (`▾ logs`,
                `▸ Hear it`), and the word says which state it is IN, not
                which one the click would reach: this button is a monitor
                state, and the timeline has room to say so. */}
            {sfxPreview ? "♪ sfx on" : "♪ sfx off"}
          </button>
        )}
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
          {(() => {
            // The removal marker lane (field report 2026-08-26): produce's
            // labelled removals — pauses, fillers, retakes, bloopers — as
            // readable chips in their OWN row above the ruler, the way NLEs
            // put markers above the timeline, instead of 6px ticks competing
            // with the track's seek/drag/trim surfaces. The contract is the
            // seams' own (cut review steps 2–4), unchanged: a chip present at
            // render time means the removal HAPPENS; clicking a vetoable chip
            // toggles the keep (`cleanup.kept` / the category switch), the
            // preview plays the change immediately, and a KEPT chip renders
            // hollow with a band spanning the revived material it now
            // occupies. `user`/`clip` chips stay hover-only disclosures —
            // `applyCleanupChoices` ignores vetoes on them by contract.
            const seams = removalSeams(cleanup, spans, edits.doc.cleanup);
            if (seams.length === 0) return null;
            return (
              <div data-testid="marker-lane" style={markerLane}>
                {seams.map((seam) => {
                  const leftPct =
                    durationSec > 0
                      ? Math.min(100, Math.max(0, (seam.outSec / durationSec) * 100))
                      : 0;
                  const title = seam.vetoed
                    ? `${seam.label} — kept: playing in the preview (click to re-remove)`
                    : seam.vetoable
                      ? `${seam.label} — click to keep this; the preview updates immediately`
                      : seam.label;
                  return (
                    <div
                      key={`removal-${seam.srcIn}-${seam.srcOut}`}
                      data-testid={`timeline-removal-${seam.srcIn}-${seam.srcOut}`}
                      {...(seam.vetoed ? { "data-vetoed": "true" } : {})}
                      title={title}
                      {...(seam.vetoable
                        ? {
                            onMouseDown: (e: React.MouseEvent) => {
                              // The restore seam's idiom: act on mousedown,
                              // stopPropagation so the track underneath
                              // doesn't also seek-and-scrub. Right-button
                              // presses fall through to onContextMenu below.
                              if (e.button === 2) return;
                              e.stopPropagation();
                              e.preventDefault();
                              edits.toggleKept(seam.srcIn, seam.srcOut);
                              // AFTER the dispatch, and only on the keep
                              // direction — `onRevived`'s docstring.
                              if (!seam.vetoed) onRevived?.(seam.srcIn, seam.srcOut);
                            },
                            onContextMenu: (e: React.MouseEvent) => {
                              // Right-click opens the marker menu (keep /
                              // "not a <reason>") instead of the browser's.
                              e.preventDefault();
                              e.stopPropagation();
                              setChipMenu({ x: e.clientX, y: e.clientY, seam });
                            },
                          }
                        : {})}
                      style={{
                        ...markerChip,
                        ...(seam.vetoable ? { cursor: "pointer" } : {}),
                        left: `${leftPct}%`,
                        // A chip at the timeline's tail anchors by its RIGHT
                        // edge — left-anchored at 100% it would hang past the
                        // lane entirely (the drag readout's late-block flip).
                        ...(leftPct > 90 ? { transform: "translateX(-100%)" } : {}),
                        // Coincident removals fan out so each stays hoverable.
                        marginLeft: seam.stackIndex * 10,
                        zIndex: 2 + seam.stackIndex,
                        ...(seam.vetoed
                          ? {
                              background: "transparent",
                              border: `1px dashed ${seam.color}`,
                              color: seam.color,
                              opacity: 0.7,
                            }
                          : {
                              background: `${seam.color}30`,
                              border: `1px solid ${seam.color}`,
                              color: "#EDEDF2",
                            }),
                      }}
                    >
                      {seam.vetoed ? `kept · ${seam.label}` : seam.label}
                    </div>
                  );
                })}
                {seams
                  .filter((s) => s.vetoed && durationSec > 0)
                  .map((seam) => {
                    const leftPct = Math.min(
                      100,
                      Math.max(0, (seam.outSec / durationSec) * 100),
                    );
                    const widthPct = Math.min(
                      100 - leftPct,
                      ((seam.srcOut - seam.srcIn) / durationSec) * 100,
                    );
                    return (
                      <div
                        key={`kept-band-${seam.srcIn}-${seam.srcOut}`}
                        data-testid={`timeline-kept-band-${seam.srcIn}-${seam.srcOut}`}
                        style={{
                          ...keptBand,
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          borderColor: seam.color,
                        }}
                      />
                    );
                  })}
              </div>
            );
          })()}
          {sfxMarkers === null ? null : (
            // The sound-effect lane (Phase 4): one diamond per placement at
            // the output instant its word lands on, in its own row above the
            // ruler — the removal lane's shape, for the same reason (a marker
            // belongs above the timeline, not fighting the track's
            // seek/drag/trim surfaces). Drawn from the PLAN + overrides merge,
            // never from render-props' `sfxCues` (sfxLane.ts's header owns the
            // argument): a muted placement has no cue and must still show as
            // a restorable ghost.
            <div data-testid="sfx-lane" style={sfxLane}>
              {sfxMarkers.map((m) => {
                const dragging = sfxDrag?.key === m.key;
                const atSec = dragging ? sfxDrag.atSec : m.atSec;
                const word = dragging ? sfxDrag.word : m.word;
                const leftPct =
                  durationSec > 0 ? Math.min(100, Math.max(0, (atSec / durationSec) * 100)) : 0;
                const selected = sfxSelected === m.key;
                return (
                  <div
                    key={m.key}
                    data-testid={`sfx-marker-${m.key}`}
                    {...(m.muted ? { "data-muted": "true" } : {})}
                    {...(selected ? { "data-selected": "true" } : {})}
                    title={
                      `${m.soundId} · word ${word} · gain ${m.gain}` +
                      (m.muted ? " · muted (restore it in the panel)" : "") +
                      (m.kind === "added" ? " · added by you" : "") +
                      " — drag to another word"
                    }
                    onMouseDown={(e) => {
                      // The strip's own idiom: act on mousedown, stop the
                      // press reaching the surfaces underneath (the lane sits
                      // over nothing clickable today, but the removal chips
                      // learned this the hard way). Blur discipline comes free
                      // from the strip's capture-phase `blurTypingElement`.
                      if (e.button === 2) return;
                      e.stopPropagation();
                      e.preventDefault();
                      onSelectSfx?.(m.key);
                      sfxPressRef.current = { marker: m, startX: e.clientX, moved: false };
                    }}
                    style={{
                      ...sfxMarkerHit,
                      left: `${leftPct}%`,
                      // A diamond at the very end anchors by its own centre
                      // like every other, but its hit box would hang past the
                      // lane — the removal chip's tail rule, halved because
                      // this mark is already centred on its instant.
                      zIndex: selected || dragging ? 3 : 2,
                    }}
                  >
                    <div
                      style={{
                        ...sfxDiamond,
                        // Selection wins the border, as it does on a block;
                        // a MUTED marker is hollow and dimmed — the vetoed
                        // chip's "still here, not happening" vocabulary,
                        // which is exactly what a mute is.
                        border: `1px solid ${selected ? "#5b8cff" : SFX_COLOR}`,
                        background: m.muted ? "transparent" : SFX_COLOR,
                        opacity: m.muted ? 0.45 : 1,
                        ...(m.kind === "added" ? { borderStyle: "dashed" } : {}),
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
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
                    // Select right away for feedback. The press then waits on
                    // travel (MOVE_THRESHOLD_PX) to decide what it is: a GRAPHIC
                    // block's drag moves the block, a PLAIN take's drag scrubs
                    // (its window is derived, not stored — it can't move, and
                    // the takes cover most of the track, so losing press-and-
                    // drag seeking over them would regress the very gesture the
                    // track was given). Below the threshold BOTH stay a bare
                    // select — no seek: clicking a scene to edit it kept
                    // yanking the playhead away (field report 2026-08-07).
                    onSelect({ sceneId: cue.id, elementId: null });
                    blockPressRef.current = {
                      sceneId: cue.id,
                      startX: e.clientX,
                      startContentX:
                        e.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0),
                      moved: false,
                      scrub: isPlain,
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
                    // A revived block (`cue.kept` — a vetoed removal carved
                    // into its own take by carveKeptTakes) reads as its own
                    // state at a glance: dashed violet over a faint tint,
                    // the kept-band family. Selection still wins the border.
                    border: isSelected
                      ? "2px solid #5b8cff"
                      : cue.kept !== undefined
                        ? "1px dashed #B78CFF"
                        : isPlain
                          ? "1px solid #22222a"
                          : "1px solid #2A2A33",
                    backgroundColor: isSelected
                      ? "#1c2333"
                      : cue.kept !== undefined
                        ? "#1a1524"
                        : isPlain
                          ? "#131318"
                          : "#1A1A21",
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
                    {cue.kept !== undefined ? "KEPT" : cue.id}
                  </span>
                  {/* Non-default gain reads at a glance where time lives
                      (field report 2026-08-31); the control itself is the
                      Inspector's Audio slider. */}
                  {cue.video?.volume !== undefined && cue.video.volume !== 1 ? (
                    <span data-testid={`volume-badge-${cue.id}`} style={pinBadge}>
                      {cue.video.volume === 0 ? "MUTE" : `${Math.round(cue.video.volume * 100)}%`}
                    </span>
                  ) : null}
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
            {cuts.map((cut, i) => {
              // User cuts (PLAN 2026-08-04 Task 4c): TWO rendering modes,
              // keyed on `src` (review fix wave, finding 1) — where `src`
              // present means APPLIED, by produce OR by the live preview
              // (cut-review rework: the editor's own cut writers resolve
              // `src` at the gesture and `livePreviewMap` subtracts it, so a
              // cut made this session is already gone from the timeline the
              // ruler describes). A cut's own
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
                // screen, at `startSec`/`endSec` in the LAST RENDER's own
                // frame — drawn at `toLive(...)` (the prop doc: under a live
                // veto this ruler is the re-cut NEW clock, and the unmapped
                // band struck through content the revived seconds off), the
                // identity when no veto is live. Both ends then clamp into
                // [0, durationSec] (the review's "clamp all cut visuals to
                // the timeline width regardless") in case an EARLIER produce
                // run already shortened the timeline out from under a cut
                // nobody has restored yet. The key/testid keep the DOC's own
                // numbers — they identify the entry, not its pixels, and the
                // no-veto path must stay bit-identical.
                const clampedStart = Math.min(Math.max(toLive(cut.startSec), 0), durationSec);
                const clampedEnd = Math.min(Math.max(toLive(cut.endSec), 0), durationSec);
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

              // ALREADY APPLIED — by produce, or by the LIVE PREVIEW since
              // the cut-review rework: either way the window at
              // `startSec`/`endSec` no longer exists in THIS output at all,
              // because it was removed and everything after it shifted (Task
              // 4b). A cut written THIS SESSION needs no special case: App
              // passes `spans={live.spans}`, the re-cut clock's own spans, so
              // `sourceToOutputClamped` places the seam of a just-made cut
              // exactly where the material disappeared. There is no live
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
              //
              // No `spans` (re-review Minor, PLAN 2026-08-04 Task 4c):
              // `sourceToOutputClamped([], …)` returns 0, which would paint
              // a clickable Restore target at the timeline's very start —
              // a POSITION the seam never actually claimed, just the
              // fallback of a lookup with nothing to look up against.
              // Skipping the seam entirely here is safer than a parked,
              // misleading Restore target; nothing is lost — the entry is
              // untouched and gets its seam back the moment `spans` loads.
              if (spans.length === 0) return null;
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
                    // call needed here. `i` is this entry's own index in
                    // `doc.cuts` (fix round 2, re-review) — identity, so a
                    // sibling entry that happens to share this window (the
                    // seam-coincidence case `cutChunk` documents) is never
                    // touched by this click.
                    e.stopPropagation();
                    e.preventDefault();
                    edits.restoreChunk(i);
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

/** A produce-removal seam's hit zone (cut review step 2, clickable for
 * vetoable reasons since step 3). Narrower than the restore seam's 12px —
 * the veto toggle is a smaller decision than restoring a user's own cut —
 * and one level BELOW it (zIndex 3 vs 4): where a user's applied cut and a
 * pipeline removal coincide, the actionable Restore must win the pointer.
 * `cursor: pointer` is added per-seam at the call site, only when the seam
 * actually takes a click (`user`/`clip` seams remain hover disclosures). */
/** The removal marker lane (field report 2026-08-26): one row above the
 * ruler, inside the zoom-width content so chips scroll and zoom with the
 * track. Height fits one chip row; coincident chips fan out horizontally. */
const markerLane: React.CSSProperties = {
  position: "relative",
  height: 22,
  marginBottom: 2,
};

/** One removal as a labelled chip — reason-coloured border and tint at the
 * call site (filled = will be removed; dashed hollow = kept). The label IS
 * the marker, so it stays small, mono, and truncates rather than wraps. */
const markerChip: React.CSSProperties = {
  position: "absolute",
  top: 2,
  height: 16,
  display: "flex",
  alignItems: "center",
  padding: "0 6px",
  borderRadius: 4,
  fontSize: 10,
  lineHeight: "16px",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  whiteSpace: "nowrap",
  maxWidth: 140,
  overflow: "hidden",
  textOverflow: "ellipsis",
  userSelect: "none",
};

/** The sound lane's own colour — a family of its own, deliberately not the
 * playhead's yellow, the cut's red, or the kept band's violet: an effect is
 * neither a time, a removal, nor a revival. */
const SFX_COLOR = "#4ECDC4";

/** The SFX row (Phase 4), above the ruler and inside the zoom-width content so
 * the diamonds scroll and zoom with the track — the removal lane's shape at
 * half its height, because a diamond carries no label. */
const sfxLane: React.CSSProperties = {
  position: "relative",
  height: 14,
  marginBottom: 2,
};

/** The clickable/draggable zone around a diamond — wider than the paint, the
 * "wide hit / thin paint" split `playheadGrab` and the cut seam both use. */
const sfxMarkerHit: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 14,
  marginLeft: -7,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

/** The mark itself: a small square rotated 45°, which is the marker shape
 * every NLE uses for an INSTANT (as opposed to the chips' spans). */
const sfxDiamond: React.CSSProperties = {
  width: 8,
  height: 8,
  transform: "rotate(45deg)",
  borderRadius: 1,
  pointerEvents: "none",
};

/** Under a KEPT chip, the span the revived material now occupies on the live
 * clock — a thin underline at the lane's floor, so "this stretch is back in
 * the video" reads spatially, not just as a chip state. */
const keptBand: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  height: 0,
  borderBottom: "2px dotted",
  opacity: 0.6,
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
