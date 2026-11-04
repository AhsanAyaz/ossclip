import { REVEAL_SPEED_DEFAULT, syncDecision } from "@ossclip/core/browser";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { enterFrames, enterProgress } from "./anim";

/**
 * One reveal schedule for every staggered graphic (reveal-timing spec §4):
 * FlowDiagram, ChatMock, TerminalMock and StrikethroughReveal all ask this
 * when item i enters instead of hand-writing `i * 6`. Pure — frames in,
 * frames out — so every mode and curve is tested without a React tree;
 * `useReveal` below is the only part that touches Remotion.
 */

export interface RevealInput {
  count: number;
  /** The component's historical stagger (6 or 8 frames) — the legacy path. */
  legacyStepFrames: number;
  fps: number;
  durationInFrames: number;
  /** The cue's FINAL start, output seconds (after floor / de-overlap / pins). */
  cueStartSec: number;
  /** `SceneCue.reveal.itemAtSec`: absolute output seconds per item, null = unmatched. */
  itemAtSec?: readonly (number | null)[];
  /**
   * Already parsed by the component's registry schema upstream, so these are
   * read as-is; an unrecognised value simply means "the default".
   */
  props: { reveal?: string; pacing?: string; revealSpeed?: number };
}

/**
 * Pacing curve: share of the reveal window elapsed at item position x ∈ [0,1].
 * Gaps between items follow the curve's slope.
 */
function curve(pacing: string | undefined, x: number): number {
  switch (pacing) {
    // Long first gap, then quicker (spec §4): slope 2(1-x) shrinks.
    case "accelerate":
      return 1 - (1 - x) ** 2;
    // Quick, then a held pause before the last items: slope 2x grows.
    case "decelerate":
      return x ** 2;
    // Slow at both ends: slope 1 + 0.6·cos(2πx) is 1.6 at the ends and 0.4
    // mid-way, so the outer gaps are ~4x the middle ones. k < 1 keeps it
    // monotonic — items never reorder.
    case "ease-in-out":
      return x + (0.6 * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);
    default:
      return x;
  }
}

function pacedFrames(count: number, windowFrames: number, pacing: string | undefined): number[] {
  if (count <= 1) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, i) =>
    Math.round(curve(pacing, i / (count - 1)) * windowFrames),
  );
}

/**
 * Per-item entrance delay in frames from the cue's first frame, each ≥ 0.
 * Three paths, in order:
 *  - legacy: no item times and no timing prop → `i * legacyStepFrames`
 *    exactly, so every scene rendered before reveal timing is untouched
 *    (plan Review Focus 5). `entrance` is deliberately NOT a timing prop —
 *    it is a style, and picking `fade` must not also re-time the items.
 *  - synced: forced, or `auto` with item times the shared `syncDecision`
 *    accepts — the same rule plan time used, never a restated threshold.
 *  - paced: everything else, spread over `revealSpeed × (duration − one
 *    entrance)`.
 */
export function revealFrames(input: RevealInput): number[] {
  const { count, legacyStepFrames, fps, durationInFrames, cueStartSec, props } = input;
  // A length mismatch means the items were edited after matching; applying
  // the times anyway would put item i on item j's word. Absent is safer.
  const timingTouched =
    props.reveal !== undefined || props.pacing !== undefined || props.revealSpeed !== undefined;
  if (input.itemAtSec === undefined && !timingTouched) {
    return Array.from({ length: count }, (_, i) => i * legacyStepFrames);
  }
  // Present-but-wrong-length still marks a NEW plan: the items were edited
  // after matching, and new items added in the editor are paced (spec §7).
  // So it reads as all-unmatched — paced — never as legacy, and never
  // applied as-is (that would put item i on item j's word).
  const itemAtSec =
    input.itemAtSec === undefined || input.itemAtSec.length === count
      ? input.itemAtSec
      : Array.from({ length: count }, () => null);

  // Every item must FINISH entering before the cut, so the latest a delay
  // may be is one entrance short of the end; a scene shorter than one
  // entrance starts everything at 0.
  const latest = Math.max(0, durationInFrames - enterFrames(fps));
  const clamp = (f: number): number => Math.min(latest, Math.max(0, Math.round(f)));

  const windowFrames = (props.revealSpeed ?? REVEAL_SPEED_DEFAULT) * latest;
  const paced = pacedFrames(count, windowFrames, props.pacing).map(clamp);

  const anyMatched = itemAtSec?.some((t) => t !== null) ?? false;
  const synced =
    itemAtSec !== undefined &&
    props.reveal !== "paced" &&
    // Forced synced falls back to paced per FAILED item (spec §5) — with
    // nothing matched at all, that is simply all paced.
    (props.reveal === "synced" ? anyMatched : syncDecision(itemAtSec) === "synced");
  if (!synced) return paced;

  return syncedFrames(itemAtSec, fps, cueStartSec, windowFrames, count).map(clamp);
}

/**
 * Matched items sit on their words; unmatched ones are placed relative to
 * the matched ones so the order never breaks:
 *  - between two matches → linear interpolation;
 *  - after the last match → keep going at the even paced gap;
 *  - before the first match (forced synced only — `auto` requires item 0 to
 *    match) → spread from the cue start up to that match.
 */
function syncedFrames(
  itemAtSec: readonly (number | null)[],
  fps: number,
  cueStartSec: number,
  windowFrames: number,
  count: number,
): number[] {
  // Unrounded, unclamped frames for matched items: interpolating between
  // rounded/clamped values would skew neighbours of a pre-start word.
  const raw = itemAtSec.map((t) => (t === null ? null : (t - cueStartSec) * fps));
  const matched = raw.flatMap((f, i) => (f === null ? [] : [i]));
  const first = matched[0]!;
  const last = matched[matched.length - 1]!;
  const gap = count > 1 ? windowFrames / (count - 1) : 0;

  const frames = raw.map((f, i) => {
    if (f !== null) return f;
    if (i < first) return (Math.max(0, raw[first]!) * i) / first;
    if (i > last) return raw[last]! + gap * (i - last);
    const prev = matched.filter((m) => m < i).at(-1)!;
    const next = matched.find((m) => m > i)!;
    return raw[prev]! + ((raw[next]! - raw[prev]!) * (i - prev)) / (next - prev);
  });
  // Unrounded: the caller rounds and clamps — a word said before the final
  // start (floor / de-overlap moved it later) to frame 0, a late word or a
  // trailing null to the last frame an entrance can still finish by.
  return frames;
}

/** Per-item entrance progress 0→1 for a schedule from `revealFrames`. */
export function useReveal(delays: readonly number[]): number[] {
  // One frame read for the whole list, then a pure map: the item count is
  // NOT fixed for a mounted cue (an editor prop patch adds or removes a chip
  // live), so a hook per item would change the hook count between renders.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return delays.map((d) => enterProgress(frame, fps, d));
}
