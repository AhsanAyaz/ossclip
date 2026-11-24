import React, { useState } from "react";
import type { StoryboardShot } from "@ossclip/core/browser";
import { approveBlock, draftIsStale, type ShotDetail, type StoryboardRow } from "./storyboardModel";
import {
  STATE_COLOR,
  WARN,
  errorText,
  footNote,
  formBox,
  formButtons,
  formLabel,
  ideaArea,
  lineText,
  off,
  primaryBtn,
  rowBox,
  rowHead,
  rowLabel,
  stateText,
  subtitle,
  toolBtn,
  actionBtn,
  whyText,
} from "./storyboardStyles";

/**
 * One shot of the storyboard, inside the same modal as the table (storyboard
 * design §10 "Shot view"; plan B2a Task 5; §169): the draft's stills, its
 * preview, the idea, the notes, a note box with Redraw, the versions, and
 * Approve.
 *
 * Display only. Every action is the panel's (StoryboardPanel.tsx), which
 * owns the one-request-at-a-time gate and the job poll; this view calls it
 * and shows what the server answered.
 *
 * The shot's drawing is never mounted here: its stills are `<img>` and its
 * preview a `<video>`, both served from `/media/` (Global Constraints: the
 * LLM-written `.tsx` runs only in the headless render browser, never in the
 * editor page). `cacheKey` is appended to their URLs because Approve renders
 * the draft's stills again at the clip's length under the same names.
 */

export interface StoryboardShotViewProps {
  shot: StoryboardShot;
  /** The table's row for the shot: its state and spoken line on the live clock. */
  row: StoryboardRow;
  detail: ShotDetail | null;
  /** App's `edits.dirty`: Approve is refused while it is true (Review Focus 4). */
  dirty: boolean;
  jobRunning: boolean;
  /** A request of the panel's is in flight. */
  busy: boolean;
  cacheKey: number;
  onBack: () => void;
  onPreview: () => void;
  /** Resolves true when the redraw started, so the box can be cleared. */
  onRedraw: (text: string) => Promise<boolean>;
  onMakeDraft: (version: number) => void;
  onApprove: () => void;
  onUnapprove: () => void;
}

/** The server's note limit (`StoryboardNoteBodySchema`, edit.ts): the box stops there rather than be refused. */
const NOTE_MAX_CHARS = 1000;

export const StoryboardShotView: React.FC<StoryboardShotViewProps> = ({
  shot,
  row,
  detail,
  dirty,
  jobRunning,
  busy,
  cacheKey,
  onBack,
  onPreview,
  onRedraw,
  onMakeDraft,
  onApprove,
  onUnapprove,
}) => {
  const [note, setNote] = useState("");
  const draft = detail?.draft ?? null;
  const draftVersion = draft === null ? undefined : detail?.versions.find((v) => v.n === draft);
  const bust = (url: string): string => `${url}?v=${cacheKey}`;
  const block = approveBlock({ dirty, draft, jobRunning });
  const stale = draftIsStale(shot, detail);
  const starting = busy || jobRunning;
  const noteText = note.trim();

  return (
    <div data-testid="storyboard-shot-view" style={{ marginTop: 14 }}>
      <div style={rowHead}>
        <button type="button" data-testid="storyboard-shot-back" style={toolBtn} onClick={onBack}>
          ← Back to table
        </button>
        <span style={rowLabel}>Shot {shot.id}</span>
        <span style={{ ...stateText, color: STATE_COLOR[row.state] }}>
          {row.state === "drawn" && row.draft !== null ? `drawn (v${row.draft})` : row.state}
        </span>
      </div>
      {row.line.length > 0 ? <div style={lineText}>“{row.line}”</div> : null}

      {draftVersion !== undefined && draftVersion.stills.length > 0 ? (
        <div style={stillsRow}>
          {draftVersion.stills.map((src, i) => (
            <img
              key={src}
              data-testid={`storyboard-still-${i + 1}`}
              src={bust(src)}
              alt={`Shot ${shot.id}, version ${draftVersion.n}, still ${i + 1}`}
              style={still}
            />
          ))}
        </div>
      ) : (
        <div style={{ ...subtitle, marginTop: 10 }}>
          {detail === null ? "Not drawn yet: draw it from the table." : "No draft to show: every version failed its checks."}
        </div>
      )}

      <div style={{ ...formButtons, alignItems: "center" }}>
        <button
          type="button"
          data-testid="storyboard-preview"
          style={off(toolBtn, starting || draft === null)}
          disabled={starting || draft === null}
          // Design §7: three stills cannot show whether the motion works.
          title="Render the draft small, to see it move (no LLM call)"
          onClick={onPreview}
        >
          Preview
        </button>
      </div>
      {draftVersion?.preview ? (
        <video
          data-testid="storyboard-preview-video"
          src={bust(draftVersion.preview)}
          controls
          loop
          muted
          style={previewVideo}
        />
      ) : null}

      <div style={{ ...formLabel, marginTop: 14 }}>Idea</div>
      <div style={rowLabel}>{shot.idea}</div>
      {stale && detail?.drawnIdea ? (
        <div data-testid="storyboard-shot-stale" style={{ ...whyText, color: WARN }}>
          The draft was drawn from an earlier idea: “{detail.drawnIdea}”. Use Draw again in the table to draw this one.
        </div>
      ) : null}

      <div style={{ ...formLabel, marginTop: 14 }}>Notes</div>
      {detail !== null && detail.notes.length > 0 ? (
        detail.notes.map((n, i) => (
          <div key={i} style={footNote}>
            on v{n.onVersion}: {n.text}
          </div>
        ))
      ) : (
        <div style={footNote}>No notes yet.</div>
      )}
      <textarea
        data-testid="storyboard-note-input"
        aria-label={`Note for shot ${shot.id}`}
        style={ideaArea}
        rows={2}
        maxLength={NOTE_MAX_CHARS}
        value={note}
        placeholder="What to change in the draft"
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={formButtons}>
        <button
          type="button"
          data-testid="storyboard-redraw"
          style={off(toolBtn, starting || draft === null || noteText.length === 0)}
          disabled={starting || draft === null || noteText.length === 0}
          title={
            draft === null
              ? "There is no draft for a note to change"
              : noteText.length === 0
                ? "Type the note first"
                : "Redraw the draft with this note (LLM calls)"
          }
          onClick={() => {
            void onRedraw(noteText).then((started) => {
              if (started) setNote("");
            });
          }}
        >
          Redraw
        </button>
      </div>

      <div style={{ ...formLabel, marginTop: 14 }}>Versions</div>
      {detail === null || detail.versions.length === 0 ? <div style={footNote}>None yet.</div> : null}
      {detail?.versions.map((v) => (
        <div key={v.n} data-testid={`storyboard-version-${v.n}`} style={rowBox}>
          <div style={rowHead}>
            <span style={rowLabel}>v{v.n}</span>
            <span style={{ ...stateText, color: v.ok ? STATE_COLOR.drawn : STATE_COLOR.failed }}>{v.ok ? "ok" : "failed"}</span>
            {v.n === draft ? <span style={stateText}>· the draft</span> : null}
            <span style={{ flex: 1 }} />
            {v.ok && v.n !== draft ? (
              <button
                type="button"
                data-testid={`storyboard-make-draft-${v.n}`}
                style={off(actionBtn, starting)}
                disabled={starting}
                title="Look at this version again; Approve then approves it"
                onClick={() => onMakeDraft(v.n)}
              >
                Make draft
              </button>
            ) : null}
          </div>
          {v.error !== undefined ? <div style={{ ...errorText, fontSize: 12 }}>{v.error}</div> : null}
          {v.said !== undefined ? <div style={whyText}>{v.said}</div> : null}
        </div>
      ))}

      <div style={formBox}>
        {shot.approval !== undefined ? (
          <div style={{ ...rowHead, marginBottom: 8 }}>
            <span data-testid="storyboard-approved" style={{ ...rowLabel, color: STATE_COLOR["in the video"] }}>
              In the video (version {shot.approval.version}, {shot.approval.durationSec} s)
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-testid="storyboard-unapprove"
              style={off(actionBtn, starting)}
              disabled={starting}
              title="Take the clip out of the video; the drawing stays"
              onClick={onUnapprove}
            >
              Remove from video
            </button>
          </div>
        ) : null}
        <div style={{ ...rowHead }}>
          <button
            type="button"
            data-testid="storyboard-approve"
            style={off(primaryBtn, busy || block !== null)}
            disabled={busy || block !== null}
            // Design §8: the clip is rendered at the length the cut gives the
            // shot now, and the video is updated with it.
            title="Render the draft as a clip at the shot's length now, and put it in the video"
            onClick={onApprove}
          >
            {draft !== null ? `Approve v${draft}` : "Approve"}
          </button>
          {block !== null ? (
            <span data-testid="storyboard-approve-block" style={{ ...stateText, color: block === "Save first" ? WARN : stateText.color }}>
              {block === "Save first" ? "Save first: the video is updated from the saved edits" : block}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const stillsRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 12,
};

// A third of the row each, at the frame's own shape: the stills are frames
// of the video, so a portrait project shows portrait stills.
const still: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  maxHeight: 280,
  objectFit: "contain",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
};

const previewVideo: React.CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: 320,
  marginTop: 8,
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
};
