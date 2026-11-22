import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import {
  ADDED_OFFERED,
  addFormProps,
  isSrcTiming,
  resolveTimingPin,
  wordOutputStart,
  type AddFormField,
  type AddedOffered,
  type SceneCue,
  type SceneTiming,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";
import type { AddGraphicCheck } from "./addedGraphics";
import {
  ADD_TYPE_COPY,
  addFormFieldsFor,
  allowedWords,
  appendItem,
  blockWords as blockWordsOf,
  clockText,
  entryText,
  hasItemTiming,
  initialAddValues,
  keptSpanStartOf,
  listFieldOf,
  modalRows,
  openModal,
  pinItem,
  previewCue,
  removeItem,
  rowsResizable,
  saveBlocker,
  saveFor,
  shownItemPins,
  spokenWordAt,
  startWordOf,
  unpinItem,
  whenRowPin,
  windowWords as windowWordsOf,
  withEntryText,
  withProps,
  wordAtSec,
  type ModalRow,
  type ModalState,
} from "./graphicEditorModel";
import type { ItemPins } from "./useEdits";

/**
 * The graphic editor (graphic-editor-modal §5, mockup v3): one modal for
 * adding a graphic over a transcript selection and for editing one on the
 * timeline (G6). It shows the block's spoken words with each item's marker,
 * the When row, the items with what each lands on, and a live preview (G5);
 * what it dispatches is `saveFor`'s answer and nothing else, so an unchanged
 * Save or a Cancel writes nothing (§6).
 *
 * Every rule lives in `graphicEditorModel.ts`, pure and tested there; this
 * file is the state that rule set reads and the DOM the mockup drew. App owns
 * the I/O: the check made at the press, the cue the preview plays
 * (`renderPreview`, a second Remotion Player), the commit.
 */

/** What Save hands App: `saveFor`'s non-null answer. */
export type GraphicEditorSave = NonNullable<ReturnType<typeof saveFor>>;

type Common = {
  /** The run's transcript list (`sfxPlan.words`), source-timed. */
  words: readonly Word[] | null;
  /** The live clock (Terms), the one the stage cues are on. */
  liveMap: TimeMap | null;
  /** The block window (Terms): the selection's span on an add,
   * `blockWindow` on an edit. Null: no anchor to time items in. */
  window: { srcStart: number; srcEnd: number } | null;
  fps: number;
  /** The When row's floor (`previousGraphicEndSec`). */
  prevGraphicEndSec: number | null;
  /** The preview (G5): App mounts a Player playing `cue` alone over the
   * stage, limited to its window. Absent (tests) → a plain frame. */
  renderPreview?: (args: { cue: SceneCue; playerRef: React.RefObject<PlayerRef> }) => React.ReactNode;
  onClose: () => void;
};

export type GraphicEditorModalProps = Common &
  (
    | {
        mode: "add";
        /** The selected words as the panel shows them, for the prefill. */
        selectionText: string;
        selectionWordCount: number;
        check: AddGraphicCheck;
        /** The cue the add would preview as (`addPreviewCue`), or null. */
        previewFor: (component: AddedOffered, props: Record<string, unknown>) => SceneCue | null;
        onAdd: (component: AddedOffered, save: GraphicEditorSave) => void;
      }
    | {
        mode: "edit";
        /** The ROOT id (a split half opens its root, §5). */
        sceneId: string;
        component: AddedOffered;
        /** The root's merged props, before item timing forced anything. */
        props: Record<string, unknown>;
        itemPins: ItemPins | undefined;
        timing: SceneTiming | undefined;
        /** The root's own override `reveal`, undefined when unset (§3 step 5). */
        ownReveal: unknown;
        /** The root's cue as the stage draws it, halves joined. */
        liveCue: SceneCue;
        onSave: (save: GraphicEditorSave) => void;
      }
  );

const TOKENS = {
  bg: "#0B0B0E",
  panel: "#12121A",
  raised: "#1A1A21",
  hover: "#23232E",
  line: "#2A2A33",
  lineStrong: "#3A3A48",
  text: "#EDEDF2",
  soft: "#C9C9D4",
  muted: "#A3A3AD",
  faint: "#7A7A86",
  // The editor's warning/primary yellow (storyboardStyles' WARN), the
  // transcript's selection band: the primary action and the graphic's start.
  accent: "#FFE14D",
  accentInk: "#111",
  // The blue of a top-bar button that is on (§169): "you chose this word".
  pin: "#6F9BFF",
  pinInk: "#0B0B0E",
  pinSoft: "rgba(111,155,255,0.16)",
  auto: "#C4A4FF",
  even: "#A3A3AD",
  // The captions' active-word colour: the preview's playhead in the strip.
  play: "#FF8A3D",
  danger: "#FF7A7A",
  mono: "ui-monospace, 'SF Mono', Consolas, monospace",
} as const;

/** The sentence `allowedWords` refuses with (mockup v3). */
const ORDER_REFUSAL = "Pick a word between this item's neighbours, so the list stays in order.";

export const GraphicEditorModal: React.FC<GraphicEditorModalProps> = (p) => {
  const { words, liveMap, window, fps, prevGraphicEndSec, renderPreview, onClose } = p;
  const titleId = useId();
  const [opened, setOpened] = useState<ModalState | null>(() =>
    p.mode === "edit"
      ? openModal({ mode: "edit", component: p.component, props: p.props, itemPins: p.itemPins, timing: p.timing })
      : null,
  );
  const [now, setNow] = useState<ModalState | null>(opened);
  /** The row whose word is being picked, or the When row's start. */
  const [picking, setPicking] = useState<number | "start" | null>(null);
  /** The strip's roving tab stop, when the author has moved it. */
  const [focusWord, setFocusWord] = useState<number | null>(null);
  /** The start word chosen this session: a pin stores seconds, not a word. */
  const [startPick, setStartPick] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const wordRefs = useRef(new Map<number, HTMLButtonElement>());
  /** Focus to land after the next commit: a pick returns focus to the box it
   * started from (mockup v3), which only exists once the row re-renders. */
  const focusAfter = useRef<string | null>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;

  const component = (now?.component ?? null) as AddedOffered | null;
  const fields = component === null ? [] : addFormFieldsFor(component);
  const listField = component === null ? null : listFieldOf(component);
  const covered = now !== null && hasItemTiming(now.component);
  const pins = useMemo(
    () => (now !== null && opened !== null ? shownItemPins(opened, now) : undefined),
    [opened, now],
  );
  const placeable = words !== null && liveMap !== null && window !== null;
  // The window the items resolve in once a When-row pin is set: the pin's
  // own span, `blockWindow`'s rule 1, which the stage applies after Save. The
  // strip keeps showing the window the modal opened over, so the start can
  // still move back to an earlier word.
  const timing = now?.timing;
  const itemWindow = useMemo(() => {
    if (timing === undefined || window === null || liveMap === null || !isSrcTiming(timing)) return window;
    return resolveTimingPin(timing, liveMap) === null ? window : { srcStart: timing.srcStart, srcEnd: timing.srcEnd };
  }, [timing, window, liveMap]);

  // The cue the stage would draw: an add's one-scene assembly of the current
  // props (the last one that could render, while the author is mid-edit), an
  // edit's live root cue.
  const lastAddCue = useRef<SceneCue | null>(null);
  const addCue = useMemo(() => {
    if (p.mode !== "add" || now === null) return null;
    return p.previewFor(now.component as AddedOffered, now.props);
    // `previewFor` is App's fresh closure each render over the same clock
    // and words: the cue follows the props, the type, and those two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode, now?.component, now?.props, words, liveMap]);
  if (addCue !== null) lastAddCue.current = addCue;
  const baseCue = p.mode === "edit" ? p.liveCue : (addCue ?? lastAddCue.current);
  const ownReveal = p.mode === "edit" ? p.ownReveal : undefined;
  const liveCue = p.mode === "edit" ? p.liveCue : undefined;
  const cue = useMemo(
    () =>
      baseCue === null || now === null
        ? null
        : previewCue(baseCue, now, pins, { words, window: itemWindow, liveMap, ownReveal }),
    [baseCue, now, pins, words, itemWindow, liveMap, ownReveal],
  );
  const cueWindow = cue ?? (p.mode === "add" ? p.check.at : null);

  const rows: ModalRow[] = useMemo(() => {
    if (now === null || !placeable || cueWindow === null) return [];
    return modalRows(now.component, now.props, pins, {
      words: words!,
      window: itemWindow!,
      liveMap: liveMap!,
      cue: { startSec: cueWindow.startSec, endSec: cueWindow.endSec },
      fps,
      ownReveal: ownReveal !== undefined,
      liveCue,
    });
  }, [now, pins, placeable, words, itemWindow, liveMap, cueWindow, fps, ownReveal, liveCue]);

  const windowW = useMemo(() => (words !== null && window !== null ? windowWordsOf(words, window) : []), [words, window]);
  const blockW = useMemo(
    () => (words !== null && window !== null && liveMap !== null ? blockWordsOf(words, window, liveMap) : []),
    [words, window, liveMap],
  );
  const blockSet = useMemo(() => new Set(blockW), [blockW]);
  const allowed = picking === null || !placeable ? null : allowedWords(rows, picking, blockW);

  const item1 = rows[0] !== undefined && (rows[0].state === "pinned" || rows[0].state === "auto") ? rows[0].word : null;
  const startWord =
    !placeable || cueWindow === null
      ? null
      : (startPick ?? startWordOf(blockW, words!, liveMap!, cueWindow.startSec));
  const startIsItem1 = covered && item1 !== null && startWord === item1;
  const nowWord =
    playheadSec === null || !placeable ? null : spokenWordAt(windowW, words!, liveMap!, playheadSec);

  const blocker = component === null ? "Choose a type on the left." : saveBlocker(component, now!.props);
  const refusal = p.mode === "add" ? p.check.refusal : null;

  const say = (text: string): void => setSaid(text);

  // The preview's playhead, for the strip's orange word: read off the second
  // Player, which App mounts inside `renderPreview` in this same commit.
  useEffect(() => {
    const player = playerRef.current;
    if (player === null) return;
    const onFrame = (e: { detail: { frame: number } }): void => setPlayheadSec(e.detail.frame / fps);
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [fps, cue !== null]);

  // Focus at open: the type list on an add (nothing is typed before a type
  // is chosen), the first field on an edit. The control that opened the
  // modal is behind the backdrop; a focus left there would send Escape and
  // the arrows to the timeline.
  useEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    const first =
      root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      root.querySelector<HTMLElement>('[role="radio"]') ??
      root.querySelector<HTMLElement>("input, select") ??
      root.querySelector<HTMLElement>("button");
    first?.focus({ preventScroll: true });
  }, []);

  // A focus queued by a pick, a cancel or a row change lands once the
  // element it names is in the DOM.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    dialogRef.current?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  });

  // Escape backs out of the innermost thing: a pick first, then the modal.
  // CAPTURE phase on the window (DeleteSceneModal's reason): Overlay's
  // window Escape would deselect the block, and the transcript's would clear
  // the selection the author is adding over. Tab stays inside, so a Space
  // can never land on a timeline block behind the backdrop.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        const was = pickingRef.current;
        if (was !== null) {
          setPicking(null);
          setFocusWord(null);
          focusAfter.current = pickSelector(was);
          say("Stopped picking");
          return;
        }
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (root === null) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>("button:not([disabled]), input, select, [tabindex='0']"),
      ).filter((el) => el.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    globalThis.window.addEventListener("keydown", onKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Starting a pick hands the strip the focus, on the word it would change.
  useEffect(() => {
    if (picking === null) return;
    const el = dialogRef.current?.querySelector<HTMLElement>('[data-strip-word][tabindex="0"]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest" });
    // Only when a pick starts, not on every re-render while it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  const chooseType = (c: AddedOffered): void => {
    if (p.mode !== "add") return;
    const st = openModal({ mode: "add", component: c, props: addFormProps(c, initialAddValues(c, p.selectionText)) });
    // The last preview was another type's: never the base of this one's.
    lastAddCue.current = null;
    setOpened(st);
    setNow(st);
    setPicking(null);
    setStartPick(null);
    setFocusWord(null);
  };

  /** The rows `withProps` decides by: the shown ones, or (with nothing
   * placed) each stored pin read as shown, so typing never drops a pin the
   * modal could not show. */
  const rowsForEdit = (st: ModalState): readonly ModalRow[] =>
    rows.length === st.items.length
      ? rows
      : st.items.map((it) => ({ text: "", state: it.pin === null ? "auto" : "pinned", word: null, estSec: null, note: null }));

  const setProp = (key: string, value: unknown): void => {
    if (now === null) return;
    setNow(withProps(now, { ...now.props, [key]: value }, rowsForEdit(now)));
  };

  const setEntry = (k: number, entry: unknown): void => {
    if (now === null || listField === null) return;
    const list = Array.isArray(now.props[listField.key]) ? (now.props[listField.key] as unknown[]) : [];
    setProp(
      listField.key,
      list.map((e, j) => (j === k ? entry : e)),
    );
  };

  const deleteRow = (k: number): void => {
    if (now === null || listField === null) return;
    if (covered) setNow(removeItem(now, k));
    else {
      const list = Array.isArray(now.props[listField.key]) ? (now.props[listField.key] as unknown[]) : [];
      setProp(
        listField.key,
        list.filter((_, j) => j !== k),
      );
    }
    setPicking(null);
    // The row that moved up into its place, or the new last one.
    const left = (Array.isArray(now.props[listField.key]) ? (now.props[listField.key] as unknown[]).length : 1) - 1;
    focusAfter.current = `[data-testid="graphic-editor-item-${Math.max(0, Math.min(k, left - 1))}"]`;
    say(`Item ${k + 1} deleted`);
  };

  const addRow = (): void => {
    if (now === null || listField === null) return;
    const list = Array.isArray(now.props[listField.key]) ? (now.props[listField.key] as unknown[]) : [];
    if (covered) setNow(appendItem(now));
    else setProp(listField.key, [...list, listField.kind === "list" && listField.item === "string" ? "" : { text: "" }]);
    focusAfter.current = `[data-testid="graphic-editor-item-${list.length}"]`;
  };

  const startPicking = (target: number | "start"): void => {
    if (!placeable) return;
    setFocusWord(null);
    if (picking === target) {
      setPicking(null);
      focusAfter.current = pickSelector(target);
      say("Stopped picking");
      return;
    }
    setPicking(target);
    say(
      target === "start"
        ? "Pick the word the graphic starts on. Arrow keys move, Enter picks."
        : `Pick the word item ${target + 1} lands on. Arrow keys move, Enter picks.`,
    );
  };

  /** The When row's pin for `i`, or why it cannot be written there. */
  const startAt = (i: number): boolean => {
    if (now === null || !placeable || cueWindow === null) return false;
    const w = words![i]!;
    const kept = keptSpanStartOf(w, liveMap!);
    if (kept === null) {
      say("That word is cut from the video.");
      return false;
    }
    const pin = whenRowPin(w, liveMap!, kept, prevGraphicEndSec, cueWindow.endSec);
    if (pin === null) {
      say("The graphic would end before it starts there. Pick an earlier word.");
      return false;
    }
    setNow({ ...now, timing: pin });
    setStartPick(i);
    say(`Graphic starts on ${w.text}`);
    return true;
  };

  const clickWord = (i: number): void => {
    if (picking === null) {
      // Not picking: the word plays from there in the preview.
      const t = liveMap === null ? null : wordOutputStart(words![i]!, liveMap);
      if (t !== null) playerRef.current?.seekTo(Math.round(t * fps));
      setFocusWord(i);
      return;
    }
    if (allowed !== null && !allowed.has(i)) {
      say(picking === "start" ? "Pick a word at or before the first item's." : ORDER_REFUSAL);
      return;
    }
    const target = picking;
    if (target === "start") {
      if (!startAt(i)) return;
    } else {
      if (now === null) return;
      setNow(pinItem(now, target, words![i]!));
      say(`Item ${target + 1} pinned to ${words![i]!.text}`);
    }
    setPicking(null);
    setFocusWord(null);
    focusAfter.current = pickSelector(target);
  };

  const stripKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const at = windowW.indexOf(Number((e.target as HTMLElement).dataset.stripWord));
    if (at === -1) return;
    let to: number | null = null;
    if (step !== undefined) {
      let j = at + step;
      while (allowed !== null && j >= 0 && j < windowW.length && !allowed.has(windowW[j]!)) j += step;
      if (j >= 0 && j < windowW.length) to = j;
    } else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = windowW.length - 1;
    else return;
    e.preventDefault();
    if (to === null) return;
    const i = windowW[to]!;
    setFocusWord(i);
    wordRefs.current.get(i)?.focus();
  };

  const primary = (): void => {
    if (now === null || opened === null || blocker !== null) return;
    const save = saveFor(opened, now);
    if (p.mode === "add") {
      if (save !== null) p.onAdd(now.component as AddedOffered, save);
      return;
    }
    if (save === null) onClose();
    else p.onSave(save);
  };

  // The strip's one tab stop (mockup v3): the word the author moved to, else
  // the word the pick would change, else the first word it may take.
  const current =
    typeof picking === "number" ? (rows[picking]?.word ?? null) : picking === "start" ? startWord : null;
  const tabStop =
    focusWord !== null && windowW.includes(focusWord) && (allowed === null || allowed.has(focusWord))
      ? focusWord
      : current !== null && (allowed === null || allowed.has(current))
        ? current
        : (windowW.find((i) => allowed === null || allowed.has(i)) ?? null);

  // Markers per word, in item order, then the start flag.
  const marks = new Map<number, React.ReactNode[]>();
  const addMark = (i: number | null, node: React.ReactNode): void => {
    if (i === null) return;
    marks.set(i, [...(marks.get(i) ?? []), node]);
  };
  if (covered && placeable) {
    rows.forEach((r, k) => {
      if (r.state === "pinned" || r.state === "cut") addMark(r.word, <Marker key={`m${k}`} kind="pinned" n={k + 1} />);
      else if (r.state === "auto") addMark(r.word, <Marker key={`m${k}`} kind="auto" n={k + 1} />);
      else if (r.text.trim() !== "") addMark(wordAtSec(blockW, words!, liveMap!, r.estSec), <Marker key={`m${k}`} kind="even" n={k + 1} />);
    });
  }
  const showStartFlag = placeable && startWord !== null && !startIsItem1;
  if (showStartFlag) addMark(startWord, <Marker key="start" kind="start" />);

  const headerRange =
    cueWindow === null ? null : `${clockText(cueWindow.startSec)} – ${clockText(cueWindow.endSec)}`;
  const wordCount = windowW.length > 0 ? windowW.length : p.mode === "add" ? p.selectionWordCount : 0;

  const footerNote =
    refusal !== null
      ? null
      : blocker !== null
        ? { bad: true, text: blocker }
        : {
            bad: false,
            text:
              p.mode === "edit"
                ? "Saving keeps the block where it is on the timeline."
                : "The block covers the selected words. You can trim it on the timeline later.",
          };

  return (
    // No close on a press outside, unlike the storyboard's table: this holds
    // typed items and picked words, and a stray click must not throw them
    // away. Esc, Cancel and ✕ are the ways out.
    <div style={backdrop}>
      <div
        ref={dialogRef}
        data-testid="graphic-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={modal}
        // Every key stays in here: Overlay's window shortcuts (Space plays,
        // Delete removes the selected block, the arrows step frames) belong
        // to the editor behind the backdrop, not to a word or a field here.
        onKeyDown={(e) => {
          e.stopPropagation();
          // Enter in a one-line field commits, the popover's convention it
          // replaces (plain Enter commits). Only from an <input>: Enter on a
          // button presses it, on a <select> it opens the choices.
          if (e.key === "Enter" && e.target instanceof HTMLInputElement && blocker === null && refusal === null) {
            e.preventDefault();
            primary();
          }
        }}
      >
        <header style={headerBar}>
          <h1 id={titleId} style={h1}>
            {p.mode === "edit" ? "Edit graphic" : "Add graphic"}
          </h1>
          {headerRange !== null ? (
            <span style={headerSpan}>
              over <b style={headerTimes}>{headerRange}</b> · {wordCount} words
            </span>
          ) : null}
          <button
            data-testid="graphic-editor-close"
            aria-label="Close"
            title="Close (Esc)"
            style={iconBtn}
            onClick={onClose}
          >
            <Icon d={ICONS.x} />
          </button>
        </header>

        {refusal !== null ? (
          <div style={refusalBody}>
            {p.mode === "add" ? (
              <div data-testid="graphic-editor-words" dir="auto" style={quote}>
                “{p.selectionText}”
              </div>
            ) : null}
            <div data-testid="graphic-editor-refusal" role="alert" style={refusalText}>
              {refusal}
            </div>
          </div>
        ) : (
          <div style={p.mode === "edit" ? bodyEdit : bodyAdd}>
            {p.mode === "add" ? (
              <nav style={typesCol} aria-label="Graphic types">
                <div style={colHead} id={`${titleId}-types`}>
                  Type
                </div>
                <div
                  role="radiogroup"
                  aria-labelledby={`${titleId}-types`}
                  onKeyDown={(e) => {
                    // From no type yet, Down picks the first and Up the last.
                    const at = component === null ? -1 : ADDED_OFFERED.indexOf(component);
                    const up = at === -1 ? ADDED_OFFERED.length - 1 : at - 1;
                    const to = { ArrowDown: at + 1, ArrowUp: up, Home: 0, End: ADDED_OFFERED.length - 1 }[e.key];
                    if (to === undefined) return;
                    e.preventDefault();
                    const next = ADDED_OFFERED[(to + ADDED_OFFERED.length) % ADDED_OFFERED.length]!;
                    chooseType(next);
                    focusAfter.current = `[data-testid="graphic-editor-type-${next}"]`;
                  }}
                >
                  {ADDED_OFFERED.map((c, i) => {
                    const on = component === c;
                    return (
                      <button
                        key={c}
                        data-testid={`graphic-editor-type-${c}`}
                        role="radio"
                        aria-checked={on}
                        tabIndex={on || (component === null && i === 0) ? 0 : -1}
                        style={{ ...typeBtn, ...(on ? typeOn : {}) }}
                        onClick={() => chooseType(c)}
                      >
                        <span style={typeName}>{ADD_TYPE_COPY[c].name}</span>
                        <span style={typeLine}>{ADD_TYPE_COPY[c].line}</span>
                      </button>
                    );
                  })}
                </div>
              </nav>
            ) : null}

            <section style={previewCol} aria-label="Preview">
              {cue !== null && renderPreview !== undefined ? (
                <div data-testid="graphic-editor-preview" style={previewFrame}>
                  {renderPreview({ cue, playerRef })}
                </div>
              ) : (
                <div data-testid="graphic-editor-preview" style={{ ...previewFrame, ...previewEmpty }}>
                  {component === null ? "Choose a type to preview it." : cue === null ? "Fill in the graphic to preview it." : null}
                </div>
              )}
            </section>

            <section style={workCol}>
              {component === null ? (
                <div style={{ ...muted, padding: "18px 22px" }}>Choose a type on the left.</div>
              ) : (
                <>
                  <div style={stripWrap}>
                    <div style={stripHead}>
                      <div style={colHeadInline} id={`${titleId}-strip`}>
                        Spoken words
                      </div>
                      {picking !== null ? (
                        <span data-testid="graphic-editor-picking" style={pickChip}>
                          {picking === "start"
                            ? "Pick the word the graphic starts on"
                            : `Pick the word item ${picking + 1} lands on`}
                          <kbd style={kbd}>Esc</kbd>
                        </span>
                      ) : null}
                    </div>
                    {placeable ? (
                      <div
                        data-testid="graphic-editor-strip"
                        role="listbox"
                        aria-labelledby={`${titleId}-strip`}
                        style={{ ...strip, ...(picking !== null ? stripPicking : {}) }}
                        onKeyDown={stripKeyDown}
                      >
                        {windowW.map((i) => {
                          const disabled = allowed !== null && !allowed.has(i);
                          const cut = !blockSet.has(i);
                          const row = rows.findIndex((r) => r.word === i && r.state !== "unmatched");
                          const st = row === -1 ? null : rows[row]!.state;
                          return (
                            <button
                              key={i}
                              ref={(el) => {
                                if (el) wordRefs.current.set(i, el);
                                else wordRefs.current.delete(i);
                              }}
                              data-strip-word={i}
                              data-testid={`graphic-editor-word-${i}`}
                              data-now={i === nowWord ? "true" : undefined}
                              role="option"
                              aria-selected={i === current}
                              aria-disabled={disabled || undefined}
                              aria-label={wordLabel(words![i]!, liveMap!, row, st, showStartFlag && i === startWord, cut, disabled)}
                              tabIndex={i === tabStop ? 0 : -1}
                              style={{ ...wordBtn, ...(disabled ? { cursor: "not-allowed" } : {}) }}
                              onClick={() => clickWord(i)}
                            >
                              <span style={{ ...marksRow, ...(disabled ? { opacity: 0.4 } : {}) }} aria-hidden="true">
                                {marks.get(i) ?? null}
                              </span>
                              <span
                                style={{
                                  ...wordTxt,
                                  ...(st === "pinned" || st === "cut" ? wordPinned : st === "auto" ? wordAuto : {}),
                                  ...(cut ? { textDecoration: "line-through", color: TOKENS.faint } : {}),
                                  ...(i === nowWord ? { color: TOKENS.play } : {}),
                                  ...(showStartFlag && i === startWord ? wordStart : {}),
                                  ...(picking !== null && !disabled ? wordPickable : {}),
                                  ...(picking !== null && i === current ? wordCurrent : {}),
                                  ...(disabled ? { color: TOKENS.faint } : {}),
                                }}
                              >
                                {words![i]!.text}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div data-testid="graphic-editor-unplaced" style={{ ...strip, ...muted }}>
                        {p.mode === "add" ? <div dir="auto">“{p.selectionText}”</div> : null}
                        The preview cannot place items on words yet: the editor has no transcript or timing for this
                        project until the next Render.
                      </div>
                    )}
                    {placeable ? (
                      <div style={legend}>
                        {covered ? (
                          <>
                            <span style={legendItem}>
                              <Marker kind="pinned" />
                              Pinned: you chose it
                            </span>
                            <span style={legendItem}>
                              <Marker kind="auto" />
                              Auto: found from the item&apos;s text
                            </span>
                            <span style={legendItem}>
                              <Marker kind="even" />
                              Even: no word, spaced evenly
                            </span>
                            <span style={legendItem}>
                              <Marker kind="start" />
                              Graphic starts
                            </span>
                          </>
                        ) : (
                          <>
                            <span style={legendItem}>
                              <Marker kind="start" />
                              where the graphic comes in
                            </span>
                            <span style={legendItem}>Click a word to play from there.</span>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div style={sectionBox}>
                    {fields
                      .filter((f) => f.kind !== "list" && f.kind !== "messages")
                      .map((f) => (
                        <ScalarField
                          key={f.key}
                          field={f}
                          value={now!.props[f.key]}
                          onChange={(v) => setProp(f.key, v)}
                        />
                      ))}

                    {placeable ? (
                      <>
                        <h2 style={h2}>When</h2>
                        <div style={{ ...rowGrid, ...(picking === "start" ? rowActive : {}) }}>
                          <span style={{ ...rowNum, color: TOKENS.accent }} aria-hidden="true">
                            <Icon d={ICONS.start} />
                          </span>
                          <span style={{ color: TOKENS.soft }}>
                            {covered ? "The graphic starts" : "The graphic comes in"}
                          </span>
                          <button
                            data-testid="graphic-editor-start"
                            data-pick="start"
                            style={{ ...landsBox, ...landsStart, ...(picking === "start" ? landsActive : {}) }}
                            aria-label={
                              startIsItem1
                                ? "Graphic starts with item 1. Change"
                                : `Starts on ${startWord === null ? "its first word" : words![startWord]!.text}. Change`
                            }
                            onClick={() => startPicking("start")}
                          >
                            <StateBadge kind="start" />
                            {startIsItem1 || startWord === null ? (
                              <span style={{ ...landsWord, fontWeight: 500 }}>
                                {startWord === null ? "Its first word" : "With item 1"}
                              </span>
                            ) : (
                              <>
                                <span style={landsWord}>“{words![startWord]!.text}”</span>
                                <span style={landsTime}>{clockText(wordOutputStart(words![startWord]!, liveMap!) ?? 0)}</span>
                              </>
                            )}
                          </button>
                          {covered && item1 !== null && !startIsItem1 ? (
                            <button
                              data-testid="graphic-editor-start-item1"
                              style={{ ...iconBtn, color: TOKENS.accent }}
                              aria-label="Start with item 1"
                              title="Start with item 1"
                              onClick={() => {
                                if (startAt(item1)) focusAfter.current = pickSelector("start");
                              }}
                            >
                              <Icon d={ICONS.x} />
                            </button>
                          ) : (
                            <span />
                          )}
                          <span />
                        </div>
                      </>
                    ) : null}

                    {listField !== null ? (
                      <ItemRows
                        field={listField}
                        props={now!.props}
                        covered={covered}
                        placeable={placeable}
                        rows={rows}
                        words={words}
                        picking={picking}
                        resizable={rowsResizable(component, now!.props)}
                        onText={(k, text) => {
                          const list = now!.props[listField.key] as unknown[];
                          setEntry(k, withEntryText(list[k], text));
                        }}
                        onFrom={(k, from) => {
                          const list = now!.props[listField.key] as Record<string, unknown>[];
                          setEntry(k, { ...list[k], from });
                        }}
                        onPick={(k) => startPicking(k)}
                        onUnpin={(k) => {
                          setNow(unpinItem(now!, k));
                          setPicking(null);
                          focusAfter.current = pickSelector(k);
                          say(`Item ${k + 1} unpinned; its word now comes from its text`);
                        }}
                        onDelete={deleteRow}
                        onAdd={addRow}
                      />
                    ) : null}
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        <footer style={footerBar}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            {refusal === null && p.mode === "add"
              ? p.check.notes.map((n) => (
                  <span key={n} data-testid="graphic-editor-note" style={muted}>
                    {n}
                  </span>
                ))
              : null}
            {footerNote !== null ? (
              <span
                data-testid="graphic-editor-footer"
                id={`${titleId}-foot`}
                style={{ ...muted, ...(footerNote.bad ? { color: TOKENS.danger } : {}) }}
              >
                {footerNote.text}
              </span>
            ) : null}
          </div>
          <span style={{ marginLeft: "auto" }} />
          <button data-testid="graphic-editor-cancel" style={secondaryBtn} onClick={onClose} title="Close (Esc)">
            {refusal !== null ? "Close" : "Cancel"}
          </button>
          {refusal === null ? (
            <button
              data-testid="graphic-editor-save"
              style={{ ...primaryBtn, ...(blocker !== null ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
              disabled={blocker !== null}
              aria-describedby={`${titleId}-foot`}
              title={blocker ?? undefined}
              onClick={primary}
            >
              {p.mode === "edit" ? "Save" : "Add graphic"}
            </button>
          ) : null}
        </footer>
        <div data-testid="graphic-editor-live" aria-live="polite" style={srOnly}>
          {said}
        </div>
      </div>
    </div>
  );
};

/** The selector a pick returns focus to (mockup v3): the box it started from. */
const pickSelector = (target: number | "start"): string =>
  target === "start" ? '[data-testid="graphic-editor-start"]' : `[data-testid="graphic-editor-lands-${target}"]`;

/** A word's spoken label: the word, its time, what is on it, and why a pick
 * cannot take it. */
function wordLabel(
  w: Word,
  map: TimeMap,
  row: number,
  st: ModalRow["state"] | null,
  start: boolean,
  cut: boolean,
  disabled: boolean,
): string {
  const t = wordOutputStart(w, map);
  return [
    w.text,
    t === null ? "cut" : clockText(t),
    row === -1 || st === null ? "" : `item ${row + 1}, ${STATE_LABEL[st]}`,
    start ? "graphic starts" : "",
    cut ? "cut from the video" : "",
    disabled ? "not available for this pick" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const STATE_LABEL: Record<ModalRow["state"], string> = {
  pinned: "Pinned",
  auto: "Auto",
  cut: "Pinned, its word was cut",
  unmatched: "Even",
};

/** The item rows (§5): text, what it lands on, unpin, delete; within the
 * schema's count. ChatMock rows carry the sender too; a ChatMock whose
 * keyword is its one item shows its bubbles as fields and the keyword as the
 * one row that lands on a word. */
const ItemRows: React.FC<{
  field: AddFormField & { kind: "list" | "messages" };
  props: Record<string, unknown>;
  covered: boolean;
  placeable: boolean;
  rows: ModalRow[];
  words: readonly Word[] | null;
  picking: number | "start" | null;
  resizable: boolean;
  onText: (k: number, text: string) => void;
  onFrom: (k: number, from: string) => void;
  onPick: (k: number) => void;
  onUnpin: (k: number) => void;
  onDelete: (k: number) => void;
  onAdd: () => void;
}> = ({ field, props, covered, placeable, rows, words, picking, resizable, onText, onFrom, onPick, onUnpin, onDelete, onAdd }) => {
  const list = Array.isArray(props[field.key]) ? (props[field.key] as unknown[]) : [];
  const label = field.kind === "messages" ? "Messages" : field.label;
  const noun = field.kind === "messages" ? "message" : label.toLowerCase().replace(/s$/, "");
  // One row per entry carries its own lands-on box only when the entries
  // ARE the items; a keyword ChatMock's one item gets its own row below.
  const inline = covered && resizable && placeable;
  return (
    <>
      <h2 style={{ ...h2, marginTop: 14 }}>
        {label} <span style={{ fontWeight: 500 }}>· {list.length} of {field.min}–{field.max}</span>
      </h2>
      {list.map((entry, k) => {
        const text = entryText(entry);
        const row = inline ? rows[k] : undefined;
        const empty = text.trim() === "";
        return (
          <React.Fragment key={k}>
            <div
              data-testid={`graphic-editor-row-${k}`}
              style={{ ...rowGrid, ...(picking === k && inline ? rowActive : {}) }}
            >
              <span style={rowNum}>{k + 1}</span>
              <span style={{ display: "flex", gap: 6, minWidth: 0 }}>
                {field.kind === "messages" ? (
                  <select
                    data-testid={`graphic-editor-from-${k}`}
                    aria-label={`Message ${k + 1} sender`}
                    style={{ ...fieldInput, width: "auto", flex: "none" }}
                    value={str((entry as Record<string, unknown>)?.from) ?? field.from[0]}
                    onChange={(e) => onFrom(k, e.target.value)}
                  >
                    {field.from.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  data-testid={`graphic-editor-item-${k}`}
                  aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)} ${k + 1} text`}
                  aria-invalid={empty || undefined}
                  aria-describedby={empty ? `graphic-editor-need-${k}` : undefined}
                  dir="auto"
                  style={{ ...fieldInput, ...(empty ? { borderColor: TOKENS.danger } : {}) }}
                  value={text}
                  onChange={(e) => onText(k, e.target.value)}
                />
              </span>
              {row !== undefined ? (
                <LandsBox row={row} k={k} words={words!} empty={empty} active={picking === k} onPick={() => onPick(k)} />
              ) : (
                <span />
              )}
              {row !== undefined && (row.state === "pinned" || row.state === "cut") ? (
                <button
                  data-testid={`graphic-editor-unpin-${k}`}
                  style={{ ...iconBtn, color: TOKENS.pin }}
                  aria-label={`Unpin item ${k + 1}; find its word from the text again`}
                  title="Unpin"
                  onClick={() => onUnpin(k)}
                >
                  <Icon d={ICONS.unpin} />
                </button>
              ) : (
                <span />
              )}
              {resizable ? (
                <button
                  data-testid={`graphic-editor-delete-${k}`}
                  style={{ ...iconBtn, ...(list.length <= field.min ? { opacity: 0.35, cursor: "not-allowed" } : {}) }}
                  aria-label={`Delete ${noun} ${k + 1}`}
                  title={list.length <= field.min ? `This graphic needs at least ${field.min} ${label.toLowerCase()}` : `Delete ${noun}`}
                  disabled={list.length <= field.min}
                  onClick={() => onDelete(k)}
                >
                  <Icon d={ICONS.x} />
                </button>
              ) : (
                <span />
              )}
            </div>
            {empty ? (
              <div id={`graphic-editor-need-${k}`} data-testid={`graphic-editor-need-${k}`} style={needText}>
                Needs text
              </div>
            ) : null}
            {row?.note ? (
              <div data-testid={`graphic-editor-row-note-${k}`} style={rowNote}>
                {row.note}
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
      {resizable ? (
        list.length < field.max ? (
          <button data-testid="graphic-editor-add-item" style={addBtn} onClick={onAdd}>
            <Icon d={ICONS.plus} /> Add {noun}
          </button>
        ) : (
          <p style={{ ...muted, margin: "6px 0 6px 30px" }}>
            {field.max} {label.toLowerCase()} is the most this graphic holds.
          </p>
        )
      ) : null}
      {covered && !resizable && placeable
        ? rows.map((row, k) => (
            <React.Fragment key={`kw${k}`}>
              <h2 style={{ ...h2, marginTop: 14 }}>Keyword</h2>
              <div data-testid={`graphic-editor-row-${k}`} style={{ ...rowGrid, ...(picking === k ? rowActive : {}) }}>
                <span style={rowNum}>{k + 1}</span>
                <span style={{ ...fieldInput, color: TOKENS.soft }}>{row.text}</span>
                <LandsBox row={row} k={k} words={words!} empty={false} active={picking === k} onPick={() => onPick(k)} />
                {row.state === "pinned" || row.state === "cut" ? (
                  <button
                    data-testid={`graphic-editor-unpin-${k}`}
                    style={{ ...iconBtn, color: TOKENS.pin }}
                    aria-label={`Unpin item ${k + 1}; find its word from the text again`}
                    title="Unpin"
                    onClick={() => onUnpin(k)}
                  >
                    <Icon d={ICONS.unpin} />
                  </button>
                ) : (
                  <span />
                )}
                <span />
              </div>
            </React.Fragment>
          ))
        : null}
    </>
  );
};

/** The lands-on box (§5): the state, the word, and when it enters; for an
 * unmatched item the reason and the renderer's estimate. No time at all for
 * a row on its component's legacy stagger (`estSec` null). */
const LandsBox: React.FC<{
  row: ModalRow;
  k: number;
  words: readonly Word[];
  empty: boolean;
  active: boolean;
  onPick: () => void;
}> = ({ row, k, words, empty, active, onPick }) => {
  const kind = row.state === "cut" ? "pinned" : row.state === "unmatched" ? "even" : row.state;
  // The word as said, its trailing punctuation off (mockup v3): the quotes
  // already mark it as a word, and "hallucinate,” reads as a typo.
  const word = row.word === null ? null : (words[row.word]?.text.replace(/[.,!?;:…]+$/u, "") ?? null);
  const time = row.estSec === null ? null : `${row.state === "pinned" || row.state === "auto" ? "" : "~"}${clockText(row.estSec)}`;
  const label = empty
    ? `Item ${k + 1} has no text yet`
    : row.state === "unmatched"
      ? `Item ${k + 1} has no word${time === null ? "" : `, comes in at about ${clockText(row.estSec!)}`}. Pick a word`
      : row.state === "cut"
        ? `Item ${k + 1} is pinned to ${word ?? "a word"}, which was cut. Change`
        : `Item ${k + 1} lands on ${word ?? "a word"}, ${STATE_LABEL[row.state]}. Change`;
  return (
    <button
      data-testid={`graphic-editor-lands-${k}`}
      data-pick={k}
      data-state={row.state}
      aria-label={label}
      title={row.note ?? undefined}
      style={{
        ...landsBox,
        ...(kind === "pinned" ? landsPinned : kind === "auto" ? landsAuto : {}),
        ...(active ? landsActive : {}),
      }}
      onClick={onPick}
    >
      <StateBadge kind={kind} />
      {empty ? (
        <span style={landsWhy}>Type the item first</span>
      ) : row.state === "unmatched" ? (
        <span style={landsWhy}>{row.note ?? "No word here"}</span>
      ) : (
        <span style={{ ...landsWord, ...(row.state === "cut" ? { textDecoration: "line-through" } : {}) }}>
          “{word}”
        </span>
      )}
      {time !== null && !empty ? <span style={landsTime}>{time}</span> : null}
    </button>
  );
};

/** One non-list field of the form: a text with its count, a choice, a
 * number. Values stay in the props' own shapes; nothing is trimmed or
 * clamped here, the gate (`saveBlocker`) judges what the author typed. */
const ScalarField: React.FC<{
  field: AddFormField;
  value: unknown;
  onChange: (value: unknown) => void;
}> = ({ field: f, value, onChange }) => {
  const id = useId();
  const testid = `graphic-editor-field-${f.key}`;
  if (f.kind === "list" || f.kind === "messages") return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <h2 style={h2}>
        <label htmlFor={id}>{f.label}</label>
      </h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {f.kind === "text" ? (
          <>
            <input
              id={id}
              data-testid={testid}
              dir="auto"
              aria-describedby={`${id}-count`}
              aria-invalid={(typeof value === "string" ? value : "").trim() === "" || undefined}
              style={fieldInput}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            />
            <span
              id={`${id}-count`}
              style={{
                ...countText,
                ...((typeof value === "string" ? value : "").length > f.max ? { color: TOKENS.danger } : {}),
              }}
            >
              {(typeof value === "string" ? value : "").length}/{f.max}
            </span>
          </>
        ) : f.kind === "choice" ? (
          <select
            id={id}
            data-testid={testid}
            style={fieldInput}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">Choose…</option>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id={id}
              data-testid={testid}
              type="number"
              min={f.min}
              max={f.max}
              step={1}
              aria-describedby={`${id}-range`}
              style={fieldInput}
              value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
              // Empty is unset, not 0; anything else goes to the gate as typed.
              onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
            />
            <span id={`${id}-range`} style={countText}>
              {f.min} to {f.max}
            </span>
          </>
        )}
      </div>
    </div>
  );
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Marker kinds carry the state three ways (mockup v3): icon, fill, colour. */
type MarkKind = "pinned" | "auto" | "even" | "start";

const Marker: React.FC<{ kind: MarkKind; n?: number }> = ({ kind, n }) => (
  <span data-mark={kind} style={{ ...markBase, ...MARK_STYLE[kind] }}>
    {kind === "pinned" ? <Icon d={ICONS.pin} size={11} /> : null}
    {kind === "auto" ? <Icon d={ICONS.auto} size={11} /> : null}
    {kind === "start" ? <Icon d={ICONS.start} size={11} /> : null}
    {n !== undefined ? n : kind === "start" ? "Start" : kind === "even" ? " " : null}
  </span>
);

const StateBadge: React.FC<{ kind: MarkKind }> = ({ kind }) => (
  <span style={{ ...badgeBase, ...BADGE_STYLE[kind] }}>
    {kind === "pinned" ? <Icon d={ICONS.pin} size={12} /> : null}
    {kind === "auto" ? <Icon d={ICONS.auto} size={12} /> : null}
    {kind === "even" ? <Icon d={ICONS.even} size={12} /> : null}
    {kind === "start" ? <Icon d={ICONS.start} size={12} /> : null}
    {{ pinned: "Pinned", auto: "Auto", even: "Even", start: "Start" }[kind]}
  </span>
);

/** The mockup's line icons, one path set each. */
const ICONS = {
  pin: ["M9 3h6l-1 6 4 3v2H6v-2l4-3z", "M12 14v7"],
  unpin: ["M9 3h6l-1 6 4 3v2H6v-2l4-3z", "M12 14v7", "M3 3l18 18"],
  auto: ["M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3z"],
  even: ["M4 12h16", "M8 9v6M16 9v6M12 9v6"],
  start: ["M6 21V4", "M6 4h11l-3 4 3 4H6"],
  x: ["M6 6l12 12M18 6L6 18"],
  plus: ["M12 5v14M5 12h14"],
} as const;

const Icon: React.FC<{ d: readonly string[]; size?: number }> = ({ d, size = 16 }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    aria-hidden="true"
    style={{ flex: "none", stroke: "currentColor", fill: "none", strokeWidth: size < 14 ? 2.2 : 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}
  >
    {d.map((path) => (
      <path key={path} d={path} />
    ))}
  </svg>
);

// ── Styles: the mockup's tokens, which were derived from the editor's own
// (selectionMenuChrome.tsx, storyboardStyles.ts). ──────────────────────────

const DIALOG_FONT = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  background: "rgba(5,5,8,0.72)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const modal: React.CSSProperties = {
  width: "min(1180px, calc(100vw - 32px))",
  height: "min(800px, calc(100vh - 32px))",
  background: TOKENS.panel,
  border: `1px solid ${TOKENS.lineStrong}`,
  borderRadius: 14,
  boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 4px 14px rgba(0,0,0,0.4)",
  display: "grid",
  gridTemplateRows: "auto 1fr auto",
  overflow: "hidden",
  color: TOKENS.text,
  // The editor's dialog face (storyboardStyles' `panel`), not 'Inter': the
  // page registers Inter at 800 and 900 only (core's BUNDLED_FONTS, for the
  // scenes), so on a bundled theme every 'Inter' line of UI text drew in
  // ExtraBold.
  fontFamily: DIALOG_FONT,
  fontSize: 14,
  lineHeight: 1.45,
};

const headerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 14,
  padding: "16px 22px 12px",
  borderBottom: `1px solid ${TOKENS.line}`,
};
const h1: React.CSSProperties = { margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" };
const headerSpan: React.CSSProperties = { color: TOKENS.muted, fontSize: 13 };
const headerTimes: React.CSSProperties = { color: TOKENS.soft, fontFamily: TOKENS.mono, fontWeight: 500 };

const iconBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  display: "grid",
  placeItems: "center",
  background: "transparent",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  borderRadius: 8,
  color: TOKENS.muted,
  cursor: "pointer",
  marginLeft: "auto",
  alignSelf: "center",
  padding: 0,
};

const bodyAdd: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px minmax(220px, 270px) minmax(0, 1fr)",
  minHeight: 0,
};
/** Edit hides the type column (§5): the graphic is already that type. */
const bodyEdit: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 290px) minmax(0, 1fr)",
  minHeight: 0,
};
const refusalBody: React.CSSProperties = { padding: "22px", display: "flex", flexDirection: "column", gap: 10 };
const quote: React.CSSProperties = {
  color: TOKENS.soft,
  fontSize: 13,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const refusalText: React.CSSProperties = { fontSize: 14, color: TOKENS.text, lineHeight: 1.45 };

const typesCol: React.CSSProperties = { borderRight: `1px solid ${TOKENS.line}`, overflow: "auto", padding: 10 };
const colHead: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: TOKENS.muted, margin: "6px 8px 8px" };
const colHeadInline: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: TOKENS.muted };
const typeBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  borderRadius: 9,
  padding: "7px 10px",
  cursor: "pointer",
  color: TOKENS.text,
  fontFamily: "inherit",
};
const typeOn: React.CSSProperties = { background: TOKENS.hover, borderColor: TOKENS.lineStrong };
const typeName: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: 13.5 };
const typeLine: React.CSSProperties = { display: "block", color: TOKENS.muted, fontSize: 12, marginTop: 1 };

const previewCol: React.CSSProperties = {
  borderRight: `1px solid ${TOKENS.line}`,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minHeight: 0,
};
const previewFrame: React.CSSProperties = { width: "100%", borderRadius: 10, overflow: "hidden" };
const previewEmpty: React.CSSProperties = {
  aspectRatio: "9 / 16",
  background: TOKENS.bg,
  border: `1px solid ${TOKENS.line}`,
  display: "grid",
  placeItems: "center",
  color: TOKENS.muted,
  fontSize: 12.5,
  padding: 16,
  textAlign: "center",
};

const workCol: React.CSSProperties = { overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column" };
const stripWrap: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: TOKENS.panel,
  padding: "12px 22px",
  borderBottom: `1px solid ${TOKENS.line}`,
};
const stripHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 26, marginBottom: 6 };
const pickChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 6px 3px 10px",
  borderRadius: 999,
  background: TOKENS.pinSoft,
  fontSize: 12.5,
  fontWeight: 600,
  boxShadow: `inset 0 0 0 1px ${TOKENS.pin}`,
};
const kbd: React.CSSProperties = {
  font: `600 11px ${TOKENS.mono}`,
  padding: "1px 5px",
  borderRadius: 4,
  background: TOKENS.bg,
  color: TOKENS.muted,
};
const strip: React.CSSProperties = {
  background: TOKENS.bg,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: TOKENS.line,
  borderRadius: 10,
  padding: "6px 12px 8px",
  fontSize: 16,
  color: TOKENS.soft,
  maxHeight: "min(232px, 34vh)",
  overflow: "auto",
};
const stripPicking: React.CSSProperties = { borderColor: TOKENS.pin, boxShadow: `0 0 0 3px ${TOKENS.pinSoft}` };
const wordBtn: React.CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  verticalAlign: "top",
  margin: "0 1px 2px",
  padding: "0 2px",
  border: 0,
  borderRadius: 5,
  background: "none",
  cursor: "pointer",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: "inherit",
};
const marksRow: React.CSSProperties = { height: 20, display: "flex", gap: 3, alignItems: "flex-end" };
const wordTxt: React.CSSProperties = {
  position: "relative",
  // Longhands: the start bracket widens the left one alone.
  paddingTop: 1,
  paddingRight: 3,
  paddingBottom: 3,
  paddingLeft: 3,
  borderRadius: 4,
  lineHeight: 1.3,
  borderBottomWidth: 2,
  borderBottomStyle: "solid",
  borderBottomColor: "transparent",
};
const wordPinned: React.CSSProperties = { color: TOKENS.text, borderBottomColor: TOKENS.pin };
const wordAuto: React.CSSProperties = { color: TOKENS.text, borderBottomStyle: "dotted", borderBottomColor: TOKENS.auto };
/** The start bracket on the word's left edge. */
const wordStart: React.CSSProperties = { boxShadow: `inset 3px 0 0 ${TOKENS.accent}`, paddingLeft: 7 };
const wordPickable: React.CSSProperties = { background: "rgba(111,155,255,0.06)" };
const wordCurrent: React.CSSProperties = { boxShadow: `0 0 0 1.5px ${TOKENS.pin}`, background: TOKENS.pinSoft };

const markBase: React.CSSProperties = {
  height: 18,
  padding: "0 5px 0 4px",
  borderRadius: 9,
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  fontWeight: 700,
  fontSize: 11,
  lineHeight: 1,
  boxSizing: "border-box",
};
const MARK_STYLE: Record<MarkKind, React.CSSProperties> = {
  pinned: { background: TOKENS.pin, color: TOKENS.pinInk },
  auto: { color: TOKENS.auto, boxShadow: `inset 0 0 0 1.5px ${TOKENS.auto}` },
  even: { color: TOKENS.even, border: `1.5px dashed ${TOKENS.even}`, padding: "0 5px" },
  start: { background: TOKENS.accent, color: TOKENS.accentInk, borderRadius: 4, padding: "0 5px" },
};
const badgeBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontWeight: 700,
  fontSize: 11,
  lineHeight: 1,
  padding: "3px 6px",
  borderRadius: 6,
  flex: "none",
};
const BADGE_STYLE: Record<MarkKind, React.CSSProperties> = {
  pinned: { color: TOKENS.pinInk, background: TOKENS.pin },
  auto: { color: TOKENS.auto, boxShadow: `inset 0 0 0 1px ${TOKENS.auto}` },
  even: { color: TOKENS.even, border: `1px dashed ${TOKENS.even}` },
  start: { color: TOKENS.accentInk, background: TOKENS.accent },
};
const legend: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px 14px",
  color: TOKENS.muted,
  fontSize: 12.5,
  marginTop: 8,
};
const legendItem: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };

const sectionBox: React.CSSProperties = { padding: "12px 22px 4px" };
const h2: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: TOKENS.muted, margin: "0 0 8px" };
const rowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "22px minmax(140px, 1fr) minmax(190px, 250px) 32px 32px",
  gap: 6,
  alignItems: "center",
  padding: 4,
  margin: "0 0 4px -4px",
  borderRadius: 10,
};
/** The row being picked for, tinted (mockup v3). */
const rowActive: React.CSSProperties = { background: TOKENS.pinSoft };
const rowNum: React.CSSProperties = {
  color: TOKENS.muted,
  font: `600 12px/1 ${TOKENS.mono}`,
  textAlign: "right",
  display: "flex",
  justifyContent: "flex-end",
};
/** Border in longhands, here and on the boxes below: a state overrides one
 * of them (`borderColor` for an empty field), and React warns, and can drop
 * the override on a re-render, when a shorthand and a longhand meet. */
const fieldInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: TOKENS.bg,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: TOKENS.line,
  borderRadius: 8,
  color: TOKENS.text,
  // The dialog face, then the add popover's Urdu and Arabic faces: an item
  // typed in the take's own language reads right.
  fontFamily: `${DIALOG_FONT}, 'Noto Nastaliq Urdu', 'Geeza Pro', 'Noto Naskh Arabic'`,
  fontSize: 14,
  fontWeight: 500,
  padding: "9px 11px",
};
const countText: React.CSSProperties = { fontFamily: TOKENS.mono, fontSize: 12, color: TOKENS.muted, whiteSpace: "nowrap" };
const needText: React.CSSProperties = { color: TOKENS.danger, fontSize: 12, margin: "-2px 0 6px 30px" };
const rowNote: React.CSSProperties = { color: TOKENS.muted, fontSize: 12, margin: "-2px 0 6px 30px" };
const landsBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 38,
  padding: "0 9px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: TOKENS.line,
  borderRadius: 8,
  background: TOKENS.bg,
  color: TOKENS.soft,
  fontSize: 13,
  cursor: "pointer",
  textAlign: "left",
  minWidth: 0,
  fontFamily: "inherit",
};
const landsPinned: React.CSSProperties = { borderColor: "rgba(111,155,255,0.6)" };
const landsAuto: React.CSSProperties = { borderColor: "rgba(196,164,255,0.45)", borderStyle: "dashed" };
const landsStart: React.CSSProperties = { borderColor: "rgba(255,225,77,0.45)" };
const landsActive: React.CSSProperties = {
  borderColor: TOKENS.pin,
  borderStyle: "solid",
  boxShadow: `0 0 0 3px ${TOKENS.pinSoft}`,
};
const landsWord: React.CSSProperties = {
  fontWeight: 600,
  color: TOKENS.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
  fontSize: 13,
};
const landsWhy: React.CSSProperties = { ...landsWord, fontWeight: 500, color: TOKENS.muted };
const landsTime: React.CSSProperties = {
  marginLeft: "auto",
  fontFamily: TOKENS.mono,
  fontSize: 11.5,
  color: TOKENS.muted,
  flex: "none",
};
const addBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: `1px dashed ${TOKENS.lineStrong}`,
  borderRadius: 8,
  color: TOKENS.muted,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  margin: "4px 0 6px 26px",
};

const footerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 22px",
  borderTop: `1px solid ${TOKENS.line}`,
};
const muted: React.CSSProperties = { color: TOKENS.muted, fontSize: 12.5 };
const secondaryBtn: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 9,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: TOKENS.lineStrong,
  background: "transparent",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 14,
  fontFamily: "inherit",
  color: TOKENS.text,
};
const primaryBtn: React.CSSProperties = {
  ...secondaryBtn,
  background: TOKENS.accent,
  color: TOKENS.accentInk,
  borderColor: TOKENS.accent,
  marginLeft: 8,
  fontWeight: 600,
};
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
