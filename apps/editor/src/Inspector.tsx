import React from "react";
import {
  cutRangeToOldClock,
  LayoutSchema,
  scalarPropControls,
  SceneComponentIdSchema,
  splitRootId,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";
import { clampGraphicRect, graphicSlotFor, layoutSlots } from "@ossclip/renderer/composition";
import type { useEdits } from "./useEdits";
import {
  EMPTY_LUT_MENU,
  GRADE_PRESET_IDS,
  configGradeName,
  effectiveGrade,
  gradeForSource,
  gradeSliderState,
  gradeSourceValue,
  type LutMenu,
} from "./colorPanel";
import { sfxAudioUrl, type SfxLibrarySound, type SfxMarker } from "./sfxLane";
import { buildArrayPatch, elementTextOf, type Selection, type VideoPreview } from "./Overlay";

/** What planned this video and what it cost (R21 §104) — `/api/usage`'s
 * shape, read straight off the workdir's own artefacts. */
export interface RunInfo {
  usage: {
    totals?: {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      billedUsd: number | null;
      equivalentUsd: number | null;
      anyEstimated: boolean;
      allUnbilled: boolean;
    } | null;
    runs?: Array<{ at: string; cached: boolean }>;
  } | null;
  production: {
    producer?: { provider: string; models: string[]; cached?: boolean; at?: string } | null;
    clip?: { targetSec: number; startSec: number; endSec: number; reason: string } | null;
    cleanup?: string | null;
    intent?: string | null;
    sourceDuration?: number | null;
  } | null;
}

interface InspectorProps {
  selection: Selection | null;
  /** The currently-selected scene's resolved cue, or null when nothing is selected. */
  cue: SceneCue | null;
  /** The output frame (`settings.width/height`) — slot geometry follows it (R15). */
  frame: { width: number; height: number };
  /** Every live cue id, in time order — the §56b "apply to all" fan-out list. */
  allSceneIds: string[];
  edits: ReturnType<typeof useEdits>;
  /**
   * Drops the ELEMENT half of the selection (PLAN Task 2): the "Delete
   * element" button calls this right after hiding, with `elementId: null`
   * — the element has zero rect once `editStyle` returns `display:none`
   * (`hitTest.rectOf`, Overlay's box-measure effect, would collapse to
   * nothing), so nothing on stage is left for an ELEMENT selection to keep
   * pointing at. The SCENE half survives on purpose: it lands the user on
   * this same scene's panel, right where the "Hidden elements" Restore
   * list they just populated lives.
   */
  onSelect: (selection: Selection | null) => void;
  /**
   * The theme actually on screen right now (defaults merged with the
   * override doc) — the fallback a theme field shows when the user hasn't
   * overridden that token. Hardcoding a fallback here instead (as before)
   * would show the wrong swatch for anyone whose production resolved to a
   * theme other than `defaultTheme`.
   */
  resolvedTheme: Theme;
  /** The caption words under the cue's window — what "tracking" tracks. */
  anchorText?: string;
  /** Live framing preview (PLAN Task B) — the zoom slider writes it while
   * scrubbing, the release commits the real patch and clears it. */
  onVideoPreview: (preview: VideoPreview | null) => void;
  /** Run provenance and cost for the no-selection view (R21 §104). */
  runInfo?: RunInfo | null;
  /**
   * The last produce was typed with `--no-captions` (render-props'
   * `captionsHiddenByFlag`). Surfaced so the Captions toggle can say the
   * honest thing: that pin replays on every Render, so the toggle — which
   * only writes the OVERRIDE side of the OR — cannot bring captions back
   * on such a workdir.
   */
  captionsHiddenByFlag?: boolean;
  /**
   * "Delete this chunk"'s WRITE boundary (cut review step 4 follow-up): the
   * cue's window speaks the player's LIVE clock (App retimes every cue under
   * a live cleanup veto), but a fresh `cuts[]` entry's `startSec`/`endSec`
   * speak the LAST RENDER's output seconds — produce resolves `src` against
   * the prior TimeMap (the `OverrideDocSchema.cuts` comment), so an unmapped
   * write lands the cut the revived seconds off. Both endpoints convert
   * through `cutRangeToOldClock` at the click. Identity default, so the
   * no-veto path (and every existing harness) writes bit-identical values.
   */
  fromLive?: (sec: number) => number;
  /** `fromLive`'s guard (`previewClockMappers.hasOldClockPreimage`) — feeds
   * `cutRangeToOldClock`'s exact/shrunk/degenerate verdict. Defaults to
   * always-true, the no-veto shape. */
  hasOldClockPreimage?: (sec: number) => boolean;
  /**
   * Live-output → SOURCE seconds (`previewClockMappers.toSourceSec`), the
   * cut's own anchor since the cut-review rework: the cue's window resolves
   * through it at the click and the entry is written `{startSec, endSec,
   * src}` — the ⌘B dual-write posture (Overlay.tsx), now allowed for cuts
   * too (`OverrideDocSchema.cuts`). That is what makes "Delete this chunk"
   * work INSIDE revived material, where no old-clock window exists: the
   * record clamps, the source anchor is exact, and the preview applies it
   * live. NULL (no spans, no live map) is the honest fallback and keeps the
   * pre-rework flow verbatim, refusal included — a source second is never
   * guessed. Defaults to null so every existing harness pins that path.
   */
  toSourceSec?: ((sec: number) => number) | null;
  /** Visible refusal channel for a cut window with NO old-clock extent at
   * all (`cutRangeToOldClock`'s degenerate verdict) and NO `toSourceSec` to
   * anchor it with instead — App's dismissible notice, the same non-fatal
   * chrome as its other gesture refusals. */
  onClockRefused?: (message: string) => void;
  /**
   * The SFX marker the timeline lane has selected, already merged (plan +
   * overrides) by `sfxLaneMarkers`. Non-null takes the WHOLE panel, above the
   * element/scene branches — App keeps the two selection namespaces mutually
   * exclusive, so this can never be showing over a scene the user also thinks
   * is selected.
   */
  sfxMarker?: SfxMarker | null;
  /**
   * `/api/sfx/library` — every sound INSTALLED, level-agnostic on purpose:
   * the model's `--sfx-level` gate prices the model's own plan, and an
   * explicit user choice outranks it (Phase 3 doctrine), so the dropdown
   * offers a meme sound on a `subtle` video without comment.
   */
  sfxLibrary?: readonly SfxLibrarySound[];
  /**
   * This production HAS a `sfx` plan — the same signal that draws the lane.
   * Gates the "add a sound" palette, because produce only applies the override
   * layer when a plan exists (`if (sfxPlan)`, produce.ts): offering an add on
   * a workdir produced without `--sfx` would promise an effect no render would
   * ever play.
   */
  sfxEnabled?: boolean;
  /**
   * `/api/luts` — the Color section's .cube menu plus the config-level
   * default grade. Doc-global like the theme tokens, so it rides the
   * no-selection panel. Absent (fetch failed / old server) degrades to the
   * empty menu: presets and Off still work, only the LUT entries and the
   * "Default" label go missing.
   */
  lutMenu?: LutMenu;
  /**
   * Deleted scenes at their LIVE windows (App's ghostCues) — the plain take
   * covering one offers its Restore chip. A hidden scene has no block and no
   * selection of its own any more (field report 2026-08-31): the take the
   * fill minted is the cue the player reads, so it owns the controls AND the
   * way back.
   */
  deletedScenes?: readonly SceneCue[];
  /**
   * The transcript word under the playhead, read AT THE CLICK — the
   * CoverPanel's `playheadSec` idiom: the panel must not re-render on every
   * frame just to keep a number it needs once. Null when no word is there to
   * anchor to (a gap, or a clip with no words left), and the palette says so
   * rather than guessing an index.
   */
  sfxWordAtPlayhead?: () => number | null;
}

const row: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
/** Two fields on one line — the X/Y and W/H pairs (R20 §96). */
const pairGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#9A9AA3",
};
const numberInput: React.CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  fontSize: 13,
  background: "#0F0F14",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  color: "#fff",
  padding: "6px 8px",
  width: "100%",
};
const textInput: React.CSSProperties = {
  ...numberInput,
  fontFamily: "'Inter', system-ui, sans-serif",
};
const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "16px 18px",
  borderBottom: "1px solid #22222a",
};
const button: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#FF5C5C",
  background: "transparent",
  border: "1px solid #452626",
  borderRadius: 6,
  padding: "7px 10px",
  cursor: "pointer",
};

/**
 * Blur before running a destructive/mutating button's click (PLAN
 * 2026-08-04 Task 2, bug 4). Confirmed via a jsdom mount, not assumed: a
 * click that switches which Inspector view renders (Delete/Restore scene)
 * unmounts the button and the browser already resets focus to `<body>` —
 * but a click that DOESN'T change the view (Reset element/framing/box/
 * bubble/captions, Un-pin, Apply to all) leaves React re-using the exact
 * same DOM node, and the button keeps focus after its own click. Overlay's
 * global keydown listener has no `Enter` case, so a focused button just
 * sits there ready to silently re-fire its own click on the next Enter
 * press instead of any shortcut reaching the player or timeline — a
 * narrower guard (treating a focused button as "typing", the way inputs
 * already are) was rejected because it would also block Enter/Space from
 * activating a legitimately-focused button elsewhere (the stage's own
 * Play/Pause, `?`'s ShortcutsModal) — the failure mode a chunk of
 * `Overlay.tsx`'s own guard exists to avoid. Blurring here instead is
 * unconditional across every button below, Delete/Restore included: the
 * rule then doesn't depend on an unmount happening to keep resetting focus
 * on its own.
 */
const blurActive = (): void => {
  (document.activeElement as HTMLElement | null)?.blur?.();
};

/** Display precision (§48): three decimals is enough for any real edit —
 * never the 13 digits of float dust a drag can produce. */
const roundShown = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Millisecond precision for a value about to be STORED (`cuts[].src`) — the
 * ⌘B rule (Overlay.tsx): rounds belong to the values being written, not to
 * the clock the gesture happened to be on. Also what makes the reducer's
 * src-equality dedupe an exact comparison rather than a tolerance. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Play one sound through the edit server's own preview route.
 *
 * The URL is built by `sfxAudioUrl` (the pure half, tested), and only the
 * PLAY is here — the `openCommand`/`openInBrowser` split. Failures are
 * swallowed on purpose: a browser that refuses to start audio without a
 * gesture, or a pack file deleted since the library loaded (a 404), must cost
 * the click, never the panel. This stays the AUDITION affordance — "what does
 * this sound like" with the player parked — alongside the timeline's synced
 * preview (`useSfxPreview`, 2026-08-29), which answers the different question
 * of how it lands in the cut.
 */
const previewSound = (soundId: string): void => {
  try {
    void new Audio(sfxAudioUrl(soundId)).play()?.catch(() => {});
  } catch {
    // no audio element, or the environment refuses one — nothing to report
  }
};

/**
 * The library dropdown's options, with the CURRENT sound guaranteed present.
 *
 * A placement can name a sound the library no longer has (a user pack removed
 * between produce and this session — `resolveSfxCues`' "unknown sound" drop).
 * Without its own option the select would render blank and the first change
 * event would silently rewrite the placement to whatever sorted first, so the
 * missing id is offered explicitly and says what it is.
 */
const soundOptions = (
  library: readonly SfxLibrarySound[],
  current: string | null,
): React.ReactNode[] => {
  const options = library.map((s) => (
    <option key={s.id} value={s.id}>
      {s.id} — {s.whenToUse}
    </option>
  ));
  if (current !== null && !library.some((s) => s.id === current)) {
    options.unshift(
      <option key={current} value={current}>
        {current} — not in the library any more
      </option>,
    );
  }
  return options;
};

/**
 * "Add a sound" — the palette every USER-added placement comes from.
 *
 * Anchored to the word under the playhead, never to the playhead's second:
 * the doc stores a word index (recut-immune by construction,
 * `OverrideDocSchema.sfx`), and the output instant is re-derived on every run.
 * No word under the playhead ⇒ the button refuses out loud rather than
 * guessing an index — the `onClockRefused` posture, said in place.
 */
const SfxAddSection: React.FC<{
  edits: ReturnType<typeof useEdits>;
  library: readonly SfxLibrarySound[];
  wordAtPlayhead: () => number | null;
}> = ({ edits, library, wordAtPlayhead }) => {
  const [soundId, setSoundId] = React.useState<string>("");
  const [refused, setRefused] = React.useState(false);
  const chosen = soundId || library[0]?.id || "";
  return (
    <div style={section} data-testid="sfx-add-section">
      <span style={label}>Add a sound</span>
      {library.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9A9AA3" }}>
          No sounds installed — drop a pack in ~/.ossclip/sfx.
        </div>
      ) : (
        <>
          <select
            data-testid="sfx-add-sound"
            style={numberInput}
            value={chosen}
            onChange={(e) => setSoundId(e.target.value)}
          >
            {soundOptions(library, null)}
          </select>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="sfx-add"
              style={{ ...button, color: "#EDEDF2", borderColor: "#2A2A33" }}
              onClick={() => {
                blurActive();
                const word = wordAtPlayhead();
                if (word === null) {
                  setRefused(true);
                  return;
                }
                setRefused(false);
                edits.addSfx(chosen, word);
              }}
            >
              Add at playhead
            </button>
            <button
              data-testid="sfx-add-preview"
              style={{ ...button, color: "#EDEDF2", borderColor: "#2A2A33" }}
              onClick={() => {
                blurActive();
                previewSound(chosen);
              }}
            >
              ▸ Hear it
            </button>
          </div>
          {refused ? (
            <div data-testid="sfx-add-refused" style={{ fontSize: 12, color: "#FFE14D" }}>
              No transcript word under the playhead — a sound effect is anchored to a word, so
              park the playhead over speech and try again.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

/**
 * One Color slider — the sfx gain slider's shape (readout in the label, one
 * scrub = one undo step via the caller's coalesce key). No double-click
 * reset: no slider in this editor has one, and inventing the gesture for one
 * section would make it the only place it works.
 */
const GradeSlider: React.FC<{
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}> = ({ id, value, min, max, step, onCommit }) => (
  <div style={row}>
    <span style={label}>
      {id}{"  "}
      <span style={{ color: "#EDEDF2" }}>{value.toFixed(2)}</span>
    </span>
    <input
      type="range"
      data-testid={`grade-${id}`}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onCommit(Number(e.target.value))}
    />
  </div>
);

const NumberField: React.FC<{
  id: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  /**
   * Value change per pixel of horizontal drag on the LABEL (R20 §96, the
   * Filmora gesture): press the label and slide left/right to scrub the
   * value; a plain click focuses the input for typing as before. Defaults
   * to range/240 when bounded, else 0.5/px.
   */
  dragStep?: number;
}> = ({ id, value, onCommit, min, max, dragStep }) => {
  // A DRAFT while focused (§48): the field is controlled from the committed
  // value, and re-formatting the text mid-keystroke would wipe what the user
  // is typing — "0,8" would snap to "0" the instant the comma landed.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [scrubbing, setScrubbing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const drag = React.useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  const perPx =
    dragStep ?? (min !== undefined && max !== undefined ? (max - min) / 240 : 0.5);
  // Not focused → the INPUT is the scrub surface (R21 §99, the Filmora
  // gesture exactly): press and slide inside the field to adjust; a clean
  // click (≤2px of travel) focuses it for typing. Once focused it is a plain
  // text field again — dragging selects text, keys edit — until blur.
  const editing = draft !== null;
  return (
    <div style={row}>
      <span style={label}>{id}</span>
      <input
        // type="text" + inputMode="decimal", NOT type="number" (§48): in a
        // comma-decimal locale the number input renders "0,8" but reports a
        // typed comma value as an EMPTY string, so the field could display a
        // number that can never be committed. §43 fixed `step`; the locale
        // separator was the second half of the same unusable-field defect.
        type="text"
        inputMode="decimal"
        ref={inputRef}
        data-testid={`field-${id}`}
        style={{
          ...numberInput,
          ...(editing ? {} : { cursor: "ew-resize", touchAction: "none" }),
          ...(scrubbing ? { borderColor: "#FFE14D", color: "#FFE14D" } : {}),
        }}
        value={draft ?? (Number.isFinite(value) ? roundShown(value) : "0")}
        onFocus={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onPointerDown={(e) => {
          if (editing) return; // focused = a text field; leave selection alone
          // preventDefault keeps the browser from focusing on mousedown — the
          // gesture decides: a drag scrubs, a clean click focuses on release.
          e.preventDefault();
          drag.current = { x: e.clientX, v: Number.isFinite(value) ? value : 0, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubbing(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) <= 2) return; // a click, until it isn't
          d.moved = true;
          // Commits per move under the caller's fixed coalesce key, so one
          // scrub is one undo step — the contract the sliders already hold.
          // Quantized to the §48 display precision, so a scrub can never
          // commit float dust the field itself would refuse to show.
          const next = Math.round(Math.min(hi, Math.max(lo, d.v + dx * perPx)) * 1000) / 1000;
          onCommit(next);
        }}
        onPointerUp={() => {
          const wasDrag = drag.current?.moved === true;
          drag.current = null;
          setScrubbing(false);
          // A click without a drag focuses for typing — exactly where the
          // field was before scrubbing existed.
          if (!wasDrag) {
            inputRef.current?.focus();
            inputRef.current?.select();
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setScrubbing(false);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          // Accept both decimal separators; skip while the text is not yet a
          // number ("", "-", "0,") so a still-typing input never commits
          // garbage. Clamp to the declared range so the schema's own bounds
          // reject nothing the UI accepted.
          const text = e.target.value.trim();
          if (text === "") return;
          const parsed = Number(text.replace(",", "."));
          if (!Number.isFinite(parsed)) return;
          onCommit(Math.min(hi, Math.max(lo, parsed)));
        }}
      />
    </div>
  );
};

const ThemeField: React.FC<{
  id: string;
  value: string;
  isColor: boolean;
  onCommit: (v: string | number) => void;
}> = ({ id, value, isColor, onCommit }) => (
  <div style={row}>
    <span style={label}>{id}</span>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {isColor ? (
        <input
          type="color"
          value={value}
          onChange={(e) => onCommit(e.target.value)}
          style={{ width: 28, height: 28, border: "1px solid #2A2A33", borderRadius: 6, padding: 0, background: "none" }}
        />
      ) : null}
      <input
        data-testid={`theme-${id}`}
        style={{ ...textInput, flex: 1 }}
        value={value}
        onChange={(e) => onCommit(isColor ? e.target.value : e.target.value)}
      />
    </div>
  </div>
);

/**
 * Precision editing to complement the drag-and-drop overlay. Dragging is
 * imprecise; typing a value (including `0`, to cleanly undo a nudge) goes
 * straight to `patchElement`/`patchTheme` rather than waiting on a blur.
 */
export const Inspector: React.FC<InspectorProps> = ({
  selection,
  cue,
  frame,
  allSceneIds,
  edits,
  onSelect,
  resolvedTheme,
  anchorText,
  onVideoPreview,
  runInfo,
  captionsHiddenByFlag,
  fromLive = (sec: number): number => sec,
  hasOldClockPreimage = (): boolean => true,
  toSourceSec = null,
  onClockRefused = (): void => {},
  sfxMarker = null,
  sfxLibrary = [],
  sfxEnabled = false,
  lutMenu = EMPTY_LUT_MENU,
  deletedScenes = [],
  sfxWordAtPlayhead = (): number | null => null,
}) => {
  if (sfxMarker) {
    // The selected sound effect. FIRST branch on purpose: an SFX selection is
    // exclusive with the scene/element one (App clears each when the other is
    // made), so reaching this at all means the lane owns the panel.
    const m = sfxMarker;
    const added = m.kind === "added";
    // The two write paths, chosen once here rather than at four call sites: a
    // PLANNED placement patches its `sfx.edits` entry against the plan (so a
    // field set back to what the model planned clears itself), an ADDED one
    // just rewrites its own record.
    const patch = (
      p: { word?: number; soundId?: string; gain?: number },
      coalesce?: string,
    ): void => {
      if (added) edits.patchSfxAdded(m.key, p, coalesce);
      else if (m.planned) edits.patchSfx(m.key, p, m.planned, coalesce);
    };
    return (
      <div>
        <div style={section}>
          <span style={label}>Sound effect</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {m.soundId}
            {m.muted ? <span style={{ color: "#9A9AA3", fontWeight: 400 }}> (muted)</span> : null}
            {added ? <span style={{ color: "#9A9AA3", fontWeight: 400 }}> (added)</span> : null}
          </div>
          <div style={{ fontSize: 12, color: "#9A9AA3" }}>
            {/* The WORD, not a timecode: that is what the doc stores, and it
                is why the effect survives the next re-cut (the schema's
                recut-immune note). Drag the diamond to move it. */}
            anchored to word {m.word} · drag the diamond to retime
          </div>
        </div>
        <div style={section}>
          <div style={row}>
            <span style={label}>Sound</span>
            <select
              data-testid="sfx-sound"
              style={numberInput}
              value={m.soundId}
              onChange={(e) => patch({ soundId: e.target.value })}
            >
              {soundOptions(sfxLibrary, m.soundId)}
            </select>
          </div>
          <button
            data-testid="sfx-preview"
            style={{ ...button, color: "#EDEDF2", borderColor: "#2A2A33" }}
            onClick={() => {
              blurActive();
              previewSound(m.soundId);
            }}
          >
            ▸ Hear it
          </button>
        </div>
        <div style={section}>
          {/* One scrub is one undo step (the B5 coalesce rule), and the value
              is the PLACEMENT's multiplier — the sound's own `gain` multiplies
              on top, once, at resolve time (`resolveSfxCues`). */}
          <div style={row}>
            <span style={label}>
              gain{"  "}
              <span style={{ color: "#EDEDF2" }}>{m.gain.toFixed(2)}×</span>
            </span>
            <input
              type="range"
              data-testid="sfx-gain-slider"
              min={0}
              max={2}
              step={0.05}
              value={m.gain}
              onChange={(e) => patch({ gain: Number(e.target.value) }, `sfx:${m.key}:gain`)}
            />
          </div>
        </div>
        <div style={section}>
          {added ? (
            // No mute for an added placement: there is no plan entry left
            // behind for a ghost to negate, so deleting it splices the record
            // out (⌘Z is the way back, like every other edit here).
            <button
              data-testid="sfx-delete"
              style={button}
              onClick={() => {
                blurActive();
                edits.removeSfxAdded(m.key);
              }}
            >
              Delete this sound
            </button>
          ) : m.muted ? (
            <>
              <button
                data-testid="sfx-restore"
                style={{ ...button, color: "#EDEDF2", borderColor: "#2A2A33" }}
                onClick={() => {
                  blurActive();
                  edits.restoreSfx(m.key);
                }}
              >
                Restore this sound
              </button>
              <div style={{ fontSize: 12, color: "#9A9AA3", marginTop: 8 }}>
                Muted: it stays in the plan and out of the render.
              </div>
            </>
          ) : (
            <>
              {/* Deleting a PLANNED placement IS a mute: production.json holds
                  the model's plan and produce rewrites it every run, so the
                  only way to remove one is to negate it — which is also what
                  keeps it restorable (the `hideScene` contract). */}
              <button
                data-testid="sfx-mute"
                style={button}
                onClick={() => {
                  blurActive();
                  edits.muteSfx(m.key);
                }}
              >
                Delete this sound
              </button>
              <div style={{ fontSize: 12, color: "#9A9AA3", marginTop: 8 }}>
                It stays in the lane as a ghost you can restore.
              </div>
            </>
          )}
        </div>
        <SfxAddSection edits={edits} library={sfxLibrary} wordAtPlayhead={sfxWordAtPlayhead} />
      </div>
    );
  }

  if (selection?.elementId && cue) {
    const elementId = selection.elementId;
    const transform = cue.elements?.[elementId] ?? {};
    // The panel is where text editing LIVES now (R12 §49) — the inline
    // double-click input painted over the element it edited. `elementTextOf`
    // also reads the array-backed line-N/node-N/message-N/window-N ids, so
    // the panel covers everything the overlay input could reach. A window-N
    // (a TerminalMock window) reads its lines newline-joined and gets a
    // TEXTAREA below instead of the input: its lines carry no ids of their
    // own, so the single-line input left TerminalMock the one component
    // whose text could not be edited at all (field report 2026-08-07).
    const text = cue.props ? elementTextOf(elementId, cue.props) : null;
    const multiline = /^window-\d+$/.test(elementId);
    return (
      <div>
        <div style={section}>
          <span style={label}>Selected</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {elementId}
          </div>
        </div>
        {(() => {
          // Line style for a StrikethroughReveal line (R16 §66) — the strike
          // was producer-set with no way to correct it from the editor, which
          // is how "implement software / ARCHITECTURE" shipped with only its
          // tail struck. One select per line: plain, struck, ✗ wrong, ✓ right.
          const m = /^line-(\d+)$/.exec(elementId);
          const lines = cue.props?.lines;
          if (cue.component !== "StrikethroughReveal" || !m || !Array.isArray(lines)) return null;
          const idx = Number(m[1]);
          const line = lines[idx] as
            | { text: string; struck?: boolean; mark?: string }
            | undefined;
          if (!line) return null;
          const value = line.struck ? "struck" : (line.mark ?? "none") !== "none" ? line.mark! : "plain";
          return (
            <div style={section}>
              <div style={row}>
                <span style={label}>Line style</span>
                <select
                  data-testid="line-style"
                  style={numberInput}
                  value={value}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next = lines.slice() as Array<Record<string, unknown>>;
                    next[idx] = {
                      ...(next[idx] as Record<string, unknown>),
                      struck: v === "struck",
                      mark: v === "cross" || v === "check" ? v : "none",
                    };
                    edits.patchProps(selection.sceneId, { lines: next });
                  }}
                >
                  <option value="plain">plain</option>
                  <option value="struck">struck through</option>
                  <option value="cross">✗ wrong</option>
                  <option value="check">✓ right</option>
                </select>
              </div>
            </div>
          );
        })()}
        {text !== null ? (
          <div style={section}>
            <div style={row}>
              <span style={label}>Text</span>
              {(() => {
                // Same commit-on-change contract as every other field here
                // (see `blurTypingElement`'s comment in Overlay.tsx: fields
                // must never gate their write behind a blur) — shared so the
                // window textarea can't drift from the input's behavior.
                const commitText = (value: string) => {
                  const props = cue.props ?? {};
                  // Top-level string props patch directly; array-backed ids
                  // need buildArrayPatch to rewrite the right entry — a bare
                  // { [elementId]: text } there writes a key nothing reads.
                  const patch = /^(line|node|message|window|item)-\d+$/.test(elementId)
                    ? buildArrayPatch(elementId, props, value)
                    : { [elementId]: value };
                  if (patch) {
                    edits.patchProps(
                      selection.sceneId,
                      patch,
                      `text:${selection.sceneId}:${elementId}`,
                    );
                  }
                };
                return multiline ? (
                  <textarea
                    style={{ ...textInput, resize: "vertical", fontFamily: "inherit" }}
                    data-testid="element-text"
                    // One row per terminal line — buildArrayPatch's window
                    // arm clamps commits to the schema's 6 lines / 40 chars,
                    // so 6 rows always shows the whole window without scroll.
                    rows={Math.min(6, Math.max(2, text.split("\n").length))}
                    value={text}
                    onChange={(e) => commitText(e.target.value)}
                  />
                ) : (
                  <input
                    style={textInput}
                    data-testid="element-text"
                    value={text}
                    onChange={(e) => commitText(e.target.value)}
                  />
                );
              })()}
            </div>
          </div>
        ) : null}
        <div style={section}>
          {/* Every scale is a slider at minimum (R12 §47) — the number
              fields stay as the precision fallback. Commits per tick with a
              coalesce key, so one scrub is one undo step and the element
              follows live (its render is driven straight from the doc). */}
          <div style={row}>
            <span style={label}>
              scale{"  "}
              <span style={{ color: "#EDEDF2" }}>{(transform.scale ?? 1).toFixed(2)}×</span>
            </span>
            <input
              type="range"
              data-testid="el-scale-slider"
              min={0.1}
              max={3}
              step={0.01}
              value={transform.scale ?? 1}
              onChange={(e) =>
                edits.patchElement(
                  selection.sceneId,
                  elementId,
                  { scale: Number(e.target.value) },
                  `element:${selection.sceneId}:${elementId}:scale`,
                )
              }
            />
          </div>
          {/* Typing "120" is one gesture, not three edits — the coalesce key
              collapses the keystroke burst into a single undo step (B5). */}
          <div style={pairGrid}>
            <NumberField
              id="x"
              value={transform.dx ?? 0}
              dragStep={1}
              onCommit={(v) =>
                edits.patchElement(selection.sceneId, elementId, { dx: v }, `element:${selection.sceneId}:${elementId}:dx`)
              }
            />
            <NumberField
              id="y"
              value={transform.dy ?? 0}
              dragStep={1}
              onCommit={(v) =>
                edits.patchElement(selection.sceneId, elementId, { dy: v }, `element:${selection.sceneId}:${elementId}:dy`)
              }
            />
          </div>
          <NumberField
            id="scale"
            value={transform.scale ?? 1}
            min={0.05}
            max={4}
            dragStep={0.01}
            onCommit={(v) =>
              edits.patchElement(selection.sceneId, elementId, { scale: v }, `element:${selection.sceneId}:${elementId}:scale`)
            }
          />
        </div>
        <div style={section}>
          <button
            style={button}
            onClick={() => {
              blurActive();
              edits.clearElement(selection.sceneId, elementId);
            }}
          >
            Reset element
          </button>
          {/* Soft delete (PLAN Task 2), same shape as "Delete scene": the
              element goes `display:none` (`editStyle`, packages/scenes/src/
              editable.ts — the one chokepoint every leaf renders its edit
              style through), the remaining siblings close the gap on their
              own. Selection DROPS TO THE SCENE, not to nothing — see
              `onSelect`'s own doc comment for why the element-level
              selection specifically has to go — which lands the user
              straight on the SCENE panel's "Hidden elements" Restore list
              this same delete just populated, one click away from undoing
              it. Also the path that lets a user hide ChatMock's synthetic
              CTA bubble (`message-0` in keyword mode) — their call, not
              special-cased away. */}
          <button
            data-testid="delete-element"
            style={{ ...button, marginTop: 8 }}
            onClick={() => {
              blurActive();
              edits.hideElement(selection.sceneId, elementId);
              onSelect({ sceneId: selection.sceneId, elementId: null });
            }}
          >
            Delete element
          </button>
        </div>
      </div>
    );
  }

  if (selection && cue) {
    const isPlain = cue.kind === "plain";
    // Deleted scenes whose window this cue covers (field report 2026-08-31,
    // second round): a hidden scene is not selectable anywhere any more —
    // App remaps such a selection to the take `fillPlainCues` minted, which
    // is the cue the player actually reads, so the framing/caption controls
    // WORK (edits keyed to the deleted id landed nowhere). Restore rides
    // this take's panel as a chip per covered scene.
    const restorableScenes = isPlain
      ? deletedScenes.filter((g) => {
          const mid = (g.startSec + g.endSec) / 2;
          return mid >= cue.startSec && mid < cue.endSec;
        })
      : [];
    // A cut chunk, NOT YET APPLIED (PLAN 2026-08-04 Task 4c; keyed to
    // `src`-LESS cuts only per the review fix wave's finding 1): matched by
    // exact window equality against `cue`'s OWN startSec/endSec. Safe as
    // exact equality (not a tolerance) because both numbers trace back to
    // the SAME value with no arithmetic in between — `cutChunk` writes the
    // cue's window verbatim, and `live` (App.tsx) never reads `doc.cuts`, so
    // the cue's own window cannot have drifted out from under the match
    // within a session. Restore is the ONLY offer here, same reasoning as
    // the hidden-scene branch above: this UI exposes no way to edit a cut's
    // range, so there is nothing else this view needs to show.
    //
    // `c.src === undefined` is load-bearing, not incidental, and the
    // cut-review rework only widened what it excludes: once ANY writer
    // resolves `src` — a past produce, or "Delete this chunk" itself now —
    // `startSec`/`endSec` are a HISTORICAL record only (schema comment on
    // `OverrideDocSchema.cuts`, packages/core/src/overrides.ts) and the
    // material at that window is GONE from the output the user is watching
    // (produce removed it, or the live preview subtracted it). A live cue's
    // window landing on the same numbers by coincidence (a re-plan, a later
    // independent cut) is unrelated content, not "this block is still marked
    // for removal". So this branch — and the "marked for removal" copy under
    // it — now serves LEGACY src-less entries only; every applied cut's
    // Restore lives on its Timeline seam marker (`Timeline.tsx`'s
    // `cutSeamHit`), which this must never shadow.
    //
    // `findIndex`, not `find` (fix round 2, re-review): `restoreChunk` is
    // keyed by INDEX, not a window match, precisely because a src-anchored
    // and a src-less entry can share this exact window (the seam-
    // coincidence case `cutChunk`'s own comment in useEdits.ts documents) —
    // a window-filter restore would delete BOTH, including one this branch
    // never even matched. The index found here identifies exactly the
    // src-less entry this view is offering Restore for.
    const activeCutIndex = edits.doc.cuts.findIndex(
      (c) => c.src === undefined && c.startSec === cue.startSec && c.endSec === cue.endSec,
    );
    if (activeCutIndex !== -1) {
      return (
        <div>
          <div style={section}>
            <span style={label}>{isPlain ? "Take" : "Scene"}</span>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
              {selection.sceneId}{" "}
              <span style={{ color: "#9A9AA3", fontWeight: 400 }}>(marked for removal)</span>
            </div>
            <div style={{ fontSize: 12, color: "#9A9AA3" }}>
              Struck through on the timeline. It disappears from the output on
              the next produce/Render — this preview still plays it (the
              editor doesn't re-derive a second cut timeline just to show one
              early).
            </div>
            <button
              data-testid="restore-chunk"
              style={{ ...button, color: "#5FBF77", border: "1px solid #24402c" }}
              onClick={() => {
                blurActive();
                edits.restoreChunk(activeCutIndex);
              }}
            >
              Restore
            </button>
          </div>
        </div>
      );
    }
    // Elements this scene's user hid one at a time (PLAN Task 2) — plain
    // takes have no `cue.elements` at all (no component, nothing to key an
    // id against), so this is naturally empty for them. Hidden elements are
    // unselectable on stage by construction (`display:none` drops them out
    // of `elementFromPoint`'s hit chain), so this list — mirroring the
    // scene-level ghost/Restore pattern above — is the ONLY way back to one
    // short of hand-editing overrides.json. Computed here, past both early
    // returns above — dead weight in either of those views, which never
    // render it (review fix wave, PLAN Task 2).
    const hiddenElements = Object.entries(cue.elements ?? {})
      .filter(([, e]) => e.hidden === true)
      .map(([id]) => {
        // WHERE this id's `hidden` actually lives (review fix wave, PLAN
        // Task 2): `cue.elements` is already merged across a split half and
        // its root (`effectiveOverride`, packages/core/src/overrides.ts —
        // `elements` merges per id, and is NOT in that function's
        // inheritance-exclusion list the way `timing`/`hidden` are), so a
        // half's panel can list an id whose `hidden` flag actually sits on
        // the ROOT's own doc entry. Dispatching Restore against
        // `selection.sceneId` unconditionally would target the half's own
        // (nonexistent) entry, no-op silently, and leave the row promising
        // a way back that does nothing. Check the SELECTED scene's own raw
        // entry first; fall back to the split root — `splitRootId` is a
        // no-op on an unsplit id, so this collapses to the pre-fix
        // behavior there.
        const ownHidden = edits.doc.scenes[selection.sceneId]?.elements[id]?.hidden === true;
        const owningSceneId = ownHidden ? selection.sceneId : splitRootId(selection.sceneId);
        return { id, owningSceneId };
      });
    return (
      <div>
        <div style={section}>
          <span style={label}>{isPlain ? "Take" : "Scene"}</span>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
            {selection.sceneId}
          </div>
          {isPlain ? (
            <div style={{ fontSize: 12, color: "#9A9AA3" }}>
              A continuous stretch of the talking head — no graphic. Frame it
              below; its window follows the cut.
            </div>
          ) : null}
        </div>
        {restorableScenes.length > 0 ? (
          <div style={section}>
            <span style={label}>Deleted here</span>
            {restorableScenes.map((g) => (
              <React.Fragment key={g.id}>
                <div style={{ fontSize: 12, color: "#9A9AA3" }}>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{g.id}</span>
                  {" — its graphic is off; the window plays as this take."}
                </div>
                <button
                  data-testid={`restore-scene-${g.id}`}
                  style={{ ...button, color: "#5FBF77", border: "1px solid #24402c" }}
                  onClick={() => {
                    blurActive();
                    edits.restoreScene(g.id);
                  }}
                >
                  Restore {g.id}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        <div style={section}>
          {!isPlain && cue.component ? (
            <div style={row}>
              <span style={label}>Component</span>
              {/* Swapping the component re-resolves props against the NEW
                  component's defaults (see `applyOverrides`) — the producer's
                  old props were shaped for a different schema and don't carry
                  over, so the swap renders something coherent instead of an
                  invalid scene. */}
              <select
                style={numberInput}
                value={cue.component}
                onChange={(e) =>
                  edits.patchComponent(
                    selection.sceneId,
                    e.target.value as NonNullable<SceneCue["component"]>,
                  )
                }
              >
                {SceneComponentIdSchema.options.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {/* Props the Text field cannot reach (§153): it renders only for
              string props, so a component's booleans had no control anywhere
              in the UI and were reachable only by hand-editing overrides.json.
              Derived from the component's own schema rather than listed here,
              so a component that gains one gets a control the day it lands —
              hand-wiring is what let ScreenshotFrame ship an edit id naming no
              prop at all. */}
          {!isPlain && cue.component
            ? scalarPropControls(cue.component).map((control) =>
                control.kind === "boolean" ? (
                  <div style={row} key={control.key}>
                    <span style={label}>{control.key}</span>
                    <input
                      type="checkbox"
                      data-testid={`prop-${control.key}`}
                      // The schema's default, not `false`: kenBurns is on when
                      // unset, and a box that started unchecked would describe
                      // the scene wrongly before you touched anything.
                      checked={
                        typeof cue.props?.[control.key] === "boolean"
                          ? (cue.props[control.key] as boolean)
                          : control.fallback === true
                      }
                      onChange={(e) =>
                        edits.patchProps(selection.sceneId, { [control.key]: e.target.checked })
                      }
                    />
                  </div>
                ) : (
                  <div style={row} key={control.key}>
                    <span style={label}>{control.key}</span>
                    <select
                      style={numberInput}
                      data-testid={`prop-${control.key}`}
                      value={String(cue.props?.[control.key] ?? control.options?.[0] ?? "")}
                      onChange={(e) =>
                        edits.patchProps(selection.sceneId, { [control.key]: e.target.value })
                      }
                    >
                      {(control.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                ),
              )
            : null}
          <div style={row}>
            <span style={label}>Layout</span>
            <select
              style={numberInput}
              data-testid="layout-select"
              value={cue.layout}
              onChange={(e) => edits.patchLayout(selection.sceneId, e.target.value as SceneCue["layout"])}
            >
              {LayoutSchema.options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={section}>
          {/* Direct manipulation first (PLAN Task B4): a zoom slider with a
              live preview, pan by dragging the picture on the stage. The
              number fields stay as the precision fallback — and keep
              step="any", which the R9-5 e2e pins. Scale under 1 zooms OUT:
              more of the source, backdrop showing where it no longer
              covers. */}
          <span style={label}>Video framing</span>
          <div style={row}>
            <span style={label}>
              zoom{"  "}
              <span style={{ color: "#EDEDF2" }}>
                {(cue.video?.scale ?? 1).toFixed(2)}×
              </span>
            </span>
            <input
              type="range"
              data-testid="zoom-slider"
              min={0.5}
              max={3}
              step={0.01}
              value={cue.video?.scale ?? 1}
              // Scrub = live preview only; the REAL patch lands once, on
              // release, so one slider gesture is one undo step.
              onChange={(e) =>
                onVideoPreview({
                  sceneId: selection.sceneId,
                  patch: { scale: Number(e.target.value) },
                })
              }
              onPointerUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`);
                onVideoPreview(null);
              }}
              onKeyUp={(e) => {
                // Only keys that actually move a range input commit — a
                // stray keyup (the "s" of Cmd+S, a modifier) must not
                // re-commit the current value and un-save the document.
                const moves = [
                  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                  "Home", "End", "PageUp", "PageDown",
                ];
                if (!moves.includes(e.key)) return;
                const v = Number((e.target as HTMLInputElement).value);
                edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`);
                onVideoPreview(null);
              }}
            />
          </div>
          <label
            style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#9A9AA3", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              data-testid="auto-zoom"
              checked={cue.video?.autoZoom !== false}
              onChange={(e) => edits.patchVideo(selection.sceneId, { autoZoom: e.target.checked })}
            />
            auto zoom (the slow push composes on top of your zoom)
          </label>
          <div style={{ fontSize: 12, color: "#9A9AA3" }}>
            Pan: drag the picture on the stage.
          </div>
          <NumberField
            id="scale"
            value={cue.video?.scale ?? 1}
            min={0.05}
            max={4}
            dragStep={0.01}
            onCommit={(v) =>
              edits.patchVideo(selection.sceneId, { scale: v }, `video:${selection.sceneId}:scale`)
            }
          />
          <div style={pairGrid}>
            <NumberField
              id="dx"
              value={cue.video?.dx ?? 0}
              dragStep={1}
              onCommit={(v) =>
                edits.patchVideo(selection.sceneId, { dx: v }, `video:${selection.sceneId}:dx`)
              }
            />
            <NumberField
              id="dy"
              value={cue.video?.dy ?? 0}
              dragStep={1}
              onCommit={(v) =>
                edits.patchVideo(selection.sceneId, { dy: v }, `video:${selection.sceneId}:dy`)
              }
            />
          </div>
          {cue.video ? (
            <button
              style={button}
              onClick={() => {
                blurActive();
                edits.clearVideo(selection.sceneId);
              }}
            >
              Reset framing
            </button>
          ) : null}
        </div>
        {cue.layout === "pip-bubble"
          ? (() => {
              // PiP bubble (R14 §52): mask roundness and placement, per scene.
              // Shown for ANY cue whose resolved layout is pip-bubble — a
              // plain take switched there gets the same bubble. Defaults come
              // from the layout's own slot, so the fields always state what
              // is actually on screen.
              const slot = layoutSlots("pip-bubble", undefined, [], frame).video;
              const pip = cue.pip ?? {};
              const roundness = pip.cornerRadius ?? slot.cornerRadius;
              return (
                <div style={section}>
                  <span style={label}>PiP bubble</span>
                  <div style={row}>
                    <span style={label}>
                      roundness{"  "}
                      <span style={{ color: "#EDEDF2" }}>{roundness.toFixed(2)}</span>
                    </span>
                    {/* 1 = the default circle, 0 = a square card. Commits per
                        tick under one coalesce key — one scrub, one undo. */}
                    <input
                      type="range"
                      data-testid="pip-roundness"
                      min={0}
                      max={1}
                      step={0.01}
                      value={roundness}
                      onChange={(e) =>
                        edits.patchPip(
                          selection.sceneId,
                          { cornerRadius: Number(e.target.value) },
                          `pip:${selection.sceneId}:cornerRadius`,
                        )
                      }
                    />
                  </div>
                  <div style={pairGrid}>
                    <NumberField
                      id="pip-x"
                      value={pip.x ?? slot.rect.x}
                      min={0}
                      max={1 - slot.rect.w}
                      dragStep={0.002}
                      onCommit={(v) =>
                        edits.patchPip(selection.sceneId, { x: v }, `pip:${selection.sceneId}:x`)
                      }
                    />
                    <NumberField
                      id="pip-y"
                      value={pip.y ?? slot.rect.y}
                      min={0}
                      max={1 - slot.rect.h}
                      dragStep={0.002}
                      onCommit={(v) =>
                        edits.patchPip(selection.sceneId, { y: v }, `pip:${selection.sceneId}:y`)
                      }
                    />
                  </div>
                  {cue.pip ? (
                    <button
                      data-testid="reset-pip"
                      style={button}
                      onClick={() => {
                        blurActive();
                        edits.clearPip(selection.sceneId);
                      }}
                    >
                      Reset bubble
                    </button>
                  ) : null}
                </div>
              );
            })()
          : null}
        {(() => {
          // Graphic box (R11 Task 2.10) — the precision fallback to the
          // stage handles. The effective rect is the hand-set override, the
          // routed rect the cue carries, the layout's own slot, or the
          // full-bleed fallback band (R13) — the same resolver SceneLayer
          // draws from, so this box is always the one on screen.
          if (isPlain) return null;
          const eff = graphicSlotFor(cue, frame);
          const boxPatch = (key: "x" | "y" | "w" | "h") => (v: number) =>
            edits.patchGraphicRect(
              selection.sceneId,
              clampGraphicRect({ ...eff, [key]: v }, frame),
              `box:${selection.sceneId}:${key}`,
            );
          return (
            <div style={section}>
              <span style={label}>Graphic box</span>
              <div style={{ fontSize: 12, color: "#9A9AA3" }}>
                Frame fractions — or drag the handles on the stage.
              </div>
              <div style={pairGrid}>
                <NumberField id="box-x" value={eff.x} min={0} max={1} dragStep={0.002} onCommit={boxPatch("x")} />
                <NumberField id="box-y" value={eff.y} min={0} max={1} dragStep={0.002} onCommit={boxPatch("y")} />
              </div>
              <div style={pairGrid}>
                <NumberField id="box-w" value={eff.w} min={0.08} max={1} dragStep={0.002} onCommit={boxPatch("w")} />
                <NumberField id="box-h" value={eff.h} min={0.05} max={1} dragStep={0.002} onCommit={boxPatch("h")} />
              </div>
              {edits.doc.scenes[selection.sceneId]?.graphicRect ? (
                <button
                  data-testid="reset-box"
                  style={button}
                  onClick={() => {
                    blurActive();
                    edits.clearGraphicRect(selection.sceneId);
                  }}
                >
                  Reset box
                </button>
              ) : null}
            </div>
          );
        })()}
        {(() => {
          // Caption position (R15 §56) and size (R16 §64) — per scene, with
          // the bulk fan-out the author actually asked for ("the captions
          // are too low for this whole video"). Shown for takes too:
          // captions run over them.
          const autoAnchor = layoutSlots(cue.layout, undefined, [], frame).captionAnchor;
          const effY = cue.captionY ?? autoAnchor;
          const effScale = cue.captionScale ?? 1;
          const sceneDoc = edits.doc.scenes[selection.sceneId];
          return (
            <div style={section}>
              <span style={label}>Captions</span>
              {/* The honest CHEAP option is this hint, not disabling the
                  sliders: disabled controls would need the same sentence to
                  explain themselves anyway, and they would also block the
                  legitimate "reposition now, un-hide later" prep edit —
                  these per-scene keys are kept, not cleared, by the global
                  switch, so editing them while hidden is real work, not a
                  trap. */}
              {edits.doc.captionsHidden === true || captionsHiddenByFlag === true ? (
                <div data-testid="captions-hidden-hint" style={{ fontSize: 12, color: "#FFE14D" }}>
                  Captions are hidden globally
                  {captionsHiddenByFlag === true ? " (--no-captions)" : " (Theme panel)"} — these
                  settings are kept and apply when captions are shown again.
                </div>
              ) : null}
              <div style={row}>
                <span style={label}>
                  position{"  "}
                  <span style={{ color: "#EDEDF2" }}>{effY.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  data-testid="caption-y-slider"
                  min={0.05}
                  max={0.95}
                  step={0.01}
                  value={effY}
                  onChange={(e) =>
                    edits.patchCaptionY(
                      selection.sceneId,
                      Number(e.target.value),
                      `captionY:${selection.sceneId}`,
                    )
                  }
                />
              </div>
              {/* Same shape as every other scale control (R12 §47): a
                  slider committing per tick under one coalesce key. */}
              <div style={row}>
                <span style={label}>
                  scale{"  "}
                  <span style={{ color: "#EDEDF2" }}>{effScale.toFixed(2)}×</span>
                </span>
                <input
                  type="range"
                  data-testid="caption-scale-slider"
                  min={0.2}
                  max={3}
                  step={0.01}
                  value={effScale}
                  onChange={(e) =>
                    edits.patchCaptionScale(
                      selection.sceneId,
                      Number(e.target.value),
                      `captionScale:${selection.sceneId}`,
                    )
                  }
                />
              </div>
              <NumberField
                id="caption-scale"
                value={effScale}
                min={0.2}
                max={3}
                dragStep={0.01}
                onCommit={(v) =>
                  edits.patchCaptionScale(selection.sceneId, v, `captionScale:${selection.sceneId}`)
                }
              />
              <button
                data-testid="caption-y-all"
                style={{ ...button, color: "#EDEDF2", border: "1px solid #2A2A33" }}
                title="Write this scene's caption position and scale to every scene — one undo step"
                onClick={() => {
                  blurActive();
                  edits.patchCaptionStyleAll(allSceneIds, { y: effY, scale: effScale });
                }}
              >
                Apply to all scenes
              </button>
              {sceneDoc?.captionY !== undefined || sceneDoc?.captionScale !== undefined ? (
                <button
                  data-testid="reset-caption-y"
                  style={button}
                  onClick={() => {
                    blurActive();
                    edits.clearCaptionStyle(selection.sceneId);
                  }}
                >
                  Reset captions
                </button>
              ) : null}
            </div>
          );
        })()}
        <div style={section}>
          <span style={label}>Timing</span>
          {/* The resolved window ALWAYS shows (FINDINGS §44) — an unpinned cue
              still has one, and "tracking transcript" with no times told the
              user nothing about the scene they were looking at. Pinned vs
              tracking is a label on the times, not a replacement for them. */}
          <div
            data-testid="timing-range"
            style={{ fontSize: 13, fontFamily: "ui-monospace, 'SF Mono', monospace" }}
          >
            {cue.startSec.toFixed(2)}s – {cue.endSec.toFixed(2)}s
            <span style={{ color: "#9A9AA3" }}>
              {"  "}({(cue.endSec - cue.startSec).toFixed(2)}s)
            </span>
          </div>
          <div style={{ fontSize: 12, color: cue.pinned ? "#FFE14D" : "#9A9AA3" }}>
            {isPlain
              ? "Derived from the cut — not movable"
              : cue.pinned
                ? "Pinned to these times"
                : "Tracking transcript"}
          </div>
          {!cue.pinned && anchorText ? (
            <div style={{ fontSize: 12, color: "#9A9AA3", fontStyle: "italic" }}>
              “{anchorText}”
            </div>
          ) : null}
          {cue.pinned ? (
            <button
              style={button}
              onClick={() => {
                blurActive();
                edits.clearTiming(selection.sceneId);
              }}
            >
              Un-pin (re-anchor to words)
            </button>
          ) : null}
        </div>
        {!isPlain ? (
          <div style={section}>
            {/* Soft delete (PLAN Task C): the block goes ghost, the window
                becomes a plain take, and Restore undoes it — so this is
                danger-styled but not destructive. Delete/Backspace does the
                same from the keyboard. */}
            <button
              data-testid="delete-scene"
              style={button}
              onClick={() => {
                blurActive();
                edits.hideScene(selection.sceneId);
              }}
            >
              Delete scene
            </button>
          </div>
        ) : null}
        {hiddenElements.length > 0 ? (
          <div style={section}>
            {/* Restore for elements deleted one at a time (PLAN Task 2) —
                mirrors the ghost/restore pattern above, scoped to this
                scene's elements instead of the whole scene. Listed here,
                not on the element itself, because a hidden element can no
                longer be selected on stage to reach its own panel. */}
            <span style={label}>Hidden elements</span>
            {hiddenElements.map(({ id, owningSceneId }) => (
              <div
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13, fontFamily: "ui-monospace, monospace", color: "#C9C9D4" }}>
                  {id}
                </span>
                <button
                  data-testid={`restore-element-${id}`}
                  style={{ ...button, color: "#5FBF77", border: "1px solid #24402c", padding: "4px 8px" }}
                  onClick={() => {
                    blurActive();
                    // Dispatched against the OWNING scene id, not blindly
                    // `selection.sceneId` — see `hiddenElements`' own
                    // comment above for why the two can differ on a split
                    // half.
                    edits.restoreElement(owningSceneId, id);
                  }}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div style={section}>
          {/* User cuts (PLAN 2026-08-04 Task 4c) — the dogfooding verdict's
              actual ask: "I can split a Take, but can't delete any of it."
              Split isolates a chunk into its own block; this removes it,
              TAKE or SCENE alike (unlike "Delete scene" above, which only
              drops the graphic and keeps the window). Soft, same shape as
              every other delete in this panel — but since the cut-review
              rework it is no longer marked-only: the write carries a `src`
              (the button's own comment below), which the live preview
              SUBTRACTS, so the material stops playing at the click. Restore
              then lives on the timeline SEAM (`Timeline.tsx`'s `cutSeamHit`,
              the src branch), not on a struck band — there is no block left
              on the timeline to strike. The band and its Inspector Restore
              survive for legacy src-less entries only. */}
          <div style={{ fontSize: 12, color: "#9A9AA3" }}>
            Removes this window from the output. The preview stops playing it
            immediately — Restore lives on the seam it leaves on the timeline.
          </div>
          <button
            data-testid="cut-chunk"
            style={button}
            onClick={() => {
              blurActive();
              // The cue window speaks the LIVE clock; the entry's
              // `startSec`/`endSec` speak the OLD one (the `fromLive` prop
              // doc), and `src` speaks SOURCE time.
              const range = cutRangeToOldClock(
                { fromLive, hasOldClockPreimage },
                cue.startSec,
                cue.endSec,
              );
              if (toSourceSec !== null) {
                // Dual-write (cut-review rework) — the ⌘B posture, Overlay.tsx:
                // `src` is the authoritative anchor, resolved here on the clock
                // App holds exactly, rounded to the millisecond it is stored at
                // (the `cutChunk` dedupe compares these exactly). The old-clock
                // pair rides along as the historical record only, so a window
                // with NO old-clock extent (`degenerate` — the field report's
                // "delete half of a revived retake") no longer refuses: its
                // record simply clamps to the seam `fromLive` names, which is
                // honest because the record is never authoritative once `src`
                // exists. No shrink warning either — nothing is lost when the
                // source range is exact.
                const src = {
                  startSec: round3(toSourceSec(cue.startSec)),
                  endSec: round3(toSourceSec(cue.endSec)),
                };
                const record =
                  range.kind === "degenerate"
                    ? { startSec: fromLive(cue.startSec), endSec: fromLive(cue.endSec) }
                    : { startSec: range.startSec, endSec: range.endSec };
                edits.cutChunk(record.startSec, record.endSec, src);
                return;
              }
              // No source mapper (no spans, no live map): the pre-rework flow
              // verbatim — a window with no old-clock extent at all is refused
              // out loud rather than anchored to a guessed source second, and
              // one that merely shrinks at a revived edge proceeds and says so
              // on the console, the same channel App gives the retime's own
              // snap reports (these gestures have no quieter one today).
              if (range.kind === "degenerate") {
                onClockRefused(
                  "Can't cut this window: it isn't in the last render yet — render once (or re-remove the pause) to cut it.",
                );
                return;
              }
              if (range.kind === "shrunk") console.warn(`ossclip cut preview: ${range.report}`);
              edits.cutChunk(range.startSec, range.endSec);
            }}
          >
            Delete this chunk
          </button>
        </div>
      </div>
    );
  }

  const theme = edits.doc.theme;
  const patch = (key: string, v: string | number) => edits.patchTheme({ [key]: v });
  const mmss = (sec: number): string =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const totals = runInfo?.usage?.totals ?? null;
  const producer = runInfo?.production?.producer ?? null;
  const clip = runInfo?.production?.clip ?? null;
  return (
    <div>
      <div style={section}>
        <span style={label}>Theme</span>
        <div style={{ fontSize: 12, color: "#9A9AA3" }}>Nothing selected — global tokens.</div>
      </div>
      <div style={section}>
        <ThemeField id="accent" value={theme.accent ?? resolvedTheme.accent} isColor onCommit={(v) => patch("accent", v)} />
        <ThemeField id="bg" value={theme.bg ?? resolvedTheme.bg} isColor onCommit={(v) => patch("bg", v)} />
        <ThemeField id="fg" value={theme.fg ?? resolvedTheme.fg} isColor onCommit={(v) => patch("fg", v)} />
        <NumberField id="radiusPx" value={theme.radiusPx ?? resolvedTheme.radiusPx} min={0} dragStep={0.5} onCommit={(v) => patch("radiusPx", v)} />
        <ThemeField
          id="fontDisplay"
          value={theme.fontDisplay ?? resolvedTheme.fontDisplay}
          isColor={false}
          onCommit={(v) => patch("fontDisplay", v)}
        />
      </div>
      <div style={section}>
        <span style={label}>Captions</span>
        {/* Doc-global like the theme tokens above it, which is why it lives
            on the no-selection panel and not per scene: one switch for the
            whole video (`captionsHidden`), undo-able like every edit and
            saved through the same PUT. Checked = visible, so the checkbox
            reads as the feature ("show captions"), never as the negation
            the stored key spells. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "#EDEDF2",
            cursor: "pointer",
          }}
        >
          {/* Flag-aware (review minor 2): on a --no-captions workdir with a
              CLEAN doc, a checked box over a captionless preview was a lie —
              the truthful reading is unchecked+disabled (captions are off,
              and this toggle writes only the OVERRIDE half of produce's OR,
              so it cannot turn them on; the flag note below is the reason).
              A doc-hidden entry keeps its semantics untouched: the box stays
              ENABLED even under the flag, so the user can still clear their
              own override — it just lands on the disabled-by-flag state. */}
          <input
            type="checkbox"
            data-testid="captions-visible-toggle"
            checked={edits.doc.captionsHidden !== true && captionsHiddenByFlag !== true}
            disabled={captionsHiddenByFlag === true && edits.doc.captionsHidden !== true}
            onChange={(e) => edits.setCaptionsHidden(!e.target.checked)}
          />
          Show captions
        </label>
        {edits.doc.captionsHidden === true ? (
          <div style={{ fontSize: 12, color: "#9A9AA3" }}>
            Hidden everywhere — the CTA keyword styling rides the caption track, so it is hidden
            too. Per-scene caption position/scale edits are kept.
          </div>
        ) : null}
        {captionsHiddenByFlag === true ? (
          // The toggle writes only the OVERRIDE half of produce's OR — a
          // --no-captions pinned into command.json replays on every Render,
          // and pretending the checkbox could out-vote it would be a lie
          // the user discovers on upload.
          <div data-testid="captions-flag-note" style={{ fontSize: 12, color: "#FFE14D" }}>
            This project was produced with --no-captions, which Render replays — the toggle
            can't bring captions back here; re-run produce without the flag.
          </div>
        ) : null}
      </div>
      {(() => {
        // Color grade — doc-global like the Captions switch above (one look
        // for the whole video, `OverrideDocSchema.colorGrade`), so it lives
        // on the no-selection panel. The dropdown maps the key's three
        // states EXACTLY (colorPanel.ts owns the mapping): "Default" deletes
        // the key, "Off" stores `false`, a look stores an object.
        const docGrade = edits.doc.colorGrade;
        const eff = effectiveGrade(docGrade, lutMenu.configGrade);
        // A slider write is the whole effective grade with one field changed
        // — on an inherited default this PROMOTES it to an editor override,
        // which is the only layer produce lets outlive the next run.
        const slide = (field: string, v: number): void => {
          if (eff === null) return;
          edits.setColorGrade({ ...eff, [field]: v }, `colorGrade:${field}`);
        };
        const sliders = eff === null ? null : gradeSliderState(eff);
        return (
          <div style={section} data-testid="color-section">
            <span style={label}>Color</span>
            <select
              data-testid="grade-source"
              style={numberInput}
              value={gradeSourceValue(docGrade, lutMenu.configGrade)}
              onChange={(e) => edits.setColorGrade(gradeForSource(e.target.value, docGrade))}
            >
              <option value="off">Off</option>
              {lutMenu.configGrade !== null ? (
                <option value="default">Default ({configGradeName(lutMenu.configGrade)})</option>
              ) : null}
              {GRADE_PRESET_IDS.map((id) => (
                <option key={id} value={`preset:${id}`}>
                  {id}
                </option>
              ))}
              {lutMenu.items.map((l) => (
                <option key={l.file} value={`lut:${l.file}`}>
                  {l.title} (.cube)
                </option>
              ))}
            </select>
            {eff !== null && eff.lut !== undefined ? (
              // A .cube bakes into the mezzanine at render time — there is no
              // browser-side 3D LUT to preview with, and faking one would
              // show a grade no render produces (colorPanel.ts's
              // `liveGradeSpec` is where the preview declines).
              <div data-testid="grade-lut-note" style={{ fontSize: 12, color: "#9A9AA3" }}>
                LUT grades apply on the next render — the preview stays ungraded.
              </div>
            ) : null}
            {sliders !== null ? (
              <>
                <GradeSlider id="intensity" value={sliders.intensity} min={0} max={1} step={0.01} onCommit={(v) => slide("intensity", v)} />
                <GradeSlider id="exposure" value={sliders.exposure} min={-2} max={2} step={0.05} onCommit={(v) => slide("exposure", v)} />
                <GradeSlider id="temperature" value={sliders.temperature} min={-100} max={100} step={1} onCommit={(v) => slide("temperature", v)} />
                <GradeSlider id="saturation" value={sliders.saturation} min={0} max={2} step={0.01} onCommit={(v) => slide("saturation", v)} />
                <GradeSlider id="contrast" value={sliders.contrast} min={0} max={2} step={0.01} onCommit={(v) => slide("contrast", v)} />
              </>
            ) : null}
            {lutMenu.issues.length > 0 ? (
              // A ~/.ossclip/luts author's only surface — the sfx panel's
              // show-don't-swallow rule for pack issues, applied to LUTs.
              <div data-testid="grade-lut-issues" style={{ fontSize: 12, color: "#FFE14D" }}>
                {lutMenu.issues.map((i) => `${i.file}: ${i.message}`).join(" · ")}
              </div>
            ) : null}
          </div>
        );
      })()}
      {sfxEnabled ? (
        // The palette lives on the no-selection panel beside the global
        // Captions switch, because "add a sound" is a decision about the whole
        // video rather than about the selected scene — and it is the one
        // surface `sfx.added` placements come from. Gated on the production
        // actually having a plan (the prop's own doc).
        <SfxAddSection edits={edits} library={sfxLibrary} wordAtPlayhead={sfxWordAtPlayhead} />
      ) : null}
      {producer || totals ? (
        <div style={section} data-testid="run-info">
          {/* Provenance and cost (R21 §104) — the same accounting report.txt
              prints, where the person deciding whether to re-plan can see it. */}
          <span style={label}>This video</span>
          {producer ? (
            <div style={{ fontSize: 12, color: "#C9C9D4" }}>
              planned by <span style={{ color: "#EDEDF2" }}>{producer.provider}</span>
              {producer.models.length > 0 ? ` (${producer.models.join(", ")})` : ""}
              {producer.cached ? " · reused from cache" : ""}
              {producer.at ? ` · ${new Date(producer.at).toLocaleString()}` : ""}
            </div>
          ) : null}
          {totals ? (
            <div style={{ fontSize: 12, color: "#C9C9D4" }}>
              {totals.calls} LLM call{totals.calls === 1 ? "" : "s"} ·{" "}
              {totals.inputTokens.toLocaleString()} in / {totals.outputTokens.toLocaleString()} out
              tokens{totals.anyEstimated ? " (partly estimated)" : ""}
            </div>
          ) : null}
          {totals && totals.equivalentUsd !== null ? (
            <div style={{ fontSize: 12, color: "#C9C9D4" }}>
              {totals.allUnbilled
                ? `~$${totals.equivalentUsd.toFixed(2)} of API-rate work, covered by the subscription`
                : totals.billedUsd !== null
                  ? `~$${totals.billedUsd.toFixed(2)} charged at API rates`
                  : `~$${totals.equivalentUsd.toFixed(2)} at API rates`}
            </div>
          ) : null}
          {clip ? (
            <div style={{ fontSize: 12, color: "#C9C9D4" }}>
              clip: {mmss(clip.startSec)}–{mmss(clip.endSec)}
              {runInfo?.production?.sourceDuration
                ? ` of ${mmss(runInfo.production.sourceDuration)}`
                : ""}{" "}
              (--clip {clip.targetSec})
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={section}>
        {/* R21 §105 — the standard honesty line. It stays even on a no-LLM
            run: the cut and captions are machine-derived from ASR either way. */}
        <div data-testid="ai-disclaimer" style={{ fontSize: 12, color: "#9A9AA3" }}>
          AI can make mistakes. The cut, captions and graphics are generated — review them
          before publishing.
        </div>
      </div>
    </div>
  );
};
