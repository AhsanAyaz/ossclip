import {
  cleanupVetoable,
  vetoedRemovals,
  type CleanupChoices,
  type KeptSpan,
  type RemovalReason,
  type Segment,
} from "@ossclip/core/browser";
import { sourceToOutputClamped } from "./timing";

/**
 * One removal from produce's cutlist, resolved to where it shows on the
 * timeline (cut review step 2, toggleable since step 3). An APPLIED removal
 * occupies zero width in OUTPUT time — it is a seam between two kept spans,
 * not a band — so all the timeline needs is an output-time position, a
 * colour, and a label. Since step 3 the cutlist here is the PROPOSAL
 * (`production.cutlistProposed` via GET /api/cleanup), so a VETOED removal
 * still has a seam — hollow/dimmed, saying it comes back on the next render.
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
  /**
   * Whether a click may toggle this removal's veto (cut review step 3) —
   * core's `cleanupVetoable`, carried onto the seam so the Timeline never
   * attaches a handler that would write an inert `kept` entry for a `user`
   * or `clip` span (`applyCleanupChoices` skips those by contract).
   */
  vetoable: boolean;
  /**
   * The user has DECLINED this removal (category switch or individual veto)
   * — computed through core's `vetoedRemovals`, the same predicate produce
   * re-keeps with, so the seam can never show a veto the render would not
   * honour. Marks rather than applies: the current preview still plays the
   * cut; the material returns on the next produce/Render.
   */
  vetoed: boolean;
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
  choices?: CleanupChoices,
): RemovalSeam[] {
  if (spans.length === 0) return [];
  // Core's own predicate (cut review step 3), by segment identity over this
  // very array — the one implementation produce re-keeps with, so the seam
  // state and the render cannot disagree.
  const vetoed = new Set(vetoedRemovals(cutlist, choices));
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
      vetoable: cleanupVetoable(seg.reason),
      vetoed: vetoed.has(seg),
    });
  }
  return seams;
}

/** The panel checkbox's noun — plural, sentence-leading ("Pauses — 14
 * removals · 31.2s"). TOTAL over the vocabulary like `REMOVAL_REASON_COLOR`,
 * and for the same reason: a new reason must fail typecheck here, not render
 * a checkbox with no name. `user`/`clip` get labels for completeness even
 * though `cleanupReasonSummaries` never surfaces them (they are not
 * vetoable). */
export const REMOVAL_REASON_LABEL: Record<RemovalReason, string> = {
  silence: "Silences",
  pause: "Pauses",
  filler: "Fillers",
  retake: "Retakes",
  user: "Your cuts",
  clip: "Clip window",
};

/** One CleanupPanel checkbox row: a VETOABLE reason present in the proposal,
 * with what declining it would restore. */
export interface CleanupReasonSummary {
  reason: RemovalReason;
  /** How many removal spans carry this reason. */
  count: number;
  /** Their summed SOURCE duration — what "keep all" restores, in seconds. */
  seconds: number;
}

/**
 * Per-reason totals over the proposal's removals — the CleanupPanel's rows.
 * Only reasons PRESENT get a row (never a dead checkbox for an absent
 * reason), and only VETOABLE ones (`cleanupVetoable`): a checkbox for `user`
 * or `clip` would offer a decline `applyCleanupChoices` is contracted to
 * ignore. Rows come out in the colour map's vocabulary order, so the panel
 * is stable across runs whatever order the spans sit in.
 */
export function cleanupReasonSummaries(cutlist: readonly Segment[]): CleanupReasonSummary[] {
  const byReason = new Map<RemovalReason, CleanupReasonSummary>();
  for (const seg of cutlist) {
    if (seg.kind !== "remove" || seg.reason === undefined || !cleanupVetoable(seg.reason)) continue;
    if (seg.srcOut <= seg.srcIn) continue;
    const entry = byReason.get(seg.reason) ?? { reason: seg.reason, count: 0, seconds: 0 };
    entry.count += 1;
    entry.seconds += seg.srcOut - seg.srcIn;
    byReason.set(seg.reason, entry);
  }
  return (Object.keys(REMOVAL_REASON_COLOR) as RemovalReason[])
    .map((reason) => byReason.get(reason))
    .filter((s): s is CleanupReasonSummary => s !== undefined);
}
