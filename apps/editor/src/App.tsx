import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import { applyOverrides, resolveTheme, defaultTheme } from "@ossclip/core/browser";
import { useEdits } from "./useEdits";
import { Overlay, type Selection } from "./Overlay";
import { Inspector } from "./Inspector";

/**
 * `<Player>`'s generics require `Props extends Record<string, unknown>`, and
 * a plain `interface` (like `ProductionCompProps`) has no index signature, so
 * TS's generic-constraint check rejects it outright ("Index signature for
 * type 'string' is missing") even though every property IS a string key.
 * Intersecting with `Record<string, unknown>` gives the type checker an
 * actual index signature to see, without changing the runtime shape.
 */
type PlayerProductionProps = ProductionCompProps & Record<string, unknown>;

export const App: React.FC = () => {
  const edits = useEdits();
  const [renderProps, setRenderProps] = useState<PlayerProductionProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const stageRef = useRef<HTMLDivElement>(null!);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/production");
        if (!res.ok) throw new Error(`GET /api/production failed: ${res.status}`);
        const body = await res.json();
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
    const { cues } = applyOverrides(renderProps.sceneCues ?? [], edits.doc);
    return {
      ...renderProps,
      sceneCues: cues,
      theme: resolveTheme(renderProps.theme ?? defaultTheme, edits.doc),
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
        <span style={{ ...statusText, color: edits.dirty ? "#FFE14D" : "#5FBF77" }}>
          {edits.dirty ? "● Unsaved changes" : "✓ Saved"}
        </span>
      </div>
      <div style={mainRow}>
        <div style={stageArea}>
          <div ref={stageRef} style={{ position: "relative", display: "inline-block" }}>
            <Player<AnyZodObject, PlayerProductionProps>
              component={ProductionComposition}
              inputProps={live}
              durationInFrames={Math.max(1, Math.round(live.outputDurationSec * live.settings.fps))}
              fps={live.settings.fps}
              compositionWidth={live.settings.width}
              compositionHeight={live.settings.height}
              style={{ width: 380 }}
              controls
            />
            <Overlay stageRef={stageRef} selection={selection} onSelect={setSelection} edits={edits} />
          </div>
        </div>
        <div style={sidebar}>
          <Inspector selection={selection} cue={selectedCue} edits={edits} />
        </div>
      </div>
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
