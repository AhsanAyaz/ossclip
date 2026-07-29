import React, { useEffect, useState } from "react";

/**
 * The project picker (R17 §83): what a bare `ossclip edit` opens onto, and
 * what the top bar's Open button raises to switch projects mid-session.
 * Two ways in, matching how people actually find their work: the recents
 * list (every produce run and every open records itself) and a plain folder
 * browser over `/api/fs`. Both resolve to the same `POST /api/workdir`.
 *
 * `required` is the bare-launch state — no project is open, so there is
 * nothing to go back to and the backdrop/Escape do NOT dismiss. As a
 * switcher the usual modal manners apply.
 */
type FsEntry = { name: string; path: string; isWorkdir: boolean };
type FsListing = { dir: string; parent: string | null; isWorkdir: boolean; entries: FsEntry[] };

export const ProjectPicker: React.FC<{
  recent: string[];
  required: boolean;
  /** Resolves to an error message to show, or null on success (the caller
   * unmounts the picker as part of loading the new project). */
  onOpen: (path: string) => Promise<string | null>;
  onClose: () => void;
}> = ({ recent, required, onOpen, onClose }) => {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async (dir?: string): Promise<void> => {
    try {
      const res = await fetch(`/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
      const body = (await res.json()) as FsListing & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `listing failed: ${res.status}`);
      setListing(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void browse();
    // The browser starts at home once per mount; navigation is click-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (required) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [required, onClose]);

  const open = (path: string): void => {
    setBusy(true);
    setError(null);
    void onOpen(path).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <div style={backdrop} onMouseDown={required ? undefined : onClose}>
      <div data-testid="project-picker" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={title}>{required ? "open a project" : "switch project"}</span>
          {required ? null : (
            <button data-testid="project-picker-close" style={closeButton} onClick={onClose}>
              esc close
            </button>
          )}
        </div>
        <div style={subtitle}>
          A project is a work directory a `ossclip produce` run wrote — the folder holding
          render-props.json.
        </div>
        {error ? (
          <div data-testid="project-picker-error" style={errorLine}>
            {error}
          </div>
        ) : null}
        {recent.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div style={sectionTitle}>recent</div>
            {recent.map((p) => (
              <button
                key={p}
                data-testid="project-recent"
                style={entryButton}
                disabled={busy}
                onClick={() => open(p)}
                title={p}
              >
                <span style={{ color: "#FFE14D", marginRight: 8 }}>▸</span>
                {p}
              </button>
            ))}
          </div>
        ) : null}
        <div style={{ marginTop: 16 }}>
          <div style={sectionTitle}>browse</div>
          <div style={{ color: "#6a6a75", fontSize: 12, marginBottom: 6 }}>
            Folders only — hidden ones are omitted, and any projects produced inside a folder
            show up directly as <span style={{ color: "#FFE14D" }}>▸ .ossclip/…</span> entries.
          </div>
          {listing ? (
            <>
              <div style={pathRow}>
                <span style={pathText} title={listing.dir}>
                  {listing.dir}
                </span>
                {listing.isWorkdir ? (
                  <button
                    data-testid="project-open-current"
                    style={openHereButton}
                    disabled={busy}
                    onClick={() => open(listing.dir)}
                  >
                    open this project
                  </button>
                ) : null}
              </div>
              <div style={entryList} data-testid="project-fs-list">
                {listing.parent ? (
                  <button
                    data-testid="project-fs-up"
                    style={entryButton}
                    disabled={busy}
                    onClick={() => void browse(listing.parent!)}
                  >
                    ..
                  </button>
                ) : null}
                {listing.entries.map((e) => (
                  <button
                    key={e.path}
                    data-testid={e.isWorkdir ? "project-fs-workdir" : "project-fs-dir"}
                    style={{ ...entryButton, ...(e.isWorkdir ? workdirStyle : {}) }}
                    disabled={busy}
                    // A project opens; an ordinary folder descends. One click
                    // each — the isWorkdir flag decides which it is.
                    onClick={() => (e.isWorkdir ? open(e.path) : void browse(e.path))}
                    title={e.path}
                  >
                    <span style={{ marginRight: 8, color: e.isWorkdir ? "#FFE14D" : "#6a6a75" }}>
                      {e.isWorkdir ? "▸" : "▪"}
                    </span>
                    {e.name}
                    {e.isWorkdir ? <span style={workdirBadge}>project</span> : <span style={{ color: "#55555f" }}>/</span>}
                  </button>
                ))}
                {listing.entries.length === 0 ? (
                  <div style={{ color: "#6a6a75", fontSize: 12, padding: "6px 8px" }}>
                    no folders here
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div style={{ color: "#6a6a75", fontSize: 13 }}>loading…</div>
          )}
        </div>
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

const closeButton: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#0B0B0E",
  background: "#a8c7fa",
  border: "none",
  borderRadius: 4,
  padding: "3px 10px",
  cursor: "pointer",
};

const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#6a6a75",
  marginTop: 4,
};

const errorLine: React.CSSProperties = {
  marginTop: 12,
  fontSize: 13,
  color: "#FF5C5C",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#8ab4f8",
  marginBottom: 6,
};

const pathRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 6,
};

const pathText: React.CSSProperties = {
  fontSize: 12,
  color: "#9A9AA3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const openHereButton: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 700,
  color: "#0B0B0E",
  background: "#FFE14D",
  border: "1px solid #FFE14D",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
};

const entryList: React.CSSProperties = {
  maxHeight: "34vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const entryButton: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: 13,
  color: "#C9C9D4",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 6,
  padding: "5px 8px",
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const workdirStyle: React.CSSProperties = {
  color: "#EDEDF2",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
};

const workdirBadge: React.CSSProperties = {
  marginLeft: 10,
  fontSize: 11,
  fontWeight: 700,
  color: "#FFE14D",
};
