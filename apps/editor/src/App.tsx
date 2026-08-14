import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { transportReduce, type TransportKey } from "./transport";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import {
  applyCaptionEdits,
  applyOverrides,
  dropHiddenCues,
  splitThenDropHidden,
  fillPlainCues,
  splitCues,
  resolveTheme,
  defaultTheme,
  type AppliedCaptionEdits,
  type CaptionKeyMigration,
  type OverrideDoc,
  type SceneCue,
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
import { ProjectPicker } from "./ProjectPicker";
import { RenderModal } from "./RenderModal";
import { formatElapsed, pinnedInfoLines, renderCompleteReload, renderProgress } from "./renderStatus";
import { onSaveEffect } from "./save";
import { ghostCues as computeGhostCues } from "./ghosts";
import {
  anchorCaptionLines,
  droppedEditNotices,
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
  // Render-from-the-editor (R11 Task 4): whether the server has a recorded
  // invocation to replay, and the in-flight run's state while it does.
  const [canRender, setCanRender] = useState(false);
  const [render, setRender] = useState<{
    running: boolean;
    lines: string[];
    failed?: number;
    /** Server-side spawn time — the elapsed clock's origin (R13). */
    startedAt?: number | null;
    /** The run ended because the user cancelled it — not a failure (R16). */
    cancelled?: boolean;
  } | null>(null);
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
  // The pending Delete/Backspace confirmation (§139), or null. The PLAN is
  // held, not the scene id: it was computed against the doc at the moment the
  // key was pressed, and re-deriving it on every render would let an
  // undo landing behind the open dialog change which options it is offering.
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
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
              // (final review, Important 4). `setRender(null)` two lines below
              // throws away the run log that named anything produce dropped,
              // and the doc arriving here is already clean — so `unresolved`
              // and `dropped` are both empty and a missing retype would
              // vanish from the transcript with nothing said. Diffed by
              // CONTENT, so a successful re-key is not mistaken for a loss.
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
            setRender(null);
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
    setWorkdirPath(body.workdir ?? null);
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
    // Resume a render already in flight (R16 §60): a refresh used to
    // orphan the panel — the child kept rendering server-side with no
    // progress, no logs, and no way to cancel it from the UI.
    const s = await fetch("/api/render/status");
    const status = (await s.json()) as {
      running: boolean;
      lines?: string[];
      startedAt?: number | null;
    };
    if (status.running) {
      setRender({
        running: true,
        lines: status.lines ?? [],
        startedAt: status.startedAt,
      });
      beginRenderPoll();
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

  // Both halves of what the user is owed about caption edits: the ones the
  // load-time key migration could not place (an event, held in state) and the
  // ones that do not fit the lines on screen (a live property of the doc).
  const migrationLossLines = useMemo(
    () => migrationLossNotices(captionMigrationLoss),
    [captionMigrationLoss],
  );
  const droppedEditLines = useMemo(
    () => droppedEditNotices(appliedCaptions.dropped),
    [appliedCaptions],
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

  // DECIDE (PLAN 2026-08-04 Task 4c): this memo deliberately never reads
  // `edits.doc.cuts`. A cut removes an output-second RANGE and shifts every
  // scene after it — the same reshaping `produce.ts`'s `buildCutlist` +
  // `TimeMap` + `assembleScenes` does server-side. Reproducing that here
  // would mean a second EDL implementation in the browser (the brief's own
  // explicit "don't"), and there is nothing cheap to lean on instead: this
  // memo's `renderProps.spans`/`outputDurationSec` describe the LAST
  // produce run's timeline, not a live re-cut one, and the editor has no
  // client-side TimeMap to rebuild a post-cut version from (only
  // `render-props.json`'s `spans`, which is `produce.ts`'s OUTPUT, not
  // something a cut can be subtracted from without the same server-side
  // machinery). The honest v1: a cut renders as a marked-dead region
  // (Timeline's struck-through overlay, fed straight from `edits.doc.cuts`
  // below) that TAKES EFFECT on the next produce/Render, which already
  // subtracts it correctly (Task 4b) — never silently pretending the live
  // preview reflects a cut it can't actually apply.
  const live = useMemo<PlayerProductionProps | null>(() => {
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
    const splitted = splitCues(filled, edits.doc.splits);
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
    return {
      ...renderProps,
      sceneCues: previewed,
      captionLines: appliedCaptions.lines,
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
  }, [renderProps, edits.doc, videoPreview, graphicPreview, appliedCaptions]);

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
        beginRenderPoll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
    return computeGhostCues(baseCues, edits.doc);
  }, [renderProps, edits.doc]);

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
            if (target === "graphic") edits.hideScene(deletePlan.sceneId);
            else edits.cutChunk(deletePlan.startSec, deletePlan.endSec);
            setDeletePlan(null);
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
              <button
                data-testid="render-logs-toggle"
                style={{ ...ghostButton, padding: "2px 8px" }}
                onClick={() => setLogsOpen((v) => !v)}
                title={logsOpen ? "Collapse the log" : "Expand the log"}
              >
                {logsOpen ? "▾ logs" : "▸ logs"}
              </button>
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
      <div style={mainRow}>
        {showTranscript ? (
          <>
            <TranscriptPanel
              baseLines={renderProps?.baseCaptionLines ?? renderProps?.captionLines ?? []}
              liveLines={live.captionLines}
              fps={live.settings.fps}
              playerRef={playerRef}
              edits={edits}
              width={transcriptWidth}
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
        durationSec={live.outputDurationSec}
        fps={live.settings.fps}
        playerRef={playerRef}
        selection={selection}
        onSelect={setSelection}
        edits={edits}
        videoSrc={live.videoFileName}
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
