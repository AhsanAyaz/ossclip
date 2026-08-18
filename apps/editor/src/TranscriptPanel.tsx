import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import {
  applyCaptionLineTiming,
  captionAnchorOf,
  captionKeyFor,
  lineDirection,
  MIN_CAPTION_SEC,
  NASTALIQ_FONT_NAME,
  NASTALIQ_FONT_REL,
  type CaptionLine,
  type CaptionWord,
} from "@ossclip/core/browser";
import type { useEdits } from "./useEdits";
import { deleteWordsPlanFor, type DeleteWordsPlan } from "./deleteWords";
import { findOccurrences } from "./transcriptSelection";
import { peaksForWindow } from "./waveform";

/** The timing popover's waveform strip, in CSS px — also the canvas bitmap
 * size, so the handle-drag px→seconds conversion needs no rect measure. */
const TIMING_CANVAS_W = 280;
const TIMING_CANVAS_H = 48;
/** Context around the word's own window, so the strip shows what the nudge
 * is reaching toward on either side. */
const TIMING_WIN_PAD_SEC = 1;

/**
 * Lazy singleton loader for the SOURCE audio the waveform strip draws.
 * `/media/audio.wav` exists in every produced workdir (produce stages it for
 * the render), and it is SOURCE-time audio — the popover maps its output-time
 * span onto it via the word's own `srcStart` (see the draw effect). Fetched
 * and decoded ONCE per page, module-level, because every popover open reads
 * the same file. Purely decorative, the `useTakeThumbs` posture
 * (Timeline.tsx): any failure — jsdom's missing AudioContext, a 404 on a
 * hand-built workdir, a codec refusal — resolves null and the popover draws
 * a flat strip; nothing here may throw in a gesture's path.
 */
let sourceAudioPromise: Promise<{ channel: Float32Array; sampleRate: number } | null> | null = null;
const loadSourceAudio = (): Promise<{ channel: Float32Array; sampleRate: number } | null> => {
  if (sourceAudioPromise === null) {
    sourceAudioPromise = (async () => {
      if (typeof AudioContext === "undefined" || typeof fetch === "undefined") return null;
      const res = await fetch("/media/audio.wav");
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(buf);
        // Channel 0 copied out so the whole AudioBuffer can be collected.
        return { channel: decoded.getChannelData(0).slice(), sampleRate: decoded.sampleRate };
      } finally {
        void ctx.close();
      }
    })().catch(() => null);
  }
  return sourceAudioPromise;
};

/** The gap between the anchor word and the floating surface, px. */
const MENU_GAP = 6;
/** How close the surface may sit to either edge of the pane, px. */
const MENU_MARGIN = 8;

/**
 * Where the anchored surface (bar, range editor, timing popover) sits, in the
 * body's CONTENT coordinates — the PURE half of the layout effect that feeds
 * it, split out for the same reason `openCommand` is split from
 * `openInBrowser`: this is the whole placement decision, and jsdom reports
 * all-zero offsets, so the only way to test the clamp and the flip is to hand
 * them numbers directly.
 *
 * Preference is BELOW the anchor. It flips above only when the surface would
 * extend past the body's visible bottom AND there is room above inside the
 * same visible window — a flip that merely trades one overflow for another
 * (a pane shorter than the surface) keeps the below position, where the
 * content at least scrolls into reach.
 */
export const menuPlacement = (m: {
  /** The anchor span's own box, in content coords. For a selection whose
   * endpoints share a visual line this is their UNION. */
  anchorTop: number;
  anchorHeight: number;
  anchorLeft: number;
  anchorWidth: number;
  /** Measured after mount; zero on the first pass, before it exists. */
  menuW: number;
  menuH: number;
  /** The body's visible window, in the same content coords. */
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
}): { top: number; left: number } => {
  const below = m.anchorTop + m.anchorHeight + MENU_GAP;
  const above = m.anchorTop - m.menuH - MENU_GAP;
  const fitsBelow = below + m.menuH <= m.scrollTop + m.clientHeight;
  const top = fitsBelow || above < m.scrollTop ? below : above;
  // Centred on the anchor, then clamped into the pane. `max` LAST on
  // purpose: when the pane is narrower than the surface the clamp's upper
  // bound goes negative, and taking it would push the surface off the left
  // edge — the margin wins instead and the overflow lands on the right,
  // where the buttons that matter are still reachable.
  const wanted = m.anchorLeft + m.anchorWidth / 2 - m.menuW / 2;
  const left = Math.max(MENU_MARGIN, Math.min(wanted, m.clientWidth - m.menuW - MENU_MARGIN));
  return { top, left };
};

/** The prefix every word span's testid carries — also the handle the native
 * selection mapping below walks up to. */
const WORD_TESTID = "transcript-word-";

/**
 * The flat word index a native selection ENDPOINT lands in, or null when the
 * node is not inside a word span. Text nodes carry no `closest`, so a text
 * endpoint (the usual case — a selection's endpoints are offsets into text)
 * resolves through its parent element first.
 */
const wordIndexOfNode = (node: Node | null): number | null => {
  if (node === null) return null;
  const el = node.nodeType === 3 ? node.parentElement : (node as Partial<Element>);
  const span = el?.closest?.(`[data-testid^="${WORD_TESTID}"]`) ?? null;
  if (span === null) return null;
  const index = Number(span.getAttribute("data-testid")!.slice(WORD_TESTID.length));
  return Number.isInteger(index) ? index : null;
};

/**
 * One caption LINE as the timing popover addresses it: its §137 anchor plus
 * its DERIVED (pre-timing) window, which is the space `captionLineTiming`'s
 * deltas are measured in — `liveLines` is the post-range, PRE-hide, PRE-timing
 * stream (App.tsx), so these edges are exactly what core's seam sweep starts
 * from.
 */
export interface TimingLine {
  /** The line's key: its FIRST word's source anchor (`applyCaptionLineTiming`). */
  key: string;
  srcStart: number;
  start: number;
  end: number;
  /** The line's SOURCE extent — the waveform strip is source-time audio, and
   * a caption's output window only lines up with it by the identity-plus-
   * offset a kept span has (the draw effect's caveat). */
  srcEnd: number;
}

/**
 * The output-time window a caption group's drag may target.
 *
 * THE BOUNDS COME FROM THE NEIGHBOURS, NOT FROM THE GROUP'S OWN WINDOW, and
 * that is the whole reason this tool works on a real transcript. Caption lines
 * are a GAP-FREE PARTITION (`captionLineTiming`'s docstring: 116/116
 * inter-line gaps measured exactly 0.0), so bounds taken from the dragged
 * material's own edges collapse to `[span.start, span.end]` — every drag
 * clamps to identity, Apply stores nothing, and the popover is inert. That was
 * the field bug, and its shape in the code was `runDragBounds`, which bounded
 * a WORD run by its own line and its own immediate neighbours.
 *
 * A seam may take time FROM a neighbour — "this caption comes in too late" IS
 * a request for the previous caption's last moments — but it may never cross
 * one, so each neighbour keeps `MIN_CAPTION_SEC` of itself. That floor is
 * `applyCaptionLineTiming`'s own; it is restated here so the DRAG stops where
 * the sweep would rather than snapping back on release.
 *
 * The track's own outer seams are the fallback at either end: a caption must
 * not appear before the first caption of the track or linger past the last
 * (the sweep's non-growing outer bounds).
 */
export const captionDragBounds = (m: {
  /** The caption line BEFORE the group; null when the group opens the track. */
  prev: { start: number } | null;
  /** The caption line AFTER the group; null when the group closes it. */
  next: { end: number } | null;
  /** The track's first and last seam. */
  track: { start: number; end: number };
}): { lo: number; hi: number } => ({
  lo: m.prev === null ? m.track.start : m.prev.start + MIN_CAPTION_SEC,
  hi: m.next === null ? m.track.end : m.next.end - MIN_CAPTION_SEC,
});

/** A span forced inside `[lo, hi]`, end never before start. Used for the SEED
 * (reopening over stored deltas — a hand-edited doc can hold anything) so the
 * popover can never open on a span its own drag would refuse to reach. */
export const clampCaptionSpan = (
  span: { start: number; end: number },
  lo: number,
  hi: number,
): { start: number; end: number } => {
  const start = Math.min(Math.max(span.start, lo), hi);
  return { start, end: Math.min(Math.max(span.end, start), hi) };
};

/**
 * Where a drag target lands: the span captured at pointerdown moved by
 * `dSec`, clamped into the neighbours' window (`captionDragBounds`). Pure —
 * the drag is one arithmetic decision the window listener merely feeds pixels
 * to, the openCommand/openInBrowser split the popover already follows.
 *
 * Unchanged from the per-word era except its name (the band rigidity and the
 * no-invert rule were always right; only what BOUNDS it moved to the caption
 * neighbours). The BAND is the reason this is not three inline expressions: a
 * pan must stay RIGID. Clamping its two edges independently would let one hit
 * a bound while the other kept moving — a pan that silently SQUASHES the
 * group, which is the stretch gesture the user did not ask for. So the DELTA
 * is reduced until both edges fit, and the span keeps its width.
 *
 * The handles clamp against the opposite edge as well as the window, so a
 * drag can collapse the span to zero width but never INVERT it: a negative
 * ratio in `captionTimingEntries` would mirror the group's caption order, and
 * a collapsed span is pushed back apart by `applyCaptionLineTiming`'s
 * `MIN_CAPTION_SEC` sweep — which the preview runs, so the user sees it.
 */
export const dragCaptionSpan = (m: {
  edge: "lead" | "tail" | "band";
  /** The `newSpan` as it stood when the pointer went down. */
  span: { start: number; end: number };
  dSec: number;
  lo: number;
  hi: number;
}): { start: number; end: number } => {
  if (m.edge === "band") {
    const d = Math.min(Math.max(m.dSec, m.lo - m.span.start), m.hi - m.span.end);
    return { start: m.span.start + d, end: m.span.end + d };
  }
  if (m.edge === "lead") {
    return {
      start: Math.min(Math.max(m.span.start + m.dSec, m.lo), Math.min(m.hi, m.span.end)),
      end: m.span.end,
    };
  }
  return {
    start: m.span.start,
    end: Math.max(Math.min(m.span.end + m.dSec, m.hi), Math.max(m.lo, m.span.start)),
  };
};

/**
 * The `captionLineTiming` entries a drag implies — ONE pure decision the
 * preview, the readout and Apply all read (the openCommand/openInBrowser
 * split), so what is drawn is exactly what is stored.
 *
 * The group's seams are mapped PROPORTIONALLY from `span` onto `newSpan`: a
 * rigid band pan (ratio 1) shifts every seam by the same delta, and a handle
 * stretch scales the interior seams with it, which is what keeps a multi-
 * caption group's rhythm when its window grows. The interior entries are
 * WRITTEN rather than left to ride along, because the preview runs the real
 * apply pass and an unwritten interior seam would sit still while the outer
 * two moved — the group would visibly bunch up against one edge.
 *
 * THE TOUCHED NEIGHBOUR IS WRITTEN TOO. Caption lines partition the timeline,
 * so the group's opening seam IS the previous caption's closing seam
 * (`applyCaptionLineTiming`: one edit, two windows). Recording only the
 * group's side leaves the doc saying the previous caption still ends where it
 * used to — core resolves that in the group's favour ("the later line's lead
 * wins"), but a popover reopened on the NEIGHBOUR would then seed from a
 * stale `tail` and snap the seam back. Its own far-side delta (`prev.lead`,
 * `next.tail`) is carried through untouched: this gesture has nothing to say
 * about it, and a zero there would drag a neighbour's own earlier nudge back
 * to base. A neighbour that ends up with two sub-ms deltas is DELETED by the
 * reducer, which is the correct record of "this seam is where it was derived".
 */
export const captionTimingEntries = (m: {
  /** The dragged caption lines, in order. */
  lines: ReadonlyArray<{ srcStart: number; start: number; end: number }>;
  /** The group's DERIVED window — what the deltas are measured against. */
  span: { start: number; end: number };
  /** The drag target. */
  newSpan: { start: number; end: number };
  /** The caption before the group, with its own stored OPENING delta. */
  prev: { srcStart: number; end: number; lead: number } | null;
  /** The caption after it, with its own stored CLOSING delta. */
  next: { srcStart: number; start: number; tail: number } | null;
}): Array<{ srcStart: number; lead: number; tail: number }> => {
  const width = m.span.end - m.span.start;
  // A degenerate derived window (a hide that collapsed a line, a hand-edited
  // doc) has no ratio to scale by, and `0/0` would store NaN deltas — the
  // group moves RIGIDLY with its opening seam instead (`scaleWordsIntoWindow`
  // takes the same identity escape for the same reason).
  const ratio = width > 0 ? (m.newSpan.end - m.newSpan.start) / width : 1;
  const at = (t: number): number => m.newSpan.start + (t - m.span.start) * ratio;
  const out = m.lines.map((l) => ({
    srcStart: l.srcStart,
    lead: at(l.start) - l.start,
    tail: at(l.end) - l.end,
  }));
  if (m.prev !== null) {
    out.unshift({
      srcStart: m.prev.srcStart,
      lead: m.prev.lead,
      tail: m.newSpan.start - m.prev.end,
    });
  }
  if (m.next !== null) {
    out.push({ srcStart: m.next.srcStart, lead: m.newSpan.end - m.next.start, tail: m.next.tail });
  }
  return out;
};

/**
 * One line of a captured track as the popover addresses it, or null when it
 * carries no §137 anchor to key on (a pre-§137 workdir) — `captionAnchorOf`'s
 * DATA verdict, never a throw: this runs inside a memo with no error boundary
 * above it.
 */
export const timingLineAt = (lines: readonly CaptionLine[], i: number): TimingLine | null => {
  const line = lines[i];
  const first = line?.words[0];
  const key = captionAnchorOf(first);
  if (!line || !first || key === null) return null;
  const last = line.words[line.words.length - 1]!;
  return {
    key,
    srcStart: first.srcStart,
    start: line.start,
    end: line.end,
    // The last word's own source extent when it has one; a minted word (a
    // range rewrite interpolates `srcStart`, and `captionAnchorOf` only
    // vouches for the FIRST word) falls back to the line's output duration,
    // which is the right order of magnitude for a decorative strip.
    srcEnd: Number.isFinite(last.srcStart)
      ? last.srcStart + (last.end - last.start)
      : first.srcStart + (line.end - line.start),
  };
};

/**
 * The transcript view (R15 §59): every caption word in one scrollable,
 * searchable list — find a word, fix it, jump the preview to it.
 *
 * Deliberately thin, because the hard half already exists: edits write
 * through `OverrideDoc.captions` (the R11 retype layer), which the live memo
 * merges into the preview and `produce` applies on re-render. The scope is
 * the layer's own contract — 1:1 retype, stated in the header: cues anchor
 * to word INDICES and word timings drive the kinetic highlight, so
 * inserting, splitting or merging words is a re-timing project, not a text
 * box (§59b). DELETION is the one part of §59b since revisited (2026-08-18):
 * words can be hidden from the CAPTIONS via `OverrideDoc.captionWordsHidden`
 * — non-destructive and restorable, applied after retypes by
 * `applyCaptionLayers`, never touching the transcript, the timing, or the
 * audio — so the anchors §59b protects stay intact. Cutting the VIDEO from
 * the transcript rides the EXISTING cuts machinery, not a new one (§59c's
 * refusal was about inventing a second EDL): Delete builds a
 * `deleteWordsPlanFor` plan and App's modal offers captions-only (the hide
 * above) or captions + video (`cutWords` — a `doc.cuts` entry, applied on
 * the next produce like every other cut). RANGE EDITS (2026-08-18) are the
 * one deliberate relaxation of §59b's 1:1 rule: a multi-word selection's
 * Edit button rewrites the run as free text (word count may change) via
 * `OverrideDoc.captionRangeEdits` — the re-timing §59b called a project
 * lives in core (`applyCaptionRangeEdits`), on the derived lines only, so
 * `transcript.words` and the scene anchors into it stay untouched.
 */
export const TranscriptPanel: React.FC<{
  /** Pristine pre-edit lines — the truth the retype guard compares against. */
  baseLines: CaptionLine[];
  /** The live merged lines — what the preview shows, edits included. */
  liveLines: CaptionLine[];
  fps: number;
  playerRef: React.RefObject<PlayerRef | null>;
  edits: ReturnType<typeof useEdits>;
  /** Deleting a selection hands App a PLAN, and App owns the modal — the
   * same split as the scene delete (App holds `deletePlan`, this panel only
   * computes what is on the table). Never called with a null plan: a confirm
   * dialog with nothing to offer is worse than the keypress doing nothing
   * (`deletePlanFor`'s rule). */
  onDeleteWords: (plan: DeleteWordsPlan) => void;
  /** Pane width in px — owned by App, dragged via the divider (R16 §65). */
  width: number;
}> = ({ baseLines, liveLines, fps, playerRef, edits, onDeleteWords, width }) => {
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
  /**
   * Multi-word selection over the flat word indices (§59b, revisited
   * 2026-08-18) — always contiguous: `[min(anchor, focus), max(anchor,
   * focus)]` inclusive. The range is in LOGICAL (spoken) order on purpose:
   * per-word bidi isolation (the `word` style below) makes logical order
   * visually coherent per wrapped line, so a logical range reads as the
   * contiguous run the eye sees — a visual-order range would need the
   * browser's bidi resolution re-implemented here to mean anything.
   * Positional like `editing.index`, with the same staleness caveat the
   * `editing` comment above records — the effect below clears it whenever
   * the word count changes rather than letting it drift onto other words.
   */
  const [sel, setSel] = useState<{ anchor: number; focus: number } | null>(null);
  /**
   * The open RANGE editor (free-text rewrite, 2026-08-18). Everything the
   * commit needs is CAPTURED at open, the `editing` rule above: the endpoint
   * anchors were validated at the gesture (the Edit button refuses an
   * anchorless selection), and a completed render swapping `liveLines`
   * mid-edit cannot shift them under the open box. `was` is the NFC-joined
   * BASE texts of the run — the whole-run stale guard `patchCaptionRange`
   * stores compares against the base run at apply time (the reducer scrubs
   * every per-word retype inside the interval in the same commit), so a
   * live-joined `was` would stale it permanently.
   */
  const [rangeEditing, setRangeEditing] = useState<{
    draft: string;
    fromSrcStart: number;
    toSrcStart: number;
    was: string;
    /** True when the box was opened over an EXISTING range entry — the
     * commit must then stay a range edit even for a one-token draft, or a
     * `patchCaption` would write a per-word retype inside the live entry's
     * interval (the exact interleaving `openRetype`'s coverage refusal
     * exists to prevent). */
    covered: boolean;
    /** The selection this capture belongs to (2026-08-18 round 3). The
     * editor is ANCHORED to the selection, so a selection that moves while
     * the box is open would re-render it at the NEW words with this stale
     * capture — Apply then rewrites the PREVIOUS run while visually
     * pointing at the new one (the field bug). The click handlers close it
     * explicitly; the effect below is the belt-and-braces sweep for any
     * path they miss. */
    selLo: number;
    selHi: number;
  } | null>(null);
  /**
   * The open TIMING popover (2026-08-18 round 4; CAPTION-shaped since the
   * `captionLineTiming` rewrite) — the "when does this caption appear, and
   * when does it leave" adjuster.
   *
   * IT OPERATES ON CAPTIONS, NOT WORDS, and the selection is SNAPPED to the
   * caption lines its words sit in (`openTiming`). Two measured facts force
   * that: a caption's on-screen life IS `line.start`/`line.end` (one
   * `<Sequence>` per line, CaptionTrack.tsx:387 — word stamps only drive the
   * karaoke highlight inside that window), and the caption stream is a
   * gap-free partition, against which the old per-word clamp was
   * mathematically inert (see `captionLineTiming`'s docstring for the
   * measurements).
   *
   * Everything the apply needs is CAPTURED at open, the `rangeEditing` rule:
   * `track` is the whole line array as it stood at the gesture — the preview
   * runs core's REAL apply pass over it — so a completed render swapping
   * `liveLines` mid-drag cannot shift the group, its neighbours or its bounds
   * under the open popover.
   *
   * `span` is the group's DERIVED window (first line's start, last line's
   * end); `newSpan` is the LIVE drag target, seeded from the doc's existing
   * entries so reopening resumes where the last Apply left off, and always
   * kept inside `bounds` — which come from the NEIGHBOURS
   * (`captionDragBounds`), not from the group's own edges.
   */
  const [timing, setTiming] = useState<{
    /** The caption track as captured at the open. */
    track: CaptionLine[];
    /** The group: `track` indices, first and last INCLUSIVE. */
    from: number;
    to: number;
    span: { start: number; end: number };
    newSpan: { start: number; end: number };
    bounds: { lo: number; hi: number };
  } | null>(null);
  /** True between the popover's Play and whatever pauses it — the span-end
   * frameupdate watcher below, the Pause toggle, or the popover closing. */
  const [timingPlaying, setTimingPlaying] = useState(false);
  const timingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * The live handle drag — STATE, not the ref it used to be (field report
   * 2026-08-18 round 5: "dragged and left the mouse button and it was still
   * dragging"). A ref survives every close path silently, so a popover
   * closed mid-drag left `{startX}` behind and the next BARE HOVER over a
   * reopened handle jumped it by `clientX − staleStartX`. As state it is
   * cleared by the close-path effect below like every other popover
   * concern, it cannot be resurrected, and the handle can render an active
   * style from it. The per-move re-render the ref was avoiding is one
   * `setTiming` the drag already caused anyway.
   */
  const [timingDrag, setTimingDrag] = useState<{
    /** Which target took the pointer: either handle, or the BAND between
     * them (a rigid pan of both edges — `dragRunSpan`). */
    edge: "lead" | "tail" | "band";
    startX: number;
    /** `newSpan` as it stood at pointerdown — the drag is always measured
     * from there, never accumulated per move. */
    span: { start: number; end: number };
  } | null>(null);
  /** The decoded source audio, null until the singleton loader resolves —
   * and null forever when it can't (the flat-strip fallback). */
  const [audio, setAudio] = useState<{ channel: Float32Array; sampleRate: number } | null>(null);
  // The word under the playhead, so reading follows playback. Index only —
  // recomputed on frameupdate but committed to state solely when it changes,
  // or the panel would re-render at the frame rate.
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  /** The full help text, collapsed behind the `?` toggle (2026-08-18): the
   * old always-on paragraph cost four lines of pane height to restate a
   * contract most sessions already know. */
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * Where the selection bar (and the edit popover that replaces it) sits —
   * CONTENT coordinates of the selection's LAST word span (offsetTop/Left
   * against the body, which is `position: relative`), captured per
   * selection change by the layout effect below. Content coords, not a
   * viewport rect (2026-08-18 round 3): the bar renders INSIDE the
   * scrollable body and scrolls WITH its anchor, so no scroll/resize close
   * listener is needed — the old fixed-position menu was killed within a
   * frame of appearing whenever the playhead-follow `scrollIntoView` above
   * fired the body's scroll event. Stored pre-clamped to the pane so the
   * render path has no coordinate math.
   */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  /** The Delete ▾ flyout under the bar — closed on selection change (the
   * effect below), Escape (which clears the selection) and either action. */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Whichever of the three anchored surfaces is currently mounted — the bar,
   * the range editor or the timing popover. They share one anchor and one
   * `menuPos`, so they share the ref the layout effect measures. */
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The base texts each ANCHOR carries, IN ORDER — positional pairing broke
  // the moment range edits landed: a rewritten run can hold a different word
  // COUNT than the base line (and can even drop a line entirely), so
  // `base.words[wi]` past the run would pair every later word with the wrong
  // neighbour's base — mis-titling and mis-styling words the user never
  // touched. Keyed by the word's own §137 anchor instead — and a LIST per
  // anchor, not first-claimant-wins: `backfillSrcStart` MANUFACTURES shared
  // source instants (captions.ts:44-50 — a seam's two preimages, a word
  // clamped to a kept edge), so two DIFFERENT base words can carry one
  // anchor, and a single-text map paired the second live claimant with the
  // FIRST's base text: wrong edited styling and a wrong `was` capture. The
  // flatten below consumes occurrences by ordinal instead — the k-th live
  // claimant of an anchor pairs with the k-th base text.
  const baseByAnchor = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const line of baseLines) {
      for (const w of line.words) {
        const anchor = captionAnchorOf(w);
        if (anchor === null) continue;
        const list = map.get(anchor);
        if (list) list.push(w.text);
        else map.set(anchor, [w.text]);
      }
    }
    return map;
  }, [baseLines]);

  // Flatten once per lines change: global word index → texts + timing.
  const words = useMemo(() => {
    const out: Array<{
      index: number;
      base: string;
      live: string;
      /** No base word OCCURRENCE is left at this word's anchor (by ordinal —
       * see `baseByAnchor`): the word was MINTED by a range rewrite (its
       * srcStart is synthetic, interpolated between the run's endpoints).
       * Styled as edited; its title names the run's `was`. */
      synthetic: boolean;
      start: number;
      end: number;
      /** Which CAPTION LINE of `liveLines` this word belongs to. Timing is a
       * per-line record now (`captionLineTiming`), so both the popover's
       * snap-to-captions and the per-word nudge marker need the word's line,
       * and re-deriving it by scanning would be a second definition of
       * "which caption is this word in". */
      lineIndex: number;
      /** The live word itself, carried so a retype can key on its SOURCE
       * time (§137). The panel's own `index` is a scroll/testid handle and
       * nothing more — anchoring an edit to it is the bug this replaced. */
      word: CaptionWord;
    }> = [];
    let index = 0;
    // Per-anchor ordinal cursor — see `baseByAnchor` above: duplicate anchors
    // are real (manufactured, captions.ts:44-50), so the k-th live claimant
    // takes the k-th base text, and running past the list means the word was
    // minted (count changed) — `undefined`, the synthetic flag.
    const claimed = new Map<string, number>();
    for (let li = 0; li < liveLines.length; li++) {
      const live = liveLines[li]!;
      for (let wi = 0; wi < live.words.length; wi++) {
        const w = live.words[wi]!;
        const anchor = captionAnchorOf(w);
        let baseText: string | undefined;
        if (anchor !== null) {
          const k = claimed.get(anchor) ?? 0;
          claimed.set(anchor, k + 1);
          baseText = baseByAnchor.get(anchor)?.[k];
        }
        out.push({
          index: index,
          // Base text falls back to the live text for old workdirs whose
          // words carry no anchor to look up — the reducer's
          // `captionEditWas` keeps re-edits safe either way — and for
          // synthetic minted words, which have no base word at all.
          base: baseText ?? w.text,
          live: w.text,
          synthetic: anchor !== null && baseText === undefined,
          start: w.start,
          end: w.end,
          lineIndex: li,
          word: w,
        });
        index++;
      }
    }
    return out;
  }, [baseByAnchor, liveLines]);

  // Selection indices are positional — the `editing.index` staleness caveat
  // documented at the top of this file, for the same reason: a completed
  // render can swap `liveLines` and a changed word COUNT would leave the
  // range highlighting (or hiding, via Delete) different words than the
  // user selected. Cleared rather than remapped: no anchor survives here to
  // remap through.
  useEffect(() => {
    setSel(null);
    // The anchored popover goes with it (the Escape branch's rule below):
    // without a selection it has no anchor, and an invisible open editor
    // would resurface, stale draft and all, at the next selection.
    setRangeEditing(null);
  }, [words.length]);

  // The hide layer's keys, derived from the doc each render so undo/redo and
  // Restore all reflect immediately. A word is hidden when its own anchor is
  // in the set — the same `captionAnchorOf` verdict every other caption
  // surface keys on (§137).
  const hiddenKeys = useMemo(
    () => new Set(Object.keys(edits.doc.captionWordsHidden)),
    [edits.doc.captionWordsHidden],
  );
  const isHidden = (w: (typeof words)[number]): boolean => {
    const anchor = captionAnchorOf(w.word);
    return anchor !== null && hiddenKeys.has(anchor);
  };

  // Panel-level bidi base, the same first-strong resolution `CaptionTrack`
  // applies per line — at panel granularity, because the transcript is ONE
  // flowing paragraph. Without a bidi base, an Urdu transcript sat in an LTR
  // paragraph: UAX #9 visually reordered each wrapped line's RTL run while
  // DOM order stayed spoken order, so the span under the cursor was not the
  // word the eye targeted — some words were simply unclickable. A
  // code-switched transcript resolves from its leading strong character,
  // exactly like a code-switched caption line.
  const panelDir = useMemo(() => lineDirection(words.map((w) => w.live).join(" ")), [words]);

  // Register the bundled Nastaliq face for RTL transcripts. `produce` stages
  // it into the workdir for any caption set with RTL lines and the edit
  // server serves the workdir under /media/, so by the time an RTL transcript
  // exists the URL resolves; a 404 (hand-built workdir) just leaves the
  // system fallback stack in place — same wrong-font-beats-no-captions call
  // as the render's NastaliqFontLoader, minus delayRender, which only exists
  // for Remotion's seek-and-screenshot renders. Guarded so jsdom (no
  // FontFace/document.fonts) never throws.
  useEffect(() => {
    if (panelDir !== "rtl") return;
    if (typeof FontFace === "undefined" || !document.fonts) return;
    let registered = false;
    for (const face of document.fonts) {
      if (face.family === NASTALIQ_FONT_NAME) registered = true;
    }
    if (registered) return;
    try {
      const face = new FontFace(
        NASTALIQ_FONT_NAME,
        `url("/media/${NASTALIQ_FONT_REL}") format("truetype")`,
      );
      face.load().then(
        (loaded) => document.fonts.add(loaded),
        () => {},
      );
    } catch {
      // Fall back silently — see above.
    }
  }, [panelDir]);

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

  // NFC on both sides before lowercasing: Arabic text arrives in composed OR
  // decomposed form (آ U+0622 vs ا+ٓ U+0627 U+0653 is the same glyph), and a
  // byte-wise `includes` across the two silently finds nothing.
  const q = query.trim().normalize("NFC").toLowerCase();
  const matchList = useMemo(
    () =>
      q
        ? words.filter((w) => w.live.normalize("NFC").toLowerCase().includes(q)).map((w) => w.index)
        : [],
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
    // A word covered by a LIVE range rewrite refuses the 1:1 retype too —
    // neither outcome of committing one is the edit the user meant. Equal
    // count: the retype changes the run's live text, so the range entry's
    // whole-run `was` guard stales and the ENTIRE rewrite drops. Count
    // changed: the retype keys to a minted anchor, and the edits layer runs
    // BEFORE ranges (`applyCaptionLayers`), so no word ever carries that
    // anchor when it looks — the edit never applies. The gesture for a
    // covered word is the range editor; its title says so.
    if (coveringRangeEntry(w.word) !== undefined) return;
    setEditing({ index: w.index, draft: w.live, srcStart: w.word.srcStart, base: w.base });
  };

  // The LIVE range entry COVERING a word, if any. Coverage is by interval —
  // the word's anchor ms inside the entry's `[fromMs, toMs]` — because that
  // is the one test that catches every word of a rewritten run: verbatim
  // endpoint anchors sit ON the interval's edges, and minted anchors were
  // interpolated strictly inside it by construction. One helper feeds the
  // title, the retype refusal (a covered word cannot carry a per-word edit)
  // and the Edit expansion (a covered selection re-edits the ENTRY's run).
  const coveringRangeEntry = (
    w: CaptionWord,
  ): (typeof edits.doc.captionRangeEdits)[number] | undefined => {
    const anchor = captionAnchorOf(w);
    if (anchor === null) return undefined;
    const ms = Number(anchor.slice(1));
    return edits.doc.captionRangeEdits.find((e) => {
      const lo = Number(e.fromKey.slice(1));
      const hi = Number(e.toKey.slice(1));
      return ms >= Math.min(lo, hi) && ms <= Math.max(lo, hi);
    });
  };

  const selLo = sel === null ? null : Math.min(sel.anchor, sel.focus);
  const selHi = sel === null ? null : Math.max(sel.anchor, sel.focus);
  const selected = selLo === null || selHi === null ? [] : words.slice(selLo, selHi + 1);
  // Restore is offered only when EVERY selected word is hidden — a mixed
  // selection reads as "hide the rest", which is what the hide action does.
  const allSelectedHidden = selected.length > 0 && selected.every(isHidden);
  // The same §137 verdict as `openRetype`: a word with no source anchor
  // cannot carry a hide, and the refusal belongs at the gesture — disabled
  // with a reason, not a hide that silently skips a word mid-selection.
  const anySelectedAnchorless = selected.some((w) => captionAnchorOf(w.word) === null);
  // The live rewrite the selection touches, if any — one value so the
  // toolbar's Edit title and the gesture itself (`openRangeEdit`'s
  // expansion) can never disagree about which run a commit will replace.
  const selectionRangeEntry = selected
    .map((w) => coveringRangeEntry(w.word))
    .find((e) => e !== undefined);

  /**
   * Drag-select across words with the mouse, the way every other text surface
   * on the machine works (2026-08-18 round 5) — shift-click stays, but nobody
   * reaches for it first. The browser does the hard half: it already resolved
   * the drag to a Range through the bidi-reordered layout, so mapping its two
   * ENDPOINTS to word spans gives the run the eye swept without this file
   * re-implementing UAX #9 (the `sel` comment's rule — the range is stored in
   * LOGICAL order, and per-word bidi isolation is what keeps that the run the
   * eye saw).
   *
   * The native highlight is then DROPPED (`removeAllRanges`) so exactly one
   * selection is on screen: the panel's yellow band, which is the thing every
   * gesture below acts on. Leaving both would show two ranges disagreeing at
   * the edges (the band snaps to whole words; the native range does not).
   */
  const onBodyMouseUp = (e: React.MouseEvent<HTMLDivElement>): void => {
    // An open box owns the pointer: a drag inside the retype input or the
    // range editor's textarea is the user selecting TEXT TO RETYPE, and
    // re-selecting words underneath it would close the very box being typed
    // into (the `rangeEditing.selLo` sweep).
    if (editing !== null || rangeEditing !== null || timing !== null) return;
    const bodyEl = bodyRef.current;
    if (!bodyEl) return;
    // Optional-chained end to end: jsdom's Document may expose no
    // `getSelection` at all, and what it returns lacks `removeAllRanges` in
    // older versions — a selection helper must never throw in a gesture's
    // path (the `scrollIntoView` posture above).
    const selection = document.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    const { anchorNode, focusNode } = selection;
    // Both endpoints must resolve inside THIS body — a selection that started
    // in the header or another pane says nothing about which words to mark.
    if (!anchorNode || !focusNode) return;
    if (!bodyEl.contains(anchorNode) || !bodyEl.contains(focusNode)) return;
    // Belt-and-braces behind the state guard above: any future text control
    // rendered inside the body keeps its own native selection.
    const focusEl = focusNode.nodeType === 3 ? focusNode.parentElement : (focusNode as Element);
    if (focusEl?.closest?.("input, textarea")) return;
    const from = wordIndexOfNode(anchorNode);
    const to = wordIndexOfNode(focusNode);
    if (from === null || to === null) return;
    // The browser's own double-click word-select, which lands both endpoints
    // in ONE span: consuming it here would clear the native highlight and
    // steal the gesture from `onDoubleClick`'s retype box.
    if (e.detail >= 2 && from === to) return;
    setSel({ anchor: Math.min(from, to), focus: Math.max(from, to) });
    selection.removeAllRanges?.();
  };

  // Capture the bar's anchor when the selection changes — a LAYOUT effect so
  // the read happens before paint (no one-frame flash at a stale position).
  // Content coords via offsetTop/offsetLeft, whose offsetParent is the body
  // itself now that it is `position: relative` — the bar scrolls WITH the
  // words, which is what RETIRED the old close-on-scroll/resize listeners
  // (2026-08-18 round 3): those existed because a frozen viewport rect
  // drifts on scroll, and the playhead-follow `scrollIntoView` above fires
  // the body's scroll event whenever the followed word left the pane — the
  // menu was destroyed within a frame of appearing. The remaining close
  // paths are Escape, the selection clearing, a word-count change, and the
  // gestures themselves. Everything is optional-chained: jsdom reports
  // all-zero offsets, which clamp to a fine in-pane position — tests mock
  // the offsets they assert on. `width` is a dep because a divider drag
  // reflows the wrap under the anchor word; `rangeEditing`/`timing` are deps
  // because those two surfaces REPLACE the bar at this anchor and are much
  // taller — without a re-measure they inherited the bar's placement and
  // hung off the bottom of the pane.
  //
  // Two passes by construction (2026-08-18 round 5, replacing the EST_W
  // guess): pass one has no mounted surface to measure, so it places on a
  // zero-size box; the state change mounts it and `menuPos` — itself a dep —
  // re-runs the effect with a real `offsetWidth/offsetHeight`. Both passes
  // are layout effects, so both land before paint; the functional update
  // returns the PREVIOUS object when nothing moved, which is what lets React
  // bail out instead of looping.
  useLayoutEffect(() => {
    if (selLo === null || selHi === null) {
      setMenuPos(null);
      return;
    }
    const bodyEl = bodyRef.current;
    const loSpan =
      bodyEl?.querySelector<HTMLElement>(`[data-testid="transcript-word-${selLo}"]`) ?? null;
    const hiSpan =
      bodyEl?.querySelector<HTMLElement>(`[data-testid="transcript-word-${selHi}"]`) ?? null;
    if (!bodyEl || hiSpan === null) {
      setMenuPos(null);
      return;
    }
    // Anchor to the two ENDPOINT spans' union when they share a visual line,
    // so the bar centres on the band the eye sees. Across a wrap their union
    // spans the whole pane and its centre means nothing, so the LAST word
    // wins — it is where the gesture ended and where the eye is. Offset
    // coords are RTL-agnostic (the span is already where the bidi algorithm
    // put it), which is also why the union is min/max of both edges rather
    // than "first" and "last".
    const sameLine = loSpan !== null && loSpan.offsetTop === hiSpan.offsetTop;
    const left = sameLine ? Math.min(loSpan.offsetLeft, hiSpan.offsetLeft) : hiSpan.offsetLeft;
    const right = sameLine
      ? Math.max(loSpan.offsetLeft + loSpan.offsetWidth, hiSpan.offsetLeft + hiSpan.offsetWidth)
      : hiSpan.offsetLeft + hiSpan.offsetWidth;
    const menuEl = menuRef.current;
    const next = menuPlacement({
      anchorTop: hiSpan.offsetTop,
      anchorHeight: hiSpan.offsetHeight,
      anchorLeft: left,
      anchorWidth: right - left,
      menuW: menuEl?.offsetWidth ?? 0,
      menuH: menuEl?.offsetHeight ?? 0,
      scrollTop: bodyEl.scrollTop,
      clientWidth: bodyEl.clientWidth,
      clientHeight: bodyEl.clientHeight,
    });
    setMenuPos((prev) =>
      prev !== null && prev.top === next.top && prev.left === next.left ? prev : next,
    );
  }, [selLo, selHi, width, rangeEditing, timing, menuPos]);

  // The Delete ▾ flyout never outlives the selection it was opened for — a
  // flyout that survived a selection change would offer its rows for words
  // the user is no longer looking at. The timing popover closes on the same
  // sweep and for the same reason: it is anchored to the selection, and its
  // capture describes the word that WAS selected — a selection that moved
  // (including the null a word-count change forces via the `sel` effect
  // above) must drop it rather than let Apply nudge the previous word.
  useEffect(() => {
    setDeleteOpen(false);
    setTiming(null);
  }, [selLo, selHi]);

  // Belt-and-braces behind the word click handlers' explicit close (the
  // `rangeEditing.selLo/selHi` comment above): if the selection moved by ANY
  // path while the editor is open, the capture no longer describes what is
  // on screen — drop it rather than let Apply rewrite the previous run.
  useEffect(() => {
    if (rangeEditing === null) return;
    if (selLo !== rangeEditing.selLo || selHi !== rangeEditing.selHi) setRangeEditing(null);
  }, [rangeEditing, selLo, selHi]);

  // "Apply to all (n)" candidates, recomputed while the popover is open so
  // the count tracks the doc (an occurrence just rewritten by another entry
  // stops being offered). The search itself is pure — transcriptSelection.ts
  // owns the window sweep and its exclusion rules.
  const occurrences = useMemo(
    () =>
      rangeEditing !== null && selLo !== null && selHi !== null
        ? findOccurrences(words, selLo, selHi, coveringRangeEntry)
        : [],
    // coveringRangeEntry is remade per render; its only input that matters
    // here is the doc's range entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeEditing, selLo, selHi, words, edits.doc.captionRangeEdits],
  );

  const requestDelete = (): void => {
    // The §137 refusal stays at the gesture, unchanged from the old direct
    // hide: a selection with an anchorless word is refused whole (disabled
    // with a reason below), never a delete that silently skips part of it.
    if (selected.length === 0 || anySelectedAnchorless) return;
    const plan = deleteWordsPlanFor(
      // `synthetic` rides along so the plan can withhold the video cut: a
      // minted word's stamps are interpolations, not measured ASR boundaries
      // (`deleteWordsPlanFor` has the full why).
      selected.map((w) => ({ word: w.word, live: w.live, synthetic: w.synthetic })),
      // The flat word BEFORE the selection — its output end is the near cut
      // edge `deleteWordsPlanFor` clamps to; null when the selection starts
      // the transcript.
      selLo !== null && selLo > 0 ? words[selLo - 1]!.end : null,
      edits.doc,
    );
    // null = nothing left to offer — no empty dialog (`deletePlanFor`).
    if (plan === null) return;
    onDeleteWords(plan);
    // Cleared at the gesture, like the direct hide before it, not on the
    // modal's confirm: the plan already captures everything the confirm
    // needs, and a selection left live under the modal is the same
    // positional-staleness liability the `sel` comment documents — a
    // completed render swapping `liveLines` would clear it mid-dialog
    // anyway. A cancelled modal costs a re-select, which is cheap.
    setSel(null);
  };

  /**
   * Open the free-text range editor — for ANY selection size. A single word
   * opens it too, because splitting a whisper-merged word ("ہوں۔اس") needs a
   * count-changing edit the 1:1 retype box refuses by contract; a one-token
   * commit on one word still routes back to `patchCaption` (`commitRange`),
   * so the stricter path survives untouched. The §137 refusal stays at the
   * gesture, like `openRetype`/`requestDelete`: an anchorless selection is
   * refused whole via the disabled button.
   * Re-editing a REWRITTEN run goes through the covering entry's own pair —
   * see the expansion below for why a partial overlap can never be re-keyed.
   */
  const openRangeEdit = (): void => {
    if (selected.length === 0 || anySelectedAnchorless) return;
    // A selection touching an ALREADY-REWRITTEN run expands to that entry's
    // WHOLE run and re-edits it under the entry's OWN pair. Re-keying a
    // partial overlap cannot work: minted anchors exist only while their
    // entry does — the reducer's overlap scrub would delete the old entry in
    // the same commit that stores the new one, the minted words (which only
    // `applyCaptionRangeEdits` of that entry ever produces) then never
    // appear again, and the new entry's endpoints resolve `found: null`
    // forever — BOTH rewrites lost. Committing the entry's own pair instead
    // hits the reducer's equal-pair path: the overlap filter REPLACES the
    // entry and `captionRangeEditWas` inherits the original base `was`. The
    // reducer's overlap scrub stays as a backstop for hand-edited docs.
    const covering = selectionRangeEntry;
    if (covering !== undefined) {
      const lo = Math.min(Number(covering.fromKey.slice(1)), Number(covering.toKey.slice(1)));
      const hi = Math.max(Number(covering.fromKey.slice(1)), Number(covering.toKey.slice(1)));
      const run = words.filter((w) => {
        const anchor = captionAnchorOf(w.word);
        if (anchor === null) return false;
        const ms = Number(anchor.slice(1));
        return ms >= lo && ms <= hi;
      });
      // The entry addresses nothing on screen (its apply already reported a
      // drop) — nothing honest to prefill, so refuse the gesture.
      if (run.length === 0) return;
      setSel({ anchor: run[0]!.index, focus: run[run.length - 1]!.index });
      setRangeEditing({
        draft: run
          .map((w) => w.live)
          .join(" ")
          .normalize("NFC"),
        // The ENTRY's own endpoints, not the run words' srcStarts — the pair
        // is the entry's identity, and its endpoint anchors are re-minted
        // verbatim on every apply, so `w<ms>` inverts to the exact srcStart
        // `captionKeyFor` will re-derive.
        fromSrcStart: Number(covering.fromKey.slice(1)) / 1000,
        toSrcStart: Number(covering.toKey.slice(1)) / 1000,
        // Best-effort base join (minted words have no base text to name and
        // fall back to live) — the reducer's `captionRangeEditWas` inherits
        // the entry's stored base `was` for this same pair anyway, so this
        // value only matters if the entry vanished mid-gesture.
        was: run
          .map((w) => w.base)
          .join(" ")
          .normalize("NFC"),
        covered: true,
        // The EXPANDED selection just set above — the staleness sweep
        // compares against what the next render derives from it.
        selLo: run[0]!.index,
        selHi: run[run.length - 1]!.index,
      });
      return;
    }
    // NFC before storing: the same composed/decomposed trap the search box
    // normalizes for — the guard is a byte comparison on the other side.
    // A SINGLE word opens this editor too (field case 2026-08-18): whisper
    // merges a terminal `۔` and the next token into one word ("ہوں۔اس"), and
    // splitting it IS a one-word range edit (1 → N tokens; the core's
    // single-word run, `fromKey === toKey`). A one-token draft commits as a
    // plain 1:1 retype instead — see `commitRange`.
    setRangeEditing({
      draft: selected
        .map((w) => w.live)
        .join(" ")
        .normalize("NFC"),
      fromSrcStart: selected[0]!.word.srcStart,
      toSrcStart: selected[selected.length - 1]!.word.srcStart,
      // The BASE texts, never the live join: the commit scrubs every
      // per-word retype inside the interval, so the run the apply-time
      // whole-run guard reads is the base run — a live `was` carrying a
      // retype would drop the rewrite permanently (the `captionEditWas`
      // base-truth rule, run-wide; the action docstring is the contract).
      was: selected
        .map((w) => w.base)
        .join(" ")
        .normalize("NFC"),
      covered: false,
      selLo: selLo!,
      selHi: selHi!,
    });
  };

  const commitRange = (open: NonNullable<typeof rangeEditing>): void => {
    const text = open.draft.trim();
    // Empty is a cancel — deleting the run is the Delete… gesture, with its
    // own confirm; the reducer refuses an empty text anyway.
    if (text) {
      const tokens = text.split(/\s+/).filter(Boolean);
      if (!open.covered && open.fromSrcStart === open.toSrcStart && tokens.length === 1) {
        // One uncovered word rewritten to one token is a plain 1:1 retype —
        // routing it to `patchCaption` keeps the stricter contract (and its
        // clear-on-retype-back rule) instead of minting a degenerate range
        // entry for what never stopped being a retype.
        edits.patchCaption(open.fromSrcStart, text, open.was);
      } else {
        edits.patchCaptionRange(open.fromSrcStart, open.toSrcStart, text, open.was);
      }
      setSel(null);
    }
    setRangeEditing(null);
  };

  /**
   * "Apply to all (n)": the selection's own rewrite PLUS every found
   * occurrence, through ONE bulk action — one gesture, one undo step (the
   * reducer's `patchCaptionStyleAll` rule). Routing mirrors `commitRange`:
   * an uncovered single word rewritten to a single token is a 1:1 retype
   * everywhere (the per-word occurrences are single words by construction),
   * anything else is a range entry per occurrence. The selection's entry
   * leads with its own captured base `was`; each occurrence carries its own.
   */
  const commitRangeAll = (open: NonNullable<typeof rangeEditing>): void => {
    const text = open.draft.trim();
    // Empty is a cancel, same as commitRange.
    if (text) {
      const tokens = text.split(/\s+/).filter(Boolean);
      if (!open.covered && open.fromSrcStart === open.toSrcStart && tokens.length === 1) {
        edits.patchCaptionAllOccurrences(
          [
            { srcStart: open.fromSrcStart, was: open.was },
            ...occurrences.map((o) => ({ srcStart: o.fromSrcStart, was: o.was })),
          ],
          text,
        );
      } else {
        edits.patchCaptionRangeAllOccurrences(
          [
            { fromSrcStart: open.fromSrcStart, toSrcStart: open.toSrcStart, was: open.was },
            ...occurrences,
          ],
          text,
        );
      }
      setSel(null);
    }
    setRangeEditing(null);
  };

  /** Direct caption-only delete from the menu — the same payload the delete
   * modal's caption arm applies (`hideCaptionWords`, LIVE text as `was`:
   * hides apply after retypes), without the modal, because the menu names
   * the caption-only scope right on the item. Anchorable non-hidden words
   * only: the anchorless refusal already disabled the item (§137), and
   * re-hiding a hidden word would be a no-op the reducer guards anyway. */
  const hideSelection = (): void => {
    if (selected.length === 0 || anySelectedAnchorless) return;
    edits.hideCaptionWords(
      selected.filter((w) => !isHidden(w)).map((w) => ({ srcStart: w.word.srcStart, was: w.live })),
    );
    setSel(null);
  };

  const restoreSelection = (): void => {
    if (selected.length === 0) return;
    edits.restoreCaptionWords(
      // Only hidden words carry a key to delete; a hidden word's anchor is
      // by construction finite (it is a Set member), so this cannot throw.
      selected.filter(isHidden).map((w) => w.word.srcStart),
    );
    setSel(null);
  };

  /** The stored nudge a CAPTION carries, if any — keyed by the line's first
   * word (`applyCaptionLineTiming`). One lookup feeds the per-word marker,
   * its title suffix, and `openTiming`'s resume. */
  const timingEntryOfLine = (
    lineIndex: number,
  ): { lead: number; tail: number } | undefined => {
    const key = captionAnchorOf(liveLines[lineIndex]?.words[0]);
    return key === null ? undefined : edits.doc.captionLineTiming[key];
  };

  /** How many CAPTIONS the current selection covers — the gesture snaps to
   * whole lines, so the toolbar has to say so before the popover opens. */
  const selectedCaptionCount =
    selected.length === 0
      ? 0
      : selected[selected.length - 1]!.lineIndex - selected[0]!.lineIndex + 1;

  /**
   * Open the timing popover over the selected words' CAPTIONS. The §137
   * refusal stays at the gesture like every sibling
   * (`openRetype`/`openRangeEdit`): the button is disabled for anchorless
   * words, and the per-line guard below backstops it. The capture is the
   * `rangeEditing` idiom — the whole track frozen at the open, the drag
   * target resumed from the doc's existing entries so a second visit
   * continues where Apply left off.
   */
  const openTiming = (): void => {
    if (selected.length === 0 || anySelectedAnchorless) return;
    // SNAP TO CAPTIONS: a nudge moves LINE windows, so the word selection is
    // widened to the lines its words sit in. The selection is a contiguous
    // flat-index range, so its lines are a contiguous line range.
    const track = liveLines;
    const from = selected[0]!.lineIndex;
    const to = selected[selected.length - 1]!.lineIndex;
    const lines: TimingLine[] = [];
    for (let i = from; i <= to; i++) {
      const line = timingLineAt(track, i);
      // A line whose FIRST word carries no source anchor cannot be keyed at
      // all, and the §137 refusal belongs at the gesture rather than at a
      // silently-skipped Apply. The button's own `anySelectedAnchorless` only
      // sees the SELECTED words; snapping to captions can pull in a
      // line-leading word the selection never touched.
      if (line === null) return;
      lines.push(line);
    }
    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    const span = { start: first.start, end: last.end };
    const bounds = captionDragBounds({
      prev: from > 0 ? track[from - 1]! : null,
      next: to < track.length - 1 ? track[to + 1]! : null,
      track: { start: track[0]!.start, end: track[track.length - 1]!.end },
    });
    setTiming({
      track,
      from,
      to,
      span,
      bounds,
      // Seeded from the OUTER lines' stored deltas: the interior entries are
      // `captionTimingEntries`' own output for this same span, so replaying
      // the outer two reproduces them (a fixpoint) — reopening resumes the
      // group exactly where Apply left it.
      newSpan: clampCaptionSpan(
        {
          start: span.start + (edits.doc.captionLineTiming[first.key]?.lead ?? 0),
          end: span.end + (edits.doc.captionLineTiming[last.key]?.tail ?? 0),
        },
        bounds.lo,
        bounds.hi,
      ),
    });
  };

  /** The open popover's captions: the dragged group and the two neighbours
   * whose territory the drag reaches into. Derived from the CAPTURE, so a
   * completed render cannot move them mid-drag. */
  const timingCaptions = useMemo(() => {
    if (timing === null) return null;
    const lines: TimingLine[] = [];
    for (let i = timing.from; i <= timing.to; i++) {
      const line = timingLineAt(timing.track, i);
      // Unreachable — `openTiming` refuses an unanchorable group — but this
      // memo must not hand the entry builder a hole.
      if (line === null) return null;
      lines.push(line);
    }
    return {
      lines,
      prev: timing.from > 0 ? timingLineAt(timing.track, timing.from - 1) : null,
      next:
        timing.to < timing.track.length - 1 ? timingLineAt(timing.track, timing.to + 1) : null,
    };
  }, [timing]);

  /**
   * The entries this drag implies — derived ONCE and reused by the preview,
   * the readout and Apply (`captionTimingEntries`' contract), so the strip
   * can never draw a nudge the doc would not store.
   */
  const timingEntries = useMemo(() => {
    if (timing === null || timingCaptions === null) return null;
    const { lines, prev, next } = timingCaptions;
    const stored = edits.doc.captionLineTiming;
    return captionTimingEntries({
      lines,
      span: timing.span,
      newSpan: timing.newSpan,
      // The neighbour's FAR-side delta rides through untouched — this gesture
      // has nothing to say about it (see `captionTimingEntries`).
      prev: prev === null ? null : { ...prev, lead: stored[prev.key]?.lead ?? 0 },
      next: next === null ? null : { ...next, tail: stored[next.key]?.tail ?? 0 },
    });
  }, [timing, timingCaptions, edits.doc.captionLineTiming]);

  /**
   * The previewed track: core's REAL apply pass over the captured lines with
   * this drag's entries layered on the doc's own. Not an approximation of
   * what Apply will do — it IS what Apply will do, seam sweep and
   * `MIN_CAPTION_SEC` floor included, which is why a drag that a bound
   * refuses simply stops on screen instead of snapping back on release.
   */
  const timingPreview = useMemo(() => {
    if (timing === null || timingEntries === null) return null;
    // The doc's OTHER nudges ride along so the strip shows the same track the
    // render does; this drag's entries win their own keys. `captionKeyFor` is
    // safe on these `srcStart`s — every one came from a `captionAnchorOf`
    // that already vouched for it (`timingLineAt`).
    const record: Record<string, { lead: number; tail: number }> = {
      ...edits.doc.captionLineTiming,
    };
    for (const e of timingEntries) {
      record[captionKeyFor(e.srcStart)] = { lead: e.lead, tail: e.tail };
    }
    return applyCaptionLineTiming(timing.track, record).lines;
  }, [timing, timingEntries, edits.doc.captionLineTiming]);

  /** The group's previewed span — the readout, the handles and the band all
   * read the SWEPT edges, not the raw drag target, so what is drawn is what
   * Apply stores even where a floor moved an edge. */
  const timedSpan = useMemo(() => {
    if (timing === null || timingPreview === null) return null;
    const first = timingPreview[timing.from];
    const last = timingPreview[timing.to];
    return first && last ? { start: first.start, end: last.end } : null;
  }, [timing, timingPreview]);

  /** How many captions the OPEN popover is moving — the readout's count and
   * every one of its titles' singular/plural, from the capture rather than
   * from the live selection (which a render could change under it). */
  const timedCaptionCount = timing === null ? 0 : timing.to - timing.from + 1;

  /**
   * The strip's window, in SOURCE seconds: the dragged captions PLUS the
   * neighbours' territory, which is precisely how far the drag can reach
   * (`captionDragBounds`) — a strip that stopped at the group's own edges
   * would hide the material being taken from. audio.wav is source-time audio,
   * so the window is a source extent; `outStart` is the OUTPUT time the same
   * seam sits at, which is what the overlay is positioned in.
   */
  const timingWin = useMemo(() => {
    if (timing === null || timingCaptions === null) return null;
    const opening = timingCaptions.prev ?? timingCaptions.lines[0]!;
    const closing = timingCaptions.next ?? timingCaptions.lines[timingCaptions.lines.length - 1]!;
    return {
      srcStart: opening.srcStart,
      srcEnd: closing.srcEnd,
      outStart: opening.start,
      dur: closing.srcEnd - opening.srcStart + 2 * TIMING_WIN_PAD_SEC,
    };
  }, [timing, timingCaptions]);

  // Kick the singleton audio load the first time a popover opens — not at
  // mount, because most sessions never open one and the decode holds the
  // whole channel in memory.
  useEffect(() => {
    if (timing === null || audio !== null) return;
    let cancelled = false;
    void loadSourceAudio().then((a) => {
      if (!cancelled && a !== null) setAudio(a);
    });
    return () => {
      cancelled = true;
    };
  }, [timing, audio]);

  /**
   * OUTPUT seconds → x over the strip, the ONE mapping the draw effect, the
   * handles and (inverted) the drag all use. The window opens at the
   * neighbourhood's own first seam (`timingWin.outStart`) rather than at the
   * group's, because the strip shows the neighbours' territory either side.
   */
  const timingToX = (outSec: number): number =>
    timingWin === null
      ? 0
      : ((outSec - timingWin.outStart + TIMING_WIN_PAD_SEC) / timingWin.dur) * TIMING_CANVAS_W;

  // Redraw the strip on every drag change. audio.wav is SOURCE-time audio;
  // the window is `[winSrcStart − pad, winSrcEnd + pad]` SOURCE seconds
  // (`timingWin`), and the OUTPUT-time overlay is mapped onto it as
  // `winSrcStart + (t − winOutStart)` — inside a kept span the output↔source
  // map is identity plus offset, so the overlay lines up with the waveform.
  // Known caveat, reaching further now the window spans three captions:
  // within the ±1s pad — and anywhere a cut boundary falls INSIDE the window
  // — the source audio on screen can hold material the output no longer
  // contains, so the waveform drifts from the overlay past that seam. Context
  // only, never draggable-to (the bounds are output-time), so accepted.
  useEffect(() => {
    if (timing === null || timedSpan === null || timingPreview === null || timingWin === null) {
      return;
    }
    const canvas = timingCanvasRef.current;
    // jsdom implements no 2d context (getContext returns null there) — the
    // popover's tests assert presence, never pixels.
    const ctx = canvas?.getContext?.("2d") ?? null;
    if (!canvas || !ctx) return;
    const toX = timingToX;
    ctx.fillStyle = "#0F0F14";
    ctx.fillRect(0, 0, TIMING_CANVAS_W, TIMING_CANVAS_H);
    // 2px bars; a null decode draws the all-zero buckets — the flat strip.
    const bucketCount = Math.floor(TIMING_CANVAS_W / 2);
    const buckets =
      audio === null
        ? new Float32Array(bucketCount)
        : peaksForWindow(
            audio.channel,
            audio.sampleRate,
            timingWin.srcStart - TIMING_WIN_PAD_SEC,
            timingWin.srcEnd + TIMING_WIN_PAD_SEC,
            bucketCount,
          ).buckets;
    ctx.fillStyle = "#4a4a58";
    const barW = TIMING_CANVAS_W / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const h = Math.max(1, buckets[i]! * (TIMING_CANVAS_H - 4));
      ctx.fillRect(i * barW, (TIMING_CANVAS_H - h) / 2, Math.max(1, barW - 1), h);
    }
    // The NEIGHBOURS' territory, in a dimmer shade of the band's own colour:
    // dragging the opening seam back TAKES those seconds from the previous
    // caption, and a strip that showed only the group would hide who is
    // paying for the move. Drawn from the PREVIEW, so it shrinks live as the
    // band eats into it.
    ctx.fillStyle = "rgba(255, 225, 77, 0.06)";
    for (const i of [timing.from - 1, timing.to + 1]) {
      const nb = timingPreview[i];
      if (!nb) continue;
      ctx.fillRect(toX(nb.start), 0, Math.max(1, toX(nb.end) - toX(nb.start)), TIMING_CANVAS_H);
    }
    // The span overlay: a translucent band with a bright line at each edge,
    // where the drag handles sit.
    const x0 = toX(timedSpan.start);
    const x1 = toX(timedSpan.end);
    ctx.fillStyle = "rgba(255, 225, 77, 0.18)";
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), TIMING_CANVAS_H);
    // CAPTION boundaries, faint and 1px — the interior seams of the group and
    // the neighbours' outer edges. These are the ticks the field screenshot's
    // 122-word comb used to be: word stamps say nothing about when a caption
    // appears (that is the line's window), so drawing them was noise the eye
    // could not read a seam out of.
    ctx.fillStyle = "#7a7a88";
    for (let i = Math.max(0, timing.from - 1); i <= timing.to + 1; i++) {
      const line = timingPreview[i];
      if (!line) continue;
      // The two span edges get their own bright lines below; drawing a dim
      // tick under them just muddies the edge the user is dragging.
      if (i !== timing.from) ctx.fillRect(toX(line.start), 0, 1, TIMING_CANVAS_H);
      if (i !== timing.to) ctx.fillRect(toX(line.end), 0, 1, TIMING_CANVAS_H);
    }
    ctx.fillStyle = "#FFE14D";
    ctx.fillRect(x0 - 1, 0, 2, TIMING_CANVAS_H);
    ctx.fillRect(x1 - 1, 0, 2, TIMING_CANVAS_H);
    // `timingToX` is remade every render and reads only `timingWin`, which is
    // a dep already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing, timedSpan, timingPreview, timingWin, audio]);

  /** px → seconds for the drag: the canvas bitmap IS its CSS size
   * (TIMING_CANVAS_W), so no rect measure — jsdom-testable for free. */
  const timingSecPerPx = timingWin === null ? 0 : timingWin.dur / TIMING_CANVAS_W;

  /** The handles' x positions over the canvas, same mapping as the draw. */
  const timingHandleX =
    timing === null || timedSpan === null || timingWin === null
      ? null
      : { lead: timingToX(timedSpan.start), tail: timingToX(timedSpan.end) };

  const onTimingHandleDown =
    (edge: "lead" | "tail" | "band") =>
    (e: React.PointerEvent<HTMLElement>): void => {
      if (timing === null) return;
      // Suppress the text selection a drag over the popover would otherwise
      // start (and, with it, the body's own drag-select mapping above).
      e.preventDefault();
      // No `setPointerCapture` (2026-08-18 round 5): capture was the ONLY
      // thing routing moves back to a 10px element the pointer leaves within
      // the first few px of any real drag — and it was try/caught, so every
      // failure (jsdom, a synthetic event with no pointerId, a browser that
      // refuses) silently produced a drag that received neither the moves nor
      // the UP. The window listeners below need no routing to begin with.
      setTimingDrag({ edge, startX: e.clientX, span: timing.newSpan });
    };

  /**
   * The live handle drag lives on WINDOW, not on the handle (the Timeline /
   * Overlay drag idiom, and the fix for "left the mouse button and it was
   * still dragging"): a pointer that leaves the 10px strip — which every
   * real drag does immediately — kept firing at the window while the element
   * heard nothing, so the release was missed and the next move re-entered the
   * drag. EVERY terminator ends it: pointerup, pointercancel (a touch turned
   * into a scroll, a palm rejection) and the window losing focus (an OS drag
   * away, a cmd-tab — no pointerup is ever delivered for those).
   *
   * Keyed on `timingDrag` AND `timing`, so the move closure below always
   * reads the current capture: the alternative is a ref the effect never
   * refreshes, which is the class of bug this whole rewrite is about.
   */
  useEffect(() => {
    if (timingDrag === null || timing === null) return;
    const onMove = (e: PointerEvent): void => {
      // Clamped into the NEIGHBOURS' window (`captionDragBounds`, captured at
      // the open) before anything else sees it: the seam sweep would clamp
      // the same drag anyway, and stopping the target here is what keeps the
      // handle under the pointer instead of running away from a preview that
      // refuses to follow it.
      setTiming({
        ...timing,
        newSpan: dragCaptionSpan({
          edge: timingDrag.edge,
          span: timingDrag.span,
          dSec: (e.clientX - timingDrag.startX) * timingSecPerPx,
          lo: timing.bounds.lo,
          hi: timing.bounds.hi,
        }),
      });
    };
    const onEnd = (): void => setTimingDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onEnd);
    };
  }, [timingDrag, timing, timingSecPerPx]);

  // EVERY close path drops a live drag — Apply, Cancel, Escape, the
  // selection-change sweep and the word-click handler all just
  // `setTiming(null)`, so the clear lives here rather than at each of them
  // (the span-play pause below is the same shape, for the same reason). This
  // is what the old ref could not have: a drag that outlived its popover made
  // the next BARE HOVER over a reopened handle jump by the stale startX.
  // Unmount needs nothing — the effect above removes its window listeners.
  useEffect(() => {
    if (timing === null && timingDrag !== null) setTimingDrag(null);
  }, [timing, timingDrag]);

  /** Play just the nudged span. No playbackRange API exists on
   * @remotion/player, so the "play this span" is a seek+play with the
   * frameupdate watcher below pausing at the far edge. */
  const toggleTimingPlay = (): void => {
    if (timedSpan === null) return;
    const player = playerRef.current;
    if (!player) return;
    if (timingPlaying) {
      player.pause();
      setTimingPlaying(false);
      return;
    }
    // CEIL, the word-click rule above: rounding down can land the quantized
    // playhead a fraction before the span, in the previous word's window.
    player.seekTo(Math.ceil(timedSpan.start * fps));
    player.play();
    setTimingPlaying(true);
  };

  // The span-end watcher — attached only WHILE the popover's own Play is
  // live, so a frameupdate from ordinary playback (the transport bar, a
  // word-click seek) can never be paused by a popover that happens to be
  // open past its span.
  useEffect(() => {
    if (!timingPlaying || timedSpan === null) return;
    const player = playerRef.current;
    if (!player) return;
    const endSec = timedSpan.end;
    const onFrame = (e: { detail: { frame: number } }): void => {
      if (e.detail.frame / fps >= endSec) {
        player.pause();
        setTimingPlaying(false);
      }
    };
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [timingPlaying, timedSpan, fps, playerRef]);

  // EVERY close path pauses a live span play — Apply, Cancel, Escape, and
  // the selection-change sweep all just `setTiming(null)`, so the pause
  // lives here rather than being repeated at each of them.
  useEffect(() => {
    if (timing !== null || !timingPlaying) return;
    playerRef.current?.pause();
    setTimingPlaying(false);
  }, [timing, timingPlaying, playerRef]);

  const applyTiming = (entries: NonNullable<typeof timingEntries>): void => {
    // The SAME entries the strip previewed with (`timingEntries` feeds both),
    // so nothing can be persisted that the user was not shown. ONE bulk
    // action, however many captions: a drag is one gesture and must be one
    // undo step — and one seam is shared by two captions, so a drag writes
    // both sides (the `patchCaptionLineTiming` docstring). The reducer's
    // sub-ms rule turns each unmoved caption — and a group dragged back to
    // base — into a DELETE of its entry.
    edits.patchCaptionLineTiming(entries);
    // Close the popover but KEEP the selection — unlike the rewrite/delete
    // gestures, a nudge is often iterated on, and re-selecting the same
    // words to try again would be pure friction.
    setTiming(null);
  };

  return (
    <div data-testid="transcript-panel" style={{ ...panel, width }}>
      <div style={header}>
        <span style={title}>Transcript</span>
        {/* ONE hint line (2026-08-18): the old four-line scope paragraph is
            behind the `?` toggle now — the pane's height belongs to words,
            and the selection gestures announce themselves via the floating
            menu below. */}
        <div style={hintRow}>
          <span style={scopeNote}>
            Click to jump · double-click to retype · drag to select
          </span>
          <button
            data-testid="transcript-help-toggle"
            style={helpToggle}
            onClick={() => setHelpOpen((v) => !v)}
            title="What each gesture does"
            aria-label="Transcript help"
            aria-expanded={helpOpen}
          >
            ?
          </button>
        </div>
        {helpOpen ? (
          <div data-testid="transcript-help" style={scopeNote}>
            Drag across words — or shift-click — to mark a run. Its toolbar
            offers Edit (rewrite freely — word count may change, captions
            only; works on a single word too, the way to split a merged one),
            Timing (whole CAPTIONS — drag the waveform handles to move when
            they come in and go out, or drag between them to shift them all,
            taking the time from the captions either side) and Delete —
            from the captions only (restorable — the word stays here and in
            the audio) or from the video too, on the next Render. Double-click
            retype stays 1:1 — word count and timing fixed, so scene anchors
            and the caption highlight keep working.
          </div>
        ) : null}
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
      {/* The dir ATTRIBUTE, not CSS `direction`: the attribute also flips
          `text-align: start` and native selection/caret behavior, which the
          property alone does not. */}
      <div
        style={body}
        data-testid="transcript-body"
        dir={panelDir}
        ref={bodyRef}
        // Drag-select maps to the word range on RELEASE, never per-move: the
        // browser owns the in-flight highlight (that is what makes the drag
        // feel native), and this handler converts its answer once, at the end
        // — see `onBodyMouseUp`. `mouseup`, not `pointerup`: the native
        // selection is only final by the time the mouse event fires.
        onMouseUp={onBodyMouseUp}
        // Panel-scoped keyboard handling, NEVER a window listener — but the
        // scoping alone is NOT what keeps Overlay's global Delete (delete-
        // scene) and Escape (deselect) from double-firing: the keydown still
        // BUBBLES from this div to Overlay's window listener, so one Delete
        // opened the word modal AND the scene modal at once. Every key the
        // handler below actually HANDLES calls stopPropagation — and only
        // those, so an Escape with nothing selected here still reaches
        // Overlay's deselect. `tabIndex` makes the pane focusable so
        // clicking into it scopes the keys here.
        tabIndex={0}
        onKeyDown={(e) => {
          // An open retype box or range editor owns the keyboard — and the
          // popover renders INSIDE this div now (so it scrolls with its
          // anchor), so its keys BUBBLE here: without this guard a
          // Backspace typed into the textarea would fire the word-delete
          // gesture on the live selection underneath it.
          if (editing !== null || rangeEditing !== null) return;
          // The timing popover owns Escape as CANCEL — the selection stays,
          // and the bar returns at the same anchor (a second Escape then
          // clears the selection via the branch below). No other key is
          // claimed: the popover holds no text input to protect.
          if (timing !== null) {
            if (e.key === "Escape") {
              e.stopPropagation();
              setTiming(null);
            }
            return;
          }
          if (e.key === "Escape") {
            if (sel === null) return;
            e.stopPropagation();
            setSel(null);
            // The popover is ANCHORED to the selection now: clearing `sel`
            // alone would leave an invisible open editor that pops back up,
            // stale draft and all, at the NEXT selection's anchor.
            setRangeEditing(null);
            return;
          }
          if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
            e.preventDefault();
            e.stopPropagation();
            // Mirror the toolbar's Delete↔Restore swap: on an all-hidden
            // selection the modal's only remaining target would be the
            // DESTRUCTIVE video cut, preselected and Enter-armed — and the
            // Delete→Enter reflex must never escalate a recoverable hide
            // into a video cut.
            if (allSelectedHidden) restoreSelection();
            else requestDelete();
          }
        }}
      >
        {words.map((w, i) => {
          // Computed once per word: the title, the dblclick refusal and the
          // Edit expansion must all agree on whether this word sits inside a
          // live rewrite.
          const rangeEntry = coveringRangeEntry(w.word);
          // Timing marker (2026-08-18 round 4; per CAPTION since the
          // `captionLineTiming` rewrite): a stored nudge gets a dotted
          // underline plus a title suffix on EVERY word of the caption it
          // moved — the record is per line, so marking only the line's first
          // word would say a nudge belongs to one word of it. The suffix
          // COMPOSES with whatever the base title says — timing is orthogonal
          // to text edits and hides, so it must not displace their messages.
          const timedEntry = timingEntryOfLine(w.lineIndex);
          const baseTitle = isHidden(w)
            ? "hidden from captions — select and Restore"
            : rangeEntry !== undefined
              ? // Inside a LIVE rewrite: the 1:1 retype is refused
                // (`openRetype`), so the title routes to the one
                // gesture that works, naming the run it belongs to.
                `part of a rewritten range (was “${rangeEntry.was}”) — select it and use Edit`
              : w.synthetic
                ? // A minted word whose entry is gone (hand-edited
                  // doc): no base WORD to name, so the title names
                  // its own base fallback.
                  `rewritten (was “${w.base}”) — select and Edit to change`
                : w.live !== w.base
                  ? `edited (was “${w.base}”) — double-click to retype`
                  : "click to jump · double-click to retype";
          return editing?.index === w.index ? (
              <input
                key={w.index}
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
                key={w.index}
                data-testid={`transcript-word-${w.index}`}
                onClick={(e) => {
                  // An open range editor closes BEFORE the selection moves
                  // (field bug 2026-08-18 round 3): the popover is anchored
                  // to the selection, so a moved selection re-rendered it at
                  // the NEW words while it still held its stale capture —
                  // Apply then rewrote the PREVIOUS run while visually
                  // pointing at the new one. The `rangeEditing.selLo` sweep
                  // above backstops any path this misses. The timing popover
                  // closes for the same reason — explicitly, because a click
                  // on the SAME word leaves selLo/selHi unchanged and the
                  // selection-change sweep never fires.
                  if (rangeEditing !== null) setRangeEditing(null);
                  if (timing !== null) setTiming(null);
                  if (e.shiftKey) {
                    // Extend the selection (create one if none) and SUPPRESS
                    // the seek: extending a range is a selection gesture, and
                    // yanking the playhead to every shift-click would scrub
                    // the preview across the video while the user is only
                    // marking words.
                    setSel((prev) =>
                      prev === null
                        ? { anchor: w.index, focus: w.index }
                        : { ...prev, focus: w.index },
                    );
                    return;
                  }
                  // CEIL, not round (field case 2026-08-18): rounding down
                  // can land the quantized playhead a fraction BEFORE
                  // `w.start`, inside the PREVIOUS word's window — the
                  // frameupdate hit test then highlights the neighbour while
                  // the click selected this word, and the two boxes read as a
                  // double selection. Constant with degenerate ASR stamps
                  // (whisper's zero-length runs repair to 50ms words, finer
                  // than a 33ms frame is round-safe for).
                  playerRef.current?.seekTo(Math.ceil(w.start * fps));
                  setSel({ anchor: w.index, focus: w.index });
                }}
                onDoubleClick={() => openRetype(w)}
                title={
                  timedEntry === undefined
                    ? baseTitle
                    : // ms readout, the doc's own unit rounded for humans —
                      // `in` is the caption's opening seam, `out` its closing
                      // one, which is what `lead`/`tail` mean now they move
                      // LINE windows.
                      `${baseTitle} · caption timing adjusted (${Math.round(timedEntry.lead * 1000)}ms in / ${Math.round(timedEntry.tail * 1000)}ms out) — Timing to change`
                }
                style={{
                  ...word,
                  // A dotted BORDER, never textDecoration: underline is the
                  // playhead marker (`currentStyle`) and line-through the
                  // hide marker (`hiddenStyle`) — a border composes with
                  // both where a second textDecoration would clobber them.
                  ...(timedEntry !== undefined ? timedWordStyle : {}),
                  // Hidden and selected layer UNDER the find/edited/current
                  // styles: a search hit or the playhead landing on a hidden
                  // word must still read as a hit, and the strike-through
                  // survives regardless (nothing above sets textDecoration).
                  ...(isHidden(w) ? hiddenStyle : {}),
                  // `editedStyle` layers UNDER the selection band (2026-08-18
                  // round 3): its edited tint is the same yellow the band is
                  // now painted in, so spreading it above `selectedStyle`
                  // rendered edited words yellow-on-yellow — invisible while
                  // selected. The band's own #111 wins; the tint returns the
                  // moment the word is deselected.
                  ...(w.live !== w.base || w.synthetic ? editedStyle : {}),
                  ...(selLo !== null && w.index >= selLo && w.index <= selHi! ? selectedStyle : {}),
                  ...(matches?.has(w.index) ? matchStyle : {}),
                  ...(matchList[matchCursor] === w.index ? currentMatchStyle : {}),
                  ...(currentIndex === w.index ? currentStyle : {}),
                }}
              >
                {/* The inter-word space lives INSIDE the span (2026-08-18
                    round 3; it was a bare text node BETWEEN spans before —
                    the §65 wrap fix). Break opportunities are the space
                    CHARACTERS, not node boundaries, so §65's wrapping
                    survives the move — and the space now paints under
                    `selectedStyle`, which is what makes the selection band
                    CONTINUOUS instead of striped per word. A margin would
                    do neither (§65: margins are not break opportunities). */}
                {w.live}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
        })}
        {/* The selection bar (2026-08-18 round 3) — a compact HORIZONTAL
            row (Edit · Timing · Delete ▾ · count), rendered INSIDE the
            scrollable body and absolutely positioned at the anchor word's
            content coords, so it scrolls with the words instead of closing
            on every scroll (the layout effect above has the full why).
            Deliberately NO backdrop: the transcript stays interactive so a
            shift-click can keep extending the selection — Escape, the
            selection clearing, a word-count change and the gestures
            themselves are the close paths. */}
        {sel !== null && menuPos !== null && rangeEditing === null && timing === null ? (
          <div
            data-testid="transcript-selection-menu"
            role="menu"
            ref={menuRef}
            // CHROME, not content (field screenshot 2026-08-18 round 5): the
            // bar inherits the body's `dir="rtl"` on an Urdu transcript,
            // which reversed the whole button row — `word 1 · Delete ·
            // Timing · Edit`, with the count reading as the leading label.
            // Its labels are English UI strings whose order is a designed
            // sequence, so it is pinned LTR like every other menu in the app.
            dir="ltr"
            style={{ ...floatingMenu, top: menuPos.top, left: menuPos.left }}
          >
            <MenuItem
              data-testid="transcript-edit-range"
              onClick={openRangeEdit}
              disabled={anySelectedAnchorless}
              title={
                anySelectedAnchorless
                  ? // The §137 refusal, same wording as the delete items: a
                    // word with no source anchor cannot carry an edit.
                    "A selected word has no source anchor (this project predates them) — re-run produce first"
                  : selectionRangeEntry !== undefined
                    ? // The gesture expands to the covered entry's whole run
                      // (`openRangeEdit`) — say so, instead of promising a
                      // 1:1 retype a covered word cannot carry.
                      "Re-edit the rewritten range this selection touches"
                    : selected.length === 1
                      ? "Retype this word (1:1 — same as double-click)"
                      : "Rewrite these words as free text — word count may change"
              }
            >
              Edit
            </MenuItem>
            <MenuItem
              data-testid="transcript-timing"
              onClick={openTiming}
              // ANY selection size: the gesture snaps to the CAPTIONS the
              // selected words sit in, so one word and a whole paragraph are
              // the same code path — and the title names the captions rather
              // than the words, because that is what a nudge moves.
              disabled={selected.length === 0 || anySelectedAnchorless}
              title={
                anySelectedAnchorless
                  ? // The §137 refusal — a timing nudge is keyed by the
                    // caption's first word's source anchor like every other
                    // caption edit.
                    "A selected word has no source anchor (this project predates them) — re-run produce first"
                  : selectedCaptionCount === 1
                    ? "Adjust when this caption appears and leaves"
                    : `Adjust when these ${selectedCaptionCount} captions appear and leave`
              }
            >
              Timing
            </MenuItem>
            {allSelectedHidden ? (
              // Restore REPLACES the Delete ▾ button on an all-hidden
              // selection (the old toolbar's swap): the only delete left to
              // offer would be the destructive video cut.
              <MenuItem
                data-testid="transcript-restore"
                onClick={restoreSelection}
                title="Show these words in the captions again"
              >
                Restore
              </MenuItem>
            ) : (
              // Delete ▾ folds the two delete scopes into one bar slot; the
              // flyout keeps the caption-only arm a DIRECT item (it names
              // its scope, so the modal's caption/video decision stays
              // reserved for the video item).
              <span style={{ position: "relative" }}>
                <MenuItem
                  data-testid="transcript-delete-menu"
                  onClick={() => setDeleteOpen((v) => !v)}
                  title="Delete these words — from the captions only, or from the video too"
                >
                  Delete ▾
                </MenuItem>
                {deleteOpen ? (
                  // dir pinned like the bar above — the flyout is chrome too,
                  // and an rtl base right-aligned its two English rows.
                  <div data-testid="transcript-delete-flyout" dir="ltr" style={deleteFlyout}>
                    <MenuItem
                      data-testid="transcript-hide"
                      onClick={() => {
                        setDeleteOpen(false);
                        hideSelection();
                      }}
                      disabled={anySelectedAnchorless}
                      title={
                        anySelectedAnchorless
                          ? "A selected word has no source anchor (this project predates them) — re-run produce first"
                          : "Hide these words from the captions — restorable, the words stay here and in the audio"
                      }
                    >
                      Delete captions
                    </MenuItem>
                    <MenuItem
                      data-testid="transcript-delete"
                      onClick={() => {
                        setDeleteOpen(false);
                        requestDelete();
                      }}
                      disabled={anySelectedAnchorless}
                      title={
                        anySelectedAnchorless
                          ? // The §137 refusal, worded: a word with no source anchor
                            // cannot carry a hide, and disabling with the reason
                            // beats a delete that silently skips part of the selection.
                            "A selected word has no source anchor (this project predates them) — re-run produce first"
                          : "Delete these words — from the captions only, or from the video too"
                      }
                    >
                      Delete + video…
                    </MenuItem>
                  </div>
                ) : null}
              </span>
            )}
            <span style={menuLabel}>
              {selected.length} word{selected.length === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}
        {/* The free-text run editor, in the bar's place (same anchor): it is
            a text box, not a decision — the modal idiom stays reserved for
            destructive confirms (DeleteWordsModal). Blur does NOT commit
            any more (2026-08-18): with Apply/Cancel buttons IN the popover,
            a blur-commit would fire on the way to pressing Cancel. */}
        {rangeEditing !== null && menuPos !== null ? (
        <div
          data-testid="transcript-range-popover"
          ref={menuRef}
          // The popover's CHROME is LTR (the bar's rule) — its Apply/Cancel
          // row is a designed sequence. The textarea inside carries its own
          // `dir="auto"`, so an Urdu rewrite still types right-to-left.
          dir="ltr"
          style={{
            ...floatingMenu,
            top: menuPos.top,
            left: menuPos.left,
            // The bar is a row now; the popover stacks its textarea over
            // the button row.
            flexDirection: "column",
            alignItems: "stretch",
            gap: 6,
          }}
        >
          <textarea
            autoFocus
            data-testid="transcript-range-edit"
            rows={3}
            // The box holds TRANSCRIPT text, so it keeps a first-strong base
            // even though its container is pinned LTR chrome — `auto` is the
            // per-value resolution `panelDir` does for the body, delegated to
            // the browser because the value changes as the user types.
            dir="auto"
            style={rangeTextarea}
            value={rangeEditing.draft}
            onChange={(e) => setRangeEditing({ ...rangeEditing, draft: e.target.value })}
            onKeyDown={(e) => {
              // Plain Enter commits (the retype box's contract); shift-Enter
              // stays a newline for a long rewrite being drafted.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitRange(rangeEditing);
              }
              if (e.key === "Escape") setRangeEditing(null);
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              data-testid="transcript-apply"
              style={toolbarButton}
              onClick={() => commitRange(rangeEditing)}
              title="Rewrite this selection (Enter)"
            >
              Apply
            </button>
            {occurrences.length > 0 ? (
              <button
                data-testid="transcript-apply-all"
                style={toolbarButton}
                onClick={() => commitRangeAll(rangeEditing)}
                title="Rewrite this selection AND every other place the same words occur — one undo step"
              >
                Apply to all ({occurrences.length})
              </button>
            ) : null}
            <button
              style={toolbarButton}
              onClick={() => setRangeEditing(null)}
              title="Discard the rewrite (Esc)"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
        {/* The TIMING popover (2026-08-18 round 4; CAPTION-shaped since the
            `captionLineTiming` rewrite), in the bar's place at the same
            anchor — the range editor's swap idiom. A waveform strip of the
            SOURCE audio around the selected CAPTIONS and the two either side,
            the nudged span overlaid with a drag handle at each edge and a
            grabbable band between them, and a row: Play/Pause · span readout
            · Apply · Cancel. Escape cancels (the body keydown); selection
            moves and word-count changes close it (the sweep). */}
        {timing !== null && timedSpan !== null && menuPos !== null ? (
          <div
            data-testid="transcript-timing-popover"
            ref={menuRef}
            // Chrome, pinned LTR (the bar's rule) — and here the direction is
            // load-bearing beyond label order: the waveform strip and its two
            // handles are positioned in `left` px over a time axis that runs
            // left→right, which an rtl base would mirror against the drag.
            dir="ltr"
            style={{
              ...floatingMenu,
              top: menuPos.top,
              left: menuPos.left,
              flexDirection: "column",
              alignItems: "stretch",
              gap: 6,
            }}
          >
            <div style={{ position: "relative", width: TIMING_CANVAS_W, height: TIMING_CANVAS_H }}>
              <canvas
                data-testid="transcript-timing-canvas"
                ref={timingCanvasRef}
                width={TIMING_CANVAS_W}
                height={TIMING_CANVAS_H}
                style={{ display: "block", borderRadius: 4 }}
              />
              {timingHandleX !== null ? (
                <>
                  {/* The BAND between the handles: a rigid PAN of both edges
                      (`dragRunSpan`), the gesture for "these captions are all
                      a beat late". Rendered BEFORE the handles so they paint
                      over it — the two edges keep their own 12px zones, and
                      the band only owns what is left between them. */}
                  <div
                    data-testid="transcript-timing-band"
                    title={
                      timedCaptionCount === 1
                        ? "Drag to shift this caption, its duration intact"
                        : "Drag to shift these captions, every duration intact"
                    }
                    onPointerDown={onTimingHandleDown("band")}
                    style={{
                      ...timingBand,
                      left: timingHandleX.lead,
                      width: Math.max(0, timingHandleX.tail - timingHandleX.lead),
                      cursor: timingDrag?.edge === "band" ? "grabbing" : "grab",
                    }}
                  />
                  {/* 12px hit zones centred on the span's edge lines — wider
                      than the 2px grip they carry, or the drag would demand
                      pixel aim. Only pointerDOWN lives on the element: the
                      move and the release are window listeners (the drag
                      effect above has the why). */}
                  <TimingHandle
                    data-testid="transcript-timing-handle-lead"
                    title={
                      timedCaptionCount === 1
                        ? "Drag to move when this caption comes in — the previous caption gives up the time"
                        : "Drag to move when the first caption comes in — the previous caption gives up the time"
                    }
                    x={timingHandleX.lead}
                    active={timingDrag?.edge === "lead"}
                    onPointerDown={onTimingHandleDown("lead")}
                  />
                  <TimingHandle
                    data-testid="transcript-timing-handle-tail"
                    title={
                      timedCaptionCount === 1
                        ? "Drag to move when this caption goes out — the next caption gives up the time"
                        : "Drag to move when the last caption goes out — the next caption gives up the time"
                    }
                    x={timingHandleX.tail}
                    active={timingDrag?.edge === "tail"}
                    onPointerDown={onTimingHandleDown("tail")}
                  />
                </>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                data-testid="transcript-timing-play"
                style={toolbarButton}
                onClick={toggleTimingPlay}
                title={
                  timingPlaying
                    ? "Pause"
                    : timedCaptionCount === 1
                      ? "Play just this caption's span"
                      : "Play just these captions' span"
                }
              >
                {timingPlaying ? "Pause" : "Play"}
              </button>
              <span data-testid="transcript-timing-span" style={menuLabel}>
                {timedSpan.start.toFixed(2)}s – {timedSpan.end.toFixed(2)}s
                {/* The CAPTION count, always — unlike the old word count it
                    is never noise: the gesture SNAPPED the selection to whole
                    captions, and the readout is where the user finds out how
                    many they are about to move. */}
                {` · ${timedCaptionCount} caption${timedCaptionCount === 1 ? "" : "s"}`}
              </span>
              <button
                data-testid="transcript-timing-apply"
                style={toolbarButton}
                onClick={() => {
                  // Non-null by construction — the popover only renders with
                  // a previewed span, which is derived from these entries.
                  if (timingEntries !== null) applyTiming(timingEntries);
                }}
                title={
                  timedCaptionCount === 1
                    ? "Store this caption's timing — the neighbour's matching seam moves with it"
                    : "Store these captions' timing — one undo step for the whole gesture"
                }
              >
                Apply
              </button>
              <button
                data-testid="transcript-timing-cancel"
                style={toolbarButton}
                onClick={() => setTiming(null)}
                title="Discard the nudge (Esc)"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** A menu row: full-width ghost button with a hover highlight. Hover via
 * local state rather than a stylesheet class (§138 put the picker rows'
 * states in index.css because inline styles cannot express `:hover`) — these
 * rows are the panel's only hover consumers, and the state keeps the menu
 * self-contained. */
const MenuItem: React.FC<
  {
    children: React.ReactNode;
  } & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "title"> & {
      "data-testid": string;
    }
> = ({ children, ...rest }) => {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      {...rest}
      style={{
        ...menuItem,
        // One step LIGHTER than the surface it sits on (#262630) — the old
        // #23232E was a step DARKER, so hover read as a hole in the bar.
        ...(hover && !rest.disabled ? { background: "#34343F" } : {}),
        ...(rest.disabled ? { opacity: 0.5, cursor: "default" } : {}),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
};

/**
 * One edge of the nudged span: a 12px transparent hit zone with a 2px grip
 * line down its middle. The zone is deliberately six times the grip — the
 * strip is 48px tall and the two handles can sit a few px apart on a short
 * word, so the pointer needs slack the eye does not. Hover state is local
 * (the `MenuItem` rule: inline styles cannot express `:hover`, and these are
 * the popover's only hover consumers).
 */
const TimingHandle: React.FC<{
  /** The grip's CENTRE over the canvas, px — the zone is laid out around it. */
  x: number;
  /** True while THIS edge is the one being dragged (`timingDrag`). */
  active: boolean;
  title: string;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  "data-testid": string;
}> = ({ x, active, ...rest }) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      {...rest}
      style={{ ...timingHandle, left: x - TIMING_HANDLE_W / 2 }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {/* pointerEvents none so the grip never becomes the event target — the
          zone around it is the whole point. */}
      <div
        style={{
          ...timingGrip,
          background: active ? "#fff" : hover ? "#FFF0A0" : "#FFE14D",
          // A drag is a coarse gesture; the grip thickens under it so the
          // edge stays visible past the cursor.
          width: active ? 4 : 2,
        }}
      />
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
  // The offsetParent for the selection bar's anchor math (2026-08-18 round
  // 3): the bar is absolutely positioned INSIDE this div at the anchor
  // word's offsetTop/offsetLeft, so it scrolls with the content.
  position: "relative",
  // Inter has no Arabic coverage; without an explicit Arabic-capable stack
  // an Urdu transcript rendered in whatever the OS picked. Nastaliq first
  // (registered by the effect above when the bundled font is served), then
  // the platforms' own Arabic faces.
  fontFamily: "'Inter', 'Noto Nastaliq Urdu', 'Geeza Pro', 'Noto Naskh Arabic', system-ui, sans-serif",
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
  // Wider than the original 1px 2px: short Urdu words made tiny hit targets.
  padding: "2px 4px",
  // Each word is its own bidi run, so an embedded Latin loanword or digit
  // run cannot visually reorder its neighbors — visual word order per
  // wrapped line equals logical (DOM) order, mirrored under rtl, and the
  // click lands on the word the eye targets. The literal spaces (the §65
  // wrap fix — now the TRAILING character inside each span, 2026-08-18
  // round 3) stay directionally neutral inside the isolates and remain
  // line-break opportunities.
  unicodeBidi: "isolate",
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

/** The word under the playhead — an underline ALWAYS (2026-08-18 round 3),
 * never a background or outline: the old dark box + blue outline vanished
 * against (and visually fought) the selection band, and ONE scheme that
 * composes with the selected/match/edited backgrounds beats per-state
 * variants. Known cost: while the playhead sits ON a hidden word, the
 * underline replaces its strike-through for that moment (single-property
 * textDecoration) — transient and accepted. */
const currentStyle: React.CSSProperties = {
  textDecoration: "underline",
  textUnderlineOffset: 4,
};

/** Selected range — ONE continuous yellow band (2026-08-18 round 3, the
 * Opus look): the inter-word space renders INSIDE each span now, so the
 * gaps paint too. Deliberately NO outline and radius 0: per-word outlines
 * plus unstyled gaps at lineHeight 2 read as a checkerboard field, not a
 * selection, and rounded corners re-stripe the band at every span edge. */
const selectedStyle: React.CSSProperties = {
  background: "#FFE14D",
  color: "#111",
  borderRadius: 0,
};

/** Hidden from the captions (§59b, revisited 2026-08-18): struck-through and
 * dimmed but still rendered — the transcript keeps the word (it is still in
 * the audio), only the caption stream loses it. */
const hiddenStyle: React.CSSProperties = {
  textDecoration: "line-through",
  color: "#6a6a75",
};

/** A word carrying a stored timing nudge — a dotted BORDER, deliberately not
 * textDecoration: underline is the playhead marker (`currentStyle`) and
 * line-through the hide marker (`hiddenStyle`), and textDecoration is a
 * single property — a second consumer would clobber whichever got there
 * first. A border composes with both. */
const timedWordStyle: React.CSSProperties = {
  borderBottom: "1px dotted #9A9AA3",
};

/** The handle's hit zone width, px — the grip inside it is 2px. */
const TIMING_HANDLE_W = 12;

/** A timing drag handle over the canvas: a transparent hit zone centring its
 * grip. `touchAction: none` so a touch drag nudges the handle instead of
 * scrolling the transcript body under it. */
const timingHandle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  width: TIMING_HANDLE_W,
  height: TIMING_CANVAS_H,
  cursor: "ew-resize",
  touchAction: "none",
  display: "flex",
  justifyContent: "center",
};

/** The pan target: the whole area BETWEEN the two handles. Transparent — the
 * canvas already paints the highlighted span under it, and a second fill
 * would double the tint. `touchAction: none` for the same reason the handles
 * set it: a touch pan must move the run, not scroll the transcript body. */
const timingBand: React.CSSProperties = {
  position: "absolute",
  top: 0,
  height: TIMING_CANVAS_H,
  touchAction: "none",
};

/** The VISIBLE part of a handle — the line the canvas draw already paints at
 * the span's edge, redrawn here so hover and drag can light it up. */
const timingGrip: React.CSSProperties = {
  height: "100%",
  borderRadius: 1,
  pointerEvents: "none",
};

const hintRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  justifyContent: "space-between",
};

/** The `?` toggle — deliberately smaller than the search chevrons: it is a
 * footnote marker, not a control anyone reaches for twice. */
const helpToggle: React.CSSProperties = {
  width: 20,
  height: 20,
  fontSize: 11,
  lineHeight: 1,
  color: "#9A9AA3",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

/**
 * The shared surface of every anchored thing: the bar, the delete flyout,
 * the range editor and the timing popover all spread this and override only
 * layout, so one edit moves the whole family together.
 *
 * ABSOLUTE, not fixed (2026-08-18 round 3): the anchor is a positioned parent
 * (the body is `position: relative`), so the bar scrolls with the content.
 * zIndex above the word spans, below the modal backdrops (40) — same ordering
 * argument as App's menu.
 *
 * Lifted off the panel in round 5: at #1A1A21 on the panel's #111116 the bar
 * read as a patch of background with buttons on it, and it sits beside a
 * SATURATED yellow selection band that out-shouts everything. A lighter
 * surface (#262630) with a visible edge (#3A3A47) and a real drop shadow puts
 * it convincingly ABOVE the page without adding a second bright element —
 * the depth does the work the colour must not.
 */
const floatingMenu: React.CSSProperties = {
  position: "absolute",
  zIndex: 31,
  background: "#262630",
  border: "1px solid #3A3A47",
  borderRadius: 10,
  padding: "4px 6px",
  // Two shadows: a long soft one for the lift off the page, a tight one to
  // seat the edge — a single large blur alone reads as a smudge on a dark UI.
  boxShadow: "0 14px 34px rgba(0,0,0,0.66), 0 2px 6px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 2,
};

/** The Delete ▾ options — two rows under the bar's Delete slot. The bar's own
 * surface, a level above it so it paints over the words below the bar. */
const deleteFlyout: React.CSSProperties = {
  ...floatingMenu,
  top: "100%",
  left: 0,
  marginTop: 4,
  zIndex: 32,
  minWidth: 170,
  flexDirection: "column",
  alignItems: "stretch",
};

const menuLabel: React.CSSProperties = {
  fontSize: 11,
  color: "#9A9AA3",
  // LOGICAL, not the physical `0 8px 0 6px` it was: the count sits at the
  // END of the row, and under an rtl base the physical padding put its
  // breathing room on the wrong side of the label.
  paddingInline: "6px 8px",
  whiteSpace: "nowrap",
};

/** App.tsx's menuItem, compacted into a bar chip — nowrap so the row never
 * folds mid-label. Roomier than round 3's `6px 8px`: on the lifted surface
 * the labels sat tight against each other with nothing to separate them, and
 * padding is the separator that costs no ink. */
const menuItem: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#EDEDF2",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const rangeTextarea: React.CSSProperties = {
  // Same Arabic-capable stack as `editInput` — the rewrite box for an Urdu
  // run must render in the face the words wore.
  fontFamily: "'Inter', 'Noto Nastaliq Urdu', 'Geeza Pro', 'Noto Naskh Arabic', system-ui, sans-serif",
  fontSize: 13,
  width: 280,
  background: "#0F0F14",
  border: "1px solid #FFE14D",
  borderRadius: 4,
  color: "#fff",
  padding: "4px 6px",
  resize: "vertical",
};

/** The popovers' Apply/Cancel/Play row. Its fill and border are a step
 * LIGHTER than the surface (`floatingMenu`) — at the old #1A1A21/#2A2A33 the
 * buttons matched the popover they sat on and read as flat labels, which on
 * the Apply of a destructive-ish edit is the wrong thing to be invisible. */
const toolbarButton: React.CSSProperties = {
  fontSize: 11,
  color: "#EDEDF2",
  background: "#34343F",
  border: "1px solid #45454F",
  borderRadius: 6,
  cursor: "pointer",
  padding: "4px 8px",
};

const editInput: React.CSSProperties = {
  // Same Arabic-capable stack as the body: Inter has no Arabic coverage, so
  // the retype box for an Urdu word rendered in whatever fallback face the
  // OS picked — different from the word it sat in place of.
  fontFamily: "'Inter', 'Noto Nastaliq Urdu', 'Geeza Pro', 'Noto Naskh Arabic', system-ui, sans-serif",
  fontSize: 13,
  width: 110,
  background: "#0F0F14",
  border: "1px solid #FFE14D",
  borderRadius: 4,
  color: "#fff",
  padding: "1px 4px",
};
