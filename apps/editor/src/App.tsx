import React, { useEffect, useMemo, useState } from "react";
import { Player } from "@remotion/player";
import type { AnyZodObject } from "remotion";
import { ProductionComposition, type ProductionCompProps } from "@ossclip/renderer/composition";
import { applyOverrides, resolveTheme, defaultTheme } from "@ossclip/core/browser";
import { useEdits } from "./useEdits";

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
      <Player<AnyZodObject, PlayerProductionProps>
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
