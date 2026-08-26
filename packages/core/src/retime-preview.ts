/**
 * The editor's live post-veto preview (cut review step 4): when the user
 * declines a removal produce proposed, the preview's own timeline is re-cut
 * so the player actually PLAYS the revived material, immediately, instead of
 * marking a seam that only the next render honours.
 *
 * Vetoes ADD time back and live cuts REMOVE it, and since the cut-review
 * rework (2026-08-26) BOTH play immediately. The old "the editor never
 * applies a cut" premise is retired with the ban it rested on: a fresh cut's
 * `src` is no longer produce's alone to resolve — the writer resolves it at
 * the gesture, on the very clock this module hands it (`toSourceSec` /
 * `oldToSourceSec`), and the schema now says the editor MAY write it
 * (`OverrideDocSchema.cuts`, overrides.ts). So `src` present doubles as
 * "live-applied": those ranges subtract here and the material genuinely
 * stops playing. A `src`-LESS entry is the legacy marked-only shape and is
 * still never applied — the struck band communicates it, byte-identically to
 * before.
 *
 * Pure and browser-safe by construction (the cover-headline.ts split): this
 * module's whole import graph — cutlist, recut, timemap, and types — has
 * zero node built-ins, so it rides `@ossclip/core/browser` into the editor
 * bundle, and every function here is testable without a TTY or a filesystem.
 */

import type { CaptionLine } from "./captions";
import { applyCleanupChoices, type CleanupChoices } from "./cutlist";
import { remapPoint, subtractRangesFromCutlist, type UserCut } from "./recut";
import type { SceneCue } from "./scene-schema";
import type { Segment } from "./schema";
import { mapFromKeptSpans, mapsClose, TimeMap, type KeptSpan } from "./timemap";
import type { ZoomSegment } from "./zoom";

/** `applyUserCuts`'s EPS — a JSON round-trip plus TimeMap arithmetic is
 * noise, a real veto is never under a millisecond. */
const EPS = 1e-6;

/** Both clocks the retime needs: the one the current render-props are timed
 * against, and the one the user's cleanup choices produce. */
export interface LivePreviewClocks {
  oldMap: TimeMap;
  newMap: TimeMap;
}

/**
 * Whether the current cleanup choices change the timeline at all — and the
 * two clocks to retime through when they do. `null` is the identity signal:
 * the caller must hand the props through UNTOUCHED (the regression anchor —
 * a doc with no live veto must leave the preview byte-identical to today's).
 *
 * The new clock is produce's own sequence, same functions, same order:
 * `applyCleanupChoices(proposal, choices)` then user cuts subtract from the
 * result (`subtractRangesFromCutlist`), so a user cut drawn over a vetoed
 * pause still cuts here exactly as it does in produce. Only cuts carrying a
 * `src` subtract, and since the cut-review rework that is the LIVE-APPLIED
 * set, not just produce's own past resolutions: the editor's cut writers now
 * resolve `src` at the gesture (module doc), so a fresh cut removes its
 * material from the preview the moment it is made. A src-LESS entry is the
 * legacy marked-only shape and never subtracts. Skipping the subtraction
 * entirely would be worse than incomplete: every ALREADY-APPLIED cut (src
 * resolved by a past produce, absent from `oldSpans`) would silently come
 * back the moment any veto went live.
 *
 * A src cut ALONE opens the clocks (`hasLiveEdit`), which is what makes a cut
 * inside revived material previewable at all. With no cleanup proposal on
 * disk there is no partition to re-keep from, so the base cutlist becomes the
 * LAST RENDER's own spans as keep-only segments and the cuts subtract from
 * that — the honest base, and identity-safe: a cut a past produce already
 * applied is absent from those spans, subtracts nothing, and `mapsClose`
 * takes the null exit (`subtractRangesFromCutlist` is set-like).
 *
 * `null` on any degenerate input — no old spans, a veto with no proposal to
 * apply it to, choices with no actual veto and no src cut — and on a proposal
 * `TimeMap`'s constructor rejects (a hand-mangled production.json): the
 * preview degrades to step 3's honest marks-rather-than-applies, never a
 * crash, the same lenient posture as GET /api/cleanup itself.
 */
export function livePreviewMap(
  proposal: readonly Segment[],
  choices: CleanupChoices | undefined,
  cuts: readonly UserCut[],
  oldSpans: readonly KeptSpan[],
): LivePreviewClocks | null {
  // "Non-empty" means a veto actually present — a `reasons` map of tolerated
  // `true` entries restates the default (the schema comment) and must take
  // the cheap exact exit, not a float comparison of two equal maps.
  const hasVeto =
    Object.values(choices?.reasons ?? {}).some((v) => v === false) ||
    (choices?.kept?.length ?? 0) > 0 ||
    // A dismissal re-keeps content exactly like a veto does — the live
    // preview must play it (dismissedRemovals' doc: same render outcome,
    // different display state).
    (choices?.dismissed?.length ?? 0) > 0;
  const ranges = cuts.flatMap((c) =>
    c.src !== undefined && c.src.endSec > c.src.startSec
      ? [{ start: c.src.startSec, end: c.src.endSec }]
      : [],
  );
  // A src cut is a live edit in its own right now (the doc above) — the gate
  // is no longer "is a veto live" but "is ANY of this applied live".
  const hasLiveEdit = hasVeto || ranges.length > 0;
  if (!hasLiveEdit) return null;
  if (oldSpans.length === 0) return null;
  // A veto with no proposal to apply it to is still nothing to show — the
  // pre-rework early exit, kept explicit so that path stays byte-identical
  // rather than relying on the `mapsClose` exit below to reach the same null.
  if (proposal.length === 0 && ranges.length === 0) return null;
  try {
    // No proposal on disk → the last render's spans ARE the base partition
    // (keep-only): the cuts have to subtract from something, and this is the
    // one honest description of what is currently kept.
    const rekept =
      proposal.length > 0
        ? applyCleanupChoices(proposal, choices)
        : oldSpans.map((s) => ({ srcIn: s.srcIn, srcOut: s.srcOut, kind: "keep" as const }));
    const newMap = new TimeMap(subtractRangesFromCutlist(rekept, ranges));
    const oldMap = mapFromKeptSpans(oldSpans);
    // Choices that change nothing (a veto already baked into the last
    // produce's spans, a kept range overlapping no removal) are identity.
    if (mapsClose(oldMap, newMap, EPS)) return null;
    return { oldMap, newMap };
  } catch {
    return null;
  }
}

/**
 * The two clocks as POINT mappers, one per direction. `retimeForPreview`
 * below moves the player's PROPS onto the new clock in one batch, but the
 * editor also has surfaces that read or write a SINGLE instant at a gesture
 * — the transcript's click-to-seek, the timeline's ghost bands, the cover
 * panel's playhead — and each of those needs the same old-output → source →
 * new-output walk as a plain function it can be handed without knowing the
 * recut machinery behind it.
 */
export interface PreviewClockMappers {
  /** OLD-clock output seconds (the last render's own timeline — what the
   * render props, the ghost cues and the pre-retime caption lines are timed
   * in) → the clock the player is actually on. Exact for every VETO: those
   * only ever ADD time back, so every old moment survives on the new clock
   * (`retimeForPreview`'s direction argument). The clamp behind it is real,
   * not theoretical, in the two directions that REMOVE time: the
   * retracted-veto shape the retime already reports, and — since the
   * cut-review rework — an old instant a LIVE cut removed, which snaps to
   * the nearest surviving edge. The documented consumer of that clamp is
   * App.tsx's playhead-continuity effect (~:1204-1225): the playhead sitting
   * inside material the user just cut has to land SOMEWHERE, and the seam is
   * the closest honest answer. */
  toLive: (sec: number) => number;
  /** The reverse: the player's clock → the last render's own output seconds.
   * A live moment inside REVIVED material has no old-clock preimage at all —
   * the rendered mp4 never contained that frame — so it clamps to the
   * nearest kept edge (`toOutputClamped`'s documented role), the closest
   * moment the old clock can honestly name. */
  fromLive: (sec: number) => number;
  /** Whether a live instant EXISTS on the old clock at all — false exactly
   * when `fromLive` would have to clamp: the moment sits inside REVIVED
   * material (a vetoed removal the last render cut away). The WRITE-direction
   * guard (the follow-up to `fromLive`'s read direction): the doc's own time
   * slots speak the OLD clock (`splits[].at` per SplitSchema, a fresh cut's
   * `startSec`/`endSec` per the `cuts` schema comment — overrides.ts), and a
   * writer facing a moment this answers false for must refuse OUT LOUD
   * rather than let the clamp silently relocate the user's gesture to the
   * seam — the recut.ts "reported, never silently dropped" rule, applied
   * before the write instead of after. Asked as its own question, not an ad
   * hoc float comparison of `toLive(fromLive(sec))` against `sec` at some
   * caller-invented tolerance. An instant exactly AT a seam counts as HAVING
   * a preimage: `toOutput`'s containment is inclusive of both span edges
   * (timemap.ts), so the seam moment is one the last render still contained.
   * Always true for the identity pair — no veto, nothing revived. */
  hasOldClockPreimage: (sec: number) => boolean;
  /** Live-output → SOURCE seconds, or null when no conversion exists (the
   * identity case with no spans-backed fallback supplied). Exact under a
   * live veto (`newMap.toSource` is total on the player's own clock). The
   * split writer's anchor (`splits[].src`) and, since the cut-review rework,
   * the cut writers' too (`cuts[].src`, resolved at the gesture). */
  toSourceSec: ((sec: number) => number) | null;
  /** OLD-clock output → SOURCE seconds, or null when no conversion exists
   * (the identity case with no spans-backed fallback). `toSourceSec`'s
   * sibling for the surfaces whose windows are still timed against the LAST
   * RENDER rather than the player — the transcript panel's word windows, and
   * therefore `cutWords`' `src`. Exact under a live veto (`oldMap.toSource`
   * is total on the old clock). Reaching for `toSourceSec` there would
   * resolve the wrong source instant by exactly the revived seconds, which
   * is the whole class of bug the cut-review audit found. */
  oldToSourceSec: ((sec: number) => number) | null;
}

/**
 * The mappers for the current live re-cut — or the IDENTITY pair when there
 * is none (`clocks === null`, `livePreviewMap`'s own identity signal). The
 * identity is literally `(sec) => sec`, so a consumer's no-veto path computes
 * bit-identical values to what it computed before the mapping existed — the
 * same regression anchor the `live` memo's null branch holds to.
 */
export function previewClockMappers(
  clocks: LivePreviewClocks | null,
  opts: {
    /** Live-output → source when NO veto is live (`clocks === null`): the
     * identity clocks carry no map, and output seconds are NOT source
     * seconds, so the caller supplies the spans-backed conversion
     * (`mapFromKeptSpans(renderProps.spans).toSource`). Absent means
     * `toSourceSec` is null — a writer that needs source time then falls
     * back to old-clock-only behaviour rather than storing a lie. */
    identityToSource?: (sec: number) => number;
  } = {},
): PreviewClockMappers {
  if (clocks === null) {
    const identity = (sec: number): number => sec;
    return {
      toLive: identity,
      fromLive: identity,
      hasOldClockPreimage: () => true,
      toSourceSec: opts.identityToSource ?? null,
      // With no live re-cut the player's clock IS the last render's, so the
      // two source conversions are the same function — the same fallback,
      // never a second, differently-derived one.
      oldToSourceSec: opts.identityToSource ?? null,
    };
  }
  const { oldMap, newMap } = clocks;
  return {
    toLive: (sec) => {
      const src = oldMap.toSource(sec);
      return newMap.toOutput(src) ?? newMap.toOutputClamped(src);
    },
    fromLive: (sec) => {
      const src = newMap.toSource(sec);
      return oldMap.toOutput(src) ?? oldMap.toOutputClamped(src);
    },
    // `fromLive`'s exact half, asked as a question: `toOutput` is null
    // precisely when the source instant fell in a region the old map removed
    // — i.e. the live moment is inside revived material (its own doc comment
    // above pins the inclusive-seam semantics).
    hasOldClockPreimage: (sec) => oldMap.toOutput(newMap.toSource(sec)) !== null,
    // The SOURCE second under the live playhead — exact: `newMap` is the
    // very clock the player is on, and `toSource` is total. This is what
    // lets the editor write `splits[].src` directly (SplitSchema's
    // documented divergence from the cuts rule).
    toSourceSec: (sec) => newMap.toSource(sec),
    // The OLD clock's own source conversion — `oldMap`, not `newMap`: a
    // window that has not been retimed onto the player's clock (the
    // transcript panel's) must resolve through the map it was timed against.
    oldToSourceSec: (sec) => oldMap.toSource(sec),
  };
}

/** `cutRangeToOldClock`'s verdict on a live-clock window headed for a doc
 * `cuts[]` slot's HISTORICAL record. `exact`/`shrunk` carry OLD-clock seconds
 * ready to store; `shrunk` also carries a report (the `remapPoint` posture —
 * a moved value says so) for the caller's feedback channel; `degenerate`
 * means the window has NO old-clock extent at all: a writer that can resolve
 * `src` stores it with a clamped record anyway, one that cannot must refuse
 * out loud. */
export type OldClockCutRange =
  | { kind: "exact"; startSec: number; endSec: number }
  | { kind: "shrunk"; startSec: number; endSec: number; report: string }
  | { kind: "degenerate" };

/**
 * Convert a cut gesture's LIVE-clock window into the OLD-clock window a
 * `cuts[]` entry's `startSec`/`endSec` speak — since the cut-review rework
 * that is the HISTORICAL RECORD half of the write (the schema comment on
 * `OverrideDocSchema.cuts`: those two numbers describe the render-props the
 * user was looking at, and `src` is what is authoritative once present). It
 * is still the whole write for the two paths that have no `src` to offer:
 * a legacy src-less entry, whose range produce resolves through the PRIOR
 * TimeMap (so a new-clock number stored there would land the cut the revived
 * seconds off), and a writer whose source mapper is null (no spans, no live
 * map) — that one keeps the refusal, the pre-rework flow verbatim.
 *
 * Endpoints inside revived material clamp to the nearest kept edge
 * (`fromLive`'s doc): when only ONE edge clamps the range SHRINKS there and
 * the cut proceeds on what the old clock can express — the source range
 * produce resolves from the shrunk window still spans the revived material
 * BETWEEN the endpoints (a contiguous source interval), so only the revived
 * sliver past the clamped edge is lost, and the report says so. When the
 * whole window collapses to one point — both endpoints inside one revived
 * region, or the window exactly covering it seam to seam (each seam HAS a
 * preimage, but the same one twice) — the old clock has no record to give:
 * the verdict is `degenerate`, and what the caller does with it depends on
 * whether it holds a source mapper (the type's own doc) — never a silent
 * zero-length entry that pretends the old clock said something. Checked on
 * the mapped WIDTH first, before the preimage question, for exactly that
 * seam-to-seam case. The module `EPS`, not 0: the
 * mapped ends ride TimeMap arithmetic, and a real cut is never under a
 * microsecond.
 *
 * Identity mappers (no live veto) always answer `exact` with the input
 * values untouched — the no-veto regression anchor.
 */
export function cutRangeToOldClock(
  mappers: Pick<PreviewClockMappers, "fromLive" | "hasOldClockPreimage">,
  startSec: number,
  endSec: number,
): OldClockCutRange {
  const mappedStart = mappers.fromLive(startSec);
  const mappedEnd = mappers.fromLive(endSec);
  if (mappedEnd - mappedStart < EPS) return { kind: "degenerate" };
  if (mappers.hasOldClockPreimage(startSec) && mappers.hasOldClockPreimage(endSec)) {
    return { kind: "exact", startSec: mappedStart, endSec: mappedEnd };
  }
  return {
    kind: "shrunk",
    startSec: mappedStart,
    endSec: mappedEnd,
    report:
      `cut ${startSec.toFixed(3)}s–${endSec.toFixed(3)}s trimmed to the last render's ` +
      `${mappedStart.toFixed(3)}s–${mappedEnd.toFixed(3)}s — the revived material at its ` +
      `edge isn't in the last render yet`,
  };
}

/** The output-timed subset of the render props the retime reads. Structural
 * on purpose — the renderer's `ProductionCompProps` satisfies it without
 * core importing the renderer package. */
export interface RetimeablePreviewProps {
  outputDurationSec: number;
  captionLines: readonly CaptionLine[];
  sceneCues: readonly SceneCue[];
  zoomPlan?: readonly ZoomSegment[];
  ctaWindow?: { startSec: number; endSec: number };
  sourceTextRegions?: readonly { y: number; h: number; startSec: number; endSec: number }[];
}

/** Exactly the fields `retimeForPreview` re-timed — the caller spreads them
 * over the full props (`{ ...props, ...fields }`), so fields this function
 * never touches (theme, face, framingTimeline — all source-timed or
 * timeless) cannot be accidentally rewritten here. */
export interface RetimedPreviewFields {
  spans: KeptSpan[];
  outputDurationSec: number;
  captionLines: CaptionLine[];
  sceneCues: SceneCue[];
  zoomPlan?: ZoomSegment[];
  ctaWindow?: { startSec: number; endSec: number };
  sourceTextRegions?: { y: number; h: number; startSec: number; endSec: number }[];
  punch: { scale: number; allowed: boolean[] };
}

export interface RetimedPreview {
  fields: RetimedPreviewFields;
  reports: string[];
}

/**
 * Re-time every output-timed render prop from `oldMap`'s clock onto
 * `newMap`'s: old-output → source → new-output, `remapPoint`'s exact
 * algorithm — the same one produce re-anchors splits and pins with.
 *
 * A veto only ever ADDS time back (a removal becomes a keep), so under vetoes
 * alone every moment the old clock could express survives on the new one and
 * maps exactly. Two directions REMOVE time and need the clamped fallback
 * behind each point (`toOutputClamped`'s documented role): old spans carrying
 * a veto the doc no longer holds, and — since the cut-review rework — a LIVE
 * user cut (`cuts[].src`, subtracted by `livePreviewMap`). A moment inside
 * either snaps to the nearest kept edge and is reported, never silently
 * dropped.
 *
 * Removing time can also COLLAPSE a scene cue: a cut covering a whole block
 * leaves both its ends clamped to the same seam. A zero-width cue is dropped
 * from the preview outright, WITH a report — that is the honest rendering of
 * material the user just removed, where a kept sliver would draw a phantom
 * block on the timeline for footage that no longer plays. Only `sceneCues`
 * get this: a collapsed caption line or zoom segment is inert where it sits
 * (nothing renders across a zero window), while a cue is a timeline BLOCK
 * with a label, a hit target and a selection.
 *
 * Word `srcStart` is already SOURCE time (§137's recut-immune key) and is
 * carried untouched. `punch` comes back provably inert — `{scale: 1,
 * allowed: []}`: `punchScalesFor` (punch-plan.ts) renders an allowed span's
 * punched turn at `scale`, and scale 1 is no visible punch; an empty mask
 * reads all-allowed, which is exactly what makes scale the only knob. It
 * cannot pass through: `punch.allowed` is INDEXED PER SPAN, the new span
 * list has different indices, and the face-only verdict that built the mask
 * cannot be recomputed client-side — a punch on the wrong span (a screen
 * share sliding) is worse than no punch for the preview's duration. The
 * zoom plan, by contrast, IS remapped: its segments are pure output time
 * (`zoomScaleAt` consults nothing but `startSec`/`endSec`), and a revived
 * stretch simply falls outside every segment, which `zoomScaleAt` already
 * renders as the static camera.
 */
export function retimeForPreview(
  props: RetimeablePreviewProps,
  oldMap: TimeMap,
  newMap: TimeMap,
): RetimedPreview {
  const reports: string[] = [];
  const at = (label: string, t: number): number => remapPoint(label, t, oldMap, newMap, reports);
  const fields: RetimedPreviewFields = {
    spans: newMap.spans.map((s) => ({ ...s })),
    outputDurationSec: newMap.outputDuration,
    captionLines: props.captionLines.map((line, i) => ({
      ...line,
      start: at(`caption line ${i + 1} start`, line.start),
      end: at(`caption line ${i + 1} end`, line.end),
      words: line.words.map((w) => ({
        ...w,
        start: at(`caption word "${w.text}" start`, w.start),
        end: at(`caption word "${w.text}" end`, w.end),
      })),
    })),
    sceneCues: props.sceneCues.flatMap((c) => {
      const startSec = at(`scene "${c.id}" start`, c.startSec);
      const endSec = at(`scene "${c.id}" end`, c.endSec);
      // Collapsed by a live cut (the doc's own paragraph) — dropped, and
      // said out loud, the `remapPoint` "nothing moves without saying so"
      // rule applied to a block that stopped existing.
      if (endSec - startSec < EPS) {
        reports.push(`scene "${c.id}" removed from the live preview by a cut`);
        return [];
      }
      return [{ ...c, startSec, endSec }];
    }),
    punch: { scale: 1, allowed: [] },
  };
  if (props.zoomPlan) {
    fields.zoomPlan = props.zoomPlan.map((seg, i) => ({
      ...seg,
      startSec: at(`zoom segment ${i + 1} start`, seg.startSec),
      endSec: at(`zoom segment ${i + 1} end`, seg.endSec),
    }));
  }
  if (props.ctaWindow) {
    fields.ctaWindow = {
      startSec: at("CTA window start", props.ctaWindow.startSec),
      endSec: at("CTA window end", props.ctaWindow.endSec),
    };
  }
  if (props.sourceTextRegions) {
    fields.sourceTextRegions = props.sourceTextRegions.map((r, i) => ({
      ...r,
      startSec: at(`source text region ${i + 1} start`, r.startSec),
      endSec: at(`source text region ${i + 1} end`, r.endSec),
    }));
  }
  return { fields, reports };
}
