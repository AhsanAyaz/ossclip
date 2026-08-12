import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { captionAnchorOf, type CaptionLine, type CaptionWord } from "@ossclip/core/browser";
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
  /**
   * The open retype box. `srcStart` and `base` are CAPTURED when it opens,
   * mirroring `Overlay`'s `captionEdit` (§137): the anchor is validated once,
   * at the double-click, so the commit below cannot be handed an unanchorable
   * word — and THOSE TWO FIELDS cannot shift underneath an open editor if a
   * completed render swaps `liveLines` mid-edit. The claim is about them only:
   * `index` is still positional, so a swap that changes the word COUNT can
   * still draw the box over a different word, or unmount it without firing
   * `onBlur`. Pre-existing and out of §137's scope, recorded here so the
   * capture above is not mistaken for a fix to it.
   */
  const [editing, setEditing] = useState<{
    index: number;
    draft: string;
    srcStart: number;
    base: string;
  } | null>(null);
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
      /** The live word itself, carried so a retype can key on its SOURCE
       * time (§137). The panel's own `index` is a scroll/testid handle and
       * nothing more — anchoring an edit to it is the bug this replaced. */
      word: CaptionWord;
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
          word: w,
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
  const matchList = useMemo(
    () => (q ? words.filter((w) => w.live.toLowerCase().includes(q)).map((w) => w.index) : []),
    [q, words],
  );
  const matches = useMemo(() => (q ? new Set(matchList) : null), [q, matchList]);
  // Find NAVIGATION (R17 §81): a cursor over the match list, driven by the
  // chevrons and Enter/⇧Enter, scrolling the hit to view — the usual finder.
  const [matchCursor, setMatchCursor] = useState(0);
  const scrollToWord = (index: number): void => {
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-testid="transcript-word-${index}"]`)
      ?.scrollIntoView?.({ block: "center" });
  };
  useEffect(() => {
    setMatchCursor(0);
    if (matchList.length > 0) scrollToWord(matchList[0]!);
    // Jump to the first hit as the query narrows — matchList identity tracks q.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchList]);
  const gotoMatch = (dir: 1 | -1): void => {
    if (matchList.length === 0) return;
    const next = (matchCursor + dir + matchList.length) % matchList.length;
    setMatchCursor(next);
    scrollToWord(matchList[next]!);
  };

  const commit = (open: NonNullable<typeof editing>): void => {
    const text = open.draft.trim();
    // Empty is a cancel: a word cannot be deleted here — 1:1 is the contract.
    // The anchor needs no re-check: `openRetype` below refuses to open on a
    // word that has none, so nothing unanchorable can reach `patchCaption`
    // (which would throw in `captionKeyFor`).
    if (text) edits.patchCaption(open.srcStart, text, open.base);
    setEditing(null);
  };

  /**
   * Open the retype box — or refuse (§137). A word with no SOURCE anchor
   * cannot carry an edit, and the refusal belongs HERE rather than at the
   * commit: gating at the commit let the user type a correction, press Enter,
   * and watch the word revert with no explanation, which is precisely the
   * silent-discard experience this whole change exists to remove. `Overlay`'s
   * stage double-click already refuses to open; the two paths agree.
   *
   * `captionAnchorOf` is core's single definition of "anchorable" — the same
   * verdict `CaptionTrack` gates its `data-caption-src` on, so the transcript
   * and the stage can never disagree about which words are editable.
   */
  const openRetype = (w: (typeof words)[number]): void => {
    if (captionAnchorOf(w.word) === null) return;
    setEditing({ index: w.index, draft: w.live, srcStart: w.word.srcStart, base: w.base });
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            data-testid="transcript-search"
            style={{ ...search, flex: 1 }}
            placeholder="Find a word…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter walks the hits, ⇧Enter walks them backwards — the
              // universal finder contract.
              if (e.key === "Enter") {
                e.preventDefault();
                gotoMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <button
            data-testid="transcript-prev"
            style={chevron}
            onClick={() => gotoMatch(-1)}
            disabled={matchList.length === 0}
            title="Previous match (⇧Enter)"
            aria-label="Previous match"
          >
            ‹
          </button>
          <button
            data-testid="transcript-next"
            style={chevron}
            onClick={() => gotoMatch(1)}
            disabled={matchList.length === 0}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            ›
          </button>
        </div>
        {matches ? (
          <div data-testid="transcript-match-count" style={{ fontSize: 11, color: "#9A9AA3" }}>
            {matchList.length === 0
              ? "0 matches"
              : `${matchCursor + 1}/${matchList.length} match${matchList.length === 1 ? "" : "es"}`}
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
                onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                onBlur={() => commit(editing)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                data-testid={`transcript-word-${w.index}`}
                onClick={() => playerRef.current?.seekTo(Math.round(w.start * fps))}
                onDoubleClick={() => openRetype(w)}
                title={
                  w.live !== w.base
                    ? `edited (was “${w.base}”) — double-click to retype`
                    : "click to jump · double-click to retype"
                }
                style={{
                  ...word,
                  ...(matches?.has(w.index) ? matchStyle : {}),
                  ...(matchList[matchCursor] === w.index ? currentMatchStyle : {}),
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

/** The match the cursor is ON — brighter than its siblings, like any finder. */
const currentMatchStyle: React.CSSProperties = {
  background: "#3d3a17",
  outline: "2px solid #FFE14D",
  color: "#fff",
};

const chevron: React.CSSProperties = {
  width: 26,
  height: 30,
  fontSize: 16,
  lineHeight: 1,
  color: "#EDEDF2",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  cursor: "pointer",
  padding: 0,
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
