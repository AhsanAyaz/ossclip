/**
 * `ossclip produce --script <file>` (explainer spec §1.6, FINDINGS §158): the
 * CLI half of script mode — the whole-script checks that run before any
 * transcription, the plan cache key, the per-cue report, and the argv the
 * editor's Re-plan swaps in.
 *
 * PURE, every function here: produce.ts reads the files, runs ffmpeg and the
 * planner, and hands the results in, so the report and the checks are tested
 * without a workdir (the `openCommand()`/`openInBrowser()` split).
 */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  ALIGN_FLOOR,
  MAX_SCRIPT_CUES,
  ProductionScriptSchema,
  SceneSchema,
  ScriptComponentIdSchema,
  ScriptMomentSchema,
  TimeMap,
  applyCleanupChoices,
  applyUserCuts,
  cutWordIndices,
  scriptComponentIds,
  type AlignedCue,
  type FramingContext,
  type LlmEffort,
  type OverrideDoc,
  type PlannerComponentId,
  type ProductionScript,
  type Scene,
  type ScriptCue,
  type ScriptMoment,
  type Segment,
  type SkippedCue,
  type WordOutputTime,
} from "@ossclip/core";
import { ClipImportError, resolveClipPath } from "./clip-import";

/**
 * The workdir copy of a project's script, written by the editor's Re-plan from
 * `production.json`'s stored text (plan Review Focus 5: Re-plan must work
 * after the original file moved or was deleted).
 */
export const STORED_SCRIPT_BASENAME = "script.md";

/**
 * The `script` record out of a production.json's TEXT, or undefined. Pure so
 * the two readers — produce's `priorScript` and the edit server's Re-plan —
 * share one parse without edit.ts importing produce.ts (which imports it).
 * Tolerant like `priorSfxPlan`: unreadable JSON, no record, or a record that
 * fails the schema all mean "no stored script". Parsed, never cast.
 */
export function storedScriptFrom(productionJson: string): ProductionScript | undefined {
  try {
    const raw = JSON.parse(productionJson) as { script?: unknown };
    if (raw.script === undefined) return undefined;
    const parsed = ProductionScriptSchema.safeParse(raw.script);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Where the per-cue report lands beside report.txt, as `{ outcomes }`. */
export const SCRIPT_REPORT_BASENAME = "script-report.json";

/**
 * `--script <file>`'s value, parsed (CLAUDE.md: parse, never coerce). Only
 * emptiness is refused here — `--script ""` (a wizard-style blank, or a shell
 * variable that expanded to nothing) would otherwise resolve to the current
 * directory and fail later with a confusing read error. The value is returned
 * as typed, untrimmed: a path is the user's, and whether it exists is
 * `loadScriptText`'s question, asked before any transcription.
 */
export const ScriptFlagSchema = z
  .string()
  .refine((v) => v.trim().length > 0, { message: "--script needs a file path" });

/**
 * Read the script, or fail naming it. The read is injected so the message is
 * tested without a filesystem; any failure (missing, a directory, no
 * permission) is the same answer to the user: the path they gave is not a
 * script ossclip can read, and nothing has been transcribed yet.
 */
export function loadScriptText(abs: string, read: (p: string) => string): string {
  try {
    return read(abs);
  } catch {
    throw new Error(`script file not found: ${abs}`);
  }
}

/**
 * Everything wrong with a parsed script that can be known before the take is
 * transcribed, one line per problem, each naming the script line (plan Task
 * 8, "whole-script checks"). Run on the PARSED cues, not the aligned ones: a
 * typo'd `[Nope]` on a cue that later fails to align would otherwise slip
 * through to the next recording, and a transcription is minutes the author
 * should not spend to learn about a typo.
 *
 * Every problem is listed rather than the first: fixing a script one error per
 * run is the slowest loop there is. Missing clip FILES are checked separately
 * (`planScriptClips`), because a re-plan may legitimately keep a WebM whose
 * source is gone, and that needs the workdir.
 */
export function scriptCueProblems(cues: readonly ScriptCue[], scriptPath: string): string[] {
  const problems: string[] = [];
  // No cues at all is almost always the wrong file (a notes doc, the playbook
  // itself): a run that plans nothing from it would look like it worked.
  if (cues.length === 0) problems.push("the script has no 🎬 cues — is this the right file?");
  if (cues.length > MAX_SCRIPT_CUES) {
    problems.push(
      `the script has ${cues.length} cues; at most ${MAX_SCRIPT_CUES} are supported — split the video or merge cues`,
    );
  }
  // The script menu, the same schema `planScriptMoments` parses a hint with:
  // a `[CardRow]` is valid here and only here (plan Task 4), and a typo is
  // told the script-only names too.
  const valid = scriptComponentIds().join(", ");
  for (const cue of cues) {
    if (cue.hint.kind === "component" && !ScriptComponentIdSchema.safeParse(cue.hint.component).success) {
      problems.push(`script line ${cue.line}: unknown component [${cue.hint.component}]; valid names: ${valid}`);
    }
    if (cue.hint.kind === "clip") {
      try {
        resolveClipPath(scriptPath, cue.hint.path);
      } catch (err) {
        if (!(err instanceof ClipImportError)) throw err;
        problems.push(`script line ${cue.line}: ${err.message}`);
      }
    }
  }
  return problems;
}

/**
 * The script file whose folder `clip:` paths resolve against. Normally the
 * file given; but when the editor's Re-plan points `--script` at the
 * workdir's stored copy, the clips still live beside the ORIGINAL file, and
 * that path is the one `production.json` recorded. The stored copy is
 * recognised by its location, which only Re-plan writes.
 */
export function scriptSourcePath(
  scriptAbs: string,
  work: string,
  prior: ProductionScript | undefined,
): string {
  const isStoredCopy = resolve(scriptAbs) === resolve(join(work, STORED_SCRIPT_BASENAME));
  return isStoredCopy && prior?.sourcePath ? prior.sourcePath : scriptAbs;
}

/** How one `clip:` cue will be imported: from its source, or from the project's WebM. */
export interface PlannedScriptClip {
  /** As the script writes it. */
  path: string;
  /** Resolved against the source script's folder. */
  abs: string;
  /** Set when the source is gone but the project already holds its WebM. */
  reuse?: { src: string; durationSec: number };
}

/**
 * Resolve every `clip:` cue against the source script's folder, by cue id.
 * A source that exists is imported as usual (an unchanged one reuses its WebM
 * by name). A source that is MISSING is acceptable only when the project
 * recorded this path's WebM and that file is still in the workdir: that is
 * the Re-plan-after-the-clips-moved case (plan Task 8). Anything else is a
 * problem naming the script line and the file, before transcription.
 */
export function planScriptClips(
  cues: readonly ScriptCue[],
  sourcePath: string,
  work: string,
  stored: readonly NonNullable<ProductionScript["clips"]>[number][],
  exists: (p: string) => boolean,
): { clips: Map<string, PlannedScriptClip>; problems: string[] } {
  const clips = new Map<string, PlannedScriptClip>();
  const problems: string[] = [];
  for (const cue of cues) {
    if (cue.hint.kind !== "clip") continue;
    const path = cue.hint.path;
    let abs: string;
    try {
      abs = resolveClipPath(sourcePath, path);
    } catch (err) {
      if (!(err instanceof ClipImportError)) throw err;
      problems.push(`script line ${cue.line}: ${err.message}`);
      continue;
    }
    if (exists(abs)) {
      clips.set(cue.id, { path, abs });
      continue;
    }
    const record = stored.find((r) => r.path === path);
    if (record && exists(join(work, ...record.src.split("/")))) {
      clips.set(cue.id, { path, abs, reuse: { src: record.src, durationSec: record.durationSec } });
      continue;
    }
    problems.push(`script line ${cue.line}: clip file not found: ${abs}`);
  }
  return { clips, problems };
}

/**
 * The clip records `production.json` keeps: this run's imports, plus earlier
 * records for clip paths the script still names but this run did not import
 * (a cue that failed to align this time). Dropping those would make a later
 * re-plan that DOES align them fail if the source has gone since.
 */
export function mergeClipRecords(
  prior: NonNullable<ProductionScript["clips"]>,
  current: NonNullable<ProductionScript["clips"]>,
  scriptClipPaths: readonly string[],
): NonNullable<ProductionScript["clips"]> {
  const now = new Set(current.map((c) => c.path));
  const named = new Set(scriptClipPaths);
  return [...current, ...prior.filter((p) => !now.has(p.path) && named.has(p.path))];
}

/** The clip import's output shape (`clipOutputName`): the only `src` produce copies around. */
export function isProjectClipSrc(src: string): boolean {
  return /^clips\/[0-9a-f]{12}\.webm$/.test(src);
}

/**
 * The words a script run aligns against and plans with: those the EFFECTIVE
 * cut removes — the automatic cutlist after the user's cleanup vetoes and the
 * editor's cuts from `overrides.json`, i.e. the cut that will be rendered
 * (FINDINGS §158, 2026-11-16). The explainer workflow is cut and review
 * first, then add the graphics, so a script line has to land on the take the
 * author KEPT. Aligned against the automatic cut instead, the first real
 * project (39 user cuts, 3 vetoes) placed 11 of 22 cues: lines whose words
 * only the user's edits kept scored under the floor, and lines matched on
 * words the user then cut were dropped at assembly.
 *
 * No second implementation of cut application: the same two calls, in the
 * same order, as produce's own "cleanup vetoes reshape the PROPOSAL" block —
 * vetoes first, then the user's cuts subtract from the result, so a cut drawn
 * over a vetoed pause still cuts. `priorMap` is that block's too (the prior
 * render-props.json), because a src-less cut is in the frame the user drew it
 * in. Only the cutlist is used here; the doc write-back and the reports stay
 * with that block, which runs later on the same inputs.
 */
export function scriptPlanCut(parts: ScriptPlanCutParts): Set<number> {
  return cutWordIndices(parts.words, scriptPlanCutlist(parts));
}

interface ScriptPlanCutParts {
  words: readonly { start: number; end: number }[];
  /** The automatic cutlist, as produce built it. */
  cutlist: readonly Segment[];
  doc: OverrideDoc;
  priorMap: TimeMap | null;
}

/**
 * The effective cutlist `scriptPlanCut` reads its words from — exported
 * because the minimum scene length (`SCRIPT_MIN_SCENE_SEC`, §161) is screen
 * time, measured on THIS cutlist's clock: the one the video renders with,
 * the same one produce's edit-layer block rebuilds after planning.
 */
export function scriptPlanCutlist(parts: ScriptPlanCutParts): Segment[] {
  const vetoed = applyCleanupChoices(parts.cutlist, parts.doc.cleanup);
  return applyUserCuts(parts.doc, vetoed, new TimeMap(vetoed), parts.priorMap).cutlist;
}

/**
 * Every word's place on the output clock for the minimum scene length
 * (`ScriptPlanInput.wordTimes`): `map`'s times for the words the aligner
 * could use, null for every word in `cut`. The cut SET decides, not
 * `mapWord` alone: a word whose midpoint is cut can keep a sliver in the
 * map, and a scene must never end on a word the alignment treats as gone.
 */
export function keptWordTimes(
  words: readonly { start: number; end: number }[],
  cut: ReadonlySet<number>,
  map: TimeMap,
): WordOutputTime[] {
  return words.map((w, i) => (cut.has(i) ? null : map.mapWord({ text: "", ...w })));
}

/**
 * The kept words, with their transcript index, as one string for the cache
 * key. Indices are part of it on purpose: two cutlists can keep the same TEXT
 * from different takes ("And they were right." said twice, either one cut),
 * and the plan's word anchors would then point at the cut take.
 */
export function keptWordsKey(words: readonly { text: string }[], cut: ReadonlySet<number>): string {
  return JSON.stringify(words.flatMap((w, i) => (cut.has(i) ? [] : [[i, w.text]])));
}

/**
 * The script-plan cache key (`scriptplan-<key>.json`). Its own key and file,
 * never the beat sheet's: a script plan answers a different question, and
 * sharing a file would let either mode serve the other (G6).
 *
 * The plan named four parts (prompt version, script text, kept words, clip
 * names); the rest are the beat-sheet key's plan-steering parts, for its
 * reason (§78: a change that changes the answer must change the key) —
 * a `--force-component` or a re-measured framing on a cached script run
 * would otherwise be silently ignored, and `providerName` keeps the §143/§150
 * read/write split working (`scriptPlanCacheKeyCandidates`).
 */
export function scriptPlanCacheKey(parts: {
  promptVersion: string;
  scriptText: string;
  keptWords: string;
  /** The imported WebMs, in cue order — their names hash each clip's bytes. */
  clipNames: string[];
  providerName: string;
  llmModel?: string;
  llmEffort?: LlmEffort;
  forceComponent?: PlannerComponentId;
  framing?: FramingContext;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        parts.promptVersion,
        parts.scriptText,
        parts.keptWords,
        parts.clipNames,
        parts.providerName,
        parts.llmModel ?? null,
        parts.llmEffort ?? null,
        parts.forceComponent ?? null,
        parts.framing ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}

/** The keys to try on read, primary then fallback provider — `beatCacheKeyCandidates` (§150). */
export function scriptPlanCacheKeyCandidates(
  parts: Omit<Parameters<typeof scriptPlanCacheKey>[0], "providerName">,
  providerName: string,
  fallbackName: string | undefined,
): string[] {
  const keys = [scriptPlanCacheKey({ ...parts, providerName })];
  if (fallbackName && fallbackName !== providerName) {
    keys.push(scriptPlanCacheKey({ ...parts, providerName: fallbackName }));
  }
  return keys;
}

/**
 * What the script-plan cache stores: everything `produceScenes` returned that
 * a cached run still needs — the scenes, the moments (the report reads
 * footage cues off them, and `--sfx` plans against them), the hook for the
 * cover, and the issues for the report. Parsed on read, never trusted: a
 * malformed file is a re-plan, not a crash. Moments are not capped at the
 * beat sheet's 24 — a script may carry 40 cues. `ScriptMomentSchema`, not
 * `MomentSchema`: a plan holding a CardRow would fail the planner enum and
 * re-plan on every run.
 */
export const ScriptPlanCacheSchema = z.object({
  hook: z.string(),
  moments: z.array(ScriptMomentSchema),
  scenes: z.array(SceneSchema),
  issues: z.array(z.object({ moment: z.number().int(), issue: z.string() })),
  /** Scenes whose props call fell back to a TitleCard — the "planned" line's count. */
  failures: z.number().int().nonnegative(),
});
export type ScriptPlanCache = z.infer<typeof ScriptPlanCacheSchema>;

/**
 * A `footage cue <id>` issue (script-plan.ts): a cue the planner left as
 * talking head. In script mode it is a `reported` outcome in the cue report,
 * not a `⚠` warning — nothing went wrong, the cue described footage.
 */
export function isFootageCueIssue(issue: { issue: string }): boolean {
  return issue.issue.startsWith("footage cue ");
}

export type CueOutcome =
  | {
      cueId: string;
      line: number;
      text: string;
      status: "placed";
      component: string;
      startSec: number;
      /**
       * Set only when the scene was held past its line to reach
       * `SCRIPT_MIN_SCENE_SEC` (§161): the line's length, then the scene's,
       * in seconds. Optional so a report without a lengthened cue reads
       * exactly as before.
       */
      lengthened?: { fromSec: number; toSec: number };
    }
  | { cueId: string; line: number; text: string; status: "skipped"; reason: string; score?: number }
  | {
      cueId: string;
      line: number;
      text: string;
      status: "shortened";
      component: string;
      startSec: number;
      /** Lengths, wanted then got (the assembler's `shortened`), not end times. */
      fromSec: number;
      toSec: number;
    }
  | { cueId: string; line: number; text: string; status: "reported"; reason: "screen recording" | "footage cue" };

/**
 * One outcome per cue of the script, in script order (explainer spec §1.6):
 * what happened to every `🎬` line the author wrote, so a cue that did not
 * make it is named rather than silently missing from the video.
 *
 * Scenes and moments are matched to their cue by the cue's last word: the
 * one whose span CONTAINS `aligned.endWord`. Normalization may move a
 * moment's start forward but never its end, and a scene's anchor is its
 * moment's span. The minimum scene length (§161) then moves a graphic
 * scene's end LATER, but never to or past the next cue's first word, and
 * cues cannot cross (§1.2) — so each span holds exactly one cue's last word
 * and the match needs no id threading through the planner (the argument
 * `produceScriptScenes` makes for clip scenes). A scene whose end lies past
 * its cue's last word was lengthened, and says so when `wordTimes` (the
 * line's length) and the cue's `endSec` (the scene's) are both known.
 */
export function cueOutcomes(parts: {
  cues: readonly ScriptCue[];
  aligned: readonly AlignedCue[];
  skipped: readonly SkippedCue[];
  /** The plan's final moments (after normalization). */
  moments: readonly ScriptMoment[];
  /** The planned scenes, clip scenes included. */
  scenes: readonly Scene[];
  /** The assembled cues — output-timed. */
  timed: readonly { id: string; startSec: number; endSec?: number }[];
  /** The assembler's drops, with its reasons. */
  dropped: readonly { id: string; reason: string }[];
  shortened: readonly { id: string; fromSec: number; toSec: number }[];
  /** Each transcript word on the output clock (null = cut), for a lengthened line's own length. */
  wordTimes?: readonly WordOutputTime[];
}): CueOutcome[] {
  const skippedById = new Map(parts.skipped.map((s) => [s.cue.id, s]));
  const alignedById = new Map(parts.aligned.map((a) => [a.cue.id, a]));
  const timedById = new Map(parts.timed.map((t) => [t.id, t]));
  const droppedById = new Map(parts.dropped.map((d) => [d.id, d]));
  const shortenedById = new Map(parts.shortened.map((s) => [s.id, s]));

  return parts.cues.map((cue): CueOutcome => {
    const base = { cueId: cue.id, line: cue.line, text: cue.cueText };
    const skipped = skippedById.get(cue.id);
    if (skipped) {
      if (skipped.reason === "screen") return { ...base, status: "reported", reason: "screen recording" };
      if (skipped.reason === "no-spoken-lines") return { ...base, status: "skipped", reason: "no spoken lines" };
      return {
        ...base,
        status: "skipped",
        // The floor in the words, so a 0.58 reads as "nearly", not "absent".
        reason: `spoken lines below the ${ALIGN_FLOOR} match floor`,
        ...(skipped.score !== undefined ? { score: skipped.score } : {}),
      };
    }
    const aligned = alignedById.get(cue.id);
    // Every parsed cue is either aligned or skipped; this is the honest
    // answer if a caller ever hands in a partial alignment.
    if (!aligned) return { ...base, status: "skipped", reason: "not aligned" };

    const holds = (span: { startWord: number; endWord: number }) =>
      span.startWord <= aligned.endWord && aligned.endWord <= span.endWord;
    const scene = parts.scenes.find((s) => holds(s.anchor));
    if (!scene) {
      const moment = parts.moments.find(holds);
      if (moment && moment.sceneKind === "none") return { ...base, status: "reported", reason: "footage cue" };
      return { ...base, status: "skipped", reason: "dropped in planning" };
    }
    const drop = droppedById.get(scene.id);
    if (drop) return { ...base, status: "skipped", reason: `dropped: ${drop.reason}` };
    const timed = timedById.get(scene.id);
    if (!timed) return { ...base, status: "skipped", reason: "not on the timeline" };
    const short = shortenedById.get(scene.id);
    if (short) {
      return {
        ...base,
        status: "shortened",
        component: scene.component,
        startSec: timed.startSec,
        fromSec: short.fromSec,
        toSec: short.toSec,
      };
    }
    const first = parts.wordTimes?.[aligned.startWord];
    const last = parts.wordTimes?.[aligned.endWord];
    const lengthened =
      scene.anchor.endWord > aligned.endWord && first && last && timed.endSec !== undefined
        ? { fromSec: last.end - first.start, toSec: timed.endSec - timed.startSec }
        : undefined;
    return {
      ...base,
      status: "placed",
      component: scene.component,
      startSec: timed.startSec,
      ...(lengthened ? { lengthened } : {}),
    };
  });
}

/** A cue's text for one report line: enough to recognise it, never a wrapped paragraph. */
function clip(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The cue report, one line per cue and a summary line (explainer spec §1.6),
 * printed with report.txt — after planning, before rendering, so a `--review`
 * run shows it too — and written beside it. It replaces the graphics
 * accounting's "target is ~1 per 9s" line in script mode: the author asked
 * for exactly these cues, so the right denominator is the script.
 *
 * A shortened cue counts as placed (it is on screen) and the summary says how
 * many were cut to the 15 s ceiling, so the counts always add up to the cues.
 * A lengthened one is placed too: its line says how long it is held against
 * its spoken line (`SCRIPT_MIN_SCENE_SEC`, §161), and the summary counts them,
 * so an author reading "held 4.0s for a 1.3s line" knows the scene runs on
 * over the words after it.
 */
export function formatCueReport(outcomes: readonly CueOutcome[]): string {
  const lines = outcomes.map((o) => {
    const head = `  line ${String(o.line).padEnd(4)} ${o.status.padEnd(9)} `;
    const what = `"${clip(o.text)}"`;
    switch (o.status) {
      case "placed":
        return (
          `${head}${o.component} at ${o.startSec.toFixed(1)}s` +
          (o.lengthened
            ? `, held ${o.lengthened.toSec.toFixed(1)}s for a ${o.lengthened.fromSec.toFixed(1)}s line`
            : "") +
          ` — ${what}`
        );
      case "shortened":
        return (
          `${head}${o.component} at ${o.startSec.toFixed(1)}s, ` +
          `${o.fromSec.toFixed(1)}s cut to ${o.toSec.toFixed(1)}s — ${what}`
        );
      case "skipped":
        return `${head}${o.reason}${o.score !== undefined ? ` (best match ${o.score.toFixed(2)})` : ""} — ${what}`;
      case "reported":
        return `${head}${o.reason}, left to the footage — ${what}`;
    }
  });
  const count = (s: CueOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const shortened = count("shortened");
  const lengthened = outcomes.filter((o) => o.status === "placed" && o.lengthened).length;
  const notes = [
    ...(shortened > 0 ? [`${shortened} shortened`] : []),
    ...(lengthened > 0 ? [`${lengthened} lengthened`] : []),
  ];
  const summary =
    `placed ${count("placed") + shortened} of ${outcomes.length}` +
    (notes.length > 0 ? ` (${notes.join(", ")})` : "") +
    ` · skipped ${count("skipped")} · reported ${count("reported")}`;
  return `script cues:\n${lines.join("\n")}\n${summary}`;
}

/**
 * The argv the editor's Re-plan runs for a script project: `--script` points
 * at the workdir's stored copy (so it works after the original moved), and a
 * `--scenes` pin is dropped. That pin is there whenever the editor rendered
 * before: a Render replays with `--scenes` and records that argv
 * (renderReplayArgs), and `--script` refuses `--scenes` — a re-plan is a
 * fresh plan by definition. `--produce` is not needed: `--script` implies it.
 */
export function replanScriptArgs(recorded: readonly string[], scriptCopy: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < recorded.length; i++) {
    const arg = recorded[i]!;
    // Value options: dropped WITH their value, never leaving it as a stray
    // positional (§129's failure shape).
    if (arg === "--script" || arg === "--scenes") {
      i++;
      continue;
    }
    out.push(arg);
  }
  out.push("--script", scriptCopy);
  return out;
}
