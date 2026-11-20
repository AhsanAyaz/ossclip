/**
 * "Plan again" from the editor (storyboard design §2 "Planning again", §10;
 * plan Task 4; §168): one planner call on the cut as the author edited it,
 * which keeps every shot the author steered and replaces only the rest.
 *
 * The endpoint (`POST /api/storyboard/plan`, edit.ts) gathers the inputs it
 * alone can derive (the served words, the live clock, the provider) and
 * calls `planAgain`; the logic is here, the planner and the image probe
 * injected, so it is tested on a temp workdir with no server and no LLM.
 */
import { existsSync, statSync } from "node:fs";
import {
  enforcePlanLimits,
  isProtectedShot,
  mergePlanAgain,
  planStoryboard,
  type LimitChange,
  type LlmProvider,
  type Storyboard,
  type TimeMap,
  type WordOutputTime,
} from "@ossclip/core";
import { keptWordTimes } from "../script-mode";
import { peekShot } from "../draw/shot-store";
import { saveStoryboard } from "./storyboard-store";
import { planLimitContext, plannerAssets } from "./storyboard-run";

/**
 * The live cut as word indices, and each kept word's place on that clock
 * (pure). `map` is the clock the editor plays (`heardMap` in edit.ts: the
 * last render's spans re-cut by the edits saved since), which works in
 * spans of SOURCE time, so a word can straddle a span edge.
 *
 * A word is kept when its midpoint is inside a kept span (§168), the rule
 * produce's `cutWordIndices` applies to the first plan's cutlist, so a word
 * is on the same side of the cut in both plans. Not `heardWords`' rule
 * (`mapWord` not null, which keeps a word for a sliver at either edge): a
 * shot anchored on a word mostly cut would start on a sound the viewer
 * does not hear. The times are `keptWordTimes`', so the cut set decides and
 * a sliver never gives a cut word a time.
 */
export function liveCut(
  words: readonly { start: number; end: number }[],
  map: TimeMap,
): { cut: Set<number>; wordTimes: WordOutputTime[] } {
  const cut = new Set<number>();
  words.forEach((w, i) => {
    if (map.toOutput((w.start + w.end) / 2) === null) cut.add(i);
  });
  return { cut, wordTimes: keptWordTimes(words, cut, map) };
}

/** What the table shows of a shot's drawings: the draft, and how many versions finished. */
export type DrawnShot = { draft: number | null; versions: number };

/**
 * The draw state of every shot that has a history, read through `peekShot`
 * so a read deletes no file of a draw that may still be running. A version
 * counts once it has a result, failed included: a failed draw still cost a
 * call and holds the author's notes, so the shot is not an untouched row.
 * A history that does not parse throws, naming its file: what the shot holds
 * is unknown, and guessing "nothing" would let "Plan again" replace it.
 */
export function drawnShots(workdir: string, sb: Storyboard): Record<string, DrawnShot> {
  const out: Record<string, DrawnShot> = {};
  for (const s of sb.shots) {
    const h = peekShot(workdir, s.id);
    if (h === null) continue;
    out[s.id] = { draft: h.draft, versions: h.versions.filter((v) => v.result !== undefined).length };
  }
  return out;
}

export interface PlanAgainArgs {
  workdir: string;
  /** The stored table, as loaded by the caller. */
  storyboard: Storyboard;
  /** The words the editor serves; shot indices are into this list. */
  words: readonly { text: string }[];
  /** `liveCut`'s two halves, on the live clock. */
  cut: ReadonlySet<number>;
  wordTimes: readonly WordOutputTime[];
  outputDurationSec: number;
  frame: { width: number; height: number };
  provider: LlmProvider;
}

export interface PlanAgainDeps {
  plan?: typeof planStoryboard;
  probeImageSize?: (path: string) => Promise<{ width: number; height: number }>;
  log?: (line: string) => void;
}

/**
 * One call, the limits, the merge, the save. Throws, with `storyboard.json`
 * untouched, when anything before the save fails: the caller reports it.
 *
 * The plan cache (`storyboardplan-<key>.json`) is neither read nor written:
 * the author asked for a fresh plan, and a cached reply for the same words
 * would hand back the plan they are asking to replace.
 */
export async function planAgain(
  a: PlanAgainArgs,
  deps: PlanAgainDeps = {},
): Promise<{ storyboard: Storyboard; changes: LimitChange[] }> {
  const sb = a.storyboard;
  const drawn = drawnShots(a.workdir, sb);
  const hasVersions = (id: string): boolean => (drawn[id]?.versions ?? 0) > 0;
  // Protected kept shots block; a protected dropped one stays in the file,
  // dropped, but its words are free (design §2: new shots "only for spans no
  // kept shot covers").
  const keptProtected = sb.shots.filter((s) => s.kept && isProtectedShot(s, hasVersions(s.id)));

  // Checked here, before the call, because `listAssets`' own "not found" would
  // only say the path: the author never typed it in this session, and needs
  // to know it is the folder the table was planned with.
  if (sb.assetsDir !== undefined && !(existsSync(sb.assetsDir) && statSync(sb.assetsDir).isDirectory())) {
    throw new Error(
      `the storyboard's assets folder ${sb.assetsDir} no longer exists: put the folder back there, ` +
        "or change assetsDir in storyboard.json",
    );
  }
  const assets = await plannerAssets(sb.assetsDir, deps.probeImageSize, deps.log ?? (() => {}));

  // Intent and assets are the stored table's, not this session's: the plan
  // is of the same video, asked the same question, on a newer cut.
  const raw = await (deps.plan ?? planStoryboard)(a.provider, {
    words: a.words,
    cut: a.cut,
    outputDurationSec: a.outputDurationSec,
    width: a.frame.width,
    height: a.frame.height,
    ...(sb.intent !== undefined ? { intent: sb.intent } : {}),
    assets,
    taken: keptProtected.map((s) => ({ startWord: s.startWord, endWord: s.endWord, idea: s.idea })),
  });
  // The prompt asks the planner to stay off the taken spans; the limits make
  // sure of it (merge.ts runs none of its own).
  const limited = enforcePlanLimits(raw, planLimitContext({ ...a, assets, blocked: keptProtected }));
  const next = mergePlanAgain(sb, limited.shots, hasVersions);
  saveStoryboard(a.workdir, next);
  return { storyboard: next, changes: limited.changes };
}
