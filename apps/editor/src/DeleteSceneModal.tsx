import React, { useEffect, useRef, useState } from "react";
import type { DeletePlan, DeleteTarget } from "./deleteScene";

/**
 * The Delete/Backspace confirmation (§139). Delete/Backspace used to drop the
 * graphic outright, which made one key silently do one of two very different
 * things depending on state the user could not see — and never offered the
 * other one at all. This asks, with the recoverable option preselected.
 *
 * Rendered from App beside `ShortcutsModal` and styled off it deliberately:
 * the editor has exactly one modal idiom (fixed backdrop, `#12121A` panel,
 * mono type, an `esc` chip in the header) and a second one would read as a
 * different application.
 *
 * The panel is a FORM whose Delete is the submit button. That is what makes
 * "Enter confirms the default" true from anywhere inside it — including from
 * a radio, where a hand-rolled Enter handler would have had to reimplement
 * what the browser already does — while Cancel stays `type="button"` so it
 * cannot be triggered the same way.
 */
const COPY: Record<DeleteTarget, { label: string; detail: (plan: DeletePlan) => string }> = {
  graphic: {
    label: "just the graphic",
    // Names the consequence, not the mechanism: what the user gets back is
    // the take underneath, still playing, for the same stretch of time.
    detail: (plan) =>
      plan.isSplitHalf
        ? "this half only — the take underneath keeps playing"
        : "the take underneath keeps playing",
  },
  take: {
    label: "the whole take",
    detail: (plan) => `cuts ${(plan.endSec - plan.startSec).toFixed(1)}s out of the video`,
  },
};

export const DeleteSceneModal: React.FC<{
  plan: DeletePlan;
  onConfirm: (target: DeleteTarget) => void;
  onCancel: () => void;
}> = ({ plan, onConfirm, onCancel }) => {
  const [target, setTarget] = useState<DeleteTarget>(plan.targets[0]!);
  const panelRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // CAPTURE-phase Escape, same reason ShortcutsModal takes it in capture:
  // otherwise closing this also reaches the Overlay's Escape and clears the
  // selection the user was only asking about.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      // Focus trap. Not politeness: with focus loose, Tab reaches the
      // Timeline's blocks behind the backdrop and a Space or Enter there
      // edits the document the dialog is still asking permission about.
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>("input, button");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  // Focus the DEFAULT ACTION on open, and hand focus back to whatever had it
  // when this closes — the timeline block the user selected, in practice, so
  // the next ⌥-arrow keeps walking scenes instead of going nowhere.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => returnTo?.focus?.();
  }, []);

  return (
    <div style={backdrop} onMouseDown={onCancel}>
      <form
        ref={panelRef}
        data-testid="delete-scene-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${plan.rootId}`}
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(target);
        }}
      >
        <div style={header}>
          <span style={title}>
            delete {plan.rootId}
            {/* The `@<split id>` suffix is never shown: it is an opaque
                minted id and reads like a timestamp (§137). "half" is the
                fact the user actually needs. */}
            {plan.isSplitHalf ? <span style={halfChip}>half</span> : null}?
          </span>
          <span style={escChip}>esc cancel</span>
        </div>
        <div style={subtitle}>undoable with ⌘Z, like every other edit</div>
        <div style={{ marginTop: 16 }}>
          {plan.targets.map((t) => (
            <label key={t} style={row} data-testid={`delete-option-${t}`}>
              <input
                type="radio"
                name="delete-target"
                value={t}
                checked={target === t}
                onChange={() => setTarget(t)}
                style={radio}
              />
              <span>
                <span style={optionLabel}>{COPY[t].label}</span>
                <span style={optionDetail}>{COPY[t].detail(plan)}</span>
              </span>
            </label>
          ))}
        </div>
        <div style={actions}>
          <button type="button" data-testid="delete-cancel" style={cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} type="submit" data-testid="delete-confirm" style={confirmButton}>
            Delete
          </button>
        </div>
      </form>
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
  width: 420,
  maxWidth: "90vw",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 8,
  padding: "18px 22px 20px",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};

const title: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "#EDEDF2",
};

const halfChip: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#0B0B0E",
  background: "#c5a3ff",
  borderRadius: 4,
  padding: "2px 6px",
  // Left margin only: the "?" that follows must hug the chip, not float a
  // space away from it.
  marginLeft: 6,
};

const escChip: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#0B0B0E",
  background: "#a8c7fa",
  borderRadius: 4,
  padding: "3px 10px",
  whiteSpace: "nowrap",
};

const subtitle: React.CSSProperties = {
  fontSize: 12,
  color: "#6a6a75",
  marginTop: 4,
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "8px 0",
  cursor: "pointer",
};

const radio: React.CSSProperties = {
  accentColor: "#8ab4f8",
  marginTop: 2,
  cursor: "pointer",
};

const optionLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#EDEDF2",
};

const optionDetail: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#9A9AA3",
  marginTop: 2,
};

const actions: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 14,
};

const cancelButton: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  background: "transparent",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "7px 12px",
  cursor: "pointer",
  fontFamily: "inherit",
};

const confirmButton: React.CSSProperties = {
  ...cancelButton,
  color: "#FF5C5C",
  border: "1px solid #452626",
};
