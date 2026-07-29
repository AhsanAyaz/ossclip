import React from "react";
import { LayoutSchema, SceneComponentIdSchema, type SceneCue, type Theme } from "@ossclip/core/browser";
import { clampGraphicRect, graphicSlotFor, layoutSlots } from "@ossclip/renderer/composition";
import type { useEdits } from "./useEdits";
import { buildArrayPatch, elementTextOf, type Selection, type VideoPreview } from "./Overlay";

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

/** Display precision (§48): three decimals is enough for any real edit —
 * never the 13 digits of float dust a drag can produce. */
const roundShown = (v: number): string => String(Math.round(v * 1000) / 1000);

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
  return (
    <div style={row}>
      <span
        // The label is the scrub handle. Commits per move under the caller's
        // fixed coalesce key, so one scrub is one undo step — the same
        // contract every slider here already holds. touch-action none keeps
        // the browser from claiming the gesture for scrolling.
        data-testid={`scrub-${id}`}
        style={{
          ...label,
          cursor: "ew-resize",
          userSelect: "none",
          touchAction: "none",
          ...(scrubbing ? { color: "#FFE14D" } : {}),
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, v: Number.isFinite(value) ? value : 0, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setScrubbing(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) <= 2) return; // a click, until it isn't
          d.moved = true;
          // Quantized to the §48 display precision, so a scrub can never
          // commit float dust the field itself would refuse to show.
          const next = Math.round(Math.min(hi, Math.max(lo, d.v + dx * perPx)) * 1000) / 1000;
          onCommit(next);
        }}
        onPointerUp={() => {
          const wasDrag = drag.current?.moved === true;
          drag.current = null;
          setScrubbing(false);
          // A click without a drag focuses the input — typing stays one
          // gesture away, exactly where it was before scrubbing existed.
          if (!wasDrag) {
            inputRef.current?.focus();
            inputRef.current?.select();
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setScrubbing(false);
        }}
      >
        {id}
      </span>
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
        style={numberInput}
        value={draft ?? (Number.isFinite(value) ? roundShown(value) : "0")}
        onFocus={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
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
  resolvedTheme,
  anchorText,
  onVideoPreview,
}) => {
  if (selection?.elementId && cue) {
    const elementId = selection.elementId;
    const transform = cue.elements?.[elementId] ?? {};
    // The panel is where text editing LIVES now (R12 §49) — the inline
    // double-click input painted over the element it edited. `elementTextOf`
    // also reads the array-backed line-N/node-N/message-N ids, so the panel
    // covers everything the overlay input could reach (a window-N returns
    // null — its lines carry their own ids).
    const text = cue.props ? elementTextOf(elementId, cue.props) : null;
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
              <input
                style={textInput}
                data-testid="element-text"
                value={text}
                onChange={(e) => {
                  const props = cue.props ?? {};
                  // Top-level string props patch directly; array-backed ids
                  // need buildArrayPatch to rewrite the right entry — a bare
                  // { [elementId]: text } there writes a key nothing reads.
                  const patch = /^(line|node|message|window|item)-\d+$/.test(elementId)
                    ? buildArrayPatch(elementId, props, e.target.value)
                    : { [elementId]: e.target.value };
                  if (patch) {
                    edits.patchProps(
                      selection.sceneId,
                      patch,
                      `text:${selection.sceneId}:${elementId}`,
                    );
                  }
                }}
              />
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
          <button style={button} onClick={() => edits.clearElement(selection.sceneId, elementId)}>
            Reset element
          </button>
        </div>
      </div>
    );
  }

  if (selection && cue) {
    const isPlain = cue.kind === "plain";
    // A deleted scene (PLAN Task C4): the ghost selection resolves here, and
    // the ONLY offer is the way back — its other controls would edit a scene
    // that isn't rendering.
    if (edits.doc.scenes[selection.sceneId]?.hidden === true) {
      return (
        <div>
          <div style={section}>
            <span style={label}>Scene</span>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
              {selection.sceneId} <span style={{ color: "#9A9AA3", fontWeight: 400 }}>(deleted)</span>
            </div>
            <div style={{ fontSize: 12, color: "#9A9AA3" }}>
              Its window plays as a plain take. Restore brings the graphic back.
            </div>
            <button
              data-testid="restore-scene"
              style={{ ...button, color: "#5FBF77", border: "1px solid #24402c" }}
              onClick={() => edits.restoreScene(selection.sceneId)}
            >
              Restore scene
            </button>
          </div>
        </div>
      );
    }
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
            <button style={button} onClick={() => edits.clearVideo(selection.sceneId)}>
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
                      onClick={() => edits.clearPip(selection.sceneId)}
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
                  onClick={() => edits.clearGraphicRect(selection.sceneId)}
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
                onClick={() =>
                  edits.patchCaptionStyleAll(allSceneIds, { y: effY, scale: effScale })
                }
              >
                Apply to all scenes
              </button>
              {sceneDoc?.captionY !== undefined || sceneDoc?.captionScale !== undefined ? (
                <button
                  data-testid="reset-caption-y"
                  style={button}
                  onClick={() => edits.clearCaptionStyle(selection.sceneId)}
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
            <button style={button} onClick={() => edits.clearTiming(selection.sceneId)}>
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
              onClick={() => edits.hideScene(selection.sceneId)}
            >
              Delete scene
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const theme = edits.doc.theme;
  const patch = (key: string, v: string | number) => edits.patchTheme({ [key]: v });
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
    </div>
  );
};
