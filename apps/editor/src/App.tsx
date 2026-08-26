import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { transportReduce, type TransportKey } from "./transport";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import {
  applyCaptionEdits,
  applyCaptionRangeEdits,
  applyCaptionWordHides,
  applyCaptionLineTiming,
  applyOverrides,
  dropHiddenCues,
  splitThenDropHidden,
  fillPlainCues,
  splitCues,
  atSplitPoints,
  resolveSplitPoints,
  carveKeptTakes,
  dismissedRemovals,
  vetoedRemovals,
  resolveTheme,
  defaultTheme,
  cutRangeToOldClock,
  livePreviewMap,
  mapFromKeptSpans,
  mapsClose,
  previewClockMappers,
  retimeForPreview,
  type AppliedCaptionEdits,
  type LivePreviewClocks,
  type TimeMap,
  type CaptionKeyMigration,
  type OverrideDoc,
  type SceneCue,
  type Segment,
  type Theme,
} from "@ossclip/core/browser";
import { useEdits } from "./useEdits";
import { Overlay, type GraphicPreview, type Selection, type VideoPreview } from "./Overlay";
import { Inspector, type RunInfo } from "./Inspector";
import { Timeline } from "./Timeline";
import { TranscriptPanel } from "./TranscriptPanel";
import { ShortcutsModal } from "./ShortcutsModal";
import { DeleteSceneModal } from "./DeleteSceneModal";
import type { DeletePlan } from "./deleteScene";
import { DeleteWordsModal } from "./DeleteWordsModal";
import type { DeleteWordsPlan } from "./deleteWords";
import { ProjectPicker } from "./ProjectPicker";
import { RenderModal } from "./RenderModal";
import { ThumbnailPanel } from "./ThumbnailPanel";
import { CleanupPanel } from "./CleanupPanel";
import { YoutubePanel } from "./YoutubePanel";
import { CoverPanel } from "./CoverPanel";
import { PublishPanel } from "./PublishPanel";
import {
  formatElapsed,
  pinnedInfoLines,
  renderCompleteReload,
  renderProgress,
  resumedRenderStateApplies,
  resumeRenderState,
  type RenderState,
} from "./renderStatus";
import { onSaveEffect } from "./save";
import { ghostCues as computeGhostCues } from "./ghosts";
import {
  anchorCaptionLines,
  droppedEditNotices,
  droppedHideNotices,
  droppedRangeNotices,
  droppedLineTimingNotices,
  migrateLoadedDoc,
  migrationLossNotices,
  renderLossNotices,
  sourceKeyedCaptionEdits,
  vanishedCaptionEdits,
} from "./captionAnchors";

/**
 * `<Player>`'s generics require `Props extends Record<string, unknown>`, and
 * a plain `interface` (like `ProductionCompProps`) has no index signature, so
 * TS's generic-constraint check rejects it outright ("Index signature for
 * type 'string' is missing") even though every property IS a string key.
 * Intersecting with `Record<string, unknown>` gives the type checker an
 * actual index signature to see, without changing the runtime shape.
 */
type PlayerProductionProps = ProductionCompProps & Record<string, unknown>;

/**
 * The raw `render-props.json` shape the server hands back. `sceneCues` and
 * `theme` there are already override-applied (`produce` bakes the CURRENT
 * `overrides.json` into them before writing, so the actual render matches
 * what was on screen when it ran) — but that means using them as the base
 * for a SECOND round of `applyOverrides` merges the user's edits onto their
 * own already-merged output, which is add-only: a reset/un-pin/undo has
 * nothing to fall back TO and renders as if it never happened. `produce`
 * additionally writes the PRISTINE, pre-override cues/theme under these two
 * keys so the editor always has a clean base to re-apply the CURRENT
 * override doc to, however it's changed since the last `produce` run.
 * Optional so older workdirs (produced before this existed) still load —
 * they just fall back to the old (occasionally-lying) behaviour.
 */
type RawRenderProps = PlayerProductionProps & {
  baseSceneCues?: SceneCue[];
  baseTheme?: Theme;
  /** Pre-edit caption lines, mirroring `baseSceneCues` — the base the caption
   * retype layer merges onto (merging onto already-edited lines would trip
   * every edit's own stale-guard). */
  baseCaptionLines?: PlayerProductionProps["captionLines"];
  /** The flag-only part of the captions switch: true only when the last
   * produce was typed with `--no-captions`. The baked `captionsHidden` in
   * these props is the RESOLVED value (flag OR override doc) — the same
   * already-merged shape the pristine bases above exist to escape — so the
   * live memo recomposes from this plus the CURRENT doc instead: an
   * un-toggle can take a doc-sourced hide back, while a flag-sourced hide
   * stays hidden in the preview exactly as the command.json pin will render
   * it. */
  captionsHiddenByFlag?: boolean;
};

/**
 * The one gate every `render-props.json` the editor accepts passes through
 * (§137). Caption edits are keyed by the word's SOURCE start, and this file
 * predates that field — so a workdir produced before the change loads with
 * words nothing can address: `applyCaptionEdits` skips them and a retype
 * appears to work, then silently reverts. `anchorCaptionLines` recovers the
 * anchor from the file's own `spans` (and declines to invent one when there
 * are none — see its doc comment).
 *
 * Applied at the FETCH, not in the `live` memo below, deliberately: the memo
 * is not the only reader — the Transcript panel takes the same lines
 * (`baseCaptionLines ?? captionLines`) straight off `renderProps`, and a
 * repair applied in one place and not the other is how the two panes would
 * disagree about which word an edit belongs to.
 */
const anchored = (props: RawRenderProps): RawRenderProps => ({
  ...props,
  ...anchorCaptionLines(props),
});

/**
 * The DURABLE half of the disclosure for a caption edit the migration could
 * not place (§137 Task 6 review, Important 5).
 *
 * The banner is dismissible and the editor's Save writes `overrides.json` with
 * no `.bak` (`edit.ts`'s PUT handler, unlike produce's own write), so a
 * dismissed banner used to be the ONLY record of an edit that the next ⌘S then
 * deleted from disk for good. `migrateLoadedDoc` no longer strips those edits
 * from the doc, which is what actually closed that (final review, Important
 * 5) — a save round-trips them now. This stays regardless: the console keeps
 * the raw entry, ORIGINAL KEY AND REASON INCLUDED, which is what someone would
 * need to place it by hand, and it survives the banner being dismissed.
 *
 * Not `setError`: this is not fatal, and the banner is the user-facing half.
 */
const reportCaptionMigrationLoss = (unresolved: CaptionKeyMigration["unresolved"]): void => {
  const lines = migrationLossNotices(unresolved);
  unresolved.forEach((u, i) => {
    console.warn(`ossclip §137: dropped caption edit ${JSON.stringify(u)} — ${lines[i]}`);
  });
};

export const App: React.FC = () => {
  const edits = useEdits();
  // Finding 2, PLAN 2026-08-04 Task 4c fix wave: `beginRenderPoll` below is a
  // STABLE `useCallback` (created once at mount) that needs to read the
  // LIVE `edits.dirty` at the moment a render finishes, not whatever it was
  // when the callback was created — the exact stale-closure shape R16 §73
  // already burned this file on once (the ⌘+scroll zoom listener that read
  // a ref for the same reason). Updated every render, read only inside the
  // poll's success branch.
  const editsDirtyRef = useRef(edits.dirty);
  editsDirtyRef.current = edits.dirty;
  // Shown once, after a Render, ONLY when it discarded local edits made
  // while it ran (Finding 2's decided resolution: reload from produce's own
  // write-back unconditionally, but say so out loud when that reload threw
  // something away rather than silently losing it).
  const [dirtyDiscardedNotice, setDirtyDiscardedNotice] = useState(false);
  // A Save (button or ⌘S) that landed while a render was running (Finding 1,
  // PLAN 2026-08-04 fix wave; scoped re-review). Dismissible and non-fatal —
  // `onSaveEffect`'s own doc comment (save.ts) has the full reasoning for why
  // this must never go through `setError`, which is the FATAL, full-screen
  // view below with no dismiss and no state reset.
  const [saveBlockedNotice, setSaveBlockedNotice] = useState(false);
  // A render that REFUSED to start — the /api/render 400 (custom out inside
  // the folder input, 2026-08-18 field cascade), a 409/412, or the pre-start
  // save failing. The `saveBlockedNotice` posture, and for its reason: a
  // refusal is routine and the editor must stay usable after it, so this is
  // a dismissible banner, never `setError`'s FATAL full-screen view. A
  // banner rather than an inline RenderModal error because the plain Render
  // button hits this path too, with no modal open to show anything in.
  const [renderRefusedNotice, setRenderRefusedNotice] = useState<string | null>(null);
  // A gesture the OLD clock cannot express (cut review step 4 follow-up,
  // WRITE direction): a ⌘B split or a cut aimed at REVIVED material — a
  // vetoed pause the last render cut away, so the moment has no old-clock
  // preimage for the doc's own time slots (`splits[].at`,
  // `cuts[].startSec/endSec` both speak the last render's output seconds).
  // Refused OUT LOUD rather than silently clamped to the seam — relocating a
  // user's split unasked is the silent-overwrite class the override doc
  // fights. Same posture as the two notices above, and for the same reason:
  // routine, dismissible, never `setError`'s fatal full-screen view.
  const [clockRefusedNotice, setClockRefusedNotice] = useState<string | null>(null);
  // Caption edits the §137 key migration could not place when this doc was
  // loaded. They are NOT in the doc any more (the migration reports rather
  // than guesses), so this state is the only record of them — set on every
  // load, including the reload a finished render triggers, so it never
  // describes the previous project.
  const [captionMigrationLoss, setCaptionMigrationLoss] = useState<
    CaptionKeyMigration["unresolved"]
  >([]);
  // Caption edits that were in the doc before a render and are not in the one
  // it reloaded (final review, Important 4). Separate state from the migration
  // losses above because it is a different event with a different sentence,
  // but rendered through the SAME banner: one place on screen answers "what
  // happened to my retypes?".
  const [renderCaptionLoss, setRenderCaptionLoss] = useState<string[]>([]);
  // The live caption map, for the render-completion diff. A ref for the same
  // reason `editsDirtyRef` above is one: `beginRenderPoll` is a stable
  // `useCallback` created at mount, so reading `edits.doc` through its closure
  // would compare the reloaded doc against the doc as it was when the editor
  // STARTED — the R16 §73 stale-closure shape this file has been burned on.
  const captionsRef = useRef(edits.doc.captions);
  captionsRef.current = edits.doc.captions;
  // The drop notice the user has dismissed, as the exact list they dismissed
  // (see `showDropNotice` below for why it is not a boolean).
  const [dismissedDrops, setDismissedDrops] = useState<string | null>(null);
  const [renderProps, setRenderProps] = useState<RawRenderProps | null>(null);
  // Run provenance/cost for the Inspector's no-selection view (R21 §104).
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  // Produce's labeled cutlist PROPOSAL (cut review steps 2+3) — read-only
  // display data, fetched per project open like `runInfo` above, NOT part of
  // `edits`: it is the pipeline's record of what it PROPOSED to remove; the
  // user's response to it lives in `edits.doc.cleanup` (the veto layer), and
  // the two only meet through `applyCleanupChoices`/`vetoedRemovals` — the
  // same pure functions produce renders with. Timeline draws it as
  // reason-coloured seams; CleanupPanel derives its per-reason checkboxes.
  const [cleanupCutlist, setCleanupCutlist] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  // A live, uncommitted framing tweak (PLAN Task B3): the stage drag and the
  // Inspector's zoom slider both write it, the live memo applies it last, and
  // it clears the moment the real patch lands in the edit layer.
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  // Open project (R17 §83): the picker shows when a bare `ossclip edit` has
  // no workdir yet (required — there is nothing behind it) or when the top
  // bar's Open button raises it to switch. `required` is derived: no loaded
  // production means nothing to dismiss back to.
  const [showPicker, setShowPicker] = useState(false);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [workdirPath, setWorkdirPath] = useState<string | null>(null);
  /** The workdir the LAST `/api/production` load ran against — a ref, not
   * state, because `loadProduction` has to read it inside its own async body
   * before the render that a `setState` would schedule. It exists solely so
   * the render-status resume can tell a mount from a project SWITCH
   * (`resumedRenderStateApplies`). */
  const loadedWorkdirRef = useRef<string | null>(null);
  // Render-from-the-editor (R11 Task 4): whether the server has a recorded
  // invocation to replay, and the in-flight run's state while it does.
  const [canRender, setCanRender] = useState(false);
  // The state shape lives in renderStatus.ts beside `resumeRenderState`,
  // which rebuilds it after a page reload — one definition, not a drifting
  // inline copy (2026-08-18).
  const [render, setRender] = useState<RenderState | null>(null);
  const [showRenderModal, setShowRenderModal] = useState(false);
  const [defaultOutPath, setDefaultOutPath] = useState<string | undefined>();
  const renderPollRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (renderPollRef.current !== null) window.clearInterval(renderPollRef.current);
    },
    [],
  );
  // Same lifecycle for the graphic-box transform (R11 Task 2).
  const [graphicPreview, setGraphicPreview] = useState<GraphicPreview | null>(null);
  const stageRef = useRef<HTMLDivElement>(null!);
  const playerRef = useRef<PlayerRef>(null);
  // The preview fills the stage area (R15 §55a): its size derives from the
  // container, not a constant — 380px was chosen when every clip was a 9:16
  // sliver, and left a landscape preview 214px tall on a 2000px window.
  const stageAreaRef = useRef<HTMLDivElement | null>(null);
  const stageResizeObsRef = useRef<ResizeObserver | null>(null);
  const [stageAvail, setStageAvail] = useState<{ w: number; h: number } | null>(null);
  // The stage area node, as STATE (R16 §73): the area does not exist until
  // the production has loaded (the loading/error returns render without it),
  // so anything attaching to it must re-run when it actually mounts. The
  // §55a ResizeObserver learned this through a callback ref; the view-zoom
  // wheel listener below still hung off a mount-time effect that ran against
  // null — which is why ⌘+scroll on the preview NEVER worked.
  const [stageAreaEl, setStageAreaEl] = useState<HTMLDivElement | null>(null);
  const stageAreaRefCb = useCallback((el: HTMLDivElement | null) => {
    stageAreaRef.current = el;
    setStageAreaEl(el);
    stageResizeObsRef.current?.disconnect();
    stageResizeObsRef.current = null;
    if (!el) return;
    const measure = () =>
      setStageAvail({
        w: Math.max(0, el.clientWidth - STAGE_PAD * 2),
        h: Math.max(0, el.clientHeight - STAGE_PAD * 2),
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    stageResizeObsRef.current = ro;
  }, []);
  // View zoom (§55b) — a LOOKING control, never an EDIT: it changes the
  // Player's actual rendered width inside the scrolling stage area, so the
  // Player's own getScale() stays the one true page-px-per-composition-px
  // factor and every drag/handle keeps landing where it is dropped. (A CSS
  // transform on top of the Player would silently break that mapping.)
  const [viewZoom, setViewZoom] = useState(1);
  const viewZoomRef = useRef(viewZoom);
  viewZoomRef.current = viewZoom;
  const viewAnchorRef = useRef<{
    prev: number;
    ax: number;
    ay: number;
    sl: number;
    st: number;
  } | null>(null);
  const applyViewZoom = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const el = stageAreaRef.current;
    // Below 1 is allowed (R17 §82): shrinking under the fitted size gives
    // room to see the whole frame small and pan/arrange around it.
    const clamped = Math.min(8, Math.max(0.25, next));
    const prev = viewZoomRef.current;
    if (el && clamped !== prev) {
      const r = el.getBoundingClientRect();
      viewAnchorRef.current = {
        prev,
        ax: (anchor?.x ?? r.left + r.width / 2) - r.left,
        ay: (anchor?.y ?? r.top + r.height / 2) - r.top,
        sl: el.scrollLeft,
        st: el.scrollTop,
      };
    }
    setViewZoom(clamped);
  }, []);
  // Applied AFTER the wider player has rendered — scrollLeft set before that
  // clamps against the old content size (the R14 §53 lesson, same shape).
  useLayoutEffect(() => {
    const el = stageAreaRef.current;
    const a = viewAnchorRef.current;
    if (!el || !a) return;
    viewAnchorRef.current = null;
    const ratio = viewZoom / a.prev;
    el.scrollLeft = (a.sl + a.ax) * ratio - a.ax;
    el.scrollTop = (a.st + a.ay) * ratio - a.ay;
  }, [viewZoom]);
  // Ctrl/cmd+wheel zooms the VIEW about the cursor — the same gesture the
  // timeline already owns, and native+non-passive for the same reason (a
  // passive listener cannot preventDefault the browser's pinch-zoom).
  // Depends on the ELEMENT STATE, not the ref (§73): keyed on the ref, this
  // ran once during the loading screen, attached to nothing, and the
  // shortcut was dead in every session.
  useEffect(() => {
    const el = stageAreaEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      applyViewZoom(viewZoomRef.current * Math.exp(-e.deltaY * 0.01), {
        x: e.clientX,
        y: e.clientY,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageAreaEl, applyViewZoom]);
  // Alt-drag (or middle-drag) pans the magnified view. The Overlay ignores
  // Alt/middle presses entirely, so the split with EDIT drags is a modifier,
  // not a guess — a plain drag still edits, and only a plain drag does.
  const viewPanRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const pan = viewPanRef.current;
      const el = stageAreaRef.current;
      if (!pan || !el) return;
      el.scrollLeft = pan.sl - (e.clientX - pan.x);
      el.scrollTop = pan.st - (e.clientY - pan.y);
    };
    const onUp = () => {
      viewPanRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  // The transcript view (R15 §59) — a panel, toggled from the top bar. Its
  // width is draggable via the divider (R16 §65) and remembered across
  // sessions; the stage's ResizeObserver refits the preview as it moves.
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptWidth, setTranscriptWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(TRANSCRIPT_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampTranscriptWidth(stored) : 300;
  });
  const dividerDragRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dividerDragRef.current;
      if (!drag) return;
      setTranscriptWidth(clampTranscriptWidth(drag.startW + (e.clientX - drag.startX)));
    };
    const onUp = () => {
      if (!dividerDragRef.current) return;
      dividerDragRef.current = null;
      setTranscriptWidth((w) => {
        window.localStorage.setItem(TRANSCRIPT_WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  // The keybinds reference (R16 §63) — "?" or the top-bar button.
  const [showShortcuts, setShowShortcuts] = useState(false);
  // The AI thumbnail panel (2026-08-17). Not part of useEdits/overrides on
  // purpose: the thumbnail round-trips through the workdir's approval file
  // (thumbnail-concept-approved.json — the contract the CLI's thumbnailStep
  // honors on replay), not overrides.json, so the panel talks to its own
  // endpoints and owns no doc state (see ThumbnailPanel.tsx).
  const [showThumbnail, setShowThumbnail] = useState(false);
  // The SEO pack panel (2026-08-17) — the same approval-file posture, aimed
  // at youtube-pack-approved.json (see YoutubePanel.tsx). Both panels open
  // from the ONE "YouTube ▾" top-bar menu; the menu renders even when both
  // are unavailable — each panel explains its own state, which is simpler
  // than the top bar second-guessing two availability calls.
  const [showYoutubeSeo, setShowYoutubeSeo] = useState(false);
  const [showYoutubeMenu, setShowYoutubeMenu] = useState(false);
  // The cover panel (2026-08-19) — same posture again, aimed at the workdir's
  // cover.json (see CoverPanel.tsx). Its OWN top-bar button, deliberately not
  // an item in the YouTube menu: a cover is written on every produce whether
  // or not --youtube ran, and filing it under YouTube would tell users it
  // belongs to a feature they may never turn on.
  const [showCover, setShowCover] = useState(false);
  // The publish panel (2026-08-26) — server-owned state like the three
  // panels above (see PublishPanel.tsx / /api/publish in edit.ts). Its own
  // top-bar button, not a YouTube-menu item: it posts to EVERY connected
  // platform, and filing it under YouTube would say otherwise.
  const [showPublish, setShowPublish] = useState(false);
  // The cleanup review panel (cut review step 3) — UNLIKE the three panels
  // above it edits the overrides doc (cleanup.reasons through useEdits), so
  // undo/redo/dirty/save all apply to its checkboxes; only the open/closed
  // state lives here.
  const [showCleanup, setShowCleanup] = useState(false);
  useEffect(() => {
    if (!showYoutubeMenu) return;
    // Esc closes the menu the way it closes the panels (capture-phase, so
    // the app-level shortcuts under it never see the press).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowYoutubeMenu(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [showYoutubeMenu]);
  // The pending Delete/Backspace confirmation (§139), or null. The PLAN is
  // held, not the scene id: it was computed against the doc at the moment the
  // key was pressed, and re-deriving it on every render would let an
  // undo landing behind the open dialog change which options it is offering.
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
  // The transcript's pending word-delete confirmation (§59b revisited) —
  // the PLAN is held for the same reason as `deletePlan` above: it was
  // computed against the doc at the gesture, and re-deriving it per render
  // would let an undo behind the open dialog change its options.
  const [deleteWordsPlan, setDeleteWordsPlan] = useState<DeleteWordsPlan | null>(null);
  // Render log visibility (R17 §84): the status row always shows; the pinned
  // lines and the scrollable tail collapse behind the chevron.
  const [logsOpen, setLogsOpen] = useState(true);

  // J/K/L transport (PLAN Task 2): the reducer owns the ladder; this owns the
  // side effects. `playing` is the Player's own event-mirrored state, so the
  // reducer always sees the transport as it actually is.
  const onTransport = useCallback(
    (key: TransportKey) => {
      const next = transportReduce({ rate, playing }, key);
      setRate(next.rate);
      const player = playerRef.current;
      if (!player) return;
      if (next.playing && !playing) player.play();
      if (!next.playing && playing) player.pause();
    },
    [rate, playing],
  );

  // Mirror the Player's transport state onto the stage as `data-playing`.
  // This is the PLAYER's intent, straight from its own play/pause events —
  // the honest observable for "did that click/keystroke toggle playback",
  // independent of whether the environment's browser can even decode the
  // preview media (the e2e's headless Chromium ships no H.264).
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
    // Re-attach once the Player has mounted (playerRef fills after the first
    // render that has props).
  });

  // The poll loop, shared by the Render button and the mount-time resume
  // (R16 §60): one interval, guarded so a double start can't stack two.
  const beginRenderPoll = useCallback(() => {
    if (renderPollRef.current !== null) return;
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const s = await fetch("/api/render/status");
          const body = (await s.json()) as {
            running: boolean;
            exitCode: number | null;
            lines?: string[];
            startedAt?: number | null;
            cancelled?: boolean;
          };
          if (body.running || body.exitCode === null) {
            // The server's spawn stamp wins — it survives a page reload,
            // where an optimistic Date.now() would restart at 0:00.
            setRender((prev) => ({
              running: body.running,
              lines: body.lines ?? [],
              startedAt: body.startedAt ?? prev?.startedAt,
            }));
            return;
          }
          if (renderPollRef.current !== null) {
            window.clearInterval(renderPollRef.current);
            renderPollRef.current = null;
          }
          if (body.exitCode === 0) {
            const p = await fetch("/api/production");
            const prod = (await p.json()) as {
              renderProps: RawRenderProps;
              overrides?: OverrideDoc;
              canRender?: boolean;
            };
            const props = anchored(prod.renderProps);
            setRenderProps(props);
            setCanRender(Boolean(prod.canRender));
            // Finding 2, PLAN 2026-08-04 Task 4c fix wave — see
            // `renderCompleteReload`'s own doc comment (renderStatus.ts) for
            // the full reasoning; this is the thin I/O wrapper around that
            // pure decision. `edits.load` is the SAME reload path
            // mount/project-switch already use.
            const reload = renderCompleteReload(prod.overrides, editsDirtyRef.current);
            if (reload.load) {
              // §137: the doc `produce` just wrote back can still be
              // positionally keyed — a produce that migrated nothing writes
              // back only its cut/split re-anchoring — so this reload needs
              // the same migration the mount path does, against the props it
              // just re-read.
              const before = captionsRef.current;
              const migrated = migrateLoadedDoc(reload.load, props);
              edits.load(migrated.doc);
              reportCaptionMigrationLoss(migrated.unresolved);
              setCaptionMigrationLoss(migrated.unresolved);
              // The one moment the editor adopts a doc it did not write
              // (final review, Important 4). The run log survives below now
              // (2026-08-18), but a produce-dropped retype is still buried
              // mid-scroll in it, and the doc arriving here is already clean
              // — so `unresolved` and `dropped` are both empty and a missing
              // retype would otherwise vanish from the transcript with
              // nothing said. Diffed by CONTENT, so a successful re-key is
              // not mistaken for a loss.
              const lost = renderLossNotices(vanishedCaptionEdits(before, migrated.doc.captions));
              // Durable alongside the banner, exactly like the migration
              // losses: the banner is dismissible, a console line is not.
              for (const l of lost) console.warn(`ossclip §137: ${l}`);
              setRenderCaptionLoss(lost);
            } else {
              // No doc came back, so nothing was migrated — and a list left
              // over from the PREVIOUS load would now be describing a doc the
              // editor no longer holds (§137 Task 6 review, Minor 6).
              setCaptionMigrationLoss([]);
              setRenderCaptionLoss([]);
            }
            if (reload.notifyDiscard) setDirtyDiscardedNotice(true);
            // The panel STAYS, flipped to the success row (2026-08-18):
            // `setRender(null)` here dropped the run log — provider, cost,
            // any §137 drop it named — the instant the render landed.
            // `finishedAt` stamps the elapsed clock's END; rendering it from
            // Date.now() would keep counting long after the run stopped.
            setRender((prev) => ({
              running: false,
              lines: body.lines ?? [],
              succeeded: true,
              startedAt: body.startedAt ?? prev?.startedAt,
              finishedAt: Date.now(),
            }));
            // The user asked for the output's folder to open when the render
            // lands. Fire-and-forget: a 404/412 (nothing recorded, file
            // moved) is silently fine — reveal is a courtesy, not a step.
            // LIVE completions only, structurally: the reload-resumed
            // terminal state never enters this poll branch (`resumed`'s doc,
            // renderStatus.ts).
            void fetch("/api/reveal-output", { method: "POST" }).catch(() => {});
          } else {
            setRender({
              running: false,
              lines: body.lines ?? [],
              failed: body.exitCode,
              cancelled: body.cancelled,
            });
          }
        } catch {
          // Bundled fix (PLAN 2026-08-04 fix wave, scoped re-review — same
          // root as the Save guard above): this used to claim "keep
          // polling; the interval survives" unconditionally, but the
          // interval is cleared ABOVE the moment an exit is detected — a
          // tick that gets that far and then throws (the follow-up
          // `fetch("/api/production")`, not the render-status check just
          // above it) lands here with NO interval left running. Left
          // alone, `render` stuck at whatever the last successful tick
          // reported (`{running: true}`) used to just be a stale progress
          // panel; now that Save refuses while `render?.running`, it is a
          // PERMANENT save lockout with no way out but a reload that
          // discards the in-memory doc — exactly the failure mode the
          // guard above exists to prevent, reintroduced by a different
          // route. `edit.ts`'s `renderExit` keeps reporting the same
          // completed exit code until the NEXT render starts, so simply
          // starting a new interval is a safe, self-healing retry: the
          // very next tick re-derives the same branch and tries the
          // reload again. When the interval is STILL running (the
          // render-status fetch itself threw), this really is the
          // transient case the old comment described, and doing nothing
          // is correct — the next tick retries on its own.
          if (renderPollRef.current === null) beginRenderPoll();
        }
      })();
    }, 1000);
    renderPollRef.current = poll;
    // `edits.load` closes over the mount-time hook object, same as
    // `loadProduction`'s identical pattern below — it only ever dispatches
    // through the reducer's stable `dispatch`, so the stale closure is
    // harmless and this callback can stay referentially stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The production load, shared by mount and every project switch (R17 §83).
  const loadProduction = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/production");
    if (!res.ok) throw new Error(`GET /api/production failed: ${res.status}`);
    const body = (await res.json()) as {
      renderProps?: RawRenderProps;
      overrides?: OverrideDoc;
      canRender?: boolean;
      defaultOutPath?: string;
      workdir?: string;
      noWorkdir?: boolean;
      recent?: string[];
    };
    if (body.defaultOutPath) setDefaultOutPath(body.defaultOutPath);
    setRecentProjects(body.recent ?? []);
    if (body.noWorkdir) {
      // Bare `ossclip edit` (R17 §83): no project open — the picker IS the
      // page until one is chosen. Any migration loss on screen belongs to the
      // project being left, so it goes with it (§137 Task 6 review, Minor 6).
      setCaptionMigrationLoss([]);
      setRenderCaptionLoss([]);
      setShowPicker(true);
      return;
    }
    const props = anchored(body.renderProps!);
    setRenderProps(props);
    const prevWorkdir = loadedWorkdirRef.current;
    const nextWorkdir = body.workdir ?? null;
    loadedWorkdirRef.current = nextWorkdir;
    setWorkdirPath(nextWorkdir);
    setCanRender(Boolean(body.canRender));
    // §137: a doc saved before this change keys caption edits by POSITION,
    // which any cut shifts — every one of them would silently revert on
    // screen. Upgraded here, against the just-anchored lines, because this is
    // the only place both halves exist at once (`migrateLoadedDoc`'s comment
    // has the full ordering argument, and why the server cannot do it).
    const migrated = migrateLoadedDoc(body.overrides!, props);
    edits.load(migrated.doc);
    reportCaptionMigrationLoss(migrated.unresolved);
    setCaptionMigrationLoss(migrated.unresolved);
    // A render-loss list belongs to the doc that was on screen when that
    // render finished; a fresh load (mount, or a project switch) is a
    // different doc, so it goes with the old one — same rule as the line
    // above (§137 Task 6 review, Minor 6).
    setRenderCaptionLoss([]);
    // Best-effort — the panel simply omits the section when this fails.
    void fetch("/api/usage")
      .then(async (r) => setRunInfo(r.ok ? ((await r.json()) as RunInfo) : null))
      .catch(() => setRunInfo(null));
    // Same posture for the labeled cutlist (cut review step 2): best-effort,
    // and any failure — endpoint missing, corrupt file — degrades to "no
    // removal seams", never an error state. The server already drops
    // individually-bad spans through SegmentSchema, so this trusts the shape.
    void fetch("/api/cleanup")
      .then(async (r) =>
        setCleanupCutlist(
          r.ok ? (((await r.json()) as { cutlist?: Segment[] }).cutlist ?? []) : [],
        ),
      )
      .catch(() => setCleanupCutlist([]));
    // Resume a render already in flight (R16 §60): a refresh used to
    // orphan the panel — the child kept rendering server-side with no
    // progress, no logs, and no way to cancel it from the UI. Since
    // 2026-08-18 a FINISHED run comes back too: the server keeps the last
    // run's ring buffer until the next render starts, and only restoring
    // the running case meant the reload you did to check on a render
    // reported nothing at all once it had ended. That ring buffer is exactly
    // why the resume must be refused on a project SWITCH — it outlives the
    // project it belongs to (`resumedRenderStateApplies` has the field case).
    const s = await fetch("/api/render/status");
    const status = (await s.json()) as {
      running: boolean;
      exitCode: number | null;
      lines?: string[];
      startedAt?: number | null;
      cancelled?: boolean;
    };
    const resumed = resumedRenderStateApplies(prevWorkdir, nextWorkdir)
      ? resumeRenderState(status)
      : null;
    if (resumed) {
      setRender(resumed);
      if (resumed.running) beginRenderPoll();
      // A terminal restore lands COLLAPSED: the row already summarizes the
      // outcome, and greeting a reload with a wall of an old run's log
      // would bury the editor it came back for. The chevron reopens it.
      else setLogsOpen(false);
    }
    // `edits.load` closes over the mount-time hook object, but it only
    // dispatches — the reducer instance is stable, so the stale closure is
    // harmless and the callback can stay referentially stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beginRenderPoll]);

  useEffect(() => {
    void loadProduction().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    // Load once on mount; the edit layer is applied live via `live` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch/open a project (R17 §83): POST the path, then reset everything
  // that belonged to the OLD project and load the new one. Returns an error
  // string for the picker to show, or null on success.
  const openProject = useCallback(
    async (path: string): Promise<string | null> => {
      // Switching abandons unsaved edits — the new overrides replace the doc
      // wholesale, so say so while there is still a way back.
      if (
        edits.dirty &&
        !window.confirm("Unsaved edits will be lost — switch projects anyway?")
      ) {
        return null;
      }
      try {
        const res = await fetch("/api/workdir", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) return body.error ?? `open failed: ${res.status}`;
        setSelection(null);
        setVideoPreview(null);
        setGraphicPreview(null);
        setRender(null);
        setViewZoom(1);
        setRenderProps(null);
        setShowPicker(false);
        await loadProduction();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits.dirty, loadProduction],
  );

  // The retyped caption words, applied once (§137). Hoisted out of the `live`
  // memo below because `dropped` has to LEAVE this function: the old code
  // called `applyCaptionEdits(...).lines` inline and discarded the report,
  // which is precisely why an edit that could not be anchored just reverted
  // in front of the user with nothing said.
  const appliedCaptions = useMemo<AppliedCaptionEdits>(() => {
    // Nothing loaded yet is not "every edit is stale" — reporting against no
    // lines at all would flash a drop notice for the whole doc between the
    // fetch and the first render.
    if (!renderProps) return { lines: [], dropped: [] };
    const base = renderProps.baseCaptionLines ?? renderProps.captionLines ?? [];
    // SOURCE-KEYED ONLY. The doc keeps the edits the load-time migration could
    // not place (final review, Important 5) and their keys are POSITIONS,
    // which address no word — passing them here would report each one as "no
    // word in this cut sits at that moment any more" on every render, which is
    // both the wrong diagnosis and a second banner for something the migration
    // notice already named.
    return applyCaptionEdits(base, sourceKeyedCaptionEdits(edits.doc.captions));
  }, [renderProps, edits.doc.captions]);

  // The RANGE layer, on top of the per-word retypes — `applyCaptionLayers`'
  // order, still composed manually here (the legacy-key filtering above is
  // why the composer can't be handed the doc whole). This intermediate —
  // post-range, PRE-hide — is what the Transcript panel renders: range edits
  // change word COUNT, so a panel fed pre-range lines would have flat
  // indices and text that diverge from the run the user just typed, while a
  // hidden word must still render struck-through (the pre-hide rule below).
  const appliedCaptionRanges = useMemo<AppliedCaptionEdits>(() => {
    // The same null-props guard as `appliedCaptions`, for the same reason:
    // nothing loaded yet is not "every rewrite is stale" — during a project
    // switch the OLD doc is still in state while `renderProps` is null, and
    // running the layer against zero lines would report every entry
    // `found: null`: a false whole-doc drop-banner flash.
    if (!renderProps) return { lines: [], dropped: [] };
    return applyCaptionRangeEdits(appliedCaptions.lines, edits.doc.captionRangeEdits);
  }, [renderProps, appliedCaptions, edits.doc.captionRangeEdits]);

  // The hide layer, applied ON TOP of the rewritten lines — `applyCaptionLayers`'
  // one authoritative order (edits → ranges → hides), composed manually here
  // rather than through the composer for two reasons: the edits layer must be
  // the SOURCE-KEYED subset (the legacy-key filtering `appliedCaptions`
  // explains above, which a doc handed whole to the composer would bypass),
  // and the transcript needs the intermediate PRE-hide lines, which the
  // composer does not return. The order itself is load-bearing: a hide's
  // `was` records the LIVE post-retype text the user saw when they deleted
  // the word, so hides run after retypes or every hide on a retyped word
  // would stale against the base text.
  const appliedCaptionHides = useMemo<AppliedCaptionEdits>(() => {
    // `appliedCaptionRanges`' null-props guard, one layer down — a hide
    // reported against no lines at all is the same false drop flash.
    if (!renderProps) return { lines: [], dropped: [] };
    return applyCaptionWordHides(appliedCaptionRanges.lines, edits.doc.captionWordsHidden);
  }, [renderProps, appliedCaptionRanges, edits.doc.captionWordsHidden]);

  // The LINE TIMING layer, LAST — `applyCaptionLayers`' order (edits → ranges
  // → hides → line timing): it moves the SEAMS between surviving lines, so it
  // runs on the post-hide lines (a hide can re-base a line's window or remove
  // the line outright). The Transcript panel keeps receiving the post-range/
  // PRE-hide lines above; it reads `edits.doc.captionLineTiming` itself for
  // the timing UI, so this memo feeds only the Player and the drop banner.
  const appliedCaptionTiming = useMemo<AppliedCaptionEdits>(() => {
    // The same null-props guard as the three layers above, for the same
    // reason: nothing loaded yet is not "every nudge is stale" — reporting
    // against zero lines would flash a false whole-doc drop banner.
    if (!renderProps) return { lines: [], dropped: [] };
    return applyCaptionLineTiming(appliedCaptionHides.lines, edits.doc.captionLineTiming);
  }, [renderProps, appliedCaptionHides, edits.doc.captionLineTiming]);

  // Both halves of what the user is owed about caption edits: the ones the
  // load-time key migration could not place (an event, held in state) and the
  // ones that do not fit the lines on screen (a live property of the doc).
  const migrationLossLines = useMemo(
    () => migrationLossNotices(captionMigrationLoss),
    [captionMigrationLoss],
  );
  const droppedEditLines = useMemo(
    // All three caption layers' reports through the one dismissible banner —
    // a range rewrite or hide that could not land is the same silent-revert
    // failure §137 removed for retypes, each with its own phrasing because
    // the fix gesture differs (retype / re-select and Edit / re-select and
    // hide).
    () => [
      ...droppedEditNotices(appliedCaptions.dropped),
      ...droppedRangeNotices(appliedCaptionRanges.dropped),
      ...droppedHideNotices(appliedCaptionHides.dropped),
      ...droppedLineTimingNotices(appliedCaptionTiming.dropped),
    ],
    [appliedCaptions, appliedCaptionRanges, appliedCaptionHides, appliedCaptionTiming],
  );
  // The dismissal is aimed at ONE list, not at the notice forever: a later,
  // DIFFERENT drop raises it again. Held as the dismissed list itself rather
  // than a boolean for exactly that (§137 Task 6 review, Important 4 — a
  // `duplicate-anchor` entry cannot be cleared by retyping, so a
  // non-dismissible banner can strand a user permanently).
  const dropNoticeSignature = droppedEditLines.join("\n");
  const showDropNotice = droppedEditLines.length > 0 && dropNoticeSignature !== dismissedDrops;
  // Durable alongside the banner, same reasoning as the migration losses: the
  // banner can be dismissed, the log cannot. Keyed on the signature so it says
  // each distinct set once rather than on every render.
  useEffect(() => {
    if (droppedEditLines.length === 0) return;
    for (const line of droppedEditLines) console.warn(`ossclip §137: ${line}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropNoticeSignature]);

  // The live clock (cut review step 4): non-null exactly when the user's
  // cleanup vetoes actually change the timeline — `livePreviewMap` owns the
  // gate (empty choices, a veto already baked into these render-props, and a
  // degenerate proposal all answer null), and null means the `live` memo
  // below hands its props through UNTOUCHED, the regression anchor. The
  // clocks are produce's own functions end to end (`applyCleanupChoices` +
  // `subtractRangesFromCutlist` + `TimeMap`), so the preview's re-cut and
  // the next render's cannot drift.
  const liveRecut = useMemo<LivePreviewClocks | null>(() => {
    if (!renderProps) return null;
    return livePreviewMap(
      cleanupCutlist,
      edits.doc.cleanup,
      edits.doc.cuts,
      renderProps.spans ?? [],
    );
  }, [renderProps, cleanupCutlist, edits.doc.cleanup, edits.doc.cuts]);

  // The two clocks as POINT mappers (step 4 follow-up): `retimeForPreview`
  // below moves the player's PROPS onto the new clock in one batch, but three
  // surfaces still spoke single instants against the OLD one — the
  // transcript's word times, the ghost cues' windows, and the cover panel's
  // playhead — each offset by exactly the revived seconds before it while a
  // veto was live. One derivation, threaded as plain functions, so no
  // consumer learns the recut machinery; identity (literally `(sec) => sec`)
  // whenever `liveRecut` is null, the same regression anchor as the memo
  // below — a session with no veto computes bit-identical values to before.
  const clock = useMemo(() => {
    // The identity case still needs live-output → SOURCE for ⌘B's
    // `splits[].src` dual-write (SplitSchema's anchor): with no veto live
    // the player's clock IS the last render's, and its spans define the
    // conversion exactly. Guarded — malformed spans degrade to at-only
    // splits, never a thrown clock.
    let identityToSource: ((sec: number) => number) | undefined;
    try {
      const spans = renderProps?.spans ?? [];
      if (spans.length > 0) {
        const m = mapFromKeptSpans(spans);
        identityToSource = (sec: number) => m.toSource(sec);
      }
    } catch {
      identityToSource = undefined;
    }
    return previewClockMappers(liveRecut, { identityToSource });
  }, [liveRecut, renderProps]);

  // DECIDE (PLAN 2026-08-04 Task 4c, revised by cut review step 4): this
  // memo still never applies `edits.doc.cuts` — but the original refusal
  // gave two reasons, and only one survived. "The editor has no client-side
  // TimeMap to rebuild a post-cut version from" is RETIRED: `livePreviewMap`
  // above builds exactly that, and the retime at the bottom of this memo
  // plays cleanup vetoes live. "A second EDL implementation in the browser"
  // stays refused — the live clock is the SAME `applyCleanupChoices`/
  // `TimeMap`/`remapPoint` produce runs, imported from core, one
  // implementation with two callers. User cuts remain marked-not-applied
  // (the struck band, effective on the next produce/Render) for two reasons
  // of their own: a fresh cut's `src` is produce's alone to resolve (the
  // `cuts[].src` schema contract — the editor must never apply a cut whose
  // source range only produce can resolve), and a cut REMOVES content, which
  // the struck band already communicates honestly, while a veto RESTORES
  // content the mezzanine already has, so the player can honestly play it.
  const liveRetimed = useMemo<{ props: PlayerProductionProps; reports: string[] } | null>(() => {
    if (!renderProps) return null;
    // Always merge onto the PRISTINE base, never onto `renderProps.sceneCues`/
    // `theme` themselves — those are what `produce` actually rendered (its
    // own override-applied output), and merging the CURRENT override doc
    // onto an already-merged base can only ever add, never take back
    // something the user just reset/un-pinned/undid.
    // The base MUST be graphic-only (`baseSceneCues` is written that way):
    // the fill below derives the plain takes fresh each render, and feeding
    // an already-filled list back in would treat the old takes as occupied
    // windows. Old workdirs' `sceneCues` fallback predates the fill, so it
    // is graphic-only too.
    const baseCues = (renderProps.baseSceneCues ?? renderProps.sceneCues ?? []).filter(
      (c) => c.kind !== "plain",
    );
    const baseTheme = renderProps.baseTheme ?? renderProps.theme ?? defaultTheme;
    const { cues: graphicCues } = applyOverrides(baseCues, edits.doc);
    // Same sequence as `produce.ts`: overrides → split, then drop the deleted
    // scenes → fill the gaps with plain takes (a deleted scene's window
    // becomes an editable take — Task C's payoff for doing A first) → a
    // SECOND override pass so framing edits on take-* ids land on the cues
    // the fill just created. The second pass is a no-op on graphic cues (same
    // component ⇒ no swap ⇒ the prop merge is idempotent) — do not
    // "simplify" it away.
    // `splitThenDropHidden`, not a bare `dropHiddenCues`: applying a stored
    // split (R16 §61) BEFORE dropping hidden cues is what lets a hidden ROOT
    // id (a deleted split half) match only its OWN post-split segment,
    // instead of erasing the whole pre-split window — including the half a
    // split was about to carve off — before the split ever ran (PLAN
    // 2026-08-04 Task 1, bug 3: deleting one split half used to delete both).
    const { cues: visibleCues } = splitThenDropHidden(graphicCues, edits.doc);
    const filled = fillPlainCues(visibleCues, {
      outputDurationSec: renderProps.outputDurationSec,
      clipStarts: (renderProps.spans ?? []).map((s) => s.outIn),
    });
    // User splits (R16 §61) — after the fill so TAKES split like scenes did
    // above; a no-op here for scene ids, already split by
    // `splitThenDropHidden`. Before the final pass so edits on the
    // `id@<split id>` halves land (the suffix is the split's minted id, §137).
    // The extra dropHiddenCues below catches halves of a TAKE
    // the user deleted, whose id did not exist until the fill just ran.
    // Pass 1 of two (cut-review rework): old-clock splits — entries carrying
    // an `at`. Src-only splits (minted inside revived material) have no image
    // on this clock; they apply in the post-retime pass below.
    const splitted = splitCues(filled, atSplitPoints(edits.doc.splits));
    const { cues: mergedCues } = applyOverrides(splitted, edits.doc);
    const { cues } = dropHiddenCues(mergedCues, edits.doc);
    // The framing preview applies LAST, onto the fully-merged cue, so what
    // the Player shows mid-gesture is exactly what committing would store.
    let previewed = videoPreview
      ? cues.map((c) =>
          c.id === videoPreview.sceneId
            ? { ...c, video: { ...c.video, ...videoPreview.patch } }
            : c,
        )
      : cues;
    if (graphicPreview) {
      previewed = previewed.map((c) =>
        c.id === graphicPreview.sceneId ? { ...c, graphicRect: graphicPreview.rect } : c,
      );
    }
    const base: PlayerProductionProps = {
      ...renderProps,
      sceneCues: previewed,
      // POST-timing lines (post-hide until 2026-08-18): a caption-only word
      // hide or timing nudge previews instantly, unlike the cuts this memo
      // refuses to apply (the DECIDE note above) — both reshape nothing but
      // the caption stream itself, no EDL, no re-cut, so the browser can show
      // exactly what produce will render.
      captionLines: appliedCaptionTiming.lines,
      theme: resolveTheme(baseTheme, edits.doc),
      // Recomposed, never inherited from the spread above: the baked
      // `captionsHidden` has the LAST-saved doc merged in (add-only — an
      // un-toggle would have nothing to take it back), so the CURRENT doc
      // is OR-ed with the flag-only part instead. Same OR as produce's
      // `resolveCaptionsHidden`, with `captionsHiddenByFlag` standing in
      // for the flag (see RawRenderProps).
      captionsHidden:
        renderProps.captionsHiddenByFlag === true || edits.doc.captionsHidden === true,
      videoFileName: `/media/${renderProps.videoFileName}`,
    };
    // Cut review step 4, LAST — a final transform over the fully-merged
    // props, so every layer above (overrides, splits, fill, captions,
    // previews) keeps reasoning on the old clock it was written against and
    // only the finished result moves. `liveRecut === null` returns `base` as
    // built — identical in content to what this memo produced before step 4
    // existed, the regression anchor. When a veto is live, every output-timed
    // field remaps old-output → source → new-output (`retimeForPreview`'s
    // doc comment owns the field list and the punch/zoom reasoning), so the
    // player genuinely plays the revived material.
    // Cut-review rework (2026-08-26): the shared tail for both branches —
    // carve kept/dismissed removals into first-class `take-kept-*` blocks
    // (`carveKeptTakes`) and apply src-only splits (`resolveSplitPoints`,
    // minted by ⌘B inside revived material), on whichever clock the branch
    // is on: the live map under a veto, the spans-backed map once a veto is
    // BAKED into the render (livePreviewMap answers null then, but the doc's
    // kept/dismissed ranges and src splits are still live edits to show).
    // Nothing to do → the props pass through untouched, the regression
    // anchor both branches held before this existed.
    const finishOnClock = (
      props: PlayerProductionProps,
      priorReports: string[],
      clockMap: TimeMap | null,
    ): { props: PlayerProductionProps; reports: string[] } => {
      const keptRanges = vetoedRemovals(cleanupCutlist, edits.doc.cleanup).map((seg) => ({
        srcIn: seg.srcIn,
        srcOut: seg.srcOut,
      }));
      const dismissedRanges = dismissedRemovals(cleanupCutlist, edits.doc.cleanup).map((seg) => ({
        srcIn: seg.srcIn,
        srcOut: seg.srcOut,
        dismissed: true,
      }));
      const srcOnly = edits.doc.splits.filter((s) => s.at === undefined && s.src !== undefined);
      const ranges = [...keptRanges, ...dismissedRanges];
      if (clockMap === null || (ranges.length === 0 && srcOnly.length === 0)) {
        return { props, reports: priorReports };
      }
      const carved = carveKeptTakes(props.sceneCues ?? [], ranges, clockMap);
      const resolved = resolveSplitPoints(srcOnly, clockMap);
      const splitted2 = splitCues(carved.cues, resolved.points);
      // One more override pass so framing edits on `take-kept-*` (and on
      // src-split halves) preview live — idempotent on already-merged cues,
      // the memo's own documented property.
      const { cues: finalCues } = applyOverrides(splitted2, edits.doc);
      return {
        props: { ...props, sceneCues: finalCues },
        reports: [...priorReports, ...carved.reports, ...resolved.reports],
      };
    };
    const spansMap = (): TimeMap | null => {
      try {
        const spans = renderProps.spans ?? [];
        return spans.length > 0 ? mapFromKeptSpans(spans) : null;
      } catch {
        return null;
      }
    };
    if (!liveRecut) return finishOnClock(base, [], spansMap());
    const { fields, reports } = retimeForPreview(base, liveRecut.oldMap, liveRecut.newMap);
    return finishOnClock({ ...base, ...fields }, reports, liveRecut.newMap);
  }, [renderProps, edits.doc, videoPreview, graphicPreview, appliedCaptionTiming, liveRecut, cleanupCutlist]);
  const live = liveRetimed === null ? null : liveRetimed.props;

  // Feed the live cue list to the edit layer so `save()` can stamp each scene
  // override with its cue's anchor (handoff-edit-anchoring). THIS list, not
  // the raw base cues, because it includes split halves — the `id@<split id>`
  // cues are what the user's edits address — and it is exactly what the user
  // is looking at, which is the identity a stamp must record (never the disk's
  // possibly-newer plan; stampSceneAnchors' doc comment has the why).
  const liveCues = live?.sceneCues;
  useEffect(() => {
    if (liveCues) edits.syncCues(liveCues);
    // `liveCues` is a fresh array whenever `edits.doc` changes, so this still
    // re-runs per edit — harmless, `syncCues` only writes a stable ref. What
    // depending on the cues alone (not the fresh-every-render `edits` object)
    // prevents is re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCues]);

  // A retime report means a stored moment fell inside a NEWLY re-cut region
  // (only possible when a veto was retracted against already-vetoed render
  // props) and was snapped to the nearest kept edge — `remapPoint`'s
  // "nothing moves without saying so" rule, honoured here in the console the
  // way the §137 drop log is. Keyed on the joined signature so each distinct
  // set is said once, not on every render.
  const retimeReportSignature = (liveRetimed?.reports ?? []).join("\n");
  useEffect(() => {
    if (!liveRetimed || liveRetimed.reports.length === 0) return;
    for (const line of liveRetimed.reports) console.warn(`ossclip cut preview: ${line}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retimeReportSignature]);

  // Playhead continuity across a clock change (cut review step 4): the
  // player's current frame is an OLD-clock output time the moment a veto
  // toggles — past a revived pause it names a different source instant, and
  // it can even exceed the new duration when a veto is retracted. Mapping it
  // through the same old → source → new path the props took keeps the user's
  // position on the SAME MATERIAL instead of jumping wildly — the difference
  // between "preview" and "glitch". The ref pairs the map with the
  // renderProps it belongs to: a project switch or a render-complete reload
  // is a NEW timeline, not a re-cut of the old one, and must not seek.
  const playheadClockRef = useRef<{ props: RawRenderProps; map: TimeMap } | null>(null);
  useEffect(() => {
    if (!renderProps) {
      playheadClockRef.current = null;
      return;
    }
    const nextMap = liveRecut ? liveRecut.newMap : mapFromKeptSpans(renderProps.spans ?? []);
    const prev = playheadClockRef.current;
    playheadClockRef.current = { props: renderProps, map: nextMap };
    if (!prev || prev.props !== renderProps) return;
    // The same float-tolerant "did it actually change" as `livePreviewMap`'s
    // identity gate — a re-derived but equal map must not seek the player.
    if (mapsClose(prev.map, nextMap, 1e-6)) return;
    const player = playerRef.current;
    if (!player) return;
    const fps = renderProps.settings.fps;
    const src = prev.map.toSource(player.getCurrentFrame() / fps);
    // A playhead inside a re-cut region snaps to the nearest kept edge —
    // `toOutputClamped`'s documented role, the same fallback `remapPoint`
    // gives the props themselves.
    const out = nextMap.toOutput(src) ?? nextMap.toOutputClamped(src);
    player.seekTo(Math.round(out * fps));
  }, [liveRecut, renderProps]);

  const onSave = (): void => {
    // Finding 1, PLAN 2026-08-04 fix wave final review (scoped re-review
    // fixed a regression here — see `onSaveEffect`'s own doc comment,
    // save.ts, for the full reasoning): this is the thin I/O wrapper both
    // the Save button and ⌘S (Overlay.tsx) go through. `onBlocked` is a
    // dismissible notice, NEVER `setError` — that path is FATAL (the
    // full-screen view below).
    onSaveEffect({
      dirty: edits.dirty,
      renderRunning: render?.running === true,
      save: edits.save,
      onBlocked: () => setSaveBlockedNotice(true),
      onSaveError: (message) => setError(message),
    });
  };

  // Render (R11 Task 4.4): save first when dirty — a render of unsaved edits
  // is the trap worth designing out — then POST and poll. On success the new
  // renderProps swap in while the CURRENT override doc, undo history and
  // selection are all KEPT (no edits.load — the server's doc is exactly what
  // was just saved). On failure the log panel stays up with the tail.
  const onRender = useCallback(
    async (customOut?: string): Promise<void> => {
      try {
        if (edits.dirty) await edits.save();
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(customOut ? { out: customOut } : {}),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `render failed to start: ${res.status}`);
        }
        setRender({ running: true, lines: [], startedAt: Date.now() });
        // A NEW run opens its own log (§147). The collapse above this in
        // loadProduction is applied BY THE APP to a restored terminal run, and
        // without this it silently governed the next run too: click Render and
        // you got a spinner with no output, collapsed on behalf of a finished
        // run you had already dismissed. Collapse is per-run state, exactly as
        // the restore path's own comment argues — a fresh run is a fresh
        // context, and the chevron is still there to fold it away again.
        setLogsOpen(true);
        setRenderRefusedNotice(null);
        beginRenderPoll();
      } catch (err) {
        // Non-fatal by design (2026-08-18): the 400 the render endpoint
        // returns for an out inside the folder input used to route through
        // `setError` — the FATAL full-screen view — turning a refusal that
        // exists to PROTECT the project into a dead editor. The notice's own
        // doc comment (by its useState above) has the banner-vs-modal call.
        setRenderRefusedNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [edits, beginRenderPoll],
  );

  // Deleted scenes, at their override-applied timing — the Timeline draws
  // them as restorable ghosts (PLAN Task C5), and selecting one resolves to
  // this list so the Inspector can offer Restore even though the live cues
  // no longer contain it.
  const ghostCues = useMemo<SceneCue[]>(() => {
    if (!renderProps) return [];
    const baseCues = (renderProps.baseSceneCues ?? renderProps.sceneCues ?? []).filter(
      (c) => c.kind !== "plain",
    );
    // Finding 2, PLAN 2026-08-04 fix wave final review: `ghostCues`'s own
    // doc comment (ghosts.ts) has the full reasoning — this used to filter
    // for `hidden` on the PRE-split cues, so a hidden `id@<split id>` half (a
    // sanctioned gesture since Task 1) never matched anything and had no
    // ghost, no Restore, no way back but hand-editing overrides.json.
    // `clock.toLive` (step 4 follow-up): the base cues are old-clock times,
    // and the Timeline draws these bands on the live (possibly re-cut)
    // timeline — unmapped, every ghost past a revived pause sat the revived
    // seconds off its true window.
    return computeGhostCues(baseCues, edits.doc, clock.toLive);
  }, [renderProps, edits.doc, clock]);

  const selectedCue = useMemo(
    () =>
      selection
        ? live?.sceneCues.find((c) => c.id === selection.sceneId) ??
          ghostCues.find((c) => c.id === selection.sceneId) ??
          null
        : null,
    [live, selection, ghostCues],
  );

  // The words the selected cue is on screen FOR — "tracking transcript" as a
  // checkable fact rather than a claim (PLAN Task 6). Captions are the words
  // in output time, so the cue's window selects exactly its anchor text.
  const anchorText = useMemo(() => {
    if (!selectedCue || !live) return undefined;
    const words = live.captionLines
      .filter((l) => l.start < selectedCue.endSec && l.end > selectedCue.startSec)
      .flatMap((l) => l.words)
      .filter((w) => w.start < selectedCue.endSec && w.end > selectedCue.startSec)
      .map((w) => w.text);
    if (words.length === 0) return undefined;
    const joined = words.join(" ");
    return joined.length > 90 ? `${joined.slice(0, 90)}…` : joined;
  }, [selectedCue, live]);

  if (error) {
    return (
      <div style={shell}>
        <div style={{ padding: 24, color: "#FF5C5C", fontFamily: "ui-monospace, monospace" }}>
          Couldn't load the production: {error}
        </div>
      </div>
    );
  }

  if (!live) {
    // No production yet. Either a bare `ossclip edit` waiting on a project
    // choice (the picker is the page — nothing behind it to dismiss to), or
    // the ordinary load in flight.
    return (
      <div style={shell}>
        {showPicker ? (
          <ProjectPicker
            recent={recentProjects}
            required
            onOpen={openProject}
            onClose={() => {}}
          />
        ) : (
          <div style={{ padding: 24, color: "#9A9AA3" }}>Loading production…</div>
        )}
      </div>
    );
  }

  const aspect = live.settings.width / live.settings.height;
  // Fit to the available box, aspect-preserving, then magnified by the view
  // zoom. The floor keeps the preview usable while the window is being
  // dragged around; before the first measurement the old constant stands in.
  const fitW = stageAvail
    ? Math.max(220, Math.min(stageAvail.w, stageAvail.h * aspect))
    : 380;
  const playerW = Math.round(fitW * viewZoom);

  // ONE toggle, rendered inside whichever status row is up (2026-08-18): it
  // used to live inside the `render.running` row only, so a finished run's
  // log — the state that most needs re-reading — had no way open. The three
  // rows are mutually exclusive, so the testid stays unique for the e2e.
  const renderLogsToggle = (
    <button
      data-testid="render-logs-toggle"
      style={{ ...ghostButton, padding: "2px 8px" }}
      onClick={() => setLogsOpen((v) => !v)}
      title={logsOpen ? "Collapse the log" : "Expand the log"}
    >
      {logsOpen ? "▾ logs" : "▸ logs"}
    </button>
  );

  return (
    <div style={shell}>
      <div style={topBar}>
        <span style={wordmark}>ossclip</span>
        {workdirPath ? (
          // Which project is open — the answer to "wait, which video is
          // this?" once switching exists. Last two segments, because the
          // default workdir is always literally named `.ossclip`.
          <span data-testid="workdir-label" style={workdirLabel} title={workdirPath}>
            {workdirPath.split("/").filter(Boolean).slice(-2).join("/")}
          </span>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          {/* The file menu, sized to what it holds (R17 §83): one action.
              Opens/switches the project without restarting the server. */}
          <button
            data-testid="open-button"
            style={ghostButton}
            onClick={() => setShowPicker(true)}
            title={
              workdirPath
                ? `Open another project — currently ${workdirPath}`
                : "Open another project"
            }
          >
            Open
          </button>
          {/* Undo/redo as icons (R17 §80) — the pair every editor's toolbar
              has, ⌘Z / ⌘⇧Z on the keyboard. */}
          <button
            data-testid="undo-button"
            style={ghostButton}
            onClick={() => edits.undo()}
            disabled={!edits.canUndo}
            title="Undo (⌘Z)"
            aria-label="Undo"
          >
            <UndoIcon />
          </button>
          <button
            data-testid="redo-button"
            style={ghostButton}
            onClick={() => edits.redo()}
            disabled={!edits.canRedo}
            title="Redo (⌘⇧Z)"
            aria-label="Redo"
          >
            <RedoIcon />
          </button>
          <button
            data-testid="transcript-toggle"
            style={{ ...ghostButton, ...(showTranscript ? { borderColor: "#5b8cff" } : {}) }}
            onClick={() => setShowTranscript((v) => !v)}
            title="Find and retype caption words across the whole transcript"
          >
            Transcript
          </button>
          <button
            data-testid="cover-button"
            style={{ ...ghostButton, ...(showCover ? { borderColor: "#5b8cff" } : {}) }}
            onClick={() => setShowCover(true)}
            title="Retype the cover headline or re-cut its frame — seconds, no re-render"
          >
            Cover
          </button>
          {/* Cut review step 3 — the Cover button precedent: its own top-bar
              button, not a menu item, because reviewing the cut is a
              first-class pass over every produce run. */}
          <button
            data-testid="cleanup-button"
            style={{ ...ghostButton, ...(showCleanup ? { borderColor: "#5b8cff" } : {}) }}
            onClick={() => setShowCleanup(true)}
            title="Review what produce removed — keep whole categories; the preview plays your choices immediately"
          >
            Cleanup
          </button>
          {/* One menu for the --youtube extras (2026-08-17): the thumbnail
              and the SEO pack are two panels over one feature, and two
              top-bar buttons were the bar's first scaling failure. */}
          <div style={{ position: "relative" }}>
            <button
              data-testid="youtube-menu"
              style={{
                ...ghostButton,
                ...(showYoutubeMenu || showThumbnail || showYoutubeSeo
                  ? { borderColor: "#5b8cff" }
                  : {}),
              }}
              onClick={() => setShowYoutubeMenu((v) => !v)}
              title="AI thumbnail and SEO metadata for the YouTube upload"
              aria-haspopup="menu"
              aria-expanded={showYoutubeMenu}
            >
              YouTube ▾
            </button>
            {showYoutubeMenu ? (
              <>
                {/* Click-away closer UNDER the menu — the RenderModal
                    backdrop idea without the dimming, since this is a menu,
                    not a dialog. */}
                <div style={menuBackdrop} onMouseDown={() => setShowYoutubeMenu(false)} />
                <div style={menuPopover} role="menu">
                  <button
                    data-testid="youtube-menu-thumbnail"
                    style={menuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowYoutubeMenu(false);
                      setShowThumbnail(true);
                    }}
                  >
                    Thumbnail
                  </button>
                  <button
                    data-testid="youtube-menu-seo"
                    style={menuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowYoutubeMenu(false);
                      setShowYoutubeSeo(true);
                    }}
                  >
                    SEO metadata
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <button
            data-testid="publish-button"
            style={{ ...ghostButton, ...(showPublish ? { borderColor: "#5b8cff" } : {}) }}
            onClick={() => setShowPublish(true)}
            title="Push the finished render to your social accounts via your Postiz instance"
          >
            Publish
          </button>
          <button
            style={{ ...ghostButton, ...(edits.dirty ? primaryButton : {}) }}
            onClick={onSave}
            // Finding 1, PLAN 2026-08-04 fix wave final review: belt-and-
            // braces alongside `onSave`'s own guard (save.ts) — a render in
            // flight means produce already wrote its src-resolved
            // overrides.json for THIS render, and a Save now would PUT the
            // stale pre-render doc back over it.
            disabled={!edits.dirty || render?.running === true}
            title={
              render?.running === true
                ? "Can't save while a render is running"
                : undefined
            }
          >
            Save
          </button>
          <div style={{ display: "inline-flex", alignItems: "center" }}>
            <button
              data-testid="render-button"
              style={{
                ...ghostButton,
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                borderRight: "none",
              }}
              onClick={() => void onRender()}
              disabled={!canRender || render?.running === true}
              title={
                canRender
                  ? // R12: say what this actually does — it REPLAYS the last
                    // completed produce (command.json), so pipeline-level flags
                    // (source fit, cleanup, provider) come from that run; your
                    // saved edits are re-applied on top.
                    "Saves if needed, then replays the last completed produce command — " +
                    "pipeline flags come from that run; your saved edits apply on top"
                  : "No command.json in this workdir — run `ossclip produce` once in a " +
                    "terminal; it records the invocation and Render replays it"
              }
            >
              {render?.running ? "Rendering…" : "Render"}
            </button>
            <button
              data-testid="render-destination-button"
              style={{
                ...ghostButton,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                padding: "7px 8px",
              }}
              onClick={() => setShowRenderModal(true)}
              disabled={!canRender || render?.running === true}
              title="Choose export file destination (Browse…)"
            >
              ▾
            </button>
          </div>
        </div>
        <span
          style={{ ...statusText, color: edits.dirty ? "#FFE14D" : "#5FBF77" }}
          {...(edits.dirty ? { "data-testid": "dirty" } : {})}
        >
          {edits.dirty ? "● Unsaved changes" : "✓ Saved"}
        </span>
        <button
          data-testid="shortcuts-button"
          style={{ ...ghostButton, padding: "7px 10px" }}
          onClick={() => setShowShortcuts((v) => !v)}
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
      </div>
      {showShortcuts ? <ShortcutsModal onClose={() => setShowShortcuts(false)} /> : null}
      {showThumbnail ? <ThumbnailPanel onClose={() => setShowThumbnail(false)} /> : null}
      {showCleanup ? (
        <CleanupPanel
          cutlist={cleanupCutlist}
          edits={edits}
          onClose={() => setShowCleanup(false)}
        />
      ) : null}
      {showYoutubeSeo ? <YoutubePanel onClose={() => setShowYoutubeSeo(false)} /> : null}
      {showPublish ? <PublishPanel onClose={() => setShowPublish(false)} /> : null}
      {showCover ? (
        <CoverPanel
          onClose={() => setShowCover(false)}
          // A GETTER, read on click: App does not re-render per frame, so a
          // number prop would freeze at whatever the playhead was when the
          // panel opened. Mapped through `clock.fromLive` — the REVERSE
          // direction of every other surface's mapping, deliberately: the
          // server extracts the `--from final` frame from the FINISHED
          // RENDERED mp4 (cover.ts seeks `timeSec` into it), and that file's
          // timeline is the OLD clock — the last render's own output time —
          // while a live veto puts the player on the new one. Unmapped, the
          // grabbed frame sat exactly the revived seconds early; a playhead
          // INSIDE revived material has no frame in that mp4 at all and
          // clamps to the nearest kept edge (`fromLive`'s doc). `--from
          // source` instead seeks the ORIGINAL take in SOURCE seconds; the
          // panel has always sent last-render output seconds for that case
          // too (its prop doc), and `fromLive` preserves exactly that value —
          // the pre-existing source-case semantics are unchanged. Identity
          // when no veto is live, so the seconds go through untouched — see
          // CoverPanel's prop doc.
          playheadSec={() =>
            clock.fromLive(
              (playerRef.current?.getCurrentFrame() ?? 0) / live.settings.fps,
            )
          }
        />
      ) : null}
      {showRenderModal ? (
        <RenderModal
          defaultOutPath={defaultOutPath}
          onCancel={() => setShowRenderModal(false)}
          onConfirm={(customOut) => {
            setShowRenderModal(false);
            void onRender(customOut);
          }}
        />
      ) : null}
      {deletePlan ? (
        <DeleteSceneModal
          plan={deletePlan}
          onCancel={() => setDeletePlan(null)}
          onConfirm={(target) => {
            // Both arms are ordinary reducer commits, so ⌘Z takes either
            // back — the modal adds friction, not a second edit mechanism.
            if (target === "graphic") {
              edits.hideScene(deletePlan.sceneId);
            } else {
              // The plan's window came off a retimed cue — the LIVE clock —
              // but a fresh `cuts[]` entry speaks the LAST RENDER's output
              // seconds (the `OverrideDocSchema.cuts` contract), so it
              // converts here, at the write boundary, exactly as the
              // Inspector's own "Delete this chunk" does (same helper, so
              // the shrink/refuse verdict cannot drift between the two).
              // Identity when no veto is live — the values pass untouched.
              const range = cutRangeToOldClock(clock, deletePlan.startSec, deletePlan.endSec);
              if (range.kind === "degenerate") {
                setClockRefusedNotice(
                  "Can't cut this window: it isn't in the last render yet — render once (or re-remove the pause) to cut it.",
                );
              } else {
                // A window that merely shrinks at a revived edge proceeds
                // and says so — the console, the retime reports' own
                // channel (this gesture has no quieter one today).
                if (range.kind === "shrunk") console.warn(`ossclip cut preview: ${range.report}`);
                edits.cutChunk(range.startSec, range.endSec);
              }
            }
            setDeletePlan(null);
          }}
        />
      ) : null}
      {deleteWordsPlan ? (
        <DeleteWordsModal
          plan={deleteWordsPlan}
          onCancel={() => setDeleteWordsPlan(null)}
          onConfirm={(target) => {
            // Ordinary reducer commits both ways, so ⌘Z takes either back —
            // the DeleteSceneModal rule: friction, not a second edit
            // mechanism. `cutWords` is ONE commit for hide + cut, so the
            // whole gesture is one undo step.
            if (target === "caption") edits.hideCaptionWords(deleteWordsPlan.words);
            else
              edits.cutWords(
                deleteWordsPlan.words,
                deleteWordsPlan.startSec,
                deleteWordsPlan.endSec,
              );
            setDeleteWordsPlan(null);
          }}
        />
      ) : null}
      {showPicker ? (
        <ProjectPicker
          recent={recentProjects}
          required={false}
          onOpen={openProject}
          onClose={() => setShowPicker(false)}
        />
      ) : null}
      {render ? (
        <div
          data-testid="render-log"
          style={{
            ...renderLog,
            borderColor: render.failed !== undefined ? "#FF5C5C" : "#2A2A33",
          }}
        >
          {render.failed !== undefined ? (
            <div
              style={{
                color: render.cancelled ? "#9A9AA3" : "#FF5C5C",
                marginBottom: 4,
              }}
              data-testid={render.cancelled ? "render-cancelled" : "render-failed"}
            >
              {render.cancelled ? "render cancelled" : `render failed (exit ${render.failed})`}
              <button
                style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
                onClick={() => setRender(null)}
              >
                Dismiss
              </button>
              <span style={{ marginLeft: 6 }}>{renderLogsToggle}</span>
            </div>
          ) : null}
          {render.succeeded ? (
            // The success row (2026-08-18): the run's log — provider, cost,
            // anything §137 dropped — stays readable until dismissed instead
            // of vanishing the instant the render lands. Elapsed only when
            // this page WATCHED the run end (`finishedAt`); a reload-resumed
            // success has no honest end stamp and shows none.
            <div data-testid="render-succeeded" style={renderStatusRow}>
              <span style={{ color: "#5FBF77" }}>
                ✓ done
                {render.startedAt != null && render.finishedAt !== undefined
                  ? ` · ${formatElapsed(render.startedAt, render.finishedAt)}`
                  : ""}
              </span>
              <button
                data-testid="render-open-folder"
                style={{ ...ghostButton, padding: "2px 8px" }}
                onClick={() => void fetch("/api/reveal-output", { method: "POST" }).catch(() => {})}
                title="Reveal the rendered file in your file manager"
              >
                Open folder
              </button>
              <button
                style={{ ...ghostButton, padding: "2px 8px" }}
                onClick={() => setRender(null)}
              >
                Dismiss
              </button>
              {renderLogsToggle}
            </div>
          ) : null}
          {render.running ? (
            // Liveness that doesn't depend on new log lines arriving (R13):
            // the render's 10% steps can be minutes apart, and a panel that
            // only moves when they land reads as stuck. The spinner animates
            // regardless; elapsed ticks with the 1s poll; the bar appears
            // once the render phase starts printing percentages.
            <div data-testid="render-status" style={renderStatusRow}>
              <style>{"@keyframes ossclip-spin { to { transform: rotate(360deg) } }"}</style>
              <span style={spinner} aria-hidden />
              <span style={{ color: "#EDEDF2" }}>
                rendering
                {render.startedAt != null
                  ? ` · ${formatElapsed(render.startedAt, Date.now())}`
                  : ""}
                {renderProgress(render.lines) !== null
                  ? ` · ${renderProgress(render.lines)}%`
                  : ""}
              </span>
              {renderProgress(render.lines) !== null ? (
                <div style={progressOuter}>
                  <div
                    data-testid="render-progress-bar"
                    style={{ ...progressInner, width: `${renderProgress(render.lines)}%` }}
                  />
                </div>
              ) : null}
              {/* The way out (R16 §60): kill the replayed child. The poll
                  sees the exit and the panel reports "cancelled", not a
                  dressed-up failure. */}
              <button
                data-testid="render-cancel"
                style={{ ...ghostButton, padding: "2px 8px" }}
                onClick={() => void fetch("/api/render/cancel", { method: "POST" })}
              >
                Cancel
              </button>
              {renderLogsToggle}
            </div>
          ) : null}
          {logsOpen ? (
            <>
              {/* Provider + token/cost lines pinned above the tail (R13):
                  they print early and would scroll away long before anyone
                  wonders what this run cost. Only lines the run actually
                  printed — a cached replay has no cost to report. */}
              {pinnedInfoLines(render.lines).map((l) => (
                <div key={l} data-testid="render-pinned" style={{ color: "#C9C9D4" }}>
                  {l}
                </div>
              ))}
              <LogTail lines={render.lines} />
            </>
          ) : null}
        </div>
      ) : null}
      {dirtyDiscardedNotice ? (
        // Finding 2's honest-copy requirement (PLAN 2026-08-04 Task 4c fix
        // wave): this only ever shows when the reload above actually threw
        // something away, so it says exactly that rather than being a
        // routine "we refreshed" banner nobody needs to read.
        <div data-testid="reanchor-notice" style={reanchorNotice}>
          Render re-anchored your saved cuts and splits — edits made while it
          ran were dropped, not merged, to avoid overwriting that anchor.
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => setDirtyDiscardedNotice(false)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {migrationLossLines.length > 0 || renderCaptionLoss.length > 0 ? (
        // §137: caption edits this project's older, position-keyed
        // overrides.json could not be matched to a word in the current cut,
        // and (final review, Important 4) any retype that did not come back
        // from a completed render. DISMISSIBLE, like the two notices around
        // it, because both report one-time events — nothing the user does
        // here re-runs the load migration or the render.
        <div data-testid="caption-migration-notice" style={reanchorNotice}>
          {/* Index keys: two edits can produce the SAME sentence (the same
              word retyped at two moments), and a duplicated React key would
              drop one of the lines the user is being told about. */}
          {[...migrationLossLines, ...renderCaptionLoss].map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => {
              setCaptionMigrationLoss([]);
              setRenderCaptionLoss([]);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {showDropNotice ? (
        // §137, the field case: `applyCaptionEdits`' drop report used to be
        // discarded here, so a retype that could not land just reverted with
        // nothing said. Dismissible — an earlier cut of this was not, on the
        // theory that the list clears itself once the doc stops holding an
        // unplaceable edit, which is false for `duplicate-anchor`: retyping
        // mints the same key and the second word still carries it, so the
        // entry comes back forever and only deleting the edit ends it (§137
        // Task 6 review, Important 4). The dismissal covers THIS list only —
        // a different drop raises the notice again — and `console.warn` keeps
        // a record either way.
        <div data-testid="caption-dropped-notice" style={reanchorNotice}>
          {/* Index keys — see the note in the notice above. */}
          {droppedEditLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => setDismissedDrops(dropNoticeSignature)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {saveBlockedNotice ? (
        // Finding 1's scoped re-review fix (PLAN 2026-08-04 fix wave):
        // dismissible and non-fatal, same chrome as `dirtyDiscardedNotice`
        // above — a render in flight is routine, not an app-breaking error,
        // and `onSaveEffect`'s doc comment (save.ts) explains why this must
        // never route through `setError` instead.
        <div data-testid="save-blocked-notice" style={reanchorNotice}>
          Can't save while a render is running — it's writing its own
          overrides.json right now. Wait for it to finish (or cancel it)
          before saving.
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => setSaveBlockedNotice(false)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {renderRefusedNotice !== null ? (
        // A render that refused to start (2026-08-18) — same chrome and same
        // non-fatal posture as the save-blocked notice above; the useState's
        // doc comment has the reasoning.
        <div data-testid="render-refused-notice" style={reanchorNotice}>
          Render didn't start: {renderRefusedNotice}
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => setRenderRefusedNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {clockRefusedNotice !== null ? (
        // A split/cut aimed at revived material (step 4 follow-up) — same
        // chrome and same non-fatal posture as the render refusal above; the
        // useState's doc comment has the reasoning.
        <div data-testid="clock-refused-notice" style={reanchorNotice}>
          {clockRefusedNotice}
          <button
            style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
            onClick={() => setClockRefusedNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <div style={mainRow}>
        {showTranscript ? (
          <>
            <TranscriptPanel
              baseLines={renderProps?.baseCaptionLines ?? renderProps?.captionLines ?? []}
              // POST-range, PRE-hide lines, deliberately not
              // `live.captionLines` (post-hide) and no longer the edits-only
              // set: range edits change word COUNT, so the panel must see
              // them or its flat indices and text diverge from what the user
              // just typed. A hidden word still renders — struck-through,
              // ready to select and Restore — and the panel derives which
              // words are hidden from `edits.doc.captionWordsHidden` itself.
              liveLines={appliedCaptionRanges.lines}
              // The POST-hide lines the TIMING layer runs on, alongside the
              // pre-hide ones the panel renders: `applyCaptionLineTiming`
              // keys every entry by the SURVIVING line's first word, so a
              // nudge captured against the pre-hide stream could be keyed to
              // a hidden word core never sees (`postHideLineIndices`).
              timingLines={appliedCaptionHides.lines}
              fps={live.settings.fps}
              playerRef={playerRef}
              edits={edits}
              onDeleteWords={setDeleteWordsPlan}
              width={transcriptWidth}
              // `/media/*` resolves against the CURRENT workdir, so the
              // waveform cache is keyed by it (`loadSourceAudio`).
              workdir={workdirPath}
              // Step 4 follow-up: the panel's lines are pre-retime (old
              // clock) BY DESIGN — see the liveLines comment above — so its
              // seeks and playhead reads convert at the boundary instead.
              // Identity when no veto is live (the panel's own prop doc).
              toPlayerSec={clock.toLive}
              fromPlayerSec={clock.fromLive}
            />
            {/* The pane ↔ stage divider (R16 §65). preventDefault keeps the
                press from starting a text selection across the transcript. */}
            <div
              data-testid="transcript-divider"
              style={divider}
              title="Drag to resize the transcript pane"
              onMouseDown={(e) => {
                e.preventDefault();
                dividerDragRef.current = { startX: e.clientX, startW: transcriptWidth };
              }}
            />
          </>
        ) : null}
        <div style={stageWrap}>
          <div
            ref={stageAreaRefCb}
            style={stageArea}
            onMouseDown={(e) => {
              // View pan (§55b): Alt-drag or middle-drag moves the camera.
              // preventDefault kills the browser's middle-click autoscroll;
              // the Overlay ignores these presses, so no edit can start.
              if (e.altKey || e.button === 1) {
                e.preventDefault();
                const el = stageAreaRef.current;
                if (el) {
                  viewPanRef.current = {
                    x: e.clientX,
                    y: e.clientY,
                    sl: el.scrollLeft,
                    st: el.scrollTop,
                  };
                }
              }
            }}
          >
            <div style={{ margin: "auto", padding: STAGE_PAD }}>
          <div
            ref={stageRef}
            data-testid="stage"
            data-playing={playing ? "true" : "false"}
            data-rate={rate}
            style={{ position: "relative", display: "inline-block" }}
          >
            <Player<AnyZodObject, PlayerProductionProps>
              ref={playerRef}
              component={ProductionComposition}
              inputProps={live}
              durationInFrames={Math.max(1, Math.round(live.outputDurationSec * live.settings.fps))}
              fps={live.settings.fps}
              compositionWidth={live.settings.width}
              compositionHeight={live.settings.height}
              style={{ width: playerW }}
              controls
              // The frame is a canvas, not a play button (PLAN Task 1).
              // Remotion defaults clickToPlay to `controls`, which is right
              // for a viewer and wrong for an editor: playback is explicit —
              // the transport bar, SPACE, or J/K/L.
              clickToPlay={false}
              // Signed rate; negative genuinely plays backwards on this
              // Remotion version (measured — see transport.ts).
              playbackRate={rate}
            />
            <Overlay
              stageRef={stageRef}
              selection={selection}
              onSelect={setSelection}
              edits={edits}
              onSave={onSave}
              settings={live.settings}
              cues={live.sceneCues}
              playerRef={playerRef}
              cue={selectedCue}
              onTransport={onTransport}
              onVideoPreview={setVideoPreview}
              onGraphicPreview={setGraphicPreview}
              onToggleHelp={() => setShowShortcuts((v) => !v)}
              onRequestDelete={setDeletePlan}
              // ⌘B's write boundary (step 4 follow-up): the playhead is on
              // the live clock, `splits[].at` on the old — the Overlay prop
              // docs own the argument; identity when no veto is live.
              fromLive={clock.fromLive}
              hasOldClockPreimage={clock.hasOldClockPreimage}
              toSourceSec={clock.toSourceSec}
              onClockRefused={setClockRefusedNotice}
            />
            {/* The rate, visible and mouse-reachable (PLAN Task 2.4): a rate
                only reachable by keyboard is a rate users lose track of.
                Clicking cycles the forward ladder; J/K/L drive it too. */}
            <button
              data-testid="rate-chip"
              onClick={() => onTransport("L")}
              title="Playback rate — click to speed up (J/K/L on the keyboard)"
              style={rateChip}
            >
              {rate < 0 ? `◂◂ ${Math.abs(rate)}×` : `${rate}×`}
            </button>
          </div>
            </div>
          </div>
          {/* View zoom (§55b) — pinned to the stage AREA, not the scrolled
              content, so it stays reachable while magnified. */}
          <div style={viewZoomBar}>
            <button
              data-testid="view-zoom-out"
              style={viewZoomButton}
              onClick={() => applyViewZoom(viewZoom / 2)}
              disabled={viewZoom <= 0.25}
              title="Zoom the preview out — below 100% shrinks under the fitted size"
            >
              −
            </button>
            <span data-testid="view-zoom-level" style={viewZoomLabel}>
              {Math.round(viewZoom * 100)}%
            </span>
            <button
              data-testid="view-zoom-in"
              style={viewZoomButton}
              onClick={() => applyViewZoom(viewZoom * 2)}
              disabled={viewZoom >= 8}
              title="Zoom the preview in — a viewing magnifier, it never edits the video"
            >
              +
            </button>
            <button
              data-testid="view-zoom-fit"
              style={{ ...viewZoomButton, width: "auto", padding: "0 8px" }}
              onClick={() => applyViewZoom(1)}
              disabled={Math.abs(viewZoom - 1) < 1e-3}
              title="Fit the preview to the window"
            >
              fit
            </button>
            <span style={viewZoomHint}>⌥-drag pans</span>
          </div>
        </div>
        <div style={sidebar}>
          <Inspector
            selection={selection}
            cue={selectedCue}
            frame={{ width: live.settings.width, height: live.settings.height }}
            allSceneIds={live.sceneCues.map((c) => c.id)}
            edits={edits}
            onSelect={setSelection}
            resolvedTheme={live.theme}
            anchorText={anchorText}
            onVideoPreview={setVideoPreview}
            runInfo={runInfo}
            captionsHiddenByFlag={renderProps?.captionsHiddenByFlag === true}
            // "Delete this chunk"'s write boundary (step 4 follow-up): the
            // cue window is on the live clock, a fresh `cuts[]` entry on the
            // old — the Inspector prop docs own the argument; identity when
            // no veto is live.
            fromLive={clock.fromLive}
            hasOldClockPreimage={clock.hasOldClockPreimage}
            onClockRefused={setClockRefusedNotice}
          />
        </div>
      </div>
      <Timeline
        cues={live.sceneCues}
        ghosts={ghostCues}
        cuts={edits.doc.cuts}
        // The CURRENT render-props' spans (PLAN 2026-08-04 Task 4c fix
        // wave, review finding 1) — Timeline needs these to place an
        // ALREADY-APPLIED cut's seam marker at its true position via
        // `sourceToOutputClamped`; a NOT-YET-APPLIED cut's struck band
        // doesn't consume them at all.
        spans={live.spans ?? []}
        // Produce's labeled removals (cut review step 2) — the seams also
        // place through `spans`, same lookup as an applied cut's.
        cleanup={cleanupCutlist}
        durationSec={live.outputDurationSec}
        fps={live.settings.fps}
        playerRef={playerRef}
        selection={selection}
        onSelect={setSelection}
        edits={edits}
        videoSrc={live.videoFileName}
        // The struck band's DISPLAY half (step 4 follow-up): a fresh cut's
        // doc window is old-clock, this ruler is the live one — the Timeline
        // prop doc owns the argument; identity when no veto is live.
        toLive={clock.toLive}
        toSourceSec={(outSec) => {
          // Output→source through the spans (R20 §97) — the filmstrip frame
          // must be the source second actually playing there, not the raw
          // output second, or every thumbnail past the first cut is wrong.
          for (const sp of live.spans ?? []) {
            if (outSec >= sp.outIn && outSec < sp.outOut) return sp.srcIn + (outSec - sp.outIn);
          }
          return (live.spans ?? [])[0]?.srcIn ?? outSec;
        }}
      />
    </div>
  );
};

/**
 * The render log tail (R17 §84): the FULL captured stream in its own scroll
 * box, stuck to the bottom while new lines arrive — until the user scrolls
 * up to read, which un-sticks it (scrolling back down re-arms the stick).
 */
const LogTail: React.FC<{ lines: string[] }> = ({ lines }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      data-testid="render-tail"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}
      style={{ maxHeight: 220, overflowY: "auto" }}
    >
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
};

/** Curved-arrow undo/redo glyphs — inline SVG so they inherit the button's
 * disabled color like text would. */
const UndoIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);

const RedoIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </svg>
);

const shell: React.CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  background: "#0B0B0E",
  color: "#EDEDF2",
  // HEIGHT, not minHeight: the editor is an app frame, not a document. With
  // minHeight, a tall Inspector panel stretched the whole page and pushed
  // the timeline below the fold — the sidebar's own overflowY:auto only
  // scrolls when this row is actually height-capped (found when R11 Task
  // 2's Graphic-box section made the scene panel taller than the viewport).
  height: "100vh",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "10px 20px",
  borderBottom: "1px solid #1E1E24",
  background: "#111116",
};

const wordmark: React.CSSProperties = {
  fontWeight: 800,
  fontSize: 14,
  letterSpacing: "0.02em",
  color: "#FFE14D",
  marginRight: 8,
};

const workdirLabel: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#6a6a75",
  maxWidth: 260,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const statusText: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  marginLeft: "auto",
};

const ghostButton: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#EDEDF2",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "7px 12px",
  cursor: "pointer",
};

const primaryButton: React.CSSProperties = {
  background: "#FFE14D",
  color: "#0B0B0E",
  border: "1px solid #FFE14D",
};

// The "YouTube ▾" menu chrome. zIndex above the transparent click-away
// layer, both above the stage but below the modal backdrops (40) so an open
// panel always covers a stale menu.
const menuBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 30,
};

const menuPopover: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 31,
  minWidth: 150,
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
  display: "flex",
  flexDirection: "column",
};

const menuItem: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#EDEDF2",
  background: "transparent",
  border: "none",
  borderRadius: 4,
  padding: "8px 10px",
  cursor: "pointer",
  textAlign: "left",
};

const mainRow: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

/** Breathing room around the preview; the fit math subtracts it per side. */
const STAGE_PAD = 32;

/** Transcript pane width bounds and its cross-session memory (R16 §65). */
const TRANSCRIPT_WIDTH_KEY = "ossclip.transcriptWidth";
const clampTranscriptWidth = (w: number): number => Math.min(640, Math.max(220, w));

const divider: React.CSSProperties = {
  width: 5,
  flexShrink: 0,
  cursor: "col-resize",
  background: "#1E1E24",
  // A slim but honest grab target — the border look stays, the hit area is
  // the full 5px strip.
  borderLeft: "1px solid #2A2A33",
};

const stageWrap: React.CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
};

/**
 * The preview's scroll viewport (§55b). Centering comes from the inner
 * wrapper's `margin: auto`, NOT from justify/align center — a centred flex
 * child that overflows its scroller puts its start edge outside the
 * scrollable range, which is exactly the part a magnified inspection needs
 * to reach.
 */
const stageArea: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  overflow: "auto",
};

const viewZoomBar: React.CSSProperties = {
  position: "absolute",
  top: 10,
  left: 10,
  zIndex: 6,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px",
  background: "rgba(17,17,22,0.85)",
  border: "1px solid #2A2A33",
  borderRadius: 6,
};

const viewZoomButton: React.CSSProperties = {
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

const viewZoomLabel: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#9A9AA3",
  minWidth: 34,
  textAlign: "center",
};

const viewZoomHint: React.CSSProperties = {
  fontSize: 10,
  color: "#55555f",
  userSelect: "none",
};

const sidebar: React.CSSProperties = {
  width: 260,
  flexShrink: 0,
  borderLeft: "1px solid #1E1E24",
  background: "#111116",
  overflowY: "auto",
};

const renderLog: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#9A9AA3",
  background: "#0F0F14",
  borderBottom: "1px solid #2A2A33",
  padding: "6px 20px",
  // The TAIL scrolls itself (R17 §84) — the panel no longer clips it.
  whiteSpace: "pre-wrap",
  flexShrink: 0,
};

/** The Finding 2 discard notice (PLAN 2026-08-04 Task 4c fix wave) — same
 * chrome family as `renderLog` (monospace, dark panel, a bottom border) so
 * it reads as part of the same status-reporting language, not a foreign
 * alert box; yellow text because this is informational, not an error. */
const reanchorNotice: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#FFE14D",
  background: "#0F0F14",
  borderBottom: "1px solid #2A2A33",
  padding: "6px 20px",
  flexShrink: 0,
};

const renderStatusRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 4,
};

const spinner: React.CSSProperties = {
  width: 12,
  height: 12,
  flexShrink: 0,
  border: "2px solid #2A2A33",
  borderTopColor: "#FFE14D",
  borderRadius: "50%",
  animation: "ossclip-spin 0.8s linear infinite",
};

const progressOuter: React.CSSProperties = {
  flex: 1,
  maxWidth: 260,
  height: 4,
  background: "#1E1E24",
  borderRadius: 2,
  overflow: "hidden",
};

const progressInner: React.CSSProperties = {
  height: "100%",
  background: "#FFE14D",
  borderRadius: 2,
  transition: "width 0.6s ease",
};

const rateChip: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 5,
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "ui-monospace, 'SF Mono', monospace",
  color: "#FFE14D",
  background: "rgba(11,11,14,0.75)",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "3px 8px",
  cursor: "pointer",
};
