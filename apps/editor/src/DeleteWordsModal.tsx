import React, { useEffect, useRef, useState } from "react";
import type { DeleteWordsPlan, DeleteWordsTarget } from "./deleteWords";

/**
 * The transcript's Delete confirmation (§59b revisited 2026-08-18) — the
 * word-range sibling of `DeleteSceneModal`, and deliberately its twin in
 * every mechanism: the editor has exactly one modal idiom (fixed backdrop,
 * `#12121A` panel, mono type, an `esc` chip in the header) and a second one
 * would read as a different application. See that file's comments for the
 * form-submit Enter contract, the capture-phase Escape and the focus trap —
 * they are copied, not re-derived.
 *
 * The caption-only option leads and is preselected because it is the
 * recoverable one (the `deletePlanFor` graphic-first rationale): one Restore
 * click brings the words back, whereas a cut window only lands on the next
 * produce. The video option's copy must say "next Render" — the live
 * preview deliberately never applies `doc.cuts` (App.tsx's `live` memo).
 */
const COPY: Record<DeleteWordsTarget, { label: string; detail: (plan: DeleteWordsPlan) => string }> =
  {
    caption: {
      label: "Remove from captions only",
      // Names what survives, not the mechanism — the DeleteSceneModal rule.
      detail: () => "restorable — the words stay in the transcript and the audio",
    },
    "caption-video": {
      label: "Remove captions + video",
      detail: (plan) =>
        `cuts ${(plan.endSec - plan.startSec).toFixed(1)}s out of the video on the next Render; ` +
        "captions disappear now",
    },
  };

export const DeleteWordsModal: React.FC<{
  plan: DeleteWordsPlan;
  onConfirm: (target: DeleteWordsTarget) => void;
  onCancel: () => void;
}> = ({ plan, onConfirm, onCancel }) => {
  const [target, setTarget] = useState<DeleteWordsTarget>(plan.targets[0]!);
  const panelRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // CAPTURE-phase Escape + focus trap, verbatim from DeleteSceneModal (its
  // comments carry the why for both).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
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

  // Focus the default action on open, return focus on close — the
  // transcript pane in practice, so the next keystroke keeps working there.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => returnTo?.focus?.();
  }, []);

  const n = plan.words.length;
  return (
    <div style={backdrop} onMouseDown={onCancel}>
      <form
        ref={panelRef}
        data-testid="delete-words-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${n} word${n === 1 ? "" : "s"}`}
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(target);
        }}
      >
        <div style={header}>
          <span style={title}>
            delete {n} word{n === 1 ? "" : "s"}?
          </span>
          <span style={escChip}>esc cancel</span>
        </div>
        <div style={subtitle}>undoable with ⌘Z, like every other edit</div>
        <div style={{ marginTop: 16 }}>
          {plan.targets.map((t) => (
            <label key={t} style={row} data-testid={`delete-words-option-${t}`}>
              <input
                type="radio"
                name="delete-words-target"
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
          <button
            type="button"
            data-testid="delete-words-cancel"
            style={cancelButton}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="submit"
            data-testid="delete-words-confirm"
            style={confirmButton}
          >
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
