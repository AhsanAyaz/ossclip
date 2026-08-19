import React, { useEffect, useState } from "react";
import { COVER_MAX_WORDS, coverHeadline } from "@ossclip/core/browser";

/**
 * The cover panel (2026-08-19): view the `<out>.cover.jpg`, retype its
 * headline, re-cut its frame — in seconds, with no video re-render.
 *
 * Deliberately NOT wired through useEdits or overrides.json, for the reason
 * the thumbnail panel is not: the cover round-trips through the workdir's
 * `cover.json`, which is the provenance `ossclip cover` reads and produce
 * honours (`textSource: "user"` survives a re-produce), so an edit saved by
 * the regenerate endpoint persists into future renders with no overrides
 * plumbing. Plain fetch on open and after regenerate; the server owns all the
 * state.
 *
 * The provenance shape is restated here rather than imported: the editor ships
 * as a built page and only imports @ossclip/core/browser (ThumbnailPanel.tsx's
 * `PortraitSource` note). `coverHeadline` itself is NOT restated — it is the
 * one that decides what actually gets rendered, and a second copy of the §35
 * trimming rules would show a preview the render disagrees with.
 */

/** The frame's video: the finished render or the original take. */
export type CoverFrom = "final" | "source";

/** Why a project has no cover to show. */
export type CoverReason = "no-destination" | "never-rendered";

/** The slice of `cover.json` the panel reads (packages/core/src/cover.ts). */
export interface CoverProvenanceView {
  text: string;
  textSource: "beatsheet" | "user";
  frame: {
    source: CoverFrom;
    timeSec: number;
    /**
     * The ORIGINAL TAKE, or null when this project has no record of one — a
     * cover that was only ever built from the final render. Read here purely
     * so the panel can tell whether "Original take" is offerable at all
     * (`sourceFrameOption`); the panel never sends a path anywhere.
     */
    sourceVideo: string | null;
  };
  size: { width: number; height: number };
  out: string;
}

export interface CoverInfo {
  status: "ready" | "unavailable";
  reason?: CoverReason;
  provenance: CoverProvenanceView | null;
  /** Where a regeneration would write — null when there is nowhere to put it. */
  outPath: string | null;
  imageUrl: string | null;
}

/**
 * The plain sentence an unavailable panel shows instead of controls. Pure so
 * the reason table is testable without a mount, matching the server's reason
 * vocabulary (edit.ts's /api/cover) one for one.
 */
export function coverUnavailableMessage(reason: CoverReason | undefined): string {
  switch (reason) {
    case "no-destination":
      return (
        "This workdir has no cover.json and no recorded --out, so there is nowhere to " +
        "write a cover. Run `ossclip produce` once with an output path, or " +
        "`ossclip cover --out <path>` from a terminal."
      );
    default:
      return "The cover is unavailable for this project.";
  }
}

/**
 * The live headline preview: what the render will actually put on the banner,
 * and whether that is shorter than what was typed.
 *
 * `trimmed` is computed against the NORMALIZED input, not the raw one —
 * `coverHeadline` also collapses runs of whitespace, and reporting that as a
 * trim would cry wolf on every headline typed with two spaces. Exactly
 * `resolveCoverText`'s comparison (apps/cli/src/cover.ts), so the panel's
 * warning and the CLI's printed note fire on the same inputs.
 */
export function headlinePreview(typed: string): { preview: string; trimmed: boolean } {
  const normalized = typed.trim().replace(/\s+/g, " ");
  const preview = coverHeadline(normalized);
  return { preview, trimmed: preview !== normalized };
}

/**
 * The seconds field, parsed rather than coerced (CLAUDE.md). Empty means "no
 * timestamp" — the cheap path, where the server re-uses the still already on
 * disk and runs no ffmpeg at all — which is a different answer from 0, and why
 * this returns an explicit union instead of a number-or-NaN.
 */
export function parseAtSeconds(
  raw: string,
): { ok: true; atSec?: number } | { ok: false; message: string } {
  if (raw.trim() === "") return { ok: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: `"${raw}" is not a timestamp in seconds — 0 or more, please.` };
  }
  return { ok: true, atSec: n };
}

/** Whether "Original take" is a control worth offering, and the short why
 * when it is not. */
export interface SourceFrameOption {
  enabled: boolean;
  /** Shown under the disabled toggle. Absent when the option works. */
  note?: string;
}

/**
 * Whether this project has an original take to re-cut from (2026-08-19).
 *
 * `--from source` needs `cover.json` to NAME the take, and a null
 * `frame.sourceVideo` is that file saying the take is genuinely unknown — a
 * pre-feature workdir, or one whose cover was only ever built from the final
 * render. The server refuses such a request, correctly and by design
 * (`coverFrameSource` in apps/cli/src/cover.ts), and it must keep refusing:
 * this is not the check moving to the client. It is the panel not offering a
 * control it already knows is dead, instead of letting the user find out from
 * an error after Apply.
 *
 * Pure, so the two dead cases are testable without a mount — the same split
 * as `coverUnavailableMessage`.
 */
export function sourceFrameOption(provenance: CoverProvenanceView | null): SourceFrameOption {
  if (provenance !== null && provenance.frame.sourceVideo !== null) return { enabled: true };
  return {
    enabled: false,
    note:
      "There is no record of the original take for this project, so only the finished " +
      "video can be read. The next `ossclip produce` records one.",
  };
}

/** The caveat, stated in the UI rather than discovered in the image. */
export function frameSourceNote(from: CoverFrom): string {
  return from === "final"
    ? "A frame from the finished video carries the burned-in captions, graphics and watermark."
    : "The original take — clean, framed the way produce framed it. Needs a cover.json.";
}

/**
 * The POST body, pure so the one rule that matters is testable without a
 * mount: it carries text, timestamp and which video, and NEVER a path. The
 * server derives every path from command.json + cover.json + render-props.json
 * and would strip one anyway; not building one here means the panel and the
 * server agree about what the body is for.
 *
 * `text` is omitted when it still matches what is persisted, mirroring
 * `ossclip cover --at <t>` with no `--text`: that reuses the stored headline
 * AND its `textSource`. Sending it back unchanged would flip `textSource` to
 * "user" and quietly pin the generated headline against every future produce
 * — for someone who only wanted a different frame.
 */
export function coverRegenerateBody(args: {
  typed: string;
  persistedText: string | null;
  atSec?: number;
  from: CoverFrom;
}): { text?: string; atSec?: number; from: CoverFrom } {
  return {
    ...(args.typed === (args.persistedText ?? "") ? {} : { text: args.typed }),
    ...(args.atSec === undefined ? {} : { atSec: args.atSec }),
    from: args.from,
  };
}

export interface CoverPanelProps {
  onClose: () => void;
  /**
   * The playhead, in seconds, read at CLICK time — a getter rather than a
   * number because App does not re-render per frame, so a prop snapshot would
   * be whatever the playhead was when the panel opened.
   *
   * This value goes straight through as `atSec`, and that is only sound
   * because the editor's timeline is OUTPUT time: it is the finished mp4's own
   * timeline, cuts already applied, which is exactly what `--from final` seeks
   * into. (`--from source` is the other case, and the server re-maps nothing
   * for it — see the toggle's note.)
   */
  playheadSec: () => number;
}

export const CoverPanel: React.FC<CoverPanelProps> = ({ onClose, playheadSec }) => {
  const [info, setInfo] = useState<CoverInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [atRaw, setAtRaw] = useState("");
  const [from, setFrom] = useState<CoverFrom>("final");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

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
        const res = await fetch("/api/cover");
        const body = (await res.json()) as CoverInfo & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `GET /api/cover failed: ${res.status}`);
        setInfo(body);
        setImageUrl(body.imageUrl);
        if (body.provenance) {
          setText(body.provenance.text);
          // NOT the persisted timestamp: an empty field means "re-use the
          // still already on disk", which is the cheap path and the right
          // default. Prefilling it would make every Apply re-extract a frame.
          //
          // Guarded by the same rule that disables the button: a frame read
          // from the source implies a recorded source, so this only bites a
          // hand-edited cover.json — and a disabled option must never be the
          // selected one.
          if (sourceFrameOption(body.provenance).enabled) setFrom(body.provenance.frame.source);
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const at = parseAtSeconds(atRaw);
  const headline = headlinePreview(text);
  const sourceOption = sourceFrameOption(info?.provenance ?? null);

  const onApply = async (): Promise<void> => {
    if (!at.ok) return;
    setBusy(true);
    setApplyError(null);
    setNotes([]);
    try {
      const res = await fetch("/api/cover/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          coverRegenerateBody({
            typed: text,
            persistedText: info?.provenance?.text ?? null,
            atSec: at.atSec,
            from,
          }),
        ),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        provenance?: CoverProvenanceView;
        notes?: string[];
        imageUrl?: string | null;
        error?: string;
      };
      if (!res.ok || body.ok !== true) {
        // The server's message rides VERBATIM — "is the timestamp past the
        // end?" and "--from source needs cover.json" both name their own fix,
        // and paraphrasing them here would lose it.
        setApplyError(body.error ?? `regenerate failed: ${res.status}`);
        return;
      }
      setImageUrl(body.imageUrl ?? null);
      setNotes(body.notes ?? []);
      if (body.provenance) {
        const written = body.provenance;
        setInfo((prev) => (prev ? { ...prev, provenance: written, status: "ready" } : prev));
        setText(written.text);
      }
      // The frame it used is now the still on disk, so the next Apply is the
      // cheap path again — clear the field to say so.
      setAtRaw("");
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unavailable = info?.status === "unavailable";

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div data-testid="cover-modal" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={title}>Cover image</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {loadError ? (
          <div data-testid="cover-load-error" style={errorText}>
            Couldn't load the cover state: {loadError}
          </div>
        ) : info === null ? (
          <div style={subtitle}>Loading…</div>
        ) : unavailable ? (
          <div data-testid="cover-unavailable" style={{ ...subtitle, marginTop: 12 }}>
            {coverUnavailableMessage(info.reason)}
          </div>
        ) : (
          <>
            <div style={imageBox}>
              {imageUrl ? (
                <img data-testid="cover-image" src={imageUrl} alt="Current cover" style={imageStyle} />
              ) : (
                <div data-testid="cover-placeholder" style={placeholder}>
                  No cover on disk yet — set a headline and hit Apply.
                </div>
              )}
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>Headline — at most {COVER_MAX_WORDS} words (§35)</label>
              <input
                data-testid="cover-text-input"
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                style={textInput}
              />
              {headline.trimmed ? (
                <div data-testid="cover-headline-preview" style={{ ...footNote, marginTop: 6 }}>
                  Will render as: “{headline.preview}”
                </div>
              ) : null}
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>Frame</label>
              <div style={rowStyle}>
                <button
                  data-testid="cover-playhead-btn"
                  style={ghostBtn}
                  onClick={() => setAtRaw(playheadSec().toFixed(2))}
                  disabled={busy}
                >
                  Use current playhead
                </button>
                <input
                  data-testid="cover-at-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="seconds — blank keeps the current still"
                  value={atRaw}
                  onChange={(e) => setAtRaw(e.target.value)}
                  style={{ ...textInput, flex: 1 }}
                />
              </div>
              {at.ok ? null : (
                <div data-testid="cover-at-error" style={errorText}>
                  {at.message}
                </div>
              )}
              <div style={{ ...rowStyle, marginTop: 10 }}>
                {(["final", "source"] as const).map((v) => {
                  // The only dead option is "source", and only when this
                  // project has no recorded take — the server would refuse it
                  // (and still does), so offering it is offering an error.
                  const dead = v === "source" && !sourceOption.enabled;
                  return (
                    <button
                      key={v}
                      data-testid={`cover-from-${v}`}
                      style={{
                        ...ghostBtn,
                        ...(from === v ? selectedBtn : {}),
                        ...(dead ? { opacity: 0.5, cursor: "default" } : {}),
                      }}
                      onClick={() => setFrom(v)}
                      disabled={busy || dead}
                      aria-pressed={from === v}
                    >
                      {v === "final" ? "Finished video" : "Original take"}
                    </button>
                  );
                })}
              </div>
              <div data-testid="cover-from-note" style={{ ...footNote, marginTop: 6 }}>
                {frameSourceNote(from)}
              </div>
              {sourceOption.note ? (
                <div data-testid="cover-from-disabled-note" style={{ ...footNote, marginTop: 4 }}>
                  {sourceOption.note}
                </div>
              ) : null}
              <div style={{ ...footNote, marginTop: 4 }}>
                Leave the seconds blank and the cover re-uses the still it already has — no
                frame extraction at all, and this choice does not apply.
              </div>
            </div>
            {notes.length > 0 ? (
              <div data-testid="cover-notes" style={{ ...footNote, marginTop: 12 }}>
                {notes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            ) : null}
            {applyError ? (
              <div data-testid="cover-error" style={errorText}>
                {applyError}
              </div>
            ) : null}
            <div style={footerRow}>
              <div style={footNote}>
                {info.outPath
                  ? `Writes ${info.outPath} — the video itself is untouched.`
                  : "The video itself is untouched."}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button data-testid="cover-cancel-btn" style={ghostBtn} onClick={onClose}>
                  Cancel
                </button>
                <button
                  data-testid="cover-apply-btn"
                  style={{
                    ...confirmBtn,
                    ...(busy || !at.ok ? { opacity: 0.6, cursor: "default" } : {}),
                  }}
                  onClick={() => void onApply()}
                  disabled={busy || !at.ok}
                >
                  {busy ? "Rebuilding…" : "Apply"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// Modal chrome matches ThumbnailPanel's — the editor's one dialog vocabulary.
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
  // Tall, because a cover is the 9:16 output frame — but capped in height so
  // a portrait cover cannot push the controls off the dialog.
  maxHeight: 320,
  minHeight: 180,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
};

const imageStyle: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: 320,
  objectFit: "contain",
};

const placeholder: React.CSSProperties = {
  color: "#8B8B9E",
  fontSize: 13,
  padding: 16,
  textAlign: "center",
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

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3A3A48",
  borderRadius: 6,
  color: "#C9C9D4",
  padding: "9px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const selectedBtn: React.CSSProperties = {
  borderColor: "#5b8cff",
  color: "#EDEDF2",
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
  wordBreak: "break-all",
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
