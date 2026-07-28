import React from "react";
import { LayoutSchema, SceneComponentIdSchema, type SceneCue, type Theme } from "@ossclip/core/browser";
import type { useEdits } from "./useEdits";
import type { Selection, VideoPreview } from "./Overlay";

interface InspectorProps {
  selection: Selection | null;
  /** The currently-selected scene's resolved cue, or null when nothing is selected. */
  cue: SceneCue | null;
  edits: ReturnType<typeof useEdits>;
  /**
   * The theme actually on screen right now (defaults merged with the
   * override doc) — the fallback a theme field shows when the user hasn't
   * overridden that token. Hardcoding a fallback here instead (as before)
   * would show the wrong swatch for anyone whose production resolved to a
   * theme other than `defaultTheme`.
   */
  resolvedTheme: Theme;
  /** The caption words under the cue's window — what "tracking" tracks. */
  anchorText?: string;
  /** Live framing preview (PLAN Task B) — the zoom slider writes it while
   * scrubbing, the release commits the real patch and clears it. */
  onVideoPreview: (preview: VideoPreview | null) => void;
}

const row: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#9A9AA3",
};
const numberInput: React.CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  fontSize: 13,
  background: "#0F0F14",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  color: "#fff",
  padding: "6px 8px",
  width: "100%",
};
const textInput: React.CSSProperties = {
  ...numberInput,
  fontFamily: "'Inter', system-ui, sans-serif",
};
const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "16px 18px",
  borderBottom: "1px solid #22222a",
};
const button: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#FF5C5C",
  background: "transparent",
  border: "1px solid #452626",
  borderRadius: 6,
  padding: "7px 10px",
  cursor: "pointer",
};

const NumberField: React.FC<{
  id: string;
  value: number;
  onCommit: (v: number) => void;
  /**
   * HTML's default step is 1, which silently marks 0.62 INVALID and refuses
   * to commit it — that made the 0–1 video-framing scale useless and has
   * quietly afflicted every numeric field since they shipped (FINDINGS §43).
   * "any" accepts decimals; pass a number only to genuinely quantise.
   */
  step?: number | "any";
  min?: number;
  max?: number;
}> = ({ id, value, onCommit, step = "any", min, max }) => (
  <div style={row}>
    <span style={label}>{id}</span>
    <input
      type="number"
      data-testid={`field-${id}`}
      style={numberInput}
      step={step}
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        // An in-progress value like "-" or "" parses to NaN (or, for some
        // browsers, an empty string parses to 0 which is fine) — only
        // dispatch once the field holds a real number, so a still-typing
        // input never JSON.stringifies to `null` and corrupts the stored
        // transform. Clamp to the declared range so the schema's own bounds
        // (`positive().max(4)`) reject nothing the UI accepted.
        const parsed = Number(e.target.value);
        if (!Number.isFinite(parsed)) return;
        const lo = min ?? -Infinity;
        const hi = max ?? Infinity;
        onCommit(Math.min(hi, Math.max(lo, parsed)));
      }}
    />
  </div>
);

const ThemeField: React.FC<{
  id: string;
  value: string;
  isColor: boolean;
  onCommit: (v: string | number) => void;
}> = ({ id, value, isColor, onCommit }) => (
  <div style={row}>
    <span style={label}>{id}</span>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {isColor ? (
        <input
          type="color"
          value={value}
          onChange={(e) => onCommit(e.target.value)}
          style={{ width: 28, height: 28, border: "1px solid #2A2A33", borderRadius: 6, padding: 0, background: "none" }}
        />
      ) : null}
      <input
        style={{ ...textInput, flex: 1 }}
        value={value}
        onChange={(e) => onCommit(isColor ? e.target.value : e.target.value)}
      />
    </div>
  </div>
);

/**
 * Precision editing to complement the drag-and-drop overlay. Dragging is
 * imprecise; typing a value (including `0`, to cleanly undo a nudge) goes
 * straight to `patchElement`/`patchTheme` rather than waiting on a blur.
 */
export const Inspector: React.FC<InspectorProps> = ({
  selection,
  cue,
  edits,
  resolvedTheme,
  anchorText,
  onVideoPreview,
}) => {
  if (selection?.elementId && cue) {
    const elementId = selection.elementId;
    const transform = cue.elements?.[elementId] ?? {};
    // Optional-chained for the type only: an element selection implies a
    // graphic cue — plain cues render no `data-edit-id` leaves to select.
    const text = cue.props?.[elementId];
    return (
      <div>
        <div style={section}>
          <span style={label}>Selected</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {elementId}
          </div>
        </div>
        {typeof text === "string" ? (
          <div style={section}>
            <div style={row}>
              <span style={label}>Text</span>
              <input
                style={textInput}
                value={text}
                onChange={(e) => edits.patchProps(selection.sceneId, { [elementId]: e.target.value })}
              />
            </div>
          </div>
        ) : null}
        <div style={section}>
          {/* Typing "120" is one gesture, not three edits — the coalesce key
              collapses the keystroke burst into a single undo step (B5). */}
          <NumberField
            id="x"
            value={transform.dx ?? 0}
            onCommit={(v) =>
              edits.patchElement(selection.sceneId, elementId, { dx: v }, `element:${selection.sceneId}:${elementId}:dx`)
            }
          />
          <NumberField
            id="y"
            value={transform.dy ?? 0}
            onCommit={(v) =>
              edits.patchElement(selection.sceneId, elementId, { dy: v }, `element:${selection.sceneId}:${elementId}:dy`)
            }
          />
          <NumberField
            id="scale"
            value={transform.scale ?? 1}
            min={0.05}
            max={4}
            onCommit={(v) =>
              edits.patchElement(selection.sceneId, elementId, { scale: v }, `element:${selection.sceneId}:${elementId}:scale`)
            }
          />
        </div>
        <div style={section}>
          <button style={button} onClick={() => edits.clearElement(selection.sceneId, elementId)}>
            Reset element
          </button>
        </div>
      </div>
    );
  }

  if (selection && cue) {
    const isPlain = cue.kind === "plain";
    // A deleted scene (PLAN Task C4): the ghost selection resolves here, and
    // the ONLY offer is the way back — its other controls would edit a scene
    // that isn't rendering.
    if (edits.doc.scenes[selection.sceneId]?.hidden === true) {
      return (
        <div>
          <div style={section}>
            <span style={label}>Scene</span>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
              {selection.sceneId} <span style={{ color: "#9A9AA3", fontWeight: 400 }}>(deleted)</span>
            </div>
            <div style={{ fontSize: 12, color: "#9A9AA3" }}>
              Its window plays as a plain take. Restore brings the graphic back.
            </div>
            <button
              data-testid="restore-scene"
              style={{ ...button, color: "#5FBF77", border: "1px solid #24402c" }}
              onClick={() => edits.restoreScene(selection.sceneId)}
            >
              Restore scene
            </button>
          </div>
        </div>
      );
    }
    return (
      <div>
        <div style={section}>
          <span style={label}>{isPlain ? "Take" : "Scene"}</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {selection.sceneId}
          </div>
          {isPlain ? (
            <div style={{ fontSize: 12, color: "#9A9AA3" }}>
              A continuous stretch of the talking head — no graphic. Frame it
              below; its window follows the cut.
            </div>
          ) : null}
        </div>
        <div style={section}>
          {!isPlain && cue.component ? (
            <div style={row}>
              <span style={label}>Component</span>
              {/* Swapping the component re-resolves props against the NEW
                  component's defaults (see `applyOverrides`) — the producer's
                  old props were shaped for a different schema and don't carry
                  over, so the swap renders something coherent instead of an
                  invalid scene. */}
              <select
                style={numberInput}
                value={cue.component}
                onChange={(e) =>
                  edits.patchComponent(
                    selection.sceneId,
                    e.target.value as NonNullable<SceneCue["component"]>,
                  )
                }
              >
                {SceneComponentIdSchema.options.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div style={row}>
            <span style={label}>Layout</span>
            <select
              style={numberInput}
              value={cue.layout}
              onChange={(e) => edits.patchLayout(selection.sceneId, e.target.value as SceneCue["layout"])}
            >
              {LayoutSchema.options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={section}>
          {/* Direct manipulation first (PLAN Task B4): a zoom slider with a
              live preview, pan by dragging the picture on the stage. The
              number fields stay as the precision fallback — and keep
              step="any", which the R9-5 e2e pins. Scale under 1 zooms OUT:
              more of the source, backdrop showing where it no longer
              covers. */}
          <span style={label}>Video framing</span>
          <div style={row}>
            <span style={label}>
              zoom{"  "}
              <span style={{ color: "#EDEDF2" }}>
                {(cue.video?.scale ?? 1).toFixed(2)}×
              </span>
            </span>
            <input
              type="range"
              data-testid="zoom-slider"
              min={0.5}
              max={3}
              step={0.01}
              value={cue.video?.scale ?? 1}
              // Scrub = live preview only; the REAL patch lands once, on
              // release, so one slider gesture is one undo step.
              onChange={(e) =>
                onVideoPreview({
                  sceneId: selection.sceneId,
                  patch: { scale: Number(e.target.value) },
                })
              }
              onPointerUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`);
                onVideoPreview(null);
              }}
              onKeyUp={(e) => {
                // Only keys that actually move a range input commit — a
                // stray keyup (the "s" of Cmd+S, a modifier) must not
                // re-commit the current value and un-save the document.
                const moves = [
                  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                  "Home", "End", "PageUp", "PageDown",
                ];
                if (!moves.includes(e.key)) return;
                const v = Number((e.target as HTMLInputElement).value);
                edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`);
                onVideoPreview(null);
              }}
            />
          </div>
          <label
            style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#9A9AA3", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              data-testid="auto-zoom"
              checked={cue.video?.autoZoom !== false}
              onChange={(e) => edits.patchVideo(selection.sceneId, { autoZoom: e.target.checked })}
            />
            auto zoom (the slow push composes on top of your zoom)
          </label>
          <div style={{ fontSize: 12, color: "#9A9AA3" }}>
            Pan: drag the picture on the stage.
          </div>
          <NumberField
            id="scale"
            value={cue.video?.scale ?? 1}
            min={0.05}
            max={4}
            onCommit={(v) =>
              edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`)
            }
          />
          <NumberField
            id="dx"
            value={cue.video?.dx ?? 0}
            onCommit={(v) =>
              edits.patchVideo(selection.sceneId, { dx: v }, `video:${selection.sceneId}:dx`)
            }
          />
          <NumberField
            id="dy"
            value={cue.video?.dy ?? 0}
            onCommit={(v) =>
              edits.patchVideo(selection.sceneId, { dy: v }, `video:${selection.sceneId}:dy`)
            }
          />
          {cue.video ? (
            <button style={button} onClick={() => edits.clearVideo(selection.sceneId)}>
              Reset framing
            </button>
          ) : null}
        </div>
        <div style={section}>
          <span style={label}>Timing</span>
          {/* The resolved window ALWAYS shows (FINDINGS §44) — an unpinned cue
              still has one, and "tracking transcript" with no times told the
              user nothing about the scene they were looking at. Pinned vs
              tracking is a label on the times, not a replacement for them. */}
          <div
            data-testid="timing-range"
            style={{ fontSize: 13, fontFamily: "ui-monospace, 'SF Mono', monospace" }}
          >
            {cue.startSec.toFixed(2)}s – {cue.endSec.toFixed(2)}s
            <span style={{ color: "#9A9AA3" }}>
              {"  "}({(cue.endSec - cue.startSec).toFixed(2)}s)
            </span>
          </div>
          <div style={{ fontSize: 12, color: cue.pinned ? "#FFE14D" : "#9A9AA3" }}>
            {isPlain
              ? "Derived from the cut — not movable"
              : cue.pinned
                ? "Pinned to these times"
                : "Tracking transcript"}
          </div>
          {!cue.pinned && anchorText ? (
            <div style={{ fontSize: 12, color: "#9A9AA3", fontStyle: "italic" }}>
              “{anchorText}”
            </div>
          ) : null}
          {cue.pinned ? (
            <button style={button} onClick={() => edits.clearTiming(selection.sceneId)}>
              Un-pin (re-anchor to words)
            </button>
          ) : null}
        </div>
        {!isPlain ? (
          <div style={section}>
            {/* Soft delete (PLAN Task C): the block goes ghost, the window
                becomes a plain take, and Restore undoes it — so this is
                danger-styled but not destructive. Delete/Backspace does the
                same from the keyboard. */}
            <button
              data-testid="delete-scene"
              style={button}
              onClick={() => edits.hideScene(selection.sceneId)}
            >
              Delete scene
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const theme = edits.doc.theme;
  const patch = (key: string, v: string | number) => edits.patchTheme({ [key]: v });
  return (
    <div>
      <div style={section}>
        <span style={label}>Theme</span>
        <div style={{ fontSize: 12, color: "#9A9AA3" }}>Nothing selected — global tokens.</div>
      </div>
      <div style={section}>
        <ThemeField id="accent" value={theme.accent ?? resolvedTheme.accent} isColor onCommit={(v) => patch("accent", v)} />
        <ThemeField id="bg" value={theme.bg ?? resolvedTheme.bg} isColor onCommit={(v) => patch("bg", v)} />
        <ThemeField id="fg" value={theme.fg ?? resolvedTheme.fg} isColor onCommit={(v) => patch("fg", v)} />
        <NumberField id="radiusPx" value={theme.radiusPx ?? resolvedTheme.radiusPx} min={0} onCommit={(v) => patch("radiusPx", v)} />
        <ThemeField
          id="fontDisplay"
          value={theme.fontDisplay ?? resolvedTheme.fontDisplay}
          isColor={false}
          onCommit={(v) => patch("fontDisplay", v)}
        />
      </div>
    </div>
  );
};
