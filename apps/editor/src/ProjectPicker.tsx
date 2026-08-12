import React, { useEffect, useRef, useState } from "react";

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

/**
 * Splits a recent project's path into the part worth reading big and the
 * prefix worth reading small (§138). Recents accumulate under one working
 * root, so every path shares a long identical head and differs only in its
 * TAIL — tail-ellipsising the single line (what this used to do) cut off the
 * only part that told two entries apart. Pure so the boundary is testable
 * without a DOM.
 */
export const splitRecentPath = (path: string, tailSegments = 3): { head: string; tail: string } => {
  const segments = path.split("/");
  // A leading "/" yields an empty first segment; it belongs to the head, and
  // a path with no head at all (a bare name) must still render its tail.
  if (segments.length <= tailSegments) return { head: "", tail: path };
  const cut = segments.length - tailSegments;
  return { head: segments.slice(0, cut).join("/") || "/", tail: segments.slice(cut).join("/") };
};

/**
 * Whether a scroll region has more below the fold — i.e. whether the "there
 * is more" fade should be on. The 1px slack absorbs sub-pixel clientHeight
 * on fractional-DPI displays, where an at-the-end list reports a scrollTop
 * a hair short of scrollHeight and would otherwise fade forever.
 */
export const isScrollContinuable = (m: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean => m.scrollTop + m.clientHeight < m.scrollHeight - 1;

/**
 * Where arrow-key focus lands, clamped rather than wrapped: wrapping from the
 * last row back to the first in a scroll list reads as a scroll jump, not as
 * navigation. Returns `current` unchanged when the move would leave the list.
 */
export const nextRowIndex = (current: number, delta: number, count: number): number => {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, current + delta));
};

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const recentRef = useRef<HTMLDivElement | null>(null);
  // Bottom fade only while the list is actually scrollable and not already
  // at its end — a static fade on a short list would lie about there being
  // more to see. Both lists carry it: the recents list is the one that
  // overflows first, and it was the one with no affordance at all (§138).
  const [listOverflows, setListOverflows] = useState(false);
  const [recentOverflows, setRecentOverflows] = useState(false);

  const recomputeListOverflow = (): void => {
    // Degrade to no-fade if the ref is unmounted (spec's stated fallback).
    setListOverflows(listRef.current ? isScrollContinuable(listRef.current) : false);
  };
  const recomputeRecentOverflow = (): void => {
    setRecentOverflows(recentRef.current ? isScrollContinuable(recentRef.current) : false);
  };

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
    // Recompute after every listing change (content height changes) and on
    // window resize (the flex list's clientHeight changes with the window).
    const recompute = (): void => {
      recomputeListOverflow();
      recomputeRecentOverflow();
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing, recent]);

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

  // Arrow keys walk the rows of whichever list has focus; Enter and Space are
  // already the <button>'s own business, so they are deliberately not handled
  // here. focus() scrolls the row into view for free, which is what keeps
  // keyboard navigation and the scroll region agreeing with each other.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 && e.key !== "Home" && e.key !== "End") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : nextRowIndex(current, delta, rows.length);
    e.preventDefault();
    rows[target]?.focus();
  };

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
          <div style={{ marginTop: 16, flexShrink: 0 }}>
            <div style={sectionTitle}>recent</div>
            {/* The list keeps its own modest scroll (spec: "recent list keeps
                a modest maxHeight with its own scroll") instead of growing
                unbounded — a full recents list at a short window height would
                otherwise collapse `browseSection` to zero and push the browse
                panel past the card, unreachable. */}
            <div
              ref={recentRef}
              className="ossclip-scroll-list"
              style={recentOverflows ? { ...recentList, ...bottomFade } : recentList}
              onScroll={recomputeRecentOverflow}
              onKeyDown={onListKeyDown}
              data-testid="project-recent-list"
            >
              {recent.map((p) => {
                const { head, tail } = splitRecentPath(p);
                return (
                  <button
                    key={p}
                    data-testid="project-recent"
                    className="ossclip-picker-row"
                    style={{ ...entryButton, ...recentRow }}
                    disabled={busy}
                    onClick={() => open(p)}
                    title={p}
                  >
                    <span style={{ color: "#FFE14D", flexShrink: 0 }}>▸</span>
                    <span style={recentText}>
                      <span style={recentTail}>{tail}</span>
                      {head ? <span style={recentHead}>{head}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div style={browseSection}>
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
              <div
                ref={listRef}
                className="ossclip-scroll-list"
                style={listOverflows ? { ...entryList, ...bottomFade } : entryList}
                onScroll={recomputeListOverflow}
                onKeyDown={onListKeyDown}
                data-testid="project-fs-list"
              >
                {listing.parent ? (
                  <button
                    data-testid="project-fs-up"
                    className="ossclip-picker-row"
                    style={entryButton}
                    disabled={busy}
                    onClick={() => void browse(listing.parent!)}
                  >
                    <span style={{ color: "#6a6a75", flexShrink: 0 }}>↑</span>
                    <span style={entryName}>..</span>
                  </button>
                ) : null}
                {listing.entries.map((e) => (
                  <button
                    key={e.path}
                    data-testid={e.isWorkdir ? "project-fs-workdir" : "project-fs-dir"}
                    className={`ossclip-picker-row${e.isWorkdir ? " is-workdir" : ""}`}
                    style={entryButton}
                    disabled={busy}
                    // A project opens; an ordinary folder descends. One click
                    // each — the isWorkdir flag decides which it is.
                    onClick={() => (e.isWorkdir ? open(e.path) : void browse(e.path))}
                    title={e.path}
                  >
                    <span style={{ flexShrink: 0, color: e.isWorkdir ? "#FFE14D" : "#6a6a75" }}>
                      {e.isWorkdir ? "▸" : "▪"}
                    </span>
                    <span style={entryName}>
                      {e.name}
                      {e.isWorkdir ? null : <span style={{ color: "#55555f" }}>/</span>}
                    </span>
                    {e.isWorkdir ? <span style={workdirBadge}>project</span> : null}
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
  // Without this the 26px padding and 1px border are ADDED to the 82vh cap
  // (there is no global box-sizing reset), so the card measured 868px against
  // an 820px budget and hung past the viewport on short windows (§138).
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
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

// The card is a flex column with no scroll of its own (see `panel`); this
// section is the item that grows to fill it, so its child `entryList` has
// somewhere to grow into rather than overflowing the card's maxHeight.
const browseSection: React.CSSProperties = {
  marginTop: 16,
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

// Its own capped scroll region (see the comment at the call site) — a long
// recents list must not be able to starve the browse section below it.
const recentList: React.CSSProperties = {
  // Deliberately not a multiple of the 46px row: a half-height row peeking at
  // the bottom edge is the cheapest honest "this scrolls" signal there is.
  maxHeight: 218,
  overflowY: "auto",
  overscrollBehavior: "contain",
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const entryList: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  // Reaching the end of this list must not start scrolling the editor behind
  // the modal — the card has no scroll of its own to hand the gesture to.
  overscrollBehavior: "contain",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

// Fades the last ~24px so a scrollable-but-not-at-end list reads as
// continuable rather than clipped. Applied only while listOverflows.
const bottomFade: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)",
};

/**
 * §138, the bug this shape exists to prevent: these rows are flex items in a
 * column list, and `overflow: hidden` gives a flex item an automatic minimum
 * size of ZERO. With the default `flex-shrink: 1` the rows therefore absorbed
 * the overflow themselves — crushing to 18px with the glyphs overlapping —
 * and the list's `overflow-y: auto` never fired, because scrollHeight never
 * exceeded clientHeight. `flexShrink: 0` plus a real minHeight is what makes
 * the content overflow so the container can scroll it. Do not remove either.
 */
const entryButton: React.CSSProperties = {
  flexShrink: 0,
  minHeight: 34,
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  boxSizing: "border-box",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.4,
  // color/background/border deliberately live in `.ossclip-picker-row` in
  // index.css instead of here: an inline declaration outranks any stylesheet
  // rule short of !important, so a `background: transparent` here would make
  // the :hover and :focus rules dead code.
  borderRadius: 6,
  // Generous enough to be a click target rather than a line of text (the
  // whole row is the hit area, which is why the padding lives on the button).
  padding: "6px 10px",
  cursor: "pointer",
  overflow: "hidden",
};

const entryName: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Two lines, so the tail can be read at full size while the shared prefix
// stays available but quiet (see splitRecentPath).
const recentRow: React.CSSProperties = {
  minHeight: 46,
  alignItems: "center",
};

const recentText: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
};

const recentTail: React.CSSProperties = {
  color: "#EDEDF2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const recentHead: React.CSSProperties = {
  fontSize: 11,
  color: "#6a6a75",
  // The prefix is the throwaway part, so it is the part allowed to ellipsis.
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};


const workdirBadge: React.CSSProperties = {
  marginLeft: 10,
  fontSize: 11,
  fontWeight: 700,
  color: "#FFE14D",
};
