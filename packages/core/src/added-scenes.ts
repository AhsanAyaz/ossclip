/**
 * Template graphics the author adds in the editor (editor-added-graphics):
 * the entry `overrides.json` stores, and the pure rules that turn it into a
 * `Scene` before assembly (§2), keep the remap off its keys (§3), preview it
 * before the next run (§4) and refuse an add that would cover another block
 * (§5).
 *
 * Browser-safe on purpose, as storyboard/approval.ts is: the editor previews
 * an add with the SAME conversion produce renders with, so the runtime
 * imports are zod, ./scene-schema, ./scene-registry and ./assemble (type
 * imports plus ./scene-registry and ./reveal-match), all already on the
 * browser surface. ./overrides is a type import only — overrides.ts imports
 * `AddedSceneSchema` from here, and a runtime import back would be a cycle.
 */
import { z } from "zod/v4";
import { SCENE_GAP_SEC, assembleScenes } from "./assemble";
import { SCENE_REGISTRY } from "./scene-registry";
import { ScriptComponentIdSchema, type Scene, type SceneCue, type ScriptComponentId } from "./scene-schema";
import type { OverrideDoc } from "./overrides";
import type { Transcript } from "./schema";
import type { TimeMap } from "./timemap";

/**
 * One added graphic as `overrides.json` stores it — loose on purpose
 * (editor-added-graphics §1, AG3). Every reader parses the WHOLE doc
 * (produce, the edit server, the storyboard draw), so a removed component, a
 * bad id or an inverted span written here must not fail that parse and take
 * every other edit down with it. Each entry is judged in `addedSceneToScene`
 * instead, and skipped there with a reason the author can act on.
 *
 * The span is SOURCE seconds, not word indices: the words' index space
 * differs between produce (a `--clip` run's slice) and the editor (the full
 * repaired list), and source time is the one both share (§2 step 4).
 * Written once at the gesture and never changed; every later edit lives in
 * `scenes[id]` like any block's.
 */
export const AddedSceneSchema = z.object({
  /** `added-<n>`, minted by the editor's reducer (`nextAddedId`). */
  id: z.string(),
  /** Validated at conversion, not here — see the schema's doc comment. */
  component: z.string(),
  props: z.record(z.string(), z.unknown()),
  // `.finite()` stated rather than assumed, `SplitSchema`'s reasoning.
  srcStart: z.number().finite().nonnegative(),
  srcEnd: z.number().finite().nonnegative(),
});
export type AddedScene = z.infer<typeof AddedSceneSchema>;

/**
 * The id namespace of added graphics. A prefix of their own (the
 * `SHOT_SCENE_ID_PREFIX` rule) because produce strips every scene carrying
 * it before appending the doc's entries (§2, produce step 1), and the remap
 * guard recognises their keys by it (§3) — a planned id that could spell
 * `added-…` would be deleted by the first and frozen by the second.
 */
export const ADDED_ID_PREFIX = "added-";

/**
 * The types the add gesture offers (§5), in menu order. `TerminalMock` is out
 * (nested windows of lines have no short form) and `ScreenshotFrame` needs an
 * image; `ClipScene` is a storyboard shot's, made by "Add shot from
 * selection" (NG2). Conversion accepts more than this — any script component
 * but ScreenshotFrame — because the entry is written once and kept: a menu
 * that later drops or adds a type must not strand an entry already saved.
 */
export const ADDED_OFFERED = [
  "TitleCard",
  "StatCard",
  "RuleCard",
  "StrikethroughReveal",
  "BulletList",
  "FlowDiagram",
  "ChatMock",
  "CardRow",
  "CtaCard",
  "BugCard",
  "PhoneDemo",
] as const satisfies readonly ScriptComponentId[];

/** The overrides.ts park suffix (`PARKED_SUFFIX`), restated so this module
 * needs no runtime import from there (see the header). */
const PARKED_SUFFIX = "#orphaned";

/**
 * The scene id a `scenes` key belongs to (§3): a parked key
 * (`id#orphaned`, §137) and a split half (`id@<split id>`, R16 §61) both
 * address their root's block. The park suffix comes off FIRST because it is
 * appended to the whole key, split part included (`added-3@s1#orphaned`).
 */
export function sceneKeyRoot(key: string): string {
  const unparked = key.endsWith(PARKED_SUFFIX) ? key.slice(0, -PARKED_SUFFIX.length) : key;
  const at = unparked.indexOf("@");
  return at === -1 ? unparked : unparked.slice(0, at);
}

/** True for any key of an added graphic, judged by its ROOT — so a split
 * half of a planned scene whose split id happened to contain the prefix is
 * not one. */
export function isAddedKey(key: string): boolean {
  return sceneKeyRoot(key).startsWith(ADDED_ID_PREFIX);
}

/**
 * Write the list back, or REMOVE the key when it is empty — the `withSfx` /
 * `withOverlays` rule (§1): the key is optional with no default so an
 * untouched project's overrides.json is byte-identical, and a project whose
 * last add was just undone must not keep `addedScenes: []` in every save.
 */
export function withAddedScenes(doc: OverrideDoc, list: AddedScene[]): OverrideDoc {
  if (list.length > 0) return { ...doc, addedScenes: list };
  if (doc.addedScenes === undefined) return doc;
  const { addedScenes: _dropped, ...rest } = doc;
  return rest;
}

/**
 * The next free `added-<n>`, one past the highest `n` among the taken ids'
 * roots (§1). The caller passes every id that could still name a block — the
 * doc's entries, the roots of `doc.scenes` keys, and the base cues — because
 * a reused id would pick up the edits, or preview the baked cue, of the
 * graphic that last held it. One past the MAX, never the lowest gap, for the
 * same reason: a gap is usually a deleted graphic whose edits may linger.
 */
export function nextAddedId(taken: Iterable<string>): string {
  let max = 0;
  for (const id of taken) {
    const m = /^added-(\d+)$/.exec(sceneKeyRoot(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${ADDED_ID_PREFIX}${max + 1}`;
}

/**
 * A caption word's end in SOURCE seconds: its source start plus its spoken
 * length. Caption words carry no `srcEnd` (`CaptionWord`, §137), and
 * `start`/`end` are output seconds — but a word's own length is the same on
 * either clock, so the sum is its source end (editor-added-graphics §1). One
 * helper so the transcript panel's timing strip and the add gesture's span
 * cannot disagree about where a word ends.
 */
export function wordSrcEnd(w: { srcStart: number; start: number; end: number }): number {
  return w.srcStart + (w.end - w.start);
}

export type AddedConversion = { scene: Scene } | { skipped: string };

/**
 * One stored entry as a `Scene`, or the reason it cannot be one
 * (editor-added-graphics §2). The checks run in the spec's order and the
 * first failure wins, so the reason names the thing to fix.
 *
 * `words` is the caller's index space (produce: the transcript at the
 * insertion point, a clip's slice on `--clip`; the editor: its full list),
 * given as source starts. The anchor is its first and last word whose
 * source start lies in `[srcStart, srcEnd)` — half-open because `srcEnd` is
 * the last word's END, and the next word may start exactly there.
 *
 * Cut words are not checked here: assembly already starts a scene at its
 * first kept word and drops it when every word is cut (§2).
 */
export function addedSceneToScene(
  entry: AddedScene,
  words: readonly { srcStart: number }[],
): AddedConversion {
  const component = ScriptComponentIdSchema.safeParse(entry.component);
  if (!component.success) return { skipped: `graphic type ${entry.component} no longer exists` };
  // A script component, but one the editor has no way to fill: its prop is
  // an image path that needs produce's staging (§5). Only a hand-edited
  // entry can reach this; the gesture never offers it.
  if (component.data === "ScreenshotFrame") {
    return { skipped: "graphic type ScreenshotFrame cannot be added in the editor" };
  }
  const c = component.data;
  // The registry schema directly, not `resolveSceneProps`: that returns only
  // null and loses the reason (§2 step 2), and the reason is what the
  // Inspector's skipped list shows (§7).
  const parsed = SCENE_REGISTRY[c].propsSchema.safeParse(entry.props);
  if (!parsed.success) {
    return { skipped: parsed.error.issues[0]?.message ?? `invalid props for ${c}` };
  }
  if (!(entry.srcEnd > entry.srcStart)) return { skipped: "its span ends before it starts" };
  let startWord = -1;
  let endWord = -1;
  words.forEach((w, i) => {
    if (w.srcStart >= entry.srcStart && w.srcStart < entry.srcEnd) {
      if (startWord === -1) startWord = i;
      endWord = i;
    }
  });
  if (startWord === -1) return { skipped: "its words are no longer in the transcript" };
  return {
    scene: {
      id: entry.id,
      anchor: { startWord, endWord },
      layout: SCENE_REGISTRY[c].defaultLayout,
      component: c,
      props: entry.props,
      overrides: {},
      rationale: "added in the editor",
    },
  };
}

/**
 * The first graphic cue a new graphic over `[startSec, endSec]` would touch,
 * or null (editor-added-graphics §5, AG2). Padded by `SCENE_GAP_SEC` on both
 * sides because assembly keeps that gap between cues (`assemble.ts`): a cue
 * closer than the gap would be pushed or trimmed by the next run, which is
 * the "never moves another block" the add gesture promises. Strict, as
 * assembly's push is: a cue exactly one gap away is not touched. Plain takes
 * do not count — the fill re-derives them around whatever graphics exist.
 */
export function graphicOverlap(
  cues: readonly SceneCue[],
  startSec: number,
  endSec: number,
): SceneCue | null {
  for (const cue of cues) {
    if (cue.kind === "plain") continue;
    if (cue.startSec < endSec + SCENE_GAP_SEC && startSec < cue.endSec + SCENE_GAP_SEC) return cue;
  }
  return null;
}

/**
 * The editor's base cues with the doc's added graphics reconciled in
 * (editor-added-graphics §4), run before the ordinary override merge:
 *
 * 1. DROP a base cue with an added id and no entry — an undone or deleted
 *    add whose cue a past run baked into `baseSceneCues`.
 * 2. ADD an entry with no base cue that produce did not report in
 *    `issueIds` — one added since the last run. It is timed by a one-scene
 *    `assembleScenes`: the add gesture refused any overlap (AG2), so a
 *    one-scene assembly gives the window a full run would, floor and
 *    ceiling included.
 *
 * An entry in `issueIds` is neither previewed nor reported here: the
 * Inspector lists produce's own reason for it (§7). A new entry that fails
 * conversion OR that assembly drops (all its words cut) is reported in
 * `skipped`, assembly's reason included — produce reports both kinds in
 * `addedSceneIssues` (§2), so the editor's list matches what the next run
 * will say.
 *
 * `transcript` is source-timed words, so a word's `start` IS its source
 * start — the index space the editor's anchor is drawn in (display only;
 * produce's anchor is the one that renders, §2 step 4).
 */
export function previewAddedScenes(args: {
  baseCues: readonly SceneCue[];
  added: readonly AddedScene[];
  issueIds: ReadonlySet<string>;
  transcript: Transcript;
  map: TimeMap;
}): { cues: SceneCue[]; skipped: { id: string; reason: string }[] } {
  const { baseCues, added, issueIds, transcript, map } = args;
  const entryIds = new Set(added.map((e) => e.id));
  const kept = baseCues.filter((c) => !isAddedKey(c.id) || entryIds.has(sceneKeyRoot(c.id)));
  const baseIds = new Set(kept.map((c) => c.id));
  const words = transcript.words.map((w) => ({ srcStart: w.start }));
  const fresh: SceneCue[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of added) {
    if (baseIds.has(entry.id) || issueIds.has(entry.id)) continue;
    const converted = addedSceneToScene(entry, words);
    if ("skipped" in converted) {
      skipped.push({ id: entry.id, reason: converted.skipped });
      continue;
    }
    const { cues, dropped } = assembleScenes([converted.scene], transcript, map);
    const cue = cues[0];
    if (cue) fresh.push(cue);
    else skipped.push({ id: entry.id, reason: dropped[0]?.reason ?? "dropped by assembly" });
  }
  // Time order, the order assembly writes base cues in; `sort` is stable, so
  // cues at the same second keep their base-first order.
  const cues = [...kept, ...fresh].sort((a, b) => a.startSec - b.startSec);
  return { cues, skipped };
}
