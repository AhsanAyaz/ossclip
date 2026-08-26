import React, { useEffect } from "react";
import type { Segment } from "@ossclip/core/browser";
import type { useEdits } from "./useEdits";
import {
  REMOVAL_REASON_COLOR,
  REMOVAL_REASON_LABEL,
  cleanupReasonSummaries,
} from "./cleanup";

/**
 * The cleanup review panel (cut review step 3): one checkbox per removal
 * REASON present in produce's proposal — "remove pauses", "remove retakes" —
 * each with its count and total source seconds, so unticking one says exactly
 * what it gives back. Writes through `useEdits` (`setReasonEnabled`), so
 * undo/redo/dirty come free from `commit()`; unticking writes
 * `cleanup.reasons[reason] = false`, re-ticking DELETES the key (the
 * captionsHidden rule — a `true` entry restates the default).
 *
 * Marks rather than applies, stated in the panel itself: the preview still
 * plays the current cut, and a declined category comes back on the next
 * produce/Render — the same honesty as a not-yet-applied user cut's struck
 * band. Per-span vetoes are the timeline seams' gesture, not duplicated here.
 */

export interface CleanupPanelProps {
  /** The PROPOSAL (`production.cutlistProposed` via GET /api/cleanup) — the
   * checkboxes must keep showing a category the user already declined, which
   * the resolved cutlist cannot (a vetoed removal merges into a plain keep). */
  cutlist: readonly Segment[];
  edits: ReturnType<typeof useEdits>;
  onClose: () => void;
}

export const CleanupPanel: React.FC<CleanupPanelProps> = ({ cutlist, edits, onClose }) => {
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

  const summaries = cleanupReasonSummaries(cutlist);
  const keptCount = edits.doc.cleanup.kept.length;

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div data-testid="cleanup-modal" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={title}>Cleanup</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={subtitle}>
          What produce removed, by reason. Untick a category to keep it — the preview plays
          your choice immediately and the next render applies it. Individual removals can be
          kept by clicking their marker above the timeline; right-click a marker to say the
          classification was wrong ("not a retake").
        </div>
        {summaries.length === 0 ? (
          <div data-testid="cleanup-empty" style={{ ...subtitle, marginTop: 16 }}>
            This run proposed no removals to review.
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            {summaries.map((s) => {
              const enabled = edits.doc.cleanup.reasons[s.reason] !== false;
              return (
                <label key={s.reason} data-testid={`cleanup-reason-${s.reason}`} style={row}>
                  <input
                    type="checkbox"
                    data-testid={`cleanup-checkbox-${s.reason}`}
                    checked={enabled}
                    onChange={(e) => edits.setReasonEnabled(s.reason, e.target.checked)}
                  />
                  <span style={{ ...swatch, background: REMOVAL_REASON_COLOR[s.reason] }} />
                  <span style={{ ...rowLabel, ...(enabled ? {} : { color: "#8B8B9E" }) }}>
                    {REMOVAL_REASON_LABEL[s.reason]} — {s.count} removal{s.count === 1 ? "" : "s"}{" "}
                    · {s.seconds.toFixed(1)}s
                  </span>
                  {enabled ? null : (
                    <span data-testid={`cleanup-declined-${s.reason}`} style={declinedNote}>
                      kept — live in the preview
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {keptCount > 0 ? (
          <div data-testid="cleanup-kept-note" style={{ ...footNote, marginTop: 12 }}>
            {keptCount} individual removal{keptCount === 1 ? "" : "s"} kept via timeline markers.
          </div>
        ) : null}
        {edits.doc.cleanup.dismissed.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ ...subtitle, marginBottom: 6 }}>
              Dismissed markers — the material is ordinary footage now. Restore one to bring
              the proposal (and its marker) back.
            </div>
            {edits.doc.cleanup.dismissed.map((d) => (
              <div
                key={`${d.srcIn}-${d.srcOut}`}
                data-testid={`cleanup-dismissed-${d.srcIn}-${d.srcOut}`}
                style={row}
              >
                <span style={rowLabel}>
                  {d.srcIn.toFixed(1)}s – {d.srcOut.toFixed(1)}s ({(d.srcOut - d.srcIn).toFixed(1)}s)
                </span>
                <button
                  data-testid={`cleanup-restore-dismissed-${d.srcIn}-${d.srcOut}`}
                  style={restoreBtn}
                  onClick={() => edits.restoreDismissed(d.srcIn, d.srcOut)}
                >
                  Restore proposal
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const restoreBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Modal chrome matches ThumbnailPanel's (itself RenderModal's) — the
// editor's one dialog vocabulary.
const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  background: "rgba(5,5,8,0.75)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panel: React.CSSProperties = {
  width: 460,
  maxWidth: "92vw",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 10,
  padding: "24px 28px",
  boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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
  letterSpacing: "-0.01em",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  borderRadius: 4,
};

const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  marginBottom: 8,
  cursor: "pointer",
};

const swatch: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  flexShrink: 0,
};

const rowLabel: React.CSSProperties = {
  fontSize: 13,
  color: "#EDEDF2",
  flex: 1,
  minWidth: 0,
};

const declinedNote: React.CSSProperties = {
  fontSize: 11,
  color: "#FFE14D",
  whiteSpace: "nowrap",
};

const footNote: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  lineHeight: 1.4,
};
