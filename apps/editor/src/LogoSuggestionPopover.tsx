import React, { useEffect, useRef, useState } from "react";
import type { OverlayEntrySnapshot } from "@ossclip/core/browser";
import { logoCandidateUrl, type SuggestionChip } from "./overlayLane";
import { errorOf, postJson } from "./OverlayTray";
import { parseAliases, type LibraryEntryMeta } from "./overlayTrayModel";
import { formatMinSec } from "./PublishPanel";

/**
 * A logo suggestion chip's popover (logo-finder spec §Editor, "Click a
 * chip"): the name and timestamp, the fetched candidates as thumbnails, and
 * the three answers — Use this, Skip, Paste my own.
 *
 * "Use this" is the tray's add path with a candidate as the source, as three
 * AWAITED steps (controller ruling): `POST /api/library` with
 * `{candidate: {suggestion, n}}` (the server resolves the file, so the page
 * never sends a path), then `POST /api/overlays/stage`, then `onPicked` with
 * the staged snapshot. App turns that into ONE `addOverlay` commit, so ⌘Z
 * takes the pick back and the chip returns. A failure in either request
 * shows inline, verbatim (the tray's rule), and nothing is dispatched. The
 * library entry from step 1 outlives a failed stage on purpose: the library
 * is global and outside undo, and a retry reuses it (the server matches the
 * candidate's bytes and answers 200 with the same entry).
 *
 * Like the tray, this holds no edit logic: what a pick, a skip or a paste
 * DOES to the doc is App's call, so the reducer stays the one place a doc
 * changes.
 */
export interface LogoSuggestionPopoverProps {
  chip: SuggestionChip;
  /** The chip's on-screen box, so the popover opens beside it. */
  anchor: { left: number; top: number };
  /** The staged snapshot of the picked candidate, ready for `addOverlay`. */
  onPicked: (entry: OverlayEntrySnapshot) => void;
  onSkip: () => void;
  onPasteOwn: (name: string) => void;
  onClose: () => void;
}

const WIDTH = 300;

export const LogoSuggestionPopover: React.FC<LogoSuggestionPopoverProps> = ({
  chip,
  anchor,
  onPicked,
  onSkip,
  onPasteOwn,
  onClose,
}) => {
  /** The first candidate is preselected (spec §Editor): one click picks it. */
  const [selected, setSelected] = useState(0);
  const [name, setName] = useState(chip.name);
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * False once the popover is gone — the tray's final-review-T8 rule: a pick
   * still in flight when the user closes it must not land at a word they
   * already walked away from.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // CAPTURE-phase Escape, the tray's rule: closing must not also reach the
  // Overlay's Escape and clear the selection underneath.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const use = async () => {
    if (busy || chip.candidateCount === 0) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("give it a name — it is what the transcript is matched against");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const aliasList = parseAliases(aliases, trimmed);
      const added = await postJson("/api/library", {
        name: trimmed,
        ...(aliasList.length > 0 ? { aliases: aliasList } : {}),
        source: { candidate: { suggestion: chip.id, n: selected } },
      });
      if (!added.ok) throw new Error(await errorOf(added));
      const { entry } = (await added.json()) as { entry: LibraryEntryMeta };
      const staged = await postJson("/api/overlays/stage", { entryId: entry.id });
      if (!staged.ok) throw new Error(await errorOf(staged));
      const body = (await staged.json()) as { entry: OverlayEntrySnapshot };
      if (!mounted.current) return;
      onPicked(body.entry);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // Opens ABOVE the chip: the lane sits at the bottom of the page, so below
  // would be off screen. Clamped to the viewport horizontally.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
  const bottom = Math.max(8, window.innerHeight - anchor.top + 6);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div
        data-testid="logo-suggestion-popover"
        role="dialog"
        aria-label={`Logo for ${chip.name}`}
        style={{ ...panel, left, bottom }}
        onMouseDown={(e) => e.stopPropagation()}
        // Keys typed into the name stay here (the tray's rule): Delete or
        // Space must not reach the editor's shortcuts. ⌘/Ctrl still pass.
        onKeyDown={(e) => {
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
        }}
      >
        <div style={header}>
          <div style={title}>
            {chip.name} <span style={muted}>· {formatMinSec(chip.atSec)}</span>
          </div>
          <button data-testid="logo-suggestion-close" style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {chip.candidateCount === 0 ? (
          <div data-testid="logo-suggestion-note" style={{ ...muted, marginTop: 10 }}>
            {chip.note ?? "no logo found"}
          </div>
        ) : (
          <div style={thumbs}>
            {Array.from({ length: chip.candidateCount }, (_, n) => (
              <button
                key={n}
                data-testid={`logo-candidate-${n}`}
                {...(n === selected ? { "data-selected": "true" } : {})}
                style={{ ...thumb, borderColor: n === selected ? "#00E5A3" : "#2C2C38" }}
                disabled={busy}
                onClick={() => setSelected(n)}
              >
                <img src={logoCandidateUrl(chip.id, n)} alt="" draggable={false} style={thumbImg} />
              </button>
            ))}
          </div>
        )}

        {chip.candidateCount === 0 ? null : (
          <div style={form}>
            <label style={fieldLabel}>
              Name
              <input
                data-testid="logo-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void use();
                }}
                style={textInput}
              />
            </label>
            <label style={fieldLabel}>
              Aliases (comma-separated, optional)
              <input
                data-testid="logo-aliases"
                type="text"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                style={textInput}
              />
            </label>
          </div>
        )}

        <div style={actions}>
          <button data-testid="logo-skip" style={secondaryBtn} disabled={busy} onClick={onSkip}>
            Skip
          </button>
          <button
            data-testid="logo-paste-own"
            style={secondaryBtn}
            disabled={busy}
            onClick={() => onPasteOwn(name.trim() === "" ? chip.name : name.trim())}
          >
            Paste my own
          </button>
          {chip.candidateCount === 0 ? null : (
            <button data-testid="logo-use" style={confirmBtn} disabled={busy} onClick={() => void use()}>
              {busy ? "Adding…" : "Use this"}
            </button>
          )}
        </div>

        {error !== null ? (
          <div data-testid="logo-suggestion-error" role="alert" style={errorStyle}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// The tray's palette (OverlayTray.tsx), at popover scale.
const backdrop: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 40 };

const panel: React.CSSProperties = {
  position: "fixed",
  width: WIDTH,
  boxSizing: "border-box",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 8,
  padding: "12px 14px",
  boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#EDEDF2",
};

const header: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center" };

const title: React.CSSProperties = { fontSize: 14, fontWeight: 700 };

const muted: React.CSSProperties = { fontSize: 12, fontWeight: 400, color: "#8B8B9E" };

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 14,
  cursor: "pointer",
  padding: "2px 6px",
};

const thumbs: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 10 };

const thumb: React.CSSProperties = {
  background: "#1A1A24",
  borderWidth: 2,
  borderStyle: "solid",
  borderRadius: 6,
  padding: 4,
  cursor: "pointer",
  height: 56,
};

const thumbImg: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" };

const form: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 };

const fieldLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#C9C9D4" };

const textInput: React.CSSProperties = {
  background: "#09090D",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "6px 10px",
  color: "#EDEDF2",
  fontSize: 13,
  outline: "none",
};

const actions: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 };

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3A3A48",
  borderRadius: 6,
  color: "#C9C9D4",
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const confirmBtn: React.CSSProperties = {
  background: "#00E5A3",
  border: "none",
  borderRadius: 6,
  color: "#051A13",
  padding: "6px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  color: "#FF6B6B",
  background: "rgba(255,107,107,0.08)",
  border: "1px solid rgba(255,107,107,0.3)",
  borderRadius: 6,
  padding: "6px 8px",
};
