/**
 * The planning step of a `--storyboard` run (storyboard design §1 step 2,
 * §2; plan Task 3; §168): one planner call on the cut, the limits, and the
 * table written to `storyboard.json`. Produce calls it from one branch; the
 * logic lives here, with the planner, the image probe and the provider
 * attribution injected, so the whole step is testable on a temp workdir with
 * the mock provider and no ffprobe.
 */
import { resolve } from "node:path";
import { z } from "zod/v4";
import {
  MAX_SCENE_SEC,
  SCENE_GAP_SEC,
  STORYBOARD_PLAN_PROMPT_VERSION,
  enforcePlanLimits,
  newShotId,
  planStoryboard,
  type LimitChange,
  type LimitContext,
  type LlmProvider,
  type LlmUsage,
  type PlannedShot,
  type Storyboard,
  type WordOutputTime,
} from "@ossclip/core";
import { keptWordsKey } from "../script-mode";
import { ffprobeImageSize, listAssets } from "../draw/shot-store";
import {
  loadStoryboard,
  readStoryboardPlanCache,
  saveStoryboard,
  storyboardPlanCacheKey,
  storyboardPlanCacheKeyCandidates,
  writeStoryboardPlanCache,
} from "./storyboard-store";

export interface StoryboardRunResult {
  storyboard: Storyboard;
  /** False when `storyboard.json` was already there and was loaded as it is. */
  planned: boolean;
  /** What the limits changed in the planner's reply; empty when loaded. */
  changes: LimitChange[];
}

export interface StoryboardRunArgs {
  workdir: string;
  /** The raw transcript's words; shot indices are into this list. */
  words: readonly { text: string }[];
  /** Indices of the words the effective cut removes (design §2 "Which cut"). */
  cut: ReadonlySet<number>;
  /** Every word's place on the effective cut's output clock, null when cut (`keptWordTimes`). */
  wordTimes: readonly WordOutputTime[];
  outputDurationSec: number;
  frame: { width: number; height: number };
  intent?: string;
  /** The `--assets` folder; made absolute before it is stored. */
  assetsDir?: string;
  provider: LlmProvider;
  providerName: string;
  /** The provider a timeout would fall back to, for the cache read (§150). */
  fallbackName?: string;
  llmModel?: string;
}

export interface StoryboardRunDeps {
  plan?: typeof planStoryboard;
  probeImageSize?: (path: string) => Promise<{ width: number; height: number }>;
  /**
   * Who answered a call, from the usage log (produce's `actualProvider`,
   * §143). Injected rather than imported: produce imports this module, and
   * the cycle back would load all of produce into this step's unit tests.
   */
  answeredBy: (usage: readonly LlmUsage[], schemaName: string, defaultName: string) => string;
  log?: (line: string) => void;
}

export async function runStoryboardPlan(a: StoryboardRunArgs, deps: StoryboardRunDeps): Promise<StoryboardRunResult> {
  const log = deps.log ?? (() => {});
  // A stored table is the author's and is never planned again on its own
  // (design §2 "Planning again", G10; plan Review Focus 2): loaded as it is,
  // whatever this run's intent, assets or cut. A broken one throws here
  // (`StoryboardFileError`), before anything is asked or written.
  const stored = loadStoryboard(a.workdir);
  if (stored !== null) return { storyboard: stored, planned: false, changes: [] };

  const assetsDir = a.assetsDir !== undefined ? resolve(a.assetsDir) : undefined;
  const assets = await plannerAssets(assetsDir, deps.probeImageSize, log);

  const keyParts = {
    promptVersion: STORYBOARD_PLAN_PROMPT_VERSION,
    keptWords: keptWordsKey(a.words, a.cut),
    intent: a.intent,
    // Sizes ride with names and notes: the prompt states all three, and a
    // replaced logo of another shape is a different question (§78).
    assets: JSON.stringify(assets.map((x) => [x.name, x.width, x.height, x.note ?? null])),
    frame: `${a.frame.width}x${a.frame.height}`,
    llmModel: a.llmModel,
  };
  let raw: PlannedShot[] | null = null;
  for (const key of storyboardPlanCacheKeyCandidates(keyParts, a.providerName, a.fallbackName)) {
    raw = readStoryboardPlanCache(a.workdir, key);
    if (raw !== null) break;
  }
  if (raw === null) {
    raw = await (deps.plan ?? planStoryboard)(a.provider, {
      words: a.words,
      cut: a.cut,
      outputDurationSec: a.outputDurationSec,
      width: a.frame.width,
      height: a.frame.height,
      ...(a.intent !== undefined ? { intent: a.intent } : {}),
      assets,
      taken: [],
    });
    // Written under the provider that answered (§143's write rule; the reads
    // above stay primary-keyed), raw, before the limits.
    writeStoryboardPlanCache(
      a.workdir,
      storyboardPlanCacheKey({ ...keyParts, providerName: deps.answeredBy(a.provider.usage, "storyboard_plan", a.providerName) }),
      raw,
    );
  }

  // Nothing is blocked on a first plan; "Plan again" passes the protected
  // shots here (plan-again.ts).
  const limited = enforcePlanLimits(raw, planLimitContext({ ...a, assets, blocked: [] }));

  let sb: Storyboard = {
    version: 1,
    ...(a.intent !== undefined ? { intent: a.intent } : {}),
    ...(assetsDir !== undefined ? { assetsDir } : {}),
    nextShot: 1,
    shots: [],
  };
  for (const shot of limited.shots) {
    const next = newShotId(sb);
    sb = {
      ...next.sb,
      shots: [...next.sb.shots, { id: next.id, ...shot, kept: true, origin: "planner", touched: false }],
    };
  }
  saveStoryboard(a.workdir, sb);
  return { storyboard: sb, planned: true, changes: limited.changes };
}

/** An asset as the planner is told of it: no source path, which the prompt never names. */
export type PlannerAsset = { name: string; width: number; height: number; note?: string };

/**
 * The `--assets` folder as the planner sees it, shared by the first plan and
 * "Plan again" (plan-again.ts) so both describe one folder alike. Listed,
 * never copied (plan Task 3 Step 1): staging belongs to the draw, which
 * knows the render's public dir. The planner sees what the draw will be
 * able to use, so a file the draw would skip is skipped here too, with a
 * warning. No folder, no assets.
 */
export async function plannerAssets(
  assetsDir: string | undefined,
  probeImageSize: ((path: string) => Promise<{ width: number; height: number }>) | undefined,
  log: (line: string) => void,
): Promise<PlannerAsset[]> {
  if (assetsDir === undefined) return [];
  const listed = await listAssets(assetsDir, probeImageSize ?? ffprobeImageSize);
  for (const w of listed.warnings) log(`  ⚠ storyboard: ${w}`);
  return listed.assets.map(({ src: _src, ...rest }) => rest);
}

/**
 * The limits' context, shared by the first plan and "Plan again", so a
 * re-plan is held to exactly the limits the first one was: the limits scenes
 * have today (design §2 "Limits"), `MAX_SCENE_SEC` and the gap assembly
 * keeps between scenes, on the clock of the cut the plan was made on.
 */
export function planLimitContext(a: {
  words: readonly unknown[];
  cut: ReadonlySet<number>;
  wordTimes: readonly WordOutputTime[];
  outputDurationSec: number;
  assets: readonly PlannerAsset[];
  blocked: readonly { startWord: number; endWord: number }[];
}): LimitContext {
  return {
    wordCount: a.words.length,
    cut: a.cut,
    outputTimeOf: (i) => a.wordTimes[i] ?? null,
    outputDurationSec: a.outputDurationSec,
    maxShotSec: MAX_SCENE_SEC,
    gapSec: SCENE_GAP_SEC,
    assetNames: a.assets.map((x) => x.name),
    blocked: a.blocked,
  };
}

/**
 * The console line (pure). "Changed" counts shots, not changes: one shot
 * moved and then trimmed is one shot the author should look at.
 */
export function storyboardLine(r: StoryboardRunResult): string {
  const n = r.storyboard.shots.length;
  if (!r.planned) return `▸ storyboard: loaded ${n} shots (not planned again)`;
  const changed = new Set(r.changes.map((c) => c.index)).size;
  return `▸ storyboard: ${n} shots planned (${changed} changed by limits)`;
}

/**
 * The `report.txt` block (pure): each kept shot with its place on the output
 * clock, then each limit change. A change names the shot by its index in the
 * planner's reply, as `LimitChange` does, because the reasons refer to other
 * shots by that same index; the reply itself is in the plan cache.
 */
export function formatStoryboardReport(
  r: StoryboardRunResult,
  outputTimeOf: (wordIndex: number) => { start: number; end: number } | null,
): string {
  const lines = ["", "storyboard plan:"];
  for (const s of r.storyboard.shots) {
    if (!s.kept) continue;
    const a = outputTimeOf(s.startWord);
    const b = outputTimeOf(s.endWord);
    // A loaded table may hold a shot whose end words the author has since
    // cut; it is still a row of the table, so it is listed, without a time
    // the clock cannot give.
    const at = a !== null && b !== null ? `${a.start.toFixed(1)}–${b.end.toFixed(1)} s` : "cut away";
    lines.push(`  ${s.id}  ${at}  p${s.priority}  ${s.idea}`);
  }
  for (const c of r.changes) lines.push(`  planner shot ${c.index}: ${c.kind}, ${c.reason}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `--storyboard`'s effect on the run's end (pure; design §1 step 2): it
 * never renders, since there is nothing drawn to render yet, and it opens
 * the editor as `--review` does, because the table is reviewed there. Unlike
 * `--review` (`reviewFlag`), a typed `--no-open-editor` is honoured rather
 * than refused: a storyboard run is also how a script or a test plans a
 * table, and the table on disk is useful without an editor. Applied after
 * `reviewFlag`, so `--review --storyboard` keeps `--review`'s answer.
 */
export function storyboardFlag(
  storyboard: boolean,
  resolved: { render: boolean; openEditor: boolean | undefined },
): { render: boolean; openEditor: boolean | undefined } {
  if (!storyboard) return resolved;
  return { render: false, openEditor: resolved.openEditor === false ? false : true };
}

/**
 * `--assets <dir>` as typed (the `ScriptFlagSchema` rule): an empty value
 * is an error naming the flag, not the current folder. Whether the folder
 * exists is `assertAssetsDir`'s question, asked in produce before any work.
 */
export const AssetsFlagSchema = z
  .string()
  .refine((v) => v.trim().length > 0, { message: "--assets needs a folder path" });
