import React, { useEffect, useState } from "react";

export interface RenderModalProps {
  defaultOutPath?: string;
  onCancel: () => void;
  onConfirm: (outPath?: string, replan?: boolean) => void;
}

export const RenderModal: React.FC<RenderModalProps> = ({
  defaultOutPath,
  onCancel,
  onConfirm,
}) => {
  const [outPath, setOutPath] = useState(defaultOutPath ?? "");
  // Default OFF: a render from the editor reproduces the plan on screen.
  // Ticking this asks the LLM for a fresh one, which renumbers scenes and
  // can orphan edits anchored to the old numbering (renderReplayArgs).
  const [replan, setReplan] = React.useState(false);
  const [isPicking, setIsPicking] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter" && !isPicking) {
        e.preventDefault();
        onConfirm(outPath.trim() ? outPath.trim() : undefined, replan);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm, outPath, isPicking, replan]);

  const handleBrowse = async () => {
    setIsPicking(true);
    try {
      const res = await fetch("/api/pick-save-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPath: outPath || defaultOutPath }),
      });
      if (res.ok) {
        const data = (await res.json()) as { path: string | null };
        if (data.path) {
          setOutPath(data.path);
        }
      }
    } catch {
      // ignore
    } finally {
      setIsPicking(false);
    }
  };

  return (
    <div style={backdrop} onMouseDown={onCancel}>
      <div
        data-testid="render-modal"
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <div style={title}>🎬 Render Master Video</div>
          <button style={closeBtn} onClick={onCancel}>
            ✕
          </button>
        </div>
        <div style={subtitle}>
          Choose where to export your rendered master cut, or keep the default location.
        </div>

        <div style={{ marginTop: 20 }}>
          <label style={labelStyle}>Export File Destination</label>
          <div style={inputRow}>
            <input
              data-testid="render-outpath-input"
              type="text"
              value={outPath}
              onChange={(e) => setOutPath(e.target.value)}
              placeholder="e.g. /Users/name/Movies/final-cut.mp4"
              style={textInput}
              autoFocus
            />
            <button
              data-testid="render-browse-btn"
              style={browseBtn}
              onClick={handleBrowse}
              disabled={isPicking}
              title="Open native file picker to choose destination"
            >
              {isPicking ? "Browsing…" : "📁 Browse…"}
            </button>
          </div>
        </div>

        <div style={footerRow}>
          <button style={cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0", fontSize: 13, opacity: 0.85 }}>
            <input
              type="checkbox"
              data-testid="render-replan"
              checked={replan}
              onChange={(e) => setReplan(e.target.checked)}
            />
            Re-plan graphics with the LLM (discards the reviewed plan)
          </label>
          <button
            data-testid="render-confirm-btn"
            style={confirmBtn}
            onClick={() => onConfirm(outPath.trim() ? outPath.trim() : undefined, replan)}
          >
            Start Render ⚡
          </button>
        </div>
      </div>
    </div>
  );
};

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
  width: 560,
  maxWidth: "92vw",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 10,
  padding: "24px 28px",
  boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
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

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 8,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const inputRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const textInput: React.CSSProperties = {
  flex: 1,
  background: "#09090D",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  outline: "none",
};

const browseBtn: React.CSSProperties = {
  background: "#1E1E2A",
  border: "1px solid #3A3A48",
  borderRadius: 6,
  color: "#EDEDF2",
  padding: "0 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 12,
  marginTop: 24,
};

const cancelBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  color: "#C9C9D4",
  padding: "9px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const confirmBtn: React.CSSProperties = {
  background: "#00E5A3",
  border: "none",
  borderRadius: 6,
  color: "#051A13",
  padding: "9px 20px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,229,163,0.3)",
};
