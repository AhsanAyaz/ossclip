import React, { useEffect, useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { ProductionComposition } from "@ossclip/renderer/composition";
import { applyOverrides, resolveTheme, defaultTheme } from "@ossclip/core/browser";
import { useEdits } from "./useEdits";

// The Player's prop-generic inference fights any concrete interface here
// (it wants either a zod `schema` or a `defaultProps` matching exactly), so
// the fetched render props are kept loose — same as the brief's own sketch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRenderProps = any;

export const App: React.FC = () => {
  const edits = useEdits();
  const [renderProps, setRenderProps] = useState<AnyRenderProps>(null);
  const [error, setError] = useState<string | null>(null);

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

  const live = useMemo<AnyRenderProps>(() => {
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

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: "#c00" }}>Error: {error}</div>
    );
  }

  if (!live) {
    return <div style={{ padding: 24, fontFamily: "system-ui" }}>Loading…</div>;
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => edits.undo()} disabled={!edits.canUndo}>
          Undo
        </button>
        <button onClick={onSave} disabled={!edits.dirty}>
          Save
        </button>
        <span>{edits.dirty ? "Unsaved changes" : "Saved"}</span>
      </div>
      <Player
        component={ProductionComposition}
        inputProps={live}
        durationInFrames={Math.max(1, Math.round(live.outputDurationSec * live.settings.fps))}
        fps={live.settings.fps}
        compositionWidth={live.settings.width}
        compositionHeight={live.settings.height}
        style={{ width: 360 }}
        controls
      />
    </div>
  );
};
