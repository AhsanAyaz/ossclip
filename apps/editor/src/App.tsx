import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { transportReduce, type TransportKey } from "./transport";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import {
  applyCaptionEdits,
  applyOverrides,
  dropHiddenCues,
  fillPlainCues,
  resolveTheme,
  defaultTheme,
  type OverrideDoc,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";
import { useEdits } from "./useEdits";
import { Overlay, type GraphicPreview, type Selection, type VideoPreview } from "./Overlay";
import { Inspector } from "./Inspector";
import { Timeline } from "./Timeline";

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
};

export const App: React.FC = () => {
  const edits = useEdits();
  const [renderProps, setRenderProps] = useState<RawRenderProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  // A live, uncommitted framing tweak (PLAN Task B3): the stage drag and the
  // Inspector's zoom slider both write it, the live memo applies it last, and
  // it clears the moment the real patch lands in the edit layer.
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  // Render-from-the-editor (R11 Task 4): whether the server has a recorded
  // invocation to replay, and the in-flight run's state while it does.
  const [canRender, setCanRender] = useState(false);
  const [render, setRender] = useState<{
    running: boolean;
    lines: string[];
    failed?: number;
  } | null>(null);
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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/production");
        if (!res.ok) throw new Error(`GET /api/production failed: ${res.status}`);
        const body = (await res.json()) as {
          renderProps: RawRenderProps;
          overrides: OverrideDoc;
          canRender?: boolean;
        };
        setRenderProps(body.renderProps);
        setCanRender(Boolean(body.canRender));
        edits.load(body.overrides);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // Load once on mount; the edit layer is applied live via `live` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Same sequence as `produce.ts`: overrides → drop the deleted scenes →
    // fill the gaps with plain takes (a deleted scene's window becomes an
    // editable take — Task C's payoff for doing A first) → a SECOND override
    // pass so framing edits on take-* ids land on the cues the fill just
    // created. The second pass is a no-op on graphic cues (same component ⇒
    // no swap ⇒ the prop merge is idempotent) — do not "simplify" it away.
    const { cues: visibleCues } = dropHiddenCues(graphicCues, edits.doc);
    const filled = fillPlainCues(visibleCues, {
      outputDurationSec: renderProps.outputDurationSec,
      clipStarts: (renderProps.spans ?? []).map((s) => s.outIn),
    });
    const { cues } = applyOverrides(filled, edits.doc);
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
    const baseCaptions = renderProps.baseCaptionLines ?? renderProps.captionLines ?? [];
    return {
      ...renderProps,
      sceneCues: previewed,
      captionLines: applyCaptionEdits(baseCaptions, edits.doc.captions).lines,
      theme: resolveTheme(baseTheme, edits.doc),
      videoFileName: `/media/${renderProps.videoFileName}`,
    };
  }, [renderProps, edits.doc, videoPreview, graphicPreview]);

  const onSave = (): void => {
    void edits.save().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  // Render (R11 Task 4.4): save first when dirty — a render of unsaved edits
  // is the trap worth designing out — then POST and poll. On success the new
  // renderProps swap in while the CURRENT override doc, undo history and
  // selection are all KEPT (no edits.load — the server's doc is exactly what
  // was just saved). On failure the log panel stays up with the tail.
  const onRender = useCallback(async (): Promise<void> => {
    try {
      if (edits.dirty) await edits.save();
      const res = await fetch("/api/render", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `render failed to start: ${res.status}`);
      }
      setRender({ running: true, lines: [] });
      const poll = window.setInterval(() => {
        void (async () => {
          try {
            const s = await fetch("/api/render/status");
            const body = (await s.json()) as {
              running: boolean;
              exitCode: number | null;
              lines?: string[];
            };
            if (body.running || body.exitCode === null) {
              setRender({ running: body.running, lines: body.lines ?? [] });
              return;
            }
            window.clearInterval(poll);
            renderPollRef.current = null;
            if (body.exitCode === 0) {
              const p = await fetch("/api/production");
              const prod = (await p.json()) as { renderProps: RawRenderProps; canRender?: boolean };
              setRenderProps(prod.renderProps);
              setCanRender(Boolean(prod.canRender));
              setRender(null);
            } else {
              setRender({ running: false, lines: body.lines ?? [], failed: body.exitCode });
            }
          } catch {
            // Transient poll failure — keep polling; the interval survives.
          }
        })();
      }, 1000);
      renderPollRef.current = poll;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [edits]);

  // Deleted scenes, at their override-applied timing — the Timeline draws
  // them as restorable ghosts (PLAN Task C5), and selecting one resolves to
  // this list so the Inspector can offer Restore even though the live cues
  // no longer contain it.
  const ghostCues = useMemo<SceneCue[]>(() => {
    if (!renderProps) return [];
    const baseCues = (renderProps.baseSceneCues ?? renderProps.sceneCues ?? []).filter(
      (c) => c.kind !== "plain",
    );
    const { cues } = applyOverrides(baseCues, edits.doc);
    return cues.filter((c) => edits.doc.scenes[c.id]?.hidden === true);
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
    return (
      <div style={shell}>
        <div style={{ padding: 24, color: "#9A9AA3" }}>Loading production…</div>
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={topBar}>
        <span style={wordmark}>ossclip</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={ghostButton} onClick={() => edits.undo()} disabled={!edits.canUndo}>
            Undo
          </button>
          <button
            style={{ ...ghostButton, ...(edits.dirty ? primaryButton : {}) }}
            onClick={onSave}
            disabled={!edits.dirty}
          >
            Save
          </button>
          <button
            data-testid="render-button"
            style={ghostButton}
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
        </div>
        <span
          style={{ ...statusText, color: edits.dirty ? "#FFE14D" : "#5FBF77" }}
          {...(edits.dirty ? { "data-testid": "dirty" } : {})}
        >
          {edits.dirty ? "● Unsaved changes" : "✓ Saved"}
        </span>
      </div>
      {render ? (
        <div
          data-testid="render-log"
          style={{
            ...renderLog,
            borderColor: render.failed !== undefined ? "#FF5C5C" : "#2A2A33",
          }}
        >
          {render.failed !== undefined ? (
            <div style={{ color: "#FF5C5C", marginBottom: 4 }}>
              render failed (exit {render.failed})
              <button
                style={{ ...ghostButton, marginLeft: 10, padding: "2px 8px" }}
                onClick={() => setRender(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {render.lines.slice(-6).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
      <div style={mainRow}>
        <div style={stageArea}>
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
              style={{ width: 380 }}
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
              playerRef={playerRef}
              cue={selectedCue}
              onTransport={onTransport}
              onVideoPreview={setVideoPreview}
              onGraphicPreview={setGraphicPreview}
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
        <div style={sidebar}>
          <Inspector
            selection={selection}
            cue={selectedCue}
            edits={edits}
            resolvedTheme={live.theme}
            anchorText={anchorText}
            onVideoPreview={setVideoPreview}
          />
        </div>
      </div>
      <Timeline
        cues={live.sceneCues}
        ghosts={ghostCues}
        durationSec={live.outputDurationSec}
        fps={live.settings.fps}
        playerRef={playerRef}
        selection={selection}
        onSelect={setSelection}
        edits={edits}
      />
    </div>
  );
};

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

const stageArea: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 32,
  overflow: "auto",
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
  maxHeight: 110,
  overflowY: "auto",
  whiteSpace: "pre-wrap",
  flexShrink: 0,
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
