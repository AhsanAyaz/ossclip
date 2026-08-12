import {
  backfillSrcStart,
  captionAnchorOf,
  mapFromKeptSpans,
  type CaptionLine,
  type KeptSpan,
} from "@ossclip/core/browser";

/**
 * The parts of `render-props.json` the caption repair reads. Deliberately NOT
 * `RawRenderProps` (App.tsx): stating the three fields keeps this testable
 * without standing up a whole production, and keeps the pure decision out of
 * the component that owns the fetch.
 */
export interface CaptionAnchorSource {
  captionLines?: CaptionLine[];
  /** The pristine pre-edit lines, when the workdir is new enough to have them. */
  baseCaptionLines?: CaptionLine[];
  /** The kept spans the same file carries — the map the projection runs through. */
  spans?: KeptSpan[];
}

/** Only the keys that actually changed, so the caller can spread it. */
export type AnchoredCaptionLines = Omit<CaptionAnchorSource, "spans">;

/**
 * Give every caption word a source anchor before anything derives a key from
 * it (§137).
 *
 * `render-props.json` predates `srcStart` and the editor loads it as an
 * unvalidated cast, so lines that TYPECHECK as `CaptionLine` still arrive
 * without the field on any workdir produced before this change. Nothing
 * downstream can address such a word — `applyCaptionEdits` skips it and
 * `migrateCaptionKeys` resolves nothing — so a retype would appear to work and
 * silently revert, which is the field case this plan exists to remove. This is
 * the one place on the load path where the file's own `spans` are still in
 * hand to recover it from.
 *
 * BOTH line sets are repaired. App.tsx merges edits onto
 * `baseCaptionLines ?? captionLines`, so leaving the base side unanchored
 * would break the edits at exactly the point they are applied.
 *
 * NO USABLE MAP, NO REPAIR — the constraint carried from Task 1's review, and
 * the reason this is not a one-line call at the fetch. An empty `TimeMap`'s
 * `toSource` returns 0 for every input, so backfilling through one would put
 * the ENTIRE video on a single anchor `w0`, under which one stored edit
 * rewrites the first word it meets and reports nothing. That is the same
 * one-shared-key failure `captionKeyFor` refuses for `NaN`, dressed up as a
 * successful migration.
 *
 * The verdict is taken from the MAP, never from `spans.length` (§137 review):
 * `TimeMap`'s constructor DROPS any span with `srcOut <= srcIn`, so a
 * non-empty `[{srcIn: 5, srcOut: 5, …}]` builds an empty map and would have
 * walked straight through an array-length check into exactly the failure above.
 * `render-props.json` is consumed as an unvalidated cast, so that shape is
 * reachable from a hand-edited or truncated file.
 *
 * A constructor THROW (overlapping or backwards spans — the same file, the
 * same lack of a parse) is also "no repair". Escaping would matter: this is
 * the load path, and one of its two callers sits inside a render-poll catch
 * block whose recovery is to restart the interval — a deterministic throw
 * there would retry forever with `render.running` stuck true, which the Save
 * guard turns into a permanent save lockout with the user's unsaved edits
 * still in memory.
 *
 * The map built here is a PROBE, not the one that does the work: it is
 * discarded, and `backfillSrcStart` constructs its own from the same `spans`
 * (captions.ts). So the `try` below does not wrap the throw site that would
 * actually fire — it wraps a REHEARSAL of it. That is sound only because
 * `TimeMap`'s construction is deterministic and side-effect-free on identical
 * input: whatever this probe survives, the real construction survives too, and
 * whatever it throws on never reaches the real one because we return first.
 * Written down rather than tidied away, because it is the assumption the
 * safety of this function rests on (§137 review round 2 — an earlier version
 * of this comment claimed the map was built once, which it is not).
 *
 * Anchorless words are the honest outcome in every one of these cases: they
 * simply cannot carry an edit, and every edit that then finds no home is
 * REPORTED by `applyCaptionEdits`.
 *
 * Pure — the caller owns the fetch.
 */
export function anchorCaptionLines(props: CaptionAnchorSource): AnchoredCaptionLines {
  const spans = props.spans;
  if (spans === undefined) return {};
  let kept: number;
  try {
    // Probe only — see the "PROBE, not the one that does the work" paragraph
    // above before assuming this map is reused.
    kept = mapFromKeptSpans(spans).spans.length;
  } catch {
    return {};
  }
  if (kept === 0) return {};
  const out: AnchoredCaptionLines = {};
  // Each key is set only when the file actually has it, so the result stays
  // safe to spread over the raw props: writing `baseCaptionLines: undefined`
  // would be indistinguishable from the absent key to a reader, and App.tsx's
  // `baseCaptionLines ?? captionLines` fallback depends on the difference
  // being invisible only by accident.
  if (props.captionLines) out.captionLines = backfillSrcStart(props.captionLines, spans);
  if (props.baseCaptionLines) {
    out.baseCaptionLines = backfillSrcStart(props.baseCaptionLines, spans);
  }
  return out;
}

/**
 * The source anchor a caption word's `data-caption-src` attribute carries, or
 * `null` when it carries none (§137).
 *
 * The DOM is the only channel between `CaptionTrack` (which renders inside the
 * Player) and `Overlay` (which hit-tests it and holds no caption lines), so
 * this is where an anchor re-enters the editor as a string. The verdict is
 * delegated to core's `captionAnchorOf` rather than re-tested here: that is the
 * single definition of "is this word anchorable", and the emitting side already
 * gates on it. A second, hand-rolled finiteness check in this exact path is how
 * the two would drift — and this path must never hand a non-finite value to
 * `captionKeyFor`, which throws, from a React event handler with no error
 * boundary above it.
 *
 * `Number("")` is 0, not NaN, so an empty attribute is excluded explicitly
 * rather than left to look like a real anchor at the start of the source.
 */
export function captionSrcFromAttribute(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const srcStart = Number(raw);
  // Only `srcStart` is read by `captionAnchorOf`; the rest of the shape is
  // what the DOM does not carry and does not need to.
  return captionAnchorOf({ text: "", start: 0, end: 0, srcStart }) === null ? null : srcStart;
}
