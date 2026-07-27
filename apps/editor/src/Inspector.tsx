import React from "react";
import type { SceneCue } from "@ossclip/core/browser";
import type { useEdits } from "./useEdits";
import type { Selection } from "./Overlay";

interface InspectorProps {
  selection: Selection | null;
  /** The currently-selected scene's resolved cue, or null when nothing is selected. */
  cue: SceneCue | null;
  edits: ReturnType<typeof useEdits>;
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
}> = ({ id, value, onCommit }) => (
  <div style={row}>
    <span style={label}>{id}</span>
    <input
      type="number"
      style={numberInput}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onCommit(Number(e.target.value))}
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
export const Inspector: React.FC<InspectorProps> = ({ selection, cue, edits }) => {
  if (selection?.elementId && cue) {
    const elementId = selection.elementId;
    const transform = cue.elements?.[elementId] ?? {};
    const text = cue.props[elementId];
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
          <NumberField
            id="x"
            value={transform.dx ?? 0}
            onCommit={(v) => edits.patchElement(selection.sceneId, elementId, { dx: v })}
          />
          <NumberField
            id="y"
            value={transform.dy ?? 0}
            onCommit={(v) => edits.patchElement(selection.sceneId, elementId, { dy: v })}
          />
          <NumberField
            id="scale"
            value={transform.scale ?? 1}
            onCommit={(v) => edits.patchElement(selection.sceneId, elementId, { scale: v })}
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
    return (
      <div>
        <div style={section}>
          <span style={label}>Scene</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {selection.sceneId}
          </div>
        </div>
        <div style={section}>
          <div style={row}>
            <span style={label}>Component</span>
            {/* Component/layout swaps aren't wired to the override doc yet —
                shown as read-only so the panel isn't lying about what a
                change here would do. */}
            <select style={numberInput} value={cue.component} disabled>
              <option value={cue.component}>{cue.component}</option>
            </select>
          </div>
          <div style={row}>
            <span style={label}>Layout</span>
            <select style={numberInput} value={cue.layout} disabled>
              <option value={cue.layout}>{cue.layout}</option>
            </select>
          </div>
        </div>
        <div style={section}>
          <span style={label}>Timing</span>
          <div style={{ fontSize: 13, color: cue.pinned ? "#FFE14D" : "#9A9AA3" }}>
            {cue.pinned
              ? `Pinned ${cue.startSec.toFixed(2)}s – ${cue.endSec.toFixed(2)}s`
              : "Tracking transcript"}
          </div>
        </div>
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
        <ThemeField id="accent" value={theme.accent ?? "#FFE14D"} isColor onCommit={(v) => patch("accent", v)} />
        <ThemeField id="bg" value={theme.bg ?? "#0B0B0E"} isColor onCommit={(v) => patch("bg", v)} />
        <ThemeField id="fg" value={theme.fg ?? "#FFFFFF"} isColor onCommit={(v) => patch("fg", v)} />
        <NumberField id="radiusPx" value={theme.radiusPx ?? 24} onCommit={(v) => patch("radiusPx", v)} />
        <ThemeField
          id="fontDisplay"
          value={theme.fontDisplay ?? ""}
          isColor={false}
          onCommit={(v) => patch("fontDisplay", v)}
        />
      </div>
    </div>
  );
};
