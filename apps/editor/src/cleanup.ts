import type { KeptSpan, RemovalReason, Segment } from "@ossclip/core/browser";
import { sourceToOutputClamped } from "./timing";

/**
 * One removal from produce's cutlist, resolved to where it shows on the
 * timeline (cut review step 2). An APPLIED removal occupies zero width in
 * OUTPUT time — it is a seam between two kept spans, not a band — so all the
 * timeline needs is an output-time position, a colour, and a label. Display
 * only: nothing here is clickable or writable in this step.
 */
export interface RemovalSeam {
  /** SOURCE range produce removed — identity for keys/testids, stable across recuts. */
  srcIn: number;
  srcOut: number;
  reason: RemovalReason | undefined;
  /** Where the seam sits in the CURRENT output, seconds. */
  outSec: number;
  /** Hover text: reason + how much source time is gone. */
  label: string;
  color: string;
  /**
   * Position within the group of seams sharing this output instant. Adjacent
   * removals with different reasons collapse to the SAME output position
   * (both are cut, so both clamp to the one seam their neighbouring kept
   * spans share) — the caller offsets each by `stackIndex` so every removal
   * stays individually hoverable instead of the last one painted winning.
   */
  stackIndex: number;
}

/**
 * Reason → seam colour, TOTAL over the vocabulary on purpose: a `Record`
 * keyed by the full `RemovalReason` union means adding a reason to
 * `RemovalReasonSchema` fails typecheck here instead of silently drawing an
 * unstyled seam. Hues sit in the editor's existing dark-UI palette lane
 * (selection blue #5b8cff, restore red #FF5C5C, snap yellow #FFE14D) without
 * colliding with any of those three — a removal seam must not read as
 * "selected", "restorable cut", or "snap target" at a glance.
 */
export const REMOVAL_REASON_COLOR: Record<RemovalReason, string> = {
  silence: "#4DA3FF",
  pause: "#B78CFF",
  filler: "#FFB84D",
  retake: "#FF7AB8",
  user: "#6BDD8B",
  clip: "#4DDCD4",
};

/** A `remove` span the producer wrote without a reason — the schema allows
 * it, so the display must too. Neutral grey, matching the ghost/plain-label
 * grey family rather than inventing a seventh reason hue. */
export const REMOVAL_NO_REASON_COLOR = "#8a8a95";

/** "pause · 2.3s removed" — reason first (the fact the colour encodes),
 * duration in SOURCE seconds (output duration of a removal is zero by
 * definition, so source is the only duration that means anything). */
export function removalLabel(seg: Pick<Segment, "srcIn" | "srcOut" | "reason">): string {
  const dur = `${(seg.srcOut - seg.srcIn).toFixed(1)}s removed`;
  return seg.reason ? `${seg.reason} · ${dur}` : dur;
}

/** Two seams within this of each other share one visual position — below any
 * plausible px at any zoom, so it only catches genuine coincidence. */
const SAME_SEAM_EPS = 1e-6;

/**
 * Resolve every `remove` span in the cutlist to a positioned, labelled seam.
 *
 * Position comes from `sourceToOutputClamped` over the CURRENT render-props'
 * spans — the same lookup the applied-cut restore seam uses (Timeline's
 * `cuts.map`, PLAN 2026-08-04 Task 4c), NOT a rebuilt client-side cutlist:
 * this answers "where does this removal's edge land today", nothing about
 * reshaping the timeline. A removal between two kept spans clamps to exactly
 * the output boundary those spans share; a removal before the first kept
 * span clamps to 0.
 *
 * Empty `spans` returns NO seams at all, per the same rule the restore seam
 * pinned: `sourceToOutputClamped([], …)` answers 0 as a fallback, not a
 * position, and a marker painted at the timeline's very start off that
 * fallback would be misleading rather than merely absent.
 */
export function removalSeams(
  cutlist: readonly Segment[],
  spans: readonly KeptSpan[],
): RemovalSeam[] {
  if (spans.length === 0) return [];
  const seams: RemovalSeam[] = [];
  for (const seg of cutlist) {
    // Zero-width removes carry no material — nothing was removed there, so
    // there is nothing to disclose. (The partition can hold them legally.)
    if (seg.kind !== "remove" || seg.srcOut <= seg.srcIn) continue;
    const outSec = sourceToOutputClamped(spans, seg.srcIn);
    // Stack against everything already placed at this instant. Cutlists are
    // small (tens of spans), so the linear scan beats bookkeeping a map.
    const stackIndex = seams.filter((s) => Math.abs(s.outSec - outSec) < SAME_SEAM_EPS).length;
    seams.push({
      srcIn: seg.srcIn,
      srcOut: seg.srcOut,
      reason: seg.reason,
      outSec,
      label: removalLabel(seg),
      color: seg.reason ? REMOVAL_REASON_COLOR[seg.reason] : REMOVAL_NO_REASON_COLOR,
      stackIndex,
    });
  }
  return seams;
}
