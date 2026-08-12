import { backfillSrcStart, type CaptionLine, type KeptSpan } from "@ossclip/core/browser";

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
 * NO SPANS, NO REPAIR — the constraint carried from Task 1's review, and the
 * reason this is not a one-line call at the fetch. `mapFromKeptSpans([])`
 * yields an empty map whose `toSource` returns 0 for every input, so a
 * spans-less file would backfill the ENTIRE video onto one anchor `w0`, under
 * which a single stored edit rewrites the first word it meets and reports
 * nothing. That is the same one-shared-key failure `captionKeyFor` refuses for
 * `NaN`, dressed up as a successful migration. Anchorless words are the honest
 * outcome instead: they simply cannot carry an edit, and every edit that then
 * finds no home is REPORTED by `applyCaptionEdits`.
 *
 * Pure — the caller owns the fetch.
 */
export function anchorCaptionLines(props: CaptionAnchorSource): AnchoredCaptionLines {
  const spans = props.spans;
  if (spans === undefined || spans.length === 0) return {};
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
