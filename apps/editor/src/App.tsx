import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import {
  applyOverrides,
  resolveTheme,
  defaultTheme,
  type OverrideDoc,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";
import { useEdits } from "./useEdits";
import { Overlay, type Selection } from "./Overlay";
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
};

export const App: React.FC = () => {
  const edits = useEdits();
  const [renderProps, setRenderProps] = useState<RawRenderProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playing, setPlaying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null!);
  const playerRef = useRef<PlayerRef>(null);

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
        const body = (await res.json()) as { renderProps: RawRenderProps; overrides: OverrideDoc };
        setRenderProps(body.renderProps);
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
    const baseCues = renderProps.baseSceneCues ?? renderProps.sceneCues ?? [];
    const baseTheme = renderProps.baseTheme ?? renderProps.theme ?? defaultTheme;
    const { cues } = applyOverrides(baseCues, edits.doc);
    return {
      ...renderProps,
      sceneCues: cues,
      theme: resolveTheme(baseTheme, edits.doc),
      videoFileName: `/media/${renderProps.videoFileName}`,
    };
  }, [renderProps, edits.doc]);

  const onSave = (): void => {
    void edits.save().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  const selectedCue = useMemo(
    () => (selection ? live?.sceneCues.find((c) => c.id === selection.sceneId) ?? null : null),
    [live, selection],
  );

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
        </div>
        <span
          style={{ ...statusText, color: edits.dirty ? "#FFE14D" : "#5FBF77" }}
          {...(edits.dirty ? { "data-testid": "dirty" } : {})}
        >
          {edits.dirty ? "● Unsaved changes" : "✓ Saved"}
        </span>
      </div>
      <div style={mainRow}>
        <div style={stageArea}>
          <div
            ref={stageRef}
            data-testid="stage"
            data-playing={playing ? "true" : "false"}
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
            />
          </div>
        </div>
        <div style={sidebar}>
          <Inspector selection={selection} cue={selectedCue} edits={edits} resolvedTheme={live.theme} />
        </div>
      </div>
      <Timeline
        cues={live.sceneCues}
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
  minHeight: "100vh",
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
