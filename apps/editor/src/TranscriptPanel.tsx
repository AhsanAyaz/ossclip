import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { CaptionLine } from "@ossclip/core/browser";
import type { useEdits } from "./useEdits";

/**
 * The transcript view (R15 §59): every caption word in one scrollable,
 * searchable list — find a word, fix it, jump the preview to it.
 *
 * Deliberately thin, because the hard half already exists: edits write
 * through `OverrideDoc.captions` (the R11 retype layer), which the live memo
 * merges into the preview and `produce` applies on re-render. The scope is
 * the layer's own contract — 1:1 retype, stated in the header: cues anchor
 * to word INDICES and word timings drive the kinetic highlight, so
 * inserting, deleting, splitting or merging words is a re-timing project,
 * not a text box (§59b). Cutting the VIDEO from the transcript is a third
 * thing again and explicitly out of scope (§59c).
 */
export const TranscriptPanel: React.FC<{
  /** Pristine pre-edit lines — the truth the retype guard compares against. */
  baseLines: CaptionLine[];
  /** The live merged lines — what the preview shows, edits included. */
  liveLines: CaptionLine[];
  fps: number;
  playerRef: React.RefObject<PlayerRef | null>;
  edits: ReturnType<typeof useEdits>;
  /** Pane width in px — owned by App, dragged via the divider (R16 §65). */
  width: number;
}> = ({ baseLines, liveLines, fps, playerRef, edits, width }) => {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ index: number; draft: string } | null>(null);
  // The word under the playhead, so reading follows playback. Index only —
  // recomputed on frameupdate but committed to state solely when it changes,
  // or the panel would re-render at the frame rate.
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Flatten once per lines change: global word index → texts + timing.
  const words = useMemo(() => {
    const out: Array<{
      index: number;
      base: string;
      live: string;
      start: number;
      end: number;
      lineStart: number;
    }> = [];
    let index = 0;
    for (let li = 0; li < liveLines.length; li++) {
      const live = liveLines[li]!;
      const base = baseLines[li];
      for (let wi = 0; wi < live.words.length; wi++) {
        const w = live.words[wi]!;
        out.push({
          index: index,
          // Base text falls back to the live text for old workdirs that
          // carry no pristine copy — the reducer's `captionEditWas` keeps
          // re-edits safe either way.
          base: base?.words[wi]?.text ?? w.text,
          live: w.text,
          start: w.start,
          end: w.end,
          lineStart: live.start,
        });
        index++;
      }
    }
    return out;
  }, [baseLines, liveLines]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => {
      const t = e.detail.frame / fps;
      const hit = words.find((w) => t >= w.start && t < w.end);
      setCurrentIndex((prev) => (hit ? (hit.index === prev ? prev : hit.index) : prev));
    };
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [playerRef, fps, words]);

  // The view follows the cursor (R16 §72): while playback reads through the
  // transcript, the highlighted word stays in view. `nearest` scrolls only
  // when it actually left the pane, so reading elsewhere isn't yanked around
  // unless playback truly moved on.
  useEffect(() => {
    if (currentIndex === null) return;
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-testid="transcript-word-${currentIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [currentIndex]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? new Set(words.filter((w) => w.live.toLowerCase().includes(q)).map((w) => w.index)) : null),
    [q, words],
  );

  const commit = (index: number, base: string, draft: string): void => {
    const text = draft.trim();
    // Empty is a cancel: a word cannot be deleted here — 1:1 is the contract.
    if (text) edits.patchCaption(index, text, base);
    setEditing(null);
  };

  return (
    <div data-testid="transcript-panel" style={{ ...panel, width }}>
      <div style={header}>
        <span style={title}>Transcript</span>
        <div style={scopeNote}>
          Click a word to jump the preview there; double-click to retype it.
          1:1 retype only — word count and timing stay fixed, so scene anchors
          and the caption highlight keep working.
        </div>
        <input
          data-testid="transcript-search"
          style={search}
          placeholder="Find a word…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {matches ? (
          <div style={{ fontSize: 11, color: "#9A9AA3" }}>
            {matches.size} match{matches.size === 1 ? "" : "es"}
          </div>
        ) : null}
      </div>
      <div style={body} data-testid="transcript-body" ref={bodyRef}>
        {words.map((w, i) => (
          <React.Fragment key={w.index}>
            {/* A REAL space between word spans, not a margin: margins are
                not line-break opportunities, and without whitespace the
                browser treated each caption line as one unbreakable inline
                run — wrapping only at in-text hyphens while everything else
                ran off the pane's right edge (the §65 report). */}
            {i > 0 ? " " : null}
            {editing?.index === w.index ? (
              <input
                autoFocus
                data-testid="transcript-edit"
                style={editInput}
                value={editing.draft}
                onChange={(e) => setEditing({ index: w.index, draft: e.target.value })}
                onBlur={() => commit(w.index, w.base, editing.draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                data-testid={`transcript-word-${w.index}`}
                onClick={() => playerRef.current?.seekTo(Math.round(w.start * fps))}
                onDoubleClick={() => setEditing({ index: w.index, draft: w.live })}
                title={
                  w.live !== w.base
                    ? `edited (was “${w.base}”) — double-click to retype`
                    : "click to jump · double-click to retype"
                }
                style={{
                  ...word,
                  ...(matches?.has(w.index) ? matchStyle : {}),
                  ...(w.live !== w.base ? editedStyle : {}),
                  ...(currentIndex === w.index ? currentStyle : {}),
                }}
              >
                {w.live}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

const panel: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  background: "#111116",
  minHeight: 0,
};

const header: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "14px 14px 10px",
  borderBottom: "1px solid #1E1E24",
};

const title: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#9A9AA3",
};

const scopeNote: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.45,
  color: "#6a6a75",
};

const search: React.CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 13,
  background: "#0F0F14",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  color: "#fff",
  padding: "6px 8px",
};

const body: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  // Never a horizontal scrollbar (overflow-y: auto alone computes the x
  // axis to auto too); a pathological unbreakable token breaks mid-word
  // rather than widening the pane.
  overflowX: "hidden",
  overflowWrap: "break-word",
  padding: "10px 14px 16px",
  fontSize: 13,
  lineHeight: 2,
  color: "#C9C9D4",
};

const word: React.CSSProperties = {
  cursor: "pointer",
  borderRadius: 3,
  padding: "1px 2px",
};

const matchStyle: React.CSSProperties = {
  background: "#2b2b1a",
  outline: "1px solid #6b6432",
};

const editedStyle: React.CSSProperties = {
  color: "#FFE14D",
};

const currentStyle: React.CSSProperties = {
  background: "#1c2333",
  outline: "1px solid #5b8cff",
};

const editInput: React.CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 13,
  width: 110,
  background: "#0F0F14",
  border: "1px solid #FFE14D",
  borderRadius: 4,
  color: "#fff",
  padding: "1px 4px",
};
