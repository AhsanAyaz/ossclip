import {
  ADDED_ID_PREFIX,
  MAX_SCENE_SEC,
  dropOverlappingAdded,
  graphicOverlap,
  isAddedKey,
  landscapeLayoutFor,
  previewAddedScenes,
  sceneKeyRoot,
  wordSrcEnd,
  type AddedScene,
  type SceneCue,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";

/** One entry the Inspector's no-selection view lists as not shown (§7). */
export interface AddedSkippedRow {
  id: string;
  component: string;
  reason: string;
}

/**
 * The live preview's base cues with the doc's added graphics reconciled in
 * (editor-added-graphics §4) — core's `previewAddedScenes`, plus the one case
 * it cannot take: no clock or no word list to time an add with.
 *
 * Then only rule 1 runs. A baked `added-` cue whose entry is gone (an undone
 * or deleted add) must still leave the preview, since nothing about that
 * needs a clock; an add made since the last run just has no window yet and
 * previews after the next run (the add modal says so). Rule 1 is restated
 * here rather than reached through `previewAddedScenes` with a fake map,
 * which would be a clock the cues are not on.
 *
 * `words` is the REPAIRED list produce counted scenes in (`/api/sfx/plan`'s
 * `words`, spec §2 step 4): the index space of the base cues' anchors, so the
 * anchor an added cue gets here is the one `save()` stamps beside theirs.
 *
 * `landscape` (the frame is wider than tall) and `scriptProject` (the stored
 * script record, App's state) lay a FRESH add out as produce will: produce
 * remaps every scene through `landscapeLayoutFor` before assembly (R15,
 * §163), so a 16:9 add previewed in its portrait default — a `pip-bubble`
 * TitleCard — rendered `split-left` (fix-wave I2). Base cues are left alone:
 * produce already laid them out, baked added ones included.
 */
export function previewBaseCues(args: {
  baseCues: readonly SceneCue[];
  added: readonly AddedScene[];
  issueIds: ReadonlySet<string>;
  words: readonly Word[] | null;
  map: TimeMap | null;
  landscape: boolean;
  scriptProject: boolean;
}): { cues: SceneCue[]; skipped: { id: string; reason: string }[] } {
  const { baseCues, added, issueIds, words, map, landscape, scriptProject } = args;
  if (map === null || words === null) {
    const entryIds = new Set(added.map((e) => e.id));
    return {
      cues: baseCues.filter((c) => !isAddedKey(c.id) || entryIds.has(sceneKeyRoot(c.id))),
      skipped: [],
    };
  }
  // `language` is unread by assembly; the transcript is only its word list.
  const preview = previewAddedScenes({ baseCues, added, issueIds, transcript: { language: "en", words: [...words] }, map });
  if (!landscape) return preview;
  const baseIds = new Set(baseCues.map((c) => c.id));
  return {
    ...preview,
    cues: preview.cues.map((c) =>
      isAddedKey(c.id) && !baseIds.has(c.id) ? { ...c, layout: landscapeLayoutFor(c.layout, { scriptProject }) } : c,
    ),
  };
}

/**
 * The preview's half of produce's give-way (fix-wave I1, AG2): core's
 * `dropOverlappingAdded` on the list the author sees — run by App right
 * after its hidden drop, the step produce runs it at — with each drop
 * reported under its ENTRY's id (a split half's root), once, since the
 * not-shown list (`addedSkippedRows`) and its Remove are keyed by entry.
 */
export function previewDropCovered(cues: readonly SceneCue[]): {
  cues: SceneCue[];
  skipped: { id: string; reason: string }[];
} {
  const { cues: kept, dropped } = dropOverlappingAdded(cues);
  const skipped: { id: string; reason: string }[] = [];
  for (const d of dropped) {
    const id = sceneKeyRoot(d.id);
    if (!skipped.some((r) => r.id === id)) skipped.push({ id, reason: d.reason });
  }
  return { cues: kept, skipped };
}

/**
 * Every id `addScene` must not mint again (§1), from render-props: the base
 * cues (`baseSceneCues`, or the old `sceneCues` fallback the live memo also
 * reads) and the entries the run reported in `addedSceneIssues`. The issues
 * count because a reported entry has no base cue: Removed from the not-shown
 * list and then re-added, its id would come back with the reason the next
 * run no longer has — and with its stale `scenes` edits (fix-wave I3).
 */
export function addBaseIds(
  renderProps: {
    baseSceneCues?: readonly { id: string }[];
    sceneCues?: readonly { id: string }[];
    addedSceneIssues?: readonly { id: string }[];
  } | null,
): string[] {
  if (renderProps === null) return [];
  return [
    ...(renderProps.baseSceneCues ?? renderProps.sceneCues ?? []).map((c) => c.id),
    ...(renderProps.addedSceneIssues ?? []).map((i) => i.id),
  ];
}

/**
 * The Inspector's "not shown" list (§7): produce's `addedSceneIssues` and the
 * preview's own skips, once per id, and only for entries still in the doc —
 * a removed entry leaves the list at once, before the next run rewrites
 * render-props. Produce's reason wins a tie: it is what the next run will say
 * again. Doc order, so the list reads in the order the author added them.
 *
 * `liveIds` is what the live preview is drawing (its cue ids). A reported
 * row whose graphic the preview DOES show leaves the list: the author fixed
 * it live — moved the plan block that covered it — and
 * "not shown" beside a block on the timeline would be false until the next
 * run rewrites render-props (fix-wave ruling 5: the live preview wins).
 * Judged by root, so a shown split half counts. The preview's own skips are
 * never filtered: they are the live verdict already.
 */
export function addedSkippedRows(
  added: readonly AddedScene[],
  issues: readonly { id: string; reason: string }[],
  skipped: readonly { id: string; reason: string }[],
  liveIds: Iterable<string> = [],
): AddedSkippedRow[] {
  const shown = new Set([...liveIds].map(sceneKeyRoot));
  const reasons = new Map<string, string>();
  for (const r of [...issues.filter((i) => !shown.has(i.id)), ...skipped]) {
    if (!reasons.has(r.id)) reasons.set(r.id, r.reason);
  }
  return added.flatMap((e) => {
    const reason = reasons.get(e.id);
    return reason === undefined ? [] : [{ id: e.id, component: e.component, reason }];
  });
}

/** The list's heading (plan Global Constraints): singular "graphic is" for one. */
export function addedSkippedHeading(n: number): string {
  return n === 1 ? "1 added graphic is not shown" : `${n} added graphics are not shown`;
}

/**
 * One selected transcript word as the add gesture needs it (§5): its §137
 * source anchor, its own start/end as the panel holds them (the lines' clock,
 * which is where its spoken length is read), and its text for the prefill.
 */
export interface AddGraphicWord {
  srcStart: number;
  start: number;
  end: number;
  text: string;
}

/**
 * The span an add stores, in SOURCE seconds (§1): the first word's source
 * start to the last word's source end. The last word's END, not the max of
 * anything — `wordSrcEnd` is the one definition the timing strip shares.
 */
export function addSpan(words: readonly AddGraphicWord[]): { srcStart: number; srcEnd: number } {
  const first = words[0]!;
  const last = words[words.length - 1]!;
  return { srcStart: first.srcStart, srcEnd: wordSrcEnd(last) };
}

/**
 * Where the add would sit on `map`'s clock, or null when it would not sit at
 * all (every word cut on that clock). The preview's own timing (§4 rule 2),
 * reached through `previewAddedScenes` with a stand-in entry rather than
 * restated, so the overlap check and the block that then appears cannot
 * disagree about the duration floor or the 15 s ceiling.
 *
 * The transcript is the selection itself, source-timed: a one-scene assembly
 * reads only its anchor's words, so the full list adds nothing — and this way
 * the check does not wait on `/api/sfx/plan` the way the preview must. The
 * stand-in is a TitleCard because no offered type has a length of its own
 * (`fixedDurationSec` is ClipScene's alone), so the type cannot move the
 * window and is not known yet anyway: the check runs before the type list.
 */
function addWindow(
  words: readonly AddGraphicWord[],
  map: TimeMap,
): { startSec: number; endSec: number } | null {
  const span = addSpan(words);
  const { cues } = previewAddedScenes({
    baseCues: [],
    // `added-0`: a real `added-<n>` shape, which conversion now demands
    // (fix-wave M1), and one `nextAddedId` never mints (it starts at 1) —
    // not that it could collide, with no base cues beside it.
    added: [{ id: `${ADDED_ID_PREFIX}0`, component: "TitleCard", props: { title: "window" }, ...span }],
    issueIds: new Set(),
    transcript: {
      language: "en",
      words: words.map((w) => ({ text: w.text, start: w.srcStart, end: wordSrcEnd(w) })),
    },
    map,
  });
  const cue = cues[0];
  return cue ? { startSec: cue.startSec, endSec: cue.endSec } : null;
}

/** m:ss, rounded down — how the timeline's ruler reads a second. */
const clockLabel = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The refusal the modal shows in place of its form (§5, AG2;
 * graphic-editor-modal §5). */
export function addOverlapRefusal(cue: SceneCue): string {
  return `These words overlap the graphic \u2018${cue.component ?? cue.id}\u2019 at ${clockLabel(cue.startSec)}. Trim that block or pick other words.`;
}

/** The refusal for a selection the video no longer contains (§5). */
export const ADD_CUT_REFUSAL = "These words are cut from the video. Pick words that are still in it.";

/** App's verdict when Graphic… is pressed: the span, the verdict and the
 * notes, worked out once at the press, which the modal opens with. */
export interface AddGraphicCheck {
  span: { srcStart: number; srcEnd: number };
  /** Non-null: the add is refused, and this is why. */
  refusal: string | null;
  /** Shown in the modal's footer; empty for an ordinary add. */
  notes: string[];
  /** The window the overlap was measured over, in the cues' own seconds
   * (`addWindow`, or the fallback below): the modal's header says where the
   * block will sit before any type is chosen, and a refusal and a header
   * can then never disagree about it. */
  at: { startSec: number; endSec: number };
}

/**
 * Graphic…'s decision, before the type list opens (§5).
 *
 * `cues` is what the author SEES (the live preview: overrides applied,
 * hidden cues dropped, pins applied) and `clock` the clock those cues are on,
 * so the window is measured where they are. The window is a one-scene
 * assembly (`addWindow`), padded by the gap inside `graphicOverlap`: a short
 * add the floor stretches can never trim the next block.
 *
 * Every word cut on that clock is refused outright, with its own copy:
 * assembly drops a scene whose words are all cut ("anchor words were
 * entirely cut"), so the add could only ever land in the not-shown list
 * (§7). Judged with the clock's own `mapWord`, the test assembly applies.
 *
 * With no clock, or a window the assembly would not give for some other
 * reason, there is nothing to assemble on, and the words' own on-screen span
 * is the best measure there is — mapped to the player's clock (`toPlayerSec`, the panel's own seek
 * mapping) because that is the clock `cues` speak. It misses the floor; the
 * next run's assembly then pushes, as it does for any block (§4).
 *
 * `deferred` is App's "the preview cannot place it" (no clock or no repaired
 * word list, the two inputs `previewBaseCues` needs). The long-span note
 * compares the SOURCE span with the ceiling under assemble's own float
 * epsilon: a span that is 15 s to the eye can be 15.000000000000002.
 */
export function addGraphicCheck(args: {
  words: readonly AddGraphicWord[];
  cues: readonly SceneCue[];
  clock: TimeMap | null;
  toPlayerSec: (sec: number) => number;
  deferred: boolean;
}): AddGraphicCheck {
  const { words, cues, clock, toPlayerSec, deferred } = args;
  const span = addSpan(words);
  const onScreen = {
    startSec: toPlayerSec(words[0]!.start),
    endSec: toPlayerSec(words[words.length - 1]!.end),
  };
  if (clock !== null && words.every((w) => clock.mapWord({ text: w.text, start: w.srcStart, end: wordSrcEnd(w) }) === null)) {
    return { span, refusal: ADD_CUT_REFUSAL, notes: [], at: onScreen };
  }
  const at = (clock !== null ? addWindow(words, clock) : null) ?? onScreen;
  const hit = graphicOverlap(cues, at.startSec, at.endSec);
  const notes: string[] = [];
  if (deferred) notes.push("This graphic will show after the next Render.");
  if (span.srcEnd - span.srcStart > MAX_SCENE_SEC + 1e-6) {
    notes.push(`Shown for the first ${MAX_SCENE_SEC} s of these words.`);
  }
  return { span, refusal: hit === null ? null : addOverlapRefusal(hit), notes, at };
}

/**
 * The cue an add would preview as, on `map` (graphic-editor-modal §5, the
 * modal's preview): `previewBaseCues` on the one entry, so its window, its
 * layout (landscape remap included) and its resolved props are the ones the
 * stage gives the block once it is added — one conversion, not a second
 * copy of it. Null when it would not show: no clock or word list yet, props
 * the RAW schema refuses (the modal keeps its last preview then), or words
 * all cut. `added-0` is the stand-in `addWindow` uses, one `nextAddedId`
 * never mints.
 */
export function addPreviewCue(args: {
  component: string;
  props: Record<string, unknown>;
  span: { srcStart: number; srcEnd: number };
  words: readonly Word[] | null;
  map: TimeMap | null;
  landscape: boolean;
  scriptProject: boolean;
}): SceneCue | null {
  const { component, props, span, words, map, landscape, scriptProject } = args;
  const { cues } = previewBaseCues({
    baseCues: [],
    added: [{ id: `${ADDED_ID_PREFIX}0`, component, props, ...span }],
    issueIds: new Set(),
    words,
    map,
    landscape,
    scriptProject,
  });
  return cues[0] ?? null;
}
