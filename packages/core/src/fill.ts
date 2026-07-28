import type { SceneCue } from "./scene-schema";

/**
 * Fill the gaps between graphic cues with PLAIN cues, one per continuous take
 * (PLAN 2026-07-30 Task A).
 *
 * Cues are deliberately sparse today — a gap renders as the implicit
 * full-bleed talking head — which leaves most of the video unreachable by any
 * per-scene control: `cue.video` framing only applies where a cue is active.
 * Filling the timeline is what makes framing (Task B) work everywhere, and it
 * is why a deleted scene's window (Task C) becomes an editable take instead of
 * a hole.
 *
 * Each gap is SPLIT at every cut boundary strictly inside it, so a plain cue
 * never straddles a cut: the zoom ramp (`zoom.ts`) and `EdlVideo`'s punch-in
 * already key off those same boundaries, and a block that crossed one would
 * pretend two takes are one shot.
 *
 * ID STABILITY, stated honestly: ids derive from (graphic cue windows, clip
 * starts) — `take-<clipIndex>` for a clip's first plain piece, suffixed
 * `take-<clipIndex>-<k>` only for the later pieces graphics split off. So
 * deleting a graphic that had split a take MERGES two pieces back into one:
 * the merged piece keeps the unsuffixed name (any override on it survives),
 * and an override on the vanished suffix becomes an ORPHAN — an
 * already-reported condition (`applyOverrides`), never a silent loss. The
 * alternative, time-keyed ids, would instead drift on every re-cut.
 */

/** Pieces under this are dropped: the assembler's 0.05s breathing gaps must
 * not become blocks, and the renderer's implicit full-bleed already covers
 * them identically. */
export const MIN_PLAIN_SEC = 0.6;

export interface FillPlainOptions {
  outputDurationSec: number;
  /** Output-time starts of each kept span (`spans[].outIn`) — the cuts. */
  clipStarts?: readonly number[];
}

/** Clip starts cleaned the same way the zoom planner cleans them: in range,
 * unique, sorted, always including 0 — so both layers agree on where a take
 * begins. */
function cleanStarts(starts: readonly number[] | undefined, duration: number): number[] {
  const seen = new Set<number>([0]);
  for (const t of starts ?? []) {
    if (Number.isFinite(t) && t > 0 && t < duration) seen.add(t);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Merge graphic cues with derived plain cues covering every gap; returns the
 * union, time-sorted. Input must be the GRAPHIC cues (override-applied,
 * hidden ones already dropped) — feeding an already-filled list back in would
 * treat the previous fill's takes as occupied windows.
 */
export function fillPlainCues(
  cues: readonly SceneCue[],
  opts: FillPlainOptions,
): SceneCue[] {
  const duration = opts.outputDurationSec;
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  if (duration <= 0) return sorted;
  const starts = cleanStarts(opts.clipStarts, duration);

  // Gaps: before the first cue, between consecutive ones, after the last.
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cue of sorted) {
    if (cue.startSec - cursor > 1e-9) gaps.push({ start: cursor, end: cue.startSec });
    cursor = Math.max(cursor, cue.endSec);
  }
  if (duration - cursor > 1e-9) gaps.push({ start: cursor, end: duration });

  // Split each gap at every cut strictly inside it, then drop slivers.
  const pieces: Array<{ start: number; end: number; clip: number }> = [];
  for (const gap of gaps) {
    const inner = starts.filter((t) => t > gap.start + 1e-9 && t < gap.end - 1e-9);
    const bounds = [gap.start, ...inner, gap.end];
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i]!;
      const end = bounds[i + 1]!;
      if (end - start < MIN_PLAIN_SEC) continue;
      // The clip this piece belongs to: the last cut at or before its start.
      let clip = 0;
      for (let c = 0; c < starts.length; c++) {
        if (starts[c]! <= start + 1e-9) clip = c;
      }
      pieces.push({ start, end, clip });
    }
  }

  // Per-clip ordinals: the first piece of a clip keeps the bare name, so a
  // merge (a graphic deleted) lands back on an id that may already carry an
  // override.
  const perClip = new Map<number, number>();
  const plain: SceneCue[] = pieces.map((p) => {
    const k = perClip.get(p.clip) ?? 0;
    perClip.set(p.clip, k + 1);
    return {
      id: k === 0 ? `take-${p.clip}` : `take-${p.clip}-${k}`,
      kind: "plain",
      layout: "full-bleed",
      startSec: p.start,
      endSec: p.end,
    };
  });

  return [...sorted, ...plain].sort((a, b) => a.startSec - b.startSec);
}
