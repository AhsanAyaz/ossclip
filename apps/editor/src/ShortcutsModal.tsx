import React, { useEffect } from "react";

/**
 * The keybinds reference (R16 §63) — a modal listing every shortcut the app
 * answers to, grouped the way the work is grouped. STATIC data, maintained
 * beside the handlers it documents: a list generated from the handlers would
 * be over-engineering, and a stale row here fails the e2e that greps for the
 * bindings it exercises.
 */
const SECTIONS: Array<{ title: string; rows: Array<[keys: string, action: string]> }> = [
  {
    title: "transport",
    rows: [
      ["space", "play / pause"],
      ["J / K / L", "reverse · pause · forward (tap again to speed up)"],
      ["← / →", "step one frame back / forward"],
      ["⌘/ctrl + ← / →", "jump to and select the previous / next scene"],
    ],
  },
  {
    title: "selection",
    rows: [
      ["click", "select scene or element"],
      ["⌥ + ← / →", "select previous / next scene"],
      ["esc", "clear selection · close dialogs"],
    ],
  },
  {
    title: "editing",
    rows: [
      ["⌘/ctrl + B", "split the scene at the playhead"],
      ["delete / backspace", "delete the selected scene (restorable)"],
      ["⌘/ctrl + Z", "undo"],
      ["⌘/ctrl + ⇧ + Z", "redo (⌘Y works too)"],
      ["⌘/ctrl + S", "save"],
      ["double-click caption word", "retype it in place"],
      ["drag element / corner handles", "move · resize"],
      ["drag picture", "pan the video framing"],
    ],
  },
  {
    title: "view",
    rows: [
      ["⌘/ctrl + scroll on preview", "zoom the view (never edits)"],
      ["⌥-drag / middle-drag", "pan the zoomed view"],
      ["⌘/ctrl + scroll on timeline", "zoom the timeline"],
      ["?", "this reference"],
    ],
  },
];

export const ShortcutsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  // CAPTURE-phase Escape, so closing the modal doesn't also clear the
  // selection through the Overlay's own Escape handler.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div
        data-testid="shortcuts-modal"
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <span style={title}>keybinds</span>
          <span style={escChip}>esc close</span>
        </div>
        <div style={subtitle}>available commands and configured shortcuts</div>
        {SECTIONS.map((s) => (
          <div key={s.title} style={{ marginTop: 18 }}>
            <div style={sectionTitle}>{s.title}</div>
            {s.rows.map(([keys, action]) => (
              <div key={keys} style={row}>
                <span style={keyText}>{keys}</span>
                <span style={actionText}>{action}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 30,
  background: "rgba(5,5,8,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panel: React.CSSProperties = {
  width: 620,
  maxWidth: "90vw",
  maxHeight: "82vh",
  overflowY: "auto",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 8,
  padding: "20px 26px 26px",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#EDEDF2",
};

const escChip: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#0B0B0E",
  background: "#a8c7fa",
  borderRadius: 4,
  padding: "3px 10px",
};

const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#6a6a75",
  marginTop: 4,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#8ab4f8",
  marginBottom: 6,
};

const row: React.CSSProperties = {
  display: "flex",
  gap: 16,
  padding: "3px 0",
};

const keyText: React.CSSProperties = {
  width: 290,
  flexShrink: 0,
  color: "#c5a3ff",
  fontWeight: 600,
  fontSize: 13,
};

const actionText: React.CSSProperties = {
  color: "#C9C9D4",
  fontSize: 13,
};
