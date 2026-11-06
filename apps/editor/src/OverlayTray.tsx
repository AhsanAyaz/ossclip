import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OverlayEntrySnapshot } from "@ossclip/core/browser";
import type { OverlayTrayRequest } from "./overlayLane";
import {
  TRAY_UPLOAD_MAX_BYTES,
  classifyPaste,
  filterLibrary,
  guessKind,
  libraryFileUrl,
  nameFromSource,
  parseAliases,
  type LibraryEntryMeta,
  type PasteSource,
} from "./overlayTrayModel";

/**
 * The overlay tray (overlay-library spec §Editor, "Tray"): "choose an image
 * for this moment". A library grid with a name search, a paste box for a URL
 * or an absolute path, and a drop zone; a NEW item asks for a name, aliases
 * and a kind, is saved into the global library (`POST /api/library`), and is
 * then used exactly like a grid pick.
 *
 * Every pick ends in `POST /api/overlays/stage`, which snapshots the entry and
 * copies its file into the workdir — the tray hands that snapshot to
 * `onStaged`, never the library metadata, so what the doc stores is what the
 * render will find (spec "Snapshot"). WHAT the snapshot does — add at a word
 * or swap a placement — is the owner's call (App), so this component holds
 * no edit logic and the reducer stays the one place a doc changes.
 *
 * Server errors show inline, verbatim: the edit server words every 400 for a
 * person ("no file at that path", "file is 25.0 MB; the limit is 20.0 MB"),
 * and paraphrasing would hide which check refused.
 *
 * Every POST is `content-type: application/json` — the server answers 415
 * otherwise (ruling R14).
 */
export interface OverlayTrayProps {
  request: OverlayTrayRequest;
  /** A staged entry, ready for the doc: App adds it at the word or swaps it in. */
  onStaged: (entry: OverlayEntrySnapshot) => void;
  onClose: () => void;
}

/** A new item's source in `POST /api/library`'s shape: pasted, or dropped. */
type NewSource = PasteSource | { data: string; mimeType: string };

// Exported for the logo suggestion popover, whose "Use this" is this tray's
// add path with a candidate source: one copy of the R14 JSON rule and of the
// verbatim-error rule.
export const postJson = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The server's `{error}` sentence, or a fallback naming the status. */
export const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
};

export const OverlayTray: React.FC<OverlayTrayProps> = ({ request, onStaged, onClose }) => {
  const [library, setLibrary] = useState<LibraryEntryMeta[] | null>(null);
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState("");
  /** A dropped file, held until Add (it has no paste text to re-derive from). */
  const [dropped, setDropped] = useState<{ data: string; mimeType: string; fileName: string } | null>(null);
  /** A suggestion's "Paste my own" arrives with its name (logo-finder spec
   * §Editor): pre-filled, and counted as typed so the paste's file-name
   * guess does not overwrite it. */
  const presetName = request.mode === "add" ? request.name : undefined;
  const [name, setName] = useState(presetName ?? "");
  /** Once the user types a name, a later paste no longer overwrites it. */
  const [nameTouched, setNameTouched] = useState(presetName !== undefined);
  const [aliases, setAliases] = useState("");
  const [kind, setKind] = useState<"logo" | "image" | "gif">("logo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /**
   * False once the tray is gone (final review T8): a stage still in flight
   * when the user closes the tray must not land. Its `onStaged` closed over
   * the request the tray was opened for, so it would place the overlay at a
   * word (or swap a placement) the user already walked away from. Set in the
   * effect, not just the initialiser, so a StrictMode remount re-arms it.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/library")
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res));
        return (await res.json()) as { entries: LibraryEntryMeta[] };
      })
      .then((body) => {
        if (!cancelled) setLibrary(body.entries);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLibrary([]);
        setError(`could not load the library: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // CAPTURE-phase Escape, the DeleteSceneModal rule: closing the tray must
  // not also reach the Overlay's Escape and clear the selection it serves.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const pasted = useMemo(() => classifyPaste(paste), [paste]);
  const source: NewSource | null = dropped
    ? { data: dropped.data, mimeType: dropped.mimeType }
    : pasted.ok
      ? pasted.source
      : null;
  const shown = useMemo(() => filterLibrary(library ?? [], query), [library, query]);

  /** Fill the new-item form from a source's file name — the spec's pre-fill
   * and kind guess — leaving a name the user already typed alone. */
  const prefill = (hint: { name: string; mimeType?: string }) => {
    if (!nameTouched) setName(nameFromSource(hint.name));
    setKind(guessKind(hint));
  };

  const stage = async (entryId: string) => {
    const res = await postJson("/api/overlays/stage", { entryId });
    if (!res.ok) throw new Error(await errorOf(res));
    const body = (await res.json()) as { entry: OverlayEntrySnapshot };
    if (!mounted.current) return;
    onStaged(body.entry);
  };

  /** Run one server round-trip with the busy flag and inline error. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addNew = () => {
    if (source === null || busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("give it a name — it is what the transcript is matched against");
      return;
    }
    void run(async () => {
      const aliasList = parseAliases(aliases, trimmed);
      const res = await postJson("/api/library", {
        name: trimmed,
        ...(aliasList.length > 0 ? { aliases: aliasList } : {}),
        kind,
        source,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const body = (await res.json()) as { entry: LibraryEntryMeta };
      // In the grid at once: if the stage below fails, the entry IS in the
      // library already, and the way forward is picking it — a second Add
      // would save a duplicate under `<slug>-2`.
      setLibrary((l) => [...(l ?? []), body.entry]);
      await stage(body.entry.id);
    });
  };

  const onDropFile = (file: File) => {
    // Refused HERE as well as on the server: the server's 20 MB check runs on
    // the decoded bytes, after the browser has already base64'd a mistaken
    // drop of a video into memory and pushed it over the wire.
    if (file.size > TRAY_UPLOAD_MAX_BYTES) {
      setError(
        `file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${(TRAY_UPLOAD_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("could not read the dropped file");
    reader.onload = () => {
      const url = String(reader.result);
      // `data:<mime>;base64,<payload>` — the server wants the payload only.
      const data = url.slice(url.indexOf(",") + 1);
      setError(null);
      setPaste("");
      setDropped({ data, mimeType: file.type, fileName: file.name });
      prefill({ name: file.name, mimeType: file.type });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div
        data-testid="overlay-tray"
        role="dialog"
        aria-label={request.mode === "add" ? "Add a logo or image" : "Swap image"}
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
        // Keys typed or pressed IN the tray stay in the tray: Delete on a
        // focused grid button would otherwise reach the Overlay's shortcut
        // and delete the very chip a swap is choosing art for. ⌘/Ctrl
        // combinations (save, undo) still pass.
        onKeyDown={(e) => {
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
        }}
      >
        <div style={header}>
          <div style={title}>{request.mode === "add" ? `Add a logo or image at word ${request.word}` : "Swap image"}</div>
          <button data-testid="overlay-tray-close" style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <input
          data-testid="overlay-tray-search"
          type="text"
          placeholder="Search the library by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...textInput, marginTop: 14, width: "100%", boxSizing: "border-box" }}
          autoFocus
        />
        <div data-testid="overlay-tray-grid" style={grid}>
          {library === null ? (
            <div style={muted}>Loading…</div>
          ) : shown.length === 0 ? (
            <div style={muted}>
              {library.length === 0 ? "The library is empty — add one below." : "Nothing matches that name."}
            </div>
          ) : (
            shown.map((e) => (
              <button
                key={e.id}
                data-testid={`overlay-tray-item-${e.id}`}
                style={tile}
                disabled={busy}
                title={e.names.join(", ")}
                onClick={() => void run(() => stage(e.id))}
              >
                {/* A plain <img>: a GIF animates in the grid (spec §Editor). */}
                <img src={libraryFileUrl(e.id)} alt="" draggable={false} style={tileImg} />
                <span style={tileLabel}>{e.names[0] ?? e.id}</span>
              </button>
            ))
          )}
        </div>

        <div style={{ marginTop: 18 }}>
          <label style={labelStyle} htmlFor="overlay-tray-paste">
            Add new — paste a URL or an absolute path, or drop a file
          </label>
          <input
            id="overlay-tray-paste"
            data-testid="overlay-tray-paste"
            type="text"
            placeholder="https://… or /Users/you/logo.png"
            value={paste}
            onChange={(e) => {
              const text = e.target.value;
              setPaste(text);
              setDropped(null);
              setError(null);
              if (classifyPaste(text).ok) prefill({ name: text });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addNew();
            }}
            style={{ ...textInput, width: "100%", boxSizing: "border-box" }}
          />
          {pasted.ok === false && pasted.error !== null ? (
            <div data-testid="overlay-tray-paste-hint" style={hint}>
              {pasted.error}
            </div>
          ) : null}
          <div
            data-testid="overlay-tray-drop"
            style={{ ...dropZone, ...(dragOver ? { borderColor: "#00E5A3", color: "#EDEDF2" } : {}) }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files[0];
              if (file) onDropFile(file);
            }}
          >
            {dropped ? `dropped: ${dropped.fileName}` : "drop an image here (png, jpg, webp, svg, gif)"}
          </div>
        </div>

        {source !== null ? (
          <div data-testid="overlay-tray-new" style={newForm}>
            <label style={fieldLabel}>
              Name
              <input
                data-testid="overlay-tray-name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addNew();
                }}
                style={textInput}
              />
            </label>
            <label style={fieldLabel}>
              Aliases (comma-separated, optional)
              <input
                data-testid="overlay-tray-aliases"
                type="text"
                value={aliases}
                placeholder="e.g. GDE, Google Developer Expert"
                onChange={(e) => setAliases(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addNew();
                }}
                style={textInput}
              />
            </label>
            <label style={fieldLabel}>
              Kind
              <select
                data-testid="overlay-tray-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "logo" | "image" | "gif")}
                style={textInput}
              >
                <option value="logo">logo</option>
                <option value="image">image</option>
                <option value="gif">gif</option>
              </select>
            </label>
            <button data-testid="overlay-tray-add" style={confirmBtn} disabled={busy} onClick={addNew}>
              {busy ? "Adding…" : request.mode === "add" ? "Add" : "Add and swap"}
            </button>
          </div>
        ) : null}

        {error !== null ? (
          <div data-testid="overlay-tray-error" role="alert" style={errorStyle}>
            {error}
          </div>
        ) : null}
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
  width: 620,
  maxWidth: "92vw",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 10,
  padding: "22px 26px",
  boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#EDEDF2",
};

const header: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center" };

const title: React.CSSProperties = { fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" };

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  borderRadius: 4,
};

const textInput: React.CSSProperties = {
  background: "#09090D",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "8px 12px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  outline: "none",
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
  gap: 8,
  marginTop: 10,
  maxHeight: 260,
  overflowY: "auto",
};

const tile: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  background: "#1A1A24",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: 8,
  color: "#EDEDF2",
  cursor: "pointer",
};

const tileImg: React.CSSProperties = { width: "100%", height: 56, objectFit: "contain" };

const tileLabel: React.CSSProperties = {
  fontSize: 11,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const muted: React.CSSProperties = { fontSize: 12, color: "#8B8B9E", gridColumn: "1 / -1" };

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 8,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const hint: React.CSSProperties = { fontSize: 12, color: "#C9A227", marginTop: 6 };

const dropZone: React.CSSProperties = {
  marginTop: 8,
  border: "1px dashed #3A3A48",
  borderRadius: 6,
  padding: "14px 12px",
  textAlign: "center",
  fontSize: 12,
  color: "#8B8B9E",
};

const newForm: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10, marginTop: 14 };

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#C9C9D4",
};

const confirmBtn: React.CSSProperties = {
  alignSelf: "flex-end",
  background: "#00E5A3",
  border: "none",
  borderRadius: 6,
  color: "#051A13",
  padding: "9px 20px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: "#FF6B6B",
  background: "rgba(255,107,107,0.08)",
  border: "1px solid rgba(255,107,107,0.3)",
  borderRadius: 6,
  padding: "8px 10px",
};
