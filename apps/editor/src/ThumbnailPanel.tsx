import React, { useEffect, useRef, useState } from "react";

/**
 * The AI thumbnail panel (2026-08-17): view the current `<out>.thumbnail.png`,
 * edit the concept, regenerate. Deliberately NOT wired through useEdits or
 * overrides.json — the thumbnail is not an overrides concern: the concept
 * round-trips through the workdir's approval file
 * (thumbnail-concept-approved.json), which is the contract the CLI's
 * thumbnailStep already honors on every replay, so an edit saved by the
 * regenerate endpoint persists into future renders with no overrides plumbing.
 * Plain fetch on open and after regenerate; the server owns all the state.
 */

export type ThumbnailReason =
  | "no-youtube"
  | "no-portrait"
  | "no-key"
  | "portrait-missing"
  | "skip-file"
  | "never-generated";

/** The server's portrait-precedence vocabulary (portrait-override.ts),
 * restated — the editor ships as a built page and cannot import CLI source. */
export type PortraitSource = "override" | "flag" | "config";

export interface PortraitInfo {
  url: string;
  source: PortraitSource;
}

export interface ThumbnailInfo {
  status: "ready" | "skipped" | "unavailable";
  reason?: ThumbnailReason;
  concept: { scene: string; overlayText: string; styleNotes: string } | null;
  imageUrl: string | null;
  model: string;
  /** The face a render would use — null when none resolved (or on a pre-swap
   * server, whose response simply lacks the key). */
  portrait?: PortraitInfo | null;
}

/** The swap strip's source label, pure so the three-row table needs no
 * mount. "flag"/"config" both read as the default headshot to the user —
 * the distinction that matters in the UI is override vs not. */
export function portraitSourceLabel(source: PortraitSource): string {
  switch (source) {
    case "override":
      return "Project override";
    case "flag":
    case "config":
      return "Your default portrait";
  }
}

/**
 * `data:image/png;base64,AAAA…` → the POST body shape — pure so the
 * FileReader plumbing is testable without a File. Null for anything that is
 * not a base64 data URL (FileReader.readAsDataURL only ever produces one,
 * so null here means a reader bug, not a user error).
 */
export function parsePortraitDataUrl(
  dataUrl: string,
): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  return match ? { mimeType: match[1]!, data: match[2]! } : null;
}

/**
 * The plain sentence an unavailable panel shows instead of controls. Pure so
 * the reason table is testable without a mount, matching the server's reason
 * vocabulary (thumbnail-panel.ts) one for one.
 */
export function unavailableMessage(reason: ThumbnailReason | undefined): string {
  switch (reason) {
    case "no-youtube":
      return (
        "This project was produced without the YouTube pack. The AI thumbnail needs " +
        "--youtube — run produce with it (or set \"youtube\": true in " +
        "~/.ossclip/config.json) and render once."
      );
    case "no-portrait":
      return (
        "No portrait photo is configured — the thumbnail uses it as the likeness " +
        "reference. Set \"portrait\" in ~/.ossclip/config.json or run produce with " +
        "--portrait <path>."
      );
    case "no-key":
      return "GEMINI_API_KEY is not set in the environment the edit server runs in.";
    case "portrait-missing":
      return "The configured portrait photo no longer exists on disk.";
    default:
      return "The AI thumbnail is unavailable for this project.";
  }
}

/**
 * The character budget hint for the overlay field. Hardcoded to match
 * ThumbnailConceptSchema's cappedText(60) — the schema lives outside core's
 * browser-safe surface (thumbnail.ts pulls node:crypto), so importing it
 * here would drag node built-ins into the Vite bundle. The server re-caps
 * regardless, so drift costs a stale hint, never a bad thumbnail.
 */
export const OVERLAY_CHAR_CAP = 60;

export interface ThumbnailPanelProps {
  onClose: () => void;
}

export const ThumbnailPanel: React.FC<ThumbnailPanelProps> = ({ onClose }) => {
  const [info, setInfo] = useState<ThumbnailInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [overlayText, setOverlayText] = useState("");
  const [scene, setScene] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [portraitError, setPortraitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/thumbnail");
        const body = (await res.json()) as ThumbnailInfo & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `GET /api/thumbnail failed: ${res.status}`);
        setInfo(body);
        setImageUrl(body.imageUrl);
        if (body.concept) {
          setOverlayText(body.concept.overlayText);
          setScene(body.concept.scene);
          setStyleNotes(body.concept.styleNotes);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const onRegenerate = async (): Promise<void> => {
    setBusy(true);
    setRegenError(null);
    try {
      const res = await fetch("/api/thumbnail/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: { scene, overlayText, styleNotes } }),
      });
      const body = (await res.json()) as { ok?: boolean; imageUrl?: string; error?: string };
      if (!res.ok || body.ok !== true) {
        // The server's message rides VERBATIM — a generation failure carries
        // the API's own words, and paraphrasing them here would hide the one
        // clue (a rejected model slug, a quota line) the user can act on.
        setRegenError(body.error ?? `regenerate failed: ${res.status}`);
        return;
      }
      setImageUrl(body.imageUrl ?? null);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Both portrait calls land here: update ONLY the portrait slice from the
   * response instead of refetching /api/thumbnail whole — a full refetch
   * would clobber concept text the user has typed but not regenerated yet
   * (swap → edit text → one Regenerate is the intended loop; regenerating
   * automatically on swap would spend an image call the user didn't ask
   * for). */
  const applyPortrait = (portrait: PortraitInfo | null): void => {
    setInfo((prev) => (prev ? { ...prev, portrait } : prev));
  };

  const onSwapFile = async (file: File): Promise<void> => {
    setPortraitError(null);
    try {
      const dataUrl = await new Promise<string>((resolvePromise, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolvePromise(String(reader.result));
        reader.onerror = () => reject(new Error("could not read the image file"));
        reader.readAsDataURL(file);
      });
      const parsed = parsePortraitDataUrl(dataUrl);
      if (parsed === null) {
        setPortraitError("could not read the image file");
        return;
      }
      const res = await fetch("/api/thumbnail/portrait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        portrait?: PortraitInfo | null;
        error?: string;
      };
      if (!res.ok || body.ok !== true) {
        // Server message VERBATIM, the regenerate handler's posture — a mime
        // or size rejection names the accepted set / the cap.
        setPortraitError(body.error ?? `swap failed: ${res.status}`);
        return;
      }
      applyPortrait(body.portrait ?? null);
    } catch (err) {
      setPortraitError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUseDefault = async (): Promise<void> => {
    setPortraitError(null);
    try {
      const res = await fetch("/api/thumbnail/portrait", { method: "DELETE" });
      const body = (await res.json()) as {
        ok?: boolean;
        portrait?: PortraitInfo | null;
        error?: string;
      };
      if (!res.ok || body.ok !== true) {
        setPortraitError(body.error ?? `reset failed: ${res.status}`);
        return;
      }
      applyPortrait(body.portrait ?? null);
    } catch (err) {
      setPortraitError(err instanceof Error ? err.message : String(err));
    }
  };

  const unavailable = info?.status === "unavailable";

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div data-testid="thumbnail-modal" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={title}>AI Thumbnail</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {loadError ? (
          <div data-testid="thumbnail-load-error" style={errorText}>
            Couldn't load the thumbnail state: {loadError}
          </div>
        ) : info === null ? (
          <div style={subtitle}>Loading…</div>
        ) : unavailable ? (
          <div data-testid="thumbnail-unavailable" style={{ ...subtitle, marginTop: 12 }}>
            {unavailableMessage(info.reason)}
          </div>
        ) : (
          <>
            {info.status === "skipped" ? (
              <div data-testid="thumbnail-skipped-note" style={{ ...subtitle, marginTop: 8 }}>
                Thumbnail was skipped at the concept approval prompt — regenerating
                replaces that decision.
              </div>
            ) : null}
            <div style={imageBox}>
              {imageUrl ? (
                <img
                  data-testid="thumbnail-image"
                  src={imageUrl}
                  alt="Current AI thumbnail"
                  style={imageStyle}
                />
              ) : (
                <div data-testid="thumbnail-placeholder" style={placeholder}>
                  No thumbnail generated yet — edit the concept and hit Regenerate.
                </div>
              )}
            </div>
            {info.portrait ? (
              <div data-testid="portrait-strip" style={portraitRow}>
                <img
                  data-testid="portrait-preview"
                  src={info.portrait.url}
                  alt="Portrait reference"
                  style={portraitImg}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div data-testid="portrait-source" style={portraitSourceStyle}>
                    {portraitSourceLabel(info.portrait.source)}
                  </div>
                  <div style={footNote}>
                    The swap applies to this project only and is used by future renders too.
                  </div>
                </div>
                <button
                  data-testid="portrait-swap-btn"
                  style={swapBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  Swap face…
                </button>
                {info.portrait.source === "override" ? (
                  <button
                    data-testid="portrait-reset-btn"
                    style={swapBtn}
                    onClick={() => void onUseDefault()}
                    disabled={busy}
                  >
                    Use default
                  </button>
                ) : null}
                <input
                  ref={fileInputRef}
                  data-testid="portrait-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so picking the SAME file again still fires change
                    // — re-swapping back to a face is a real flow.
                    e.target.value = "";
                    if (file) void onSwapFile(file);
                  }}
                />
              </div>
            ) : null}
            {portraitError ? (
              <div data-testid="portrait-error" style={errorText}>
                {portraitError}
              </div>
            ) : null}
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>
                Overlay text — the words ON the image ({OVERLAY_CHAR_CAP} chars, 4–9 words)
              </label>
              <input
                data-testid="thumbnail-overlay-input"
                type="text"
                maxLength={OVERLAY_CHAR_CAP}
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
                style={textInput}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Scene — what the image shows</label>
              <textarea
                data-testid="thumbnail-scene-input"
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                rows={3}
                style={{ ...textInput, resize: "vertical" }}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Style notes — palette, lighting, mood</label>
              <textarea
                data-testid="thumbnail-style-input"
                value={styleNotes}
                onChange={(e) => setStyleNotes(e.target.value)}
                rows={3}
                style={{ ...textInput, resize: "vertical" }}
              />
            </div>
            {regenError ? (
              <div data-testid="thumbnail-error" style={errorText}>
                {regenError}
              </div>
            ) : null}
            <div style={footerRow}>
              <div style={footNote}>
                Regenerating replaces the video's .thumbnail.png and saves this
                concept for future renders.
              </div>
              <button
                data-testid="thumbnail-regenerate-btn"
                style={{ ...confirmBtn, ...(busy ? { opacity: 0.6, cursor: "default" } : {}) }}
                onClick={() => void onRegenerate()}
                disabled={busy}
              >
                {busy ? "Generating…" : "Regenerate"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// Modal chrome matches RenderModal's — the editor's one dialog vocabulary.
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

const imageBox: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  // The 16:9 the image is generated at, held even for the placeholder so
  // the panel doesn't jump when the first image lands.
  aspectRatio: "16 / 9",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
};

const imageStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

const placeholder: React.CSSProperties = {
  color: "#8B8B9E",
  fontSize: 13,
  padding: 16,
  textAlign: "center",
};

const portraitRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
};

const portraitImg: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 6,
  objectFit: "cover",
  flexShrink: 0,
  border: "1px solid #2C2C38",
};

const portraitSourceStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 2,
};

const swapBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3A3A48",
  borderRadius: 6,
  color: "#C9C9D4",
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
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

const textInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#09090D",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  outline: "none",
};

const errorText: React.CSSProperties = {
  marginTop: 12,
  color: "#FF5C5C",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  whiteSpace: "pre-wrap",
};

const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  marginTop: 20,
};

const footNote: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  lineHeight: 1.4,
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
  whiteSpace: "nowrap",
  boxShadow: "0 2px 10px rgba(0,229,163,0.3)",
};
