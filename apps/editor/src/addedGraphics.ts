import {
  isAddedKey,
  previewAddedScenes,
  sceneKeyRoot,
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
 * previews after the next run (the add popover says so). Rule 1 is restated
 * here rather than reached through `previewAddedScenes` with a fake map,
 * which would be a clock the cues are not on.
 *
 * `words` is the REPAIRED list produce counted scenes in (`/api/sfx/plan`'s
 * `words`, spec §2 step 4): the index space of the base cues' anchors, so the
 * anchor an added cue gets here is the one `save()` stamps beside theirs.
 */
export function previewBaseCues(args: {
  baseCues: readonly SceneCue[];
  added: readonly AddedScene[];
  issueIds: ReadonlySet<string>;
  words: readonly Word[] | null;
  map: TimeMap | null;
}): { cues: SceneCue[]; skipped: { id: string; reason: string }[] } {
  const { baseCues, added, issueIds, words, map } = args;
  if (map === null || words === null) {
    const entryIds = new Set(added.map((e) => e.id));
    return {
      cues: baseCues.filter((c) => !isAddedKey(c.id) || entryIds.has(sceneKeyRoot(c.id))),
      skipped: [],
    };
  }
  // `language` is unread by assembly; the transcript is only its word list.
  return previewAddedScenes({ baseCues, added, issueIds, transcript: { language: "en", words: [...words] }, map });
}

/**
 * The Inspector's "not shown" list (§7): produce's `addedSceneIssues` and the
 * preview's own skips, once per id, and only for entries still in the doc —
 * a removed entry leaves the list at once, before the next run rewrites
 * render-props. Produce's reason wins a tie: it is what the next run will say
 * again. Doc order, so the list reads in the order the author added them.
 */
export function addedSkippedRows(
  added: readonly AddedScene[],
  issues: readonly { id: string; reason: string }[],
  skipped: readonly { id: string; reason: string }[],
): AddedSkippedRow[] {
  const reasons = new Map<string, string>();
  for (const r of [...issues, ...skipped]) if (!reasons.has(r.id)) reasons.set(r.id, r.reason);
  return added.flatMap((e) => {
    const reason = reasons.get(e.id);
    return reason === undefined ? [] : [{ id: e.id, component: e.component, reason }];
  });
}

/** The list's heading (plan Global Constraints): singular "graphic is" for one. */
export function addedSkippedHeading(n: number): string {
  return n === 1 ? "1 added graphic is not shown" : `${n} added graphics are not shown`;
}
