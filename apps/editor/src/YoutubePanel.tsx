import React, { useCallback, useEffect, useState } from "react";

/**
 * The YouTube SEO panel (2026-08-17): view and edit the pack a `--youtube`
 * produce generated — titles, description, hashtags, tags, chapters. Like
 * the thumbnail panel, deliberately NOT wired through useEdits or
 * overrides.json: the edit round-trips through the workdir's approval file
 * (youtube-pack-approved.json), which produce's Y2 block honors VERBATIM on
 * every replay, so a save here persists into future renders with no
 * overrides plumbing. Plain fetch on open and after save; the server owns
 * all the state.
 *
 * Edit-only by design (v1): there is no "regenerate with the AI" button —
 * the escape hatch is deleting the approval file in the workdir, and the
 * panel copy says so.
 */

export interface YoutubeChapterInfo {
  atSec: number;
  title: string;
}

/** Core's TitleAngleSchema values, spelled locally (the schema-bounds
 * posture below: importing core would drag node built-ins into the bundle). */
export type TitleAngle = "browse" | "search" | "benefit" | "alt";

export interface YoutubePackInfo {
  titles: string[];
  /** Parallel to titles (prompt v2). Absent on packs approved before it. */
  titleAngles?: TitleAngle[];
  description: string;
  hashtags: string[];
  tags: string[];
  chapters?: YoutubeChapterInfo[];
  /** Prompt-v2 optional extras — absent means the model never emitted them
   * (pre-v2 pack), and the panel hides what does not exist. */
  hook60?: string;
  linkedinPost?: string;
  communityPost?: string;
}

export interface YoutubeInfo {
  available: boolean;
  reason?: "no-pack";
  pack: YoutubePackInfo | null;
  mdPath: string | null;
}

/**
 * Schema bounds, hardcoded to match YoutubePackSchema — the ThumbnailPanel's
 * OVERLAY_CHAR_CAP posture: core's producer surface pulls node built-ins, so
 * importing the schema here would drag them into the Vite bundle. The server
 * re-validates (and re-trims) regardless, so drift costs a stale hint, never
 * a bad pack.
 */
export const TITLES_MIN = 3;
export const TITLES_MAX = 5;
/** YouTube's hard cap on the tags field, counted over the comma-joined text
 * (YOUTUBE_TAGS_LIMIT / trimTagsToLimit in core). */
export const TAGS_CHAR_LIMIT = 500;

/**
 * One space-separated line → the hashtags array the server stores. Pure so
 * the normalization matrix is testable without a mount: empty entries drop,
 * a missing leading `#` is prepended (formatYoutubeMarkdown's ensure-# rule,
 * applied at input time so the stored pack already carries it), and a bare
 * `#` with no word is noise, not a hashtag.
 */
export function hashtagsFromLine(line: string): string[] {
  return line
    .split(/\s+/)
    .filter((t) => t.replace(/^#+/, "").length > 0)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
}

/** The array back as the editable line — `#` ensured, one space between. */
export function hashtagsToLine(hashtags: string[]): string {
  return hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
}

/** One comma-separated line → the tags array: trimmed, empties dropped. */
export function tagsFromLine(line: string): string[] {
  return line
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** The array back as the editable line — YouTube's own comma spelling. */
export function tagsToLine(tags: string[]): string {
  return tags.join(", ");
}

/**
 * The live budget the counter shows: the NORMALIZED comma-joined length,
 * exactly what trimTagsToLimit measures server-side — counting the raw line
 * would let stray whitespace inflate the number past what actually counts.
 */
export function tagsBudgetUsed(line: string): number {
  return tagsToLine(tagsFromLine(line)).length;
}

/** 125 → "2:05" — YouTube's chapter-list spelling (core's chapterStamp). */
export function chapterStampLabel(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** How a title's angle spells next to its input — core's ANGLE_LABELS
 * bracket form, so panel and markdown agree on the vocabulary. */
export function angleLabel(angle: TitleAngle): string {
  const names: Record<TitleAngle, string> = {
    browse: "Browse",
    search: "Search",
    benefit: "Benefit",
    alt: "Alt",
  };
  return `[${names[angle]}]`;
}

/** The plain sentence an unavailable panel shows instead of controls — the
 * thumbnail panel's unavailableMessage posture, with one reason to name. */
export const NO_PACK_MESSAGE =
  "This run never generated YouTube metadata. Run produce with --youtube (and an " +
  "LLM provider) once — the pack lands here afterwards.";

export interface YoutubePanelProps {
  onClose: () => void;
}

export const YoutubePanel: React.FC<YoutubePanelProps> = ({ onClose }) => {
  const [info, setInfo] = useState<YoutubeInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
  // null = the pack never carried angles (pre-v2) — no labels, none sent
  // back. Kept parallel to titles by the add/remove handlers below.
  const [titleAngles, setTitleAngles] = useState<TitleAngle[] | null>(null);
  const [description, setDescription] = useState("");
  const [hashtagsLine, setHashtagsLine] = useState("");
  const [tagsLine, setTagsLine] = useState("");
  // null = absent from the pack (the model never emitted it) — the section
  // is hidden, not shown empty: an empty textarea would invite writing text
  // into a field the save path would then have to invent.
  const [hook60, setHook60] = useState<string | null>(null);
  const [linkedinPost, setLinkedinPost] = useState<string | null>(null);
  const [communityPost, setCommunityPost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/youtube");
      const body = (await res.json()) as YoutubeInfo & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `GET /api/youtube failed: ${res.status}`);
      setInfo(body);
      if (body.pack) {
        setTitles(body.pack.titles);
        setTitleAngles(body.pack.titleAngles ?? null);
        setDescription(body.pack.description);
        setHashtagsLine(hashtagsToLine(body.pack.hashtags));
        setTagsLine(tagsToLine(body.pack.tags));
        setHook60(body.pack.hook60 ?? null);
        setLinkedinPost(body.pack.linkedinPost ?? null);
        setCommunityPost(body.pack.communityPost ?? null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/youtube", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pack: {
            titles,
            // Optional fields ride only when the pack carried them — a
            // pre-v2 pack must round-trip byte-for-byte in shape, or the
            // save would silently upgrade a file the schema keeps optional
            // exactly so it does not have to.
            ...(titleAngles !== null ? { titleAngles } : {}),
            description,
            hashtags: hashtagsFromLine(hashtagsLine),
            tags: tagsFromLine(tagsLine),
            // Chapters ride through untouched — read-only in this panel.
            ...(info?.pack?.chapters ? { chapters: info.pack.chapters } : {}),
            ...(hook60 !== null ? { hook60 } : {}),
            ...(linkedinPost !== null ? { linkedinPost } : {}),
            ...(communityPost !== null ? { communityPost } : {}),
          },
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok !== true) {
        // The server's message rides VERBATIM (thumbnail panel posture) — a
        // zod refusal names the exact field, and paraphrasing would hide it.
        setSaveError(body.error ?? `save failed: ${res.status}`);
        return;
      }
      // Refetch rather than trusting local state: the server trimmed the
      // tags to budget, and the fields must show what was actually stored.
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tagsUsed = tagsBudgetUsed(tagsLine);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div data-testid="youtube-modal" style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={title}>YouTube SEO metadata</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {loadError ? (
          <div data-testid="youtube-load-error" style={errorText}>
            Couldn't load the YouTube pack: {loadError}
          </div>
        ) : info === null ? (
          <div style={subtitle}>Loading…</div>
        ) : !info.available ? (
          <div data-testid="youtube-unavailable" style={{ ...subtitle, marginTop: 12 }}>
            {NO_PACK_MESSAGE}
          </div>
        ) : (
          <>
            <div style={{ marginTop: 16 }}>
              <label style={labelStyle}>
                Title options ({TITLES_MIN}–{TITLES_MAX}, up to 100 chars each)
              </label>
              {titles.map((t, i) => (
                <div key={i} style={titleRow}>
                  {titleAngles?.[i] !== undefined ? (
                    <span data-testid={`youtube-title-angle-${i}`} style={angleTag}>
                      {angleLabel(titleAngles[i]!)}
                    </span>
                  ) : null}
                  <input
                    data-testid={`youtube-title-input-${i}`}
                    type="text"
                    maxLength={100}
                    value={t}
                    onChange={(e) =>
                      setTitles((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                    }
                    style={textInput}
                  />
                  <button
                    data-testid={`youtube-title-remove-${i}`}
                    style={smallBtn}
                    // The schema's lower bound, enforced here so the save
                    // can't fail over a bound the UI could have kept.
                    disabled={titles.length <= TITLES_MIN}
                    onClick={() => {
                      setTitles((prev) => prev.filter((_, j) => j !== i));
                      // Angles are parallel to titles — dropping a title
                      // must drop ITS label, not shift a neighbour's onto it.
                      setTitleAngles((prev) => prev && prev.filter((_, j) => j !== i));
                    }}
                    aria-label={`Remove title ${i + 1}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                data-testid="youtube-title-add"
                style={smallBtn}
                disabled={titles.length >= TITLES_MAX}
                onClick={() => {
                  setTitles((prev) => [...prev, ""]);
                  // A user-written title is neither of the model's three
                  // angles — "alt" is the honest label, and keeping the
                  // arrays parallel is what the label rendering relies on.
                  setTitleAngles((prev) => prev && [...prev, "alt"]);
                }}
              >
                + Add title
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Description</label>
              <textarea
                data-testid="youtube-description-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                style={{ ...textInput, resize: "vertical" }}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Hashtags — space-separated, # added if missing</label>
              <input
                data-testid="youtube-hashtags-input"
                type="text"
                value={hashtagsLine}
                onChange={(e) => setHashtagsLine(e.target.value)}
                style={textInput}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Tags — comma-separated</label>
              <input
                data-testid="youtube-tags-input"
                type="text"
                value={tagsLine}
                onChange={(e) => setTagsLine(e.target.value)}
                style={textInput}
              />
              <div
                data-testid="youtube-tags-counter"
                style={{
                  ...counterText,
                  // Over-budget is a warning, not a blocker: the server trims
                  // from the end on save (trimTagsToLimit), and the refetch
                  // shows what survived.
                  ...(tagsUsed > TAGS_CHAR_LIMIT ? { color: "#FFB84D" } : {}),
                }}
              >
                {tagsUsed} / {TAGS_CHAR_LIMIT}
                {tagsUsed > TAGS_CHAR_LIMIT ? " — tags past the budget are dropped on save" : ""}
              </div>
            </div>
            {info.pack?.chapters && info.pack.chapters.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>
                  Chapters (read-only — embedded in the description on save/render)
                </label>
                <div data-testid="youtube-chapters" style={chaptersBox}>
                  {info.pack.chapters.map((c, i) => (
                    <div key={i}>
                      {chapterStampLabel(c.atSec)} {c.title}
                    </div>
                  ))}
                </div>
                <div style={footNote}>
                  Timestamps are measured from the actual edit, so they are not
                  hand-editable here; the .youtube.md splices them into the
                  description's Timestamps block for you.
                </div>
              </div>
            ) : null}
            {hook60 !== null ? (
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>First-60s hook strategy (for you — never uploaded)</label>
                <textarea
                  data-testid="youtube-hook60-input"
                  value={hook60}
                  onChange={(e) => setHook60(e.target.value)}
                  rows={3}
                  style={{ ...textInput, resize: "vertical" }}
                />
              </div>
            ) : null}
            {linkedinPost !== null ? (
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>LinkedIn post</label>
                <textarea
                  data-testid="youtube-linkedin-input"
                  value={linkedinPost}
                  onChange={(e) => setLinkedinPost(e.target.value)}
                  rows={6}
                  style={{ ...textInput, resize: "vertical" }}
                />
              </div>
            ) : null}
            {communityPost !== null ? (
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>Community post</label>
                <textarea
                  data-testid="youtube-community-input"
                  value={communityPost}
                  onChange={(e) => setCommunityPost(e.target.value)}
                  rows={3}
                  style={{ ...textInput, resize: "vertical" }}
                />
              </div>
            ) : null}
            {saveError ? (
              <div data-testid="youtube-error" style={errorText}>
                {saveError}
              </div>
            ) : null}
            <div style={footerRow}>
              <div style={footNote}>
                Saves for future renders and rewrites the .youtube.md file now. Delete
                youtube-pack-approved.json in the workdir to let the AI regenerate.
              </div>
              <button
                data-testid="youtube-save-btn"
                style={{ ...confirmBtn, ...(busy ? { opacity: 0.6, cursor: "default" } : {}) }}
                onClick={() => void onSave()}
                disabled={busy}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
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
  width: 620,
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

const titleRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginBottom: 8,
};

const angleTag: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8B8B9E",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  whiteSpace: "nowrap",
  // The widest label ([Benefit]) sets the column so the inputs line up.
  minWidth: 62,
};

const smallBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const counterText: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: "#8B8B9E",
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const chaptersBox: React.CSSProperties = {
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  padding: "10px 14px",
  color: "#C9C9D4",
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  lineHeight: 1.6,
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
  marginTop: 6,
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
