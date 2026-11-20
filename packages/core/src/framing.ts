import type { Transcript } from "./schema";
import { SCENE_REGISTRY } from "./scene-registry";
import type { Layout, Scene } from "./scene-schema";
import type { Moment, ScriptMoment } from "./producer/beats";
import { headFracInSlot } from "./normalize";

/**
 * Producer framing awareness (PLAN 2026-07-28, Tasks A and B).
 *
 * The beat-sheet prompt used to contain zero geometry — intent, duration,
 * component menu, transcript. So the producer happily put `video-top` (a wide
 * band) on moments where the speaker fills 44% of a portrait canvas, and the
 * band cover-cropped the head to 206% of its height. Three rounds of tuning a
 * global crop constant could not fix that, because it is not a cropping
 * problem: the pixels a wide band wants do not exist in a portrait close-up.
 * The fix is editorial — don't put a wide band on a close-up moment — which
 * makes it the PRODUCER's decision, and this module is how the producer gets
 * the evidence (Task A) and how its choice is checked (Task B).
 *
 * Two design rules, from the plan:
 *   - The model never does pixel math. The brief is qualitative — CLOSE /
 *     MEDIUM / WIDE plus which layouts that rules out. The arithmetic stays
 *     in `headFracInSlot`, where it is tested.
 *   - The repair pass ships regardless of how well the prompt behaves. A
 *     prompt is a request; `repairMomentLayouts` is the constraint (the §35
 *     lesson).
 */

/** One framing window in SOURCE time, from the normalization plan. */
export interface FramingWindow {
  startSec: number;
  endSec: number;
  /** Face height as a fraction of the (normalized) canvas during this window. */
  faceFracOfCanvas: number;
}

/**
 * A layout's video-slot shape. Injected by the CLI from `layoutSlots` —
 * core stays React- and scenes-free, and the feasibility question needs only
 * the slot's ASPECT and whether the video is the subject there at all.
 */
export interface LayoutFraming {
  layout: Layout;
  /** Slot width over height, in output pixels. */
  slotAspect: number;
  /**
   * False for slots where the head-fits rule does not apply: a pip bubble is
   * MEANT to be a tight head shot, and a `graphic-only` slot never draws.
   */
  primary: boolean;
}

/** Everything a framing judgement needs, assembled once by the CLI. */
export interface FramingContext {
  windows: FramingWindow[];
  /** The normalized canvas's width over height. */
  canvasAspect: number;
  layouts: LayoutFraming[];
  /** The idle zoom's peak — the head must fit at the tightest moment. */
  zoom: number;
}

/** The moment's span in SOURCE seconds, off the transcript's own stamps. */
export function momentSourceWindow(
  transcript: Transcript,
  startWord: number,
  endWord: number,
): { startSec: number; endSec: number } | null {
  const first = transcript.words[startWord];
  const last = transcript.words[endWord];
  if (!first || !last) return null;
  return { startSec: first.start, endSec: last.end };
}

/** The tightest framing inside [startSec, endSec] — a span is judged by its
 * worst moment, not its average. */
export function worstFaceFrac(
  windows: readonly FramingWindow[],
  startSec: number,
  endSec: number,
): number {
  let frac = 0;
  for (const w of windows) {
    if (w.startSec < endSec && w.endSec > startSec) frac = Math.max(frac, w.faceFracOfCanvas);
  }
  return frac;
}

/** Can this layout's slot hold the whole head at this framing? Non-primary
 * slots are always feasible — the rule does not apply to them. */
export function layoutFeasible(ctx: FramingContext, layout: Layout, faceFrac: number): boolean {
  const entry = ctx.layouts.find((l) => l.layout === layout);
  if (!entry || !entry.primary || faceFrac <= 0) return true;
  return headFracInSlot(faceFrac, ctx.canvasAspect, entry.slotAspect, ctx.zoom) <= 1;
}

/** The primary layouts this framing rules out, worst offender first. */
export function infeasibleLayouts(ctx: FramingContext, faceFrac: number): Layout[] {
  return ctx.layouts
    .filter((l) => !layoutFeasible(ctx, l.layout, faceFrac))
    .sort(
      (a, b) =>
        headFracInSlot(faceFrac, ctx.canvasAspect, b.slotAspect, ctx.zoom) -
        headFracInSlot(faceFrac, ctx.canvasAspect, a.slotAspect, ctx.zoom),
    )
    .map((l) => l.layout);
}

/** Qualitative label for the brief. CLOSE is defined by CONSEQUENCE — some
 * layout is unavailable — not by an arbitrary fraction threshold. */
function shotLabel(ctx: FramingContext, faceFrac: number): "CLOSE" | "MEDIUM" | "WIDE" {
  if (infeasibleLayouts(ctx, faceFrac).length > 0) return "CLOSE";
  return faceFrac >= 0.3 ? "MEDIUM" : "WIDE";
}

/**
 * The framing brief for the beat-sheet prompt (Task A).
 *
 * One line per framing stretch, in WORD INDICES — the producer reasons in
 * word spans and never sees a second. Adjacent windows whose constraint is
 * identical merge, so a ten-segment source with two real framings reads as a
 * handful of lines, not a table. Windows with no face measurement carry no
 * signal and produce no line; a source with no measured window at all returns
 * "" and the prompt is unchanged.
 */
export function buildFramingBrief(ctx: FramingContext, transcript: Transcript): string {
  if (transcript.words.length === 0) return "";

  // Word range per window: a word belongs to the window containing its middle.
  const mid = (i: number): number => {
    const w = transcript.words[i]!;
    return (w.start + w.end) / 2;
  };
  type Line = { fromWord: number; toWord: number; faceFrac: number; avoid: Layout[] };
  const lines: Line[] = [];
  for (const win of ctx.windows) {
    if (win.faceFracOfCanvas <= 0) continue;
    let from = -1;
    let to = -1;
    for (let i = 0; i < transcript.words.length; i++) {
      if (mid(i) >= win.startSec && mid(i) < win.endSec) {
        if (from === -1) from = i;
        to = i;
      }
    }
    if (from === -1) continue;
    const avoid = infeasibleLayouts(ctx, win.faceFracOfCanvas);
    const prev = lines[lines.length - 1];
    if (prev && prev.toWord === from - 1 && sameAvoid(prev.avoid, avoid)) {
      // Same constraint, contiguous words: one line. The face fraction kept is
      // the WORST, consistent with how spans are judged everywhere else.
      prev.toWord = to;
      prev.faceFrac = Math.max(prev.faceFrac, win.faceFracOfCanvas);
    } else {
      lines.push({ fromWord: from, toWord: to, faceFrac: win.faceFracOfCanvas, avoid });
    }
  }
  if (lines.length === 0) return "";

  const body = lines
    .map((l) => {
      const label = shotLabel(ctx, l.faceFrac);
      const detail = `the face fills ~${Math.round(l.faceFrac * 100)}% of the frame height`;
      return l.avoid.length > 0
        ? `- words ${l.fromWord}-${l.toWord}: ${label} shot (${detail}) — layouts ` +
            `${l.avoid.join(", ")} would crop the head here and are UNAVAILABLE`
        : `- words ${l.fromWord}-${l.toWord}: ${label} shot (${detail}) — any layout works`;
    })
    .join("\n");
  return (
    "Camera framing by word range (measured from the footage — hard constraints, not suggestions):\n" +
    body
  );
}

function sameAvoid(a: readonly Layout[], b: readonly Layout[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

export interface LayoutRepair {
  /** Index into the moments array. */
  moment: number;
  issue: string;
}

/**
 * The Task B safety net: rewrite any moment whose layout cannot physically
 * hold the head at that moment's framing.
 *
 * Runs AFTER `normalizeBeatSheet` (word spans are already valid) and before
 * scene generation. The producer's explicit choice is kept when feasible;
 * an infeasible one — or an infeasible registry default when the producer
 * said nothing — is swapped for the first feasible layout among the
 * component's default and alternates. When NOTHING is feasible the least-bad
 * candidate is taken and the issue says so, because a scene that trims a
 * little is still better than silently rendering the worst option.
 */
export function repairMomentLayouts<M extends ScriptMoment = Moment>(
  // Generic for `normalizeBeatSheet`'s reason: a script's moments keep their
  // script-only kinds, a beat sheet's stay `Moment`s (plan Task 4).
  moments: readonly M[],
  transcript: Transcript,
  ctx: FramingContext,
): { moments: M[]; issues: LayoutRepair[] } {
  const issues: LayoutRepair[] = [];
  const out = moments.map((m, idx) => {
    if (m.sceneKind === "none") return m;
    const meta = SCENE_REGISTRY[m.sceneKind];
    const window = momentSourceWindow(transcript, m.startWord, m.endWord);
    if (!meta || !window) return m;
    const faceFrac = worstFaceFrac(ctx.windows, window.startSec, window.endSec);
    if (faceFrac <= 0) return m;

    const requested = m.layout ?? meta.defaultLayout;
    if (layoutFeasible(ctx, requested, faceFrac)) return m;

    const candidates = [...new Set<Layout>([meta.defaultLayout, ...meta.altLayouts])];
    const feasible = candidates.filter((l) => layoutFeasible(ctx, l, faceFrac));
    if (feasible.length > 0) {
      issues.push({
        moment: idx,
        issue: `layout ${requested} would crop the head on this close shot; using ${feasible[0]}`,
      });
      return { ...m, layout: feasible[0]! };
    }
    // Nothing fits: take the candidate that trims least, and say so.
    const leastBad = candidates.reduce((a, b) => {
      const fr = (l: Layout): number => {
        const entry = ctx.layouts.find((e) => e.layout === l);
        return entry && entry.primary
          ? headFracInSlot(faceFrac, ctx.canvasAspect, entry.slotAspect, ctx.zoom)
          : 0;
      };
      return fr(b) < fr(a) ? b : a;
    });
    issues.push({
      moment: idx,
      issue:
        `no ${m.sceneKind} layout fully fits the head on this close shot; ` +
        `${leastBad} trims least`,
    });
    return { ...m, layout: leastBad };
  });
  return { moments: out, issues };
}

/**
 * Layouts that make sense in a LANDSCAPE frame (R15).
 *
 * `video-top`, `pip-bubble` and `graphic-only` are vertical-format ideas: they
 * exist to split a tall frame between a face and a card, or to demote the
 * speaker to an inset because a 9:16 frame cannot show both at a readable
 * size. A 16:9 export has room the vertical frame never had, and §54 gives it
 * layouts that USE that room instead of blurring it away: a broadcast
 * `lower-third` (picture whole, card in the bottom band) and `split-left`/
 * `split-right` (speaker fills one half, graphic the other — two layouts
 * because the side matters: eyeline and the room's contents differ left vs
 * right, and the producer or the editor should be able to pick).
 */
export const LANDSCAPE_LAYOUTS: readonly Layout[] = [
  "full-bleed",
  "blurred-behind",
  "lower-third",
  "split-left",
  "split-right",
];

/**
 * Nearest landscape-appropriate layout. Identity for the five that qualify;
 * the vertical splits map to their landscape analog — `video-top` and
 * `pip-bubble` both mean "face and graphic share the frame", which in 16:9 is
 * a side-by-side split, not a blur — and `graphic-only` (the graphic IS the
 * subject) keeps `blurred-behind`, the layout that lets a card own the frame
 * without discarding the picture.
 */
export function landscapeLayout(layout: Layout): Layout {
  if (LANDSCAPE_LAYOUTS.includes(layout)) return layout;
  return layout === "graphic-only" ? "blurred-behind" : "split-left";
}

/**
 * The three layouts that ARE the three backdrops of a 16:9 script project
 * (§163; scene-backdrop-choice design, Terms): the graphic over the speaker
 * (`full-bleed`), on the look's background with the footage hidden
 * (`graphic-only`), and on the background with the speaker as a small
 * picture (`pip-bubble`). No new scene field: the layout the editor already
 * stores is the choice, so there is no second field that has to agree with it.
 */
export const BACKDROP_LAYOUTS = ["full-bleed", "graphic-only", "pip-bubble"] as const;

export function isBackdropLayout(layout: Layout): boolean {
  return (BACKDROP_LAYOUTS as readonly Layout[]).includes(layout);
}

/**
 * Whether a scene's graphic box survives its layout changing `from` → `to`:
 * only between two backdrops (§163; scene-backdrop-choice design §2).
 *
 * Why: a box is normally geometry for ONE layout's slot, so a layout change
 * dropped it (R13) — and changing the backdrop then threw away the large
 * centred `SCRIPT_LANDSCAPE_RECT` a terminal was planned in, leaving it in
 * the new layout's small slot. The three backdrops differ in what is behind
 * the graphic, not in where it belongs, so a box placed under one is still
 * the placement under the others (design G2). Any other layout splits or
 * bands the frame, its slot is the point of choosing it, and it still drops
 * the box. Not keyed on the project: the rule is about the two
 * layouts. One predicate for `applyOverrides` and the editor's
 * `patchLayout`, or the preview and the render would disagree.
 */
export function keepsBoxAcross(from: Layout, to: Layout): boolean {
  return isBackdropLayout(from) && isBackdropLayout(to);
}

/**
 * `landscapeLayout`, except that a script project keeps its backdrops (§163).
 *
 * Why: `landscapeLayout` rewrote `graphic-only` and `pip-bubble` on every
 * 16:9 run, so a backdrop could only render when the editor set it (its
 * overrides are applied after both remaps). A planned scene that carried one
 * — and the editor's Render pins the planned scenes with `--scenes` — came
 * back blurred or split. The R15 reasoning still holds for runs that never
 * chose a backdrop, so `scriptProject: false` is exactly `landscapeLayout`,
 * and `video-top` (not a backdrop) is remapped in both.
 *
 * `scriptProject` means the stored script record, not `--script`: the
 * editor's Render and the kit refresh replay without the flag (design,
 * Terms; `isScriptProject` in the CLI decides it).
 */
export function landscapeLayoutFor(layout: Layout, opts: { scriptProject: boolean }): Layout {
  if (opts.scriptProject && isBackdropLayout(layout)) return layout;
  return landscapeLayout(layout);
}

/**
 * `landscapeLayoutFor` for the remap that runs AFTER source-text routing:
 * a backdrop is kept only when the cue already had that same layout before
 * routing (§163).
 *
 * Why: routing (`routeAroundSourceText`) may itself switch a scene to one of
 * its component's `altLayouts` to dodge burned-in text, and those include
 * `graphic-only` and `pip-bubble`. A layout routing chose is not a backdrop
 * the author or the plan chose; keeping it would let a text dodge hide the
 * speaker in a 16:9 script project. So it is remapped as R15 always did.
 * `beforeRouting` is `undefined` when the cue has no pre-routing record,
 * which counts as routed — the remap is the safe answer.
 */
export function landscapeLayoutAfterRouting(
  layout: Layout,
  beforeRouting: Layout | undefined,
  opts: { scriptProject: boolean },
): Layout {
  return landscapeLayoutFor(layout, {
    scriptProject: opts.scriptProject && beforeRouting === layout,
  });
}

/**
 * Where a slot component sits in a 16:9 script run (§161): centred, 72% × 68%
 * of the frame. Inside `LANDSCAPE_SAFE_AREA` (5% sides, 6% top, 12% bottom)
 * with room to spare, so the draw-time clamp (`clampGraphicRect`) leaves it
 * as planned.
 */
export const SCRIPT_LANDSCAPE_RECT: Readonly<{ x: number; y: number; w: number; h: number }> = {
  x: 0.14,
  y: 0.16,
  w: 0.72,
  h: 0.68,
};

/**
 * The 16:9 script placement (§161): a scene whose component is NOT
 * `fullFrame` goes `full-bleed` with its graphic in `SCRIPT_LANDSCAPE_RECT`.
 *
 * Why: in the first real 16:9 script render, `TerminalMock` and `TitleCard`
 * got `blurred-behind`, `split-right` and `split-left` from the landscape
 * remap and the variety pass, so the terminal came out small in a corner or
 * in a black half-screen, while the four script-only cards (`fullFrame`)
 * drew centred over the speaker. `full-bleed` keeps the speaker whole, and
 * its scrim (the frosted panel) sits behind the graphic; the rect is the
 * cue's `graphicRect`, the field the editor's drag writes, so the user can
 * still move or resize it and their rect wins.
 *
 * A `fullFrame` component is returned as is: it lays itself out against the
 * whole frame, and a rect here would now shrink it into that box, since
 * `graphicSlotFor` draws it in one (§163). Pure, scene in
 * and scene out; the caller decides that the run is a script and the frame
 * landscape — portrait and runs without `--script` never call it.
 */
export function scriptLandscapePlacement(scene: Scene): Scene {
  if (SCENE_REGISTRY[scene.component].fullFrame) return scene;
  return { ...scene, layout: "full-bleed", graphicRect: { ...SCRIPT_LANDSCAPE_RECT } };
}
