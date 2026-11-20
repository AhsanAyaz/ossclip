import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  KIT_VERSION,
  KitReportSchema,
  ProbeSchema,
  SPEAKER_PICTURE_NOTE,
  SceneCueSchema,
  ThemeSchema,
  buildFcpxmlKit,
  isWslEnv,
  kitCaptionsSrt,
  kitClipPlans,
  kitFileUrl,
  loadConfig,
  needsRender,
  probe,
  sourceClipPlacement,
  stageBundledFonts,
  type KitClipPlan,
  type KitReport,
  type KitReportClip,
  type KitTimelineInput,
  type KitTimelineMedia,
  type Theme,
} from "@ossclip/core";
import type { SceneClipProps } from "@ossclip/renderer";
import { placedPictureFor } from "@ossclip/scenes/geometry";
import { RecordedCommandSchema, type RecordedCommand } from "./cover";
import { resolveClipPath } from "./clip-import";
import { expandHome } from "./paths";
import { renderSignalAction, resolveRenderConcurrency } from "./produce";
import {
  REVIEWED_SCENES_BASENAME,
  healRecordedProduceArgs,
  renderReplayArgs,
  reviewedScenesText,
} from "./render-replay-args";
import { storedScriptFrom, storedStoryboardFrom } from "./script-mode";

/**
 * `ossclip kit` (§162, design "Phase 3: clip kit"): one transparent ProRes
 * clip per visible scene of a produced project, plus an FCPXML timeline
 * that opens in DaVinci Resolve with the cut source on track 1 and the
 * scene clips on the track above.
 *
 * The decisions are core's (`kitClipPlans`, `needsRender`, `buildFcpxmlKit`,
 * `kitFileUrl`); this file is the I/O around them. Every side effect reaches
 * `runKit` through `KitSeams`, the cover.ts split, so the whole command runs
 * in a test with no Remotion, no ffmpeg and no TTY.
 */

export const KIT_REPORT_BASENAME = "kit-report.json";
export const KIT_TIMELINE_BASENAME = "timeline.fcpxml";
export const KIT_CLIPS_DIRNAME = "clips";
export const KIT_SRT_BASENAME = "captions.srt";
/** What `produce` writes into the workdir for a folder of takes: the re-encoded join. */
const SOURCE_CONCAT_BASENAME = "source-concat.mp4";

/** The one line the summary ends on (design 3.1). */
export const KIT_RESOLVE_HINT = "File → Import → Timeline…, then pick timeline.fcpxml";
/** Printed after it whenever captions.srt was written (design kit-captions-layer.md, Part 1). */
export const KIT_SUBTITLES_HINT = "File → Import → Subtitle…, pick captions.srt, then drag it onto the timeline";
/** Printed when the project has no line to write. */
export const KIT_NO_CAPTIONS_MESSAGE = "▸ no captions in this project; captions.srt not written";

// ---- The user's flags ------------------------------------------------------

export interface KitFlags {
  out?: string;
  clipsOnly: boolean;
  force: boolean;
  refresh: boolean;
}

/**
 * `ossclip kit`'s flags, parsed rather than coerced (CLAUDE.md). Commander
 * hands the booleans over as booleans, so the live risk is `--out ""` (a
 * shell variable that expanded to nothing), which would otherwise resolve to
 * the current directory and fill it with clips. Each error names its flag.
 */
export function parseKitFlags(raw: {
  out?: unknown;
  clipsOnly?: unknown;
  force?: unknown;
  refresh?: unknown;
}): KitFlags {
  const bool = (name: string, value: unknown, fallback: boolean): boolean => {
    const parsed = z.boolean().optional().safeParse(value);
    if (!parsed.success) throw new Error(`${name} is a switch and takes no value, got ${JSON.stringify(value)}`);
    return parsed.data ?? fallback;
  };
  let out: string | undefined;
  if (raw.out !== undefined) {
    const parsed = z.string().refine((v) => v.trim() !== "").safeParse(raw.out);
    if (!parsed.success) {
      throw new Error(`--out wants the folder to write the kit into, got ${JSON.stringify(raw.out)}`);
    }
    out = parsed.data;
  }
  return {
    out,
    clipsOnly: bool("--clips-only", raw.clipsOnly, false),
    force: bool("--force", raw.force, false),
    // commander's `--no-refresh` defaults the key to true.
    refresh: bool("--no-refresh", raw.refresh, true),
  };
}

// ---- The project files, parsed ---------------------------------------------

/**
 * The slice of `render-props.json` the kit needs — selective and parsed,
 * the `CoverRenderPropsSchema` posture. `sceneCues` is what the full render
 * drew: the last produce run's overrides applied and hidden scenes already
 * dropped, which is how hiding a scene leaves it out of the kit (design
 * 3.2). The ORIGINAL cues are parsed here; the rebased ones `kitClipPlans`
 * makes are never put through `SceneCueSchema` (a rebased reveal time can be
 * negative, and the schema would refuse a scene the renderer draws fine).
 */
export const KitRenderPropsSchema = z.object({
  sceneCues: z.array(SceneCueSchema),
  spans: z.array(
    z.object({
      srcIn: z.number(),
      srcOut: z.number(),
      outIn: z.number(),
      outOut: z.number(),
    }),
  ),
  theme: ThemeSchema,
  settings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  outputDurationSec: z.number().nonnegative(),
  // For captions.srt (design kit-captions-layer.md, Part 1): only what an SRT
  // entry needs, the `RenderPropsExportSchema` slice (analyze.ts) restated so
  // the kit does not import the export command. Always present in a project
  // produce wrote, with the author's caption edits applied, and present too
  // under --no-captions or the editor's hide setting, which only stop the
  // render drawing them. Optional so a project from before the field reads
  // as one with no lines; a line that is there but malformed fails the parse
  // like any other field, rather than shortening the SRT unseen.
  captionLines: z
    .array(
      z.object({
        words: z.array(z.object({ text: z.string() })),
        start: z.number(),
        end: z.number(),
      }),
    )
    .optional(),
});
export type KitRenderProps = z.infer<typeof KitRenderPropsSchema>;

/** The slice of `production.json` the kit needs: the source and its probe. */
const KitProductionSchema = z.object({
  source: z.object({ path: z.string(), probe: ProbeSchema }),
});

interface KitProject {
  props: KitRenderProps;
  source: z.infer<typeof KitProductionSchema>["source"];
  /** production.json's text, for `storedScriptFrom` and the refresh's pinned plan. */
  productionText: string;
}

// ---- Pure pieces -------------------------------------------------------------

/**
 * The argv the refresh replays (§162, plan decision 1): the editor's Render
 * replay — healed (§129), the reviewed plan pinned with `--scenes`,
 * `--produce` and `--script` dropped (renderReplayArgs) — plus `--no-render`,
 * because the kit needs fresh render props, not a video.
 *
 * And the editor kept shut. A record may carry a typed `--open-editor`, which
 * would start an edit server inside the replay child that nobody sees and
 * that holds it open forever; `--no-open-editor` is appended, and both
 * spellings are dropped first so it is never doubled or contradicted.
 * `--review` is dropped too: `recordedProduceArgs` already strips it at
 * record, and beside `--no-open-editor` it is an error (reviewFlag).
 */
export function kitReplayArgs(recorded: readonly string[], scenesPath: string | undefined): string[] {
  const args = renderReplayArgs(healRecordedProduceArgs(recorded), { scenesPath }).filter(
    (a) => a !== "--no-render" && a !== "--open-editor" && a !== "--no-open-editor" && a !== "--review",
  );
  args.push("--no-render", "--no-open-editor");
  return args;
}

/**
 * Where the kit goes without `--out` (design 3.1): beside the source, so
 * Resolve on the Windows side of WSL can reach it when the source is on
 * `/mnt/c`. `take.mp4` → `take-kit/`; a folder of takes → `<folder>-kit/`
 * beside the folder, never inside it (the folder is the input, and produce
 * refuses to write into it for the same reason).
 */
export function defaultKitDir(sourcePath: string, sourceIsFolder: boolean): string {
  const abs = resolve(sourcePath);
  if (sourceIsFolder) return `${abs}-kit`;
  return join(dirname(abs), `${basename(abs, extname(abs))}-kit`);
}

/**
 * Kit clips render at most two tabs at a time (§162): every tab holds a
 * full-frame PNG pipeline with alpha, and the kit is run on the same
 * machines whose browser produce's cpus-2 guess already killed (the
 * 2026-08-19 field case). A config asking for FEWER is honoured; one asking
 * for more is not, since a clip is seconds long and two tabs already finish
 * one in about ten.
 */
export const KIT_MAX_CONCURRENCY = 2;

export function kitConcurrency(
  configValue: unknown,
  cpuCount: number,
): { concurrency: number; warning?: string } {
  const r = resolveRenderConcurrency(undefined, configValue, cpuCount);
  return { ...r, concurrency: Math.min(KIT_MAX_CONCURRENCY, r.concurrency) };
}

/**
 * A plan's notes as the report writes them: the speaker-picture note gains
 * the picture's top-left and diameter in output pixels (§163, design 6), so
 * the author can place the footage on track 1 where the full render drew
 * the circle. Here and not in core because the rectangle is the scenes
 * package's (`placedPictureFor`: the frame's picture at the cue's own
 * `pip.x/y`, the one VideoStage draws), which core cannot import. Rounded
 * to whole pixels, which is what Resolve's transform fields take. The
 * diameter is the picture's width; in 16:9 the picture is square.
 */
export function kitReportNotes(plan: KitClipPlan, frame: { width: number; height: number }): string[] {
  return plan.notes.map((note) => {
    if (note !== SPEAKER_PICTURE_NOTE) return note;
    const r = placedPictureFor(plan.cue, frame);
    const px = (v: number): number => Math.round(v);
    return `${note} (picture at x ${px(r.x * frame.width)}, y ${px(r.y * frame.height)}, ${px(r.w * frame.width)} px)`;
  });
}

/**
 * Why a "render" plan cannot be drawn from this work folder, or null. A
 * `ScreenshotFrame` names its image by a path inside the render's public
 * dir (`side-images/…`); the kit renders from the work folder, and an image
 * that is not there would 404 inside the browser and fail the clip. A
 * remote `src` is the browser's to fetch, as in the full render.
 */
export function unrenderableReason(plan: KitClipPlan, exists: (rel: string) => boolean): string | null {
  if (plan.component !== "ScreenshotFrame") return null;
  const src = plan.cue.props?.src;
  if (typeof src !== "string" || src === "" || /^https?:\/\//.test(src)) return null;
  return exists(src) ? null : `side image ${src} is not in the work folder`;
}

// ---- The command ------------------------------------------------------------

export interface KitProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/**
 * Every side effect `runKit` has. Paths are absolute. The live set is
 * `liveKitSeams()`; a test passes its own and never boots Remotion.
 */
export interface KitSeams {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  exists(path: string): boolean;
  /** Null when the path does not exist. */
  stat(path: string): { mtimeMs: number; isDirectory: boolean } | null;
  /** The path with every symlink resolved; throws when it cannot be. */
  realpath(path: string): string;
  /** Recursive. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  probe(path: string): Promise<KitProbe>;
  stageFonts(theme: Theme, dirs: string[]): void;
  /** One bundle of the render entry for the whole run. */
  bundle(publicDir: string): Promise<string>;
  /**
   * Render one clip to `outPath`. Writes nothing under that name until the
   * clip is complete (`renderSceneClip`'s partial-then-rename), so a failed or
   * cancelled render never looks reusable.
   */
  renderClip(
    props: SceneClipProps,
    opts: { outPath: string; publicDir: string; serveUrl: string; onProgress: (fraction: number) => void },
  ): Promise<void>;
  /** Run the recorded produce with `args`; the exit code and the output's last lines. */
  replayProduce(req: {
    cmd: RecordedCommand;
    args: string[];
    workdir: string;
  }): Promise<{ code: number; tail: string[] }>;
  now(): Date;
  log(line: string): void;
  platform: string;
  env: Record<string, string | undefined>;
  /** `/proc/version`'s text, or null when it could not be read. */
  procVersion: string | null;
  /** What `--out` is resolved against. */
  cwd: string;
}

/** A failure that ends the command with a specific exit code (a failed refresh replay). */
export class KitExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "KitExitError";
  }
}

/** Printed the moment a clip render is cancelled (see `liveKitSeams().renderClip` for why then). */
export const KIT_CANCELLED_MESSAGE =
  "▸ cancelled — the clip in progress was discarded; clips already rendered are kept";

/**
 * Ctrl-C (or SIGTERM) during a clip render: the clip in progress is gone, the
 * rest stay. Its message was printed by the signal listener already.
 */
export class KitCancelledError extends Error {
  constructor(readonly exitCode: number) {
    super("cancelled");
    this.name = "KitCancelledError";
  }
}

export interface KitResult {
  kitDir: string;
  report: KitReport;
  clips: number;
  rendered: number;
  reused: number;
  skipped: number;
  timeline: boolean;
  /** `.mov` files removed from `clips/` because no scene names them any more. */
  removed: string[];
  /** Entries written to captions.srt; 0 when none was written. A count only (telemetry). */
  captions: number;
}

async function readProject(work: string, seams: KitSeams): Promise<KitProject> {
  const propsPath = join(work, "render-props.json");
  const productionPath = join(work, "production.json");
  if (!seams.exists(propsPath) || !seams.exists(productionPath)) {
    // Design 3.4: with no planned project, name the command that makes one.
    throw new Error(
      `${work} has no planned project (render-props.json and production.json) — ` +
        "run `ossclip produce <video> --no-render` on it first",
    );
  }
  const parseJson = async (path: string): Promise<{ text: string; value: unknown }> => {
    const text = await seams.readFile(path);
    try {
      return { text, value: JSON.parse(text) };
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const propsRaw = await parseJson(propsPath);
  const props = KitRenderPropsSchema.safeParse(propsRaw.value);
  if (!props.success) throw new Error(`render-props.json in ${work} is not valid: ${props.error.message}`);
  const productionRaw = await parseJson(productionPath);
  const production = KitProductionSchema.safeParse(productionRaw.value);
  if (!production.success) {
    throw new Error(`production.json in ${work} is not valid: ${production.error.message}`);
  }
  return { props: props.data, source: production.data.source, productionText: productionRaw.text };
}

/**
 * The refresh (plan decision 1): an editor edit lands in `overrides.json`
 * and reaches `render-props.json` only when produce runs again. A kit made
 * from stale props would export the cut and scenes from before the edit,
 * with nothing saying so — the author would import last week's timeline.
 */
function isStale(work: string, seams: KitSeams): boolean {
  const overrides = seams.stat(join(work, "overrides.json"));
  const props = seams.stat(join(work, "render-props.json"));
  return overrides !== null && props !== null && overrides.mtimeMs > props.mtimeMs;
}

async function refreshProject(work: string, project: KitProject, seams: KitSeams): Promise<void> {
  const commandPath = join(work, "command.json");
  if (!seams.exists(commandPath)) {
    throw new Error(
      `the project changed in the editor since it was last produced, and ${work} has no command.json ` +
        "to refresh it with — run `ossclip produce` on it once from the terminal so the invocation is " +
        "recorded, or pass --no-refresh to export it as it was last produced",
    );
  }
  let cmd: RecordedCommand;
  try {
    const parsed = RecordedCommandSchema.safeParse(JSON.parse(await seams.readFile(commandPath)));
    if (!parsed.success) throw new Error(parsed.error.message);
    cmd = parsed.data;
  } catch (err) {
    throw new Error(
      `command.json in ${work} is not valid (${err instanceof Error ? err.message : String(err)}) — ` +
        "run `ossclip produce` on it once from the terminal, or pass --no-refresh",
    );
  }
  // The editor's Render pins the plan on screen this way (edit.ts
  // /api/render); a pin that cannot be written replays the recorded command,
  // the same degrade it takes there.
  let scenesPath: string | undefined;
  const reviewed = reviewedScenesText(project.productionText);
  if (reviewed !== undefined) {
    try {
      scenesPath = join(work, REVIEWED_SCENES_BASENAME);
      await seams.writeFile(scenesPath, reviewed);
    } catch {
      scenesPath = undefined;
    }
  }
  const result = await seams.replayProduce({ cmd, args: kitReplayArgs(cmd.args, scenesPath), workdir: work });
  if (result.code !== 0) {
    throw new KitExitError(
      `refreshing the project failed (produce exited ${result.code}):\n` +
        result.tail.map((l) => `  ${l}`).join("\n") +
        "\n  Fix it and run `ossclip kit` again, or pass --no-refresh to export it as it was last produced.",
      result.code,
    );
  }
}

/** The previous run's report, or null — a file that does not parse counts as none (everything re-renders). */
async function readPreviousReport(path: string, seams: KitSeams): Promise<KitReport | null> {
  if (!seams.exists(path)) return null;
  try {
    const parsed = KitReportSchema.safeParse(JSON.parse(await seams.readFile(path)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const secs = (n: number): string => `${n.toFixed(1)}s`;

export async function runKit(workdir: string, flags: KitFlags, seams: KitSeams): Promise<KitResult> {
  const work = resolve(workdir);
  let project = await readProject(work, seams);
  if (flags.refresh && isStale(work, seams)) {
    seams.log("▸ the project changed since it was last produced; refreshing…");
    await refreshProject(work, project, seams);
    project = await readProject(work, seams);
  }
  const { props } = project;
  const { settings, theme } = props;
  const fps = settings.fps;

  // A folder of takes records the FOLDER as `source.path`; the file its
  // probe describes is the join produce made (plan decision 5). A folder
  // that has since moved is recognised by the join still being here.
  const sourceStat = seams.stat(project.source.path);
  const concatPath = join(work, SOURCE_CONCAT_BASENAME);
  const sourceIsFolder = sourceStat !== null ? sourceStat.isDirectory : seams.exists(concatPath);

  const kitDir =
    flags.out !== undefined
      ? resolve(seams.cwd, expandHome(flags.out))
      : defaultKitDir(project.source.path, sourceIsFolder);
  const clipsDir = join(kitDir, KIT_CLIPS_DIRNAME);
  await seams.mkdir(clipsDir);

  const plans = kitClipPlans({ cues: props.sceneCues, theme, settings });
  const reportPath = join(kitDir, KIT_REPORT_BASENAME);
  const previous = await readPreviousReport(reportPath, seams);

  // The work folder is the public dir, as in the full render: `clips/` (a
  // project's imported WebMs), `fonts/` and `side-images/` all resolve
  // there. Fonts again, copy-if-missing, so a kit never depends on produce's
  // copy having survived.
  seams.stageFonts(theme, [work]);

  const script = storedScriptFrom(project.productionText);
  const storyboard = storedStoryboardFrom(project.productionText);
  const clips: KitReportClip[] = [];
  const timelineClips: KitTimelineInput["clips"][number][] = [];
  const wsl = isWslEnv(seams.platform, seams.env, seams.procVersion);
  const urlEnv = { wsl, distro: seams.env.WSL_DISTRO_NAME };
  const warnings: string[] = [];
  // Symlinks resolved before a path becomes a URL (§162): on the EGM
  // project the `clip:` files are links in a Linux folder pointing onto
  // /mnt/c, and the link's own path gives a wsl.localhost URL Resolve may
  // not open, while its target gives the file:///C:/ one it does. A path
  // that cannot be resolved keeps the form it had.
  const real = (path: string): string => {
    try {
      return seams.realpath(path);
    } catch {
      return path;
    }
  };
  /** kitFileUrl's warnings, kept apart so they print as one line. */
  const linuxWarnings: { path: string; warning: string }[] = [];
  const urlFor = (path: string): string => {
    const { url, warning } = kitFileUrl(path, urlEnv);
    if (warning !== undefined) linuxWarnings.push({ path, warning });
    return url;
  };
  let serveUrl: string | null = null;
  let rendered = 0;
  let reused = 0;
  let skipped = 0;

  for (const [i, plan] of plans.entries()) {
    // Frame-aligned (the plan's own frames), never the cue's raw seconds:
    // the clip has exactly these frames, and the timeline must place them
    // where the full render showed them.
    const startSec = plan.startFrame / fps;
    const planLengthSec = plan.durationInFrames / fps;
    const head = `▸ [${i + 1}/${plans.length}]`;
    const notes = kitReportNotes(plan, settings);
    const entry = (
      fields: Pick<KitReportClip, "file" | "lengthSec" | "reuseKey" | "status">,
      notes: string[],
    ): void => {
      clips.push({ sceneId: plan.sceneId, component: plan.component, kind: plan.kind, startSec, notes, ...fields });
    };

    if (plan.kind === "source") {
      // A `clip:` scene is the author's own file (design 3.2): find the
      // original through the script record, never re-render the WebM copy.
      // Anything missing skips the scene — the kit is still worth having
      // without one clip (Review Focus 5).
      const src = plan.cue.props?.src;
      const record = script?.clips?.find((c) => c.src === src);
      // An approved storyboard shot's clip is in the storyboard record, not
      // the script's (design §9, §169): its ProRes original sits in the
      // workdir under the shot's folder, recorded workdir-relative. Asked
      // only when the script record has no entry, so a script clip is found
      // exactly as before.
      const shot = record === undefined ? storyboard?.shots.find((s) => s.src === src) : undefined;
      let reason: string | null = null;
      let original: string | null = null;
      if (shot !== undefined) {
        const named = join(work, shot.clip);
        if (!seams.exists(named)) reason = `the original clip ${named} is not there`;
        else original = real(named);
      } else if (record === undefined) reason = "no record of this clip's original file in production.json";
      else if (script?.sourcePath === undefined) {
        reason = "the script's own path is not recorded, so its clip: paths cannot be resolved";
      } else {
        try {
          const named = resolveClipPath(script.sourcePath, record.path);
          if (!seams.exists(named)) reason = `the original clip ${named} is not there`;
          else original = real(named);
        } catch (err) {
          reason = err instanceof Error ? err.message : String(err);
        }
      }
      let media: KitProbe | null = null;
      if (reason === null && original !== null) {
        try {
          media = await seams.probe(original);
        } catch (err) {
          reason = `could not read ${original}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (reason !== null || original === null || media === null) {
        skipped++;
        const why = reason ?? "the original clip could not be found";
        seams.log(`${head} ${plan.sceneId} (clip:)  ${secs(planLengthSec)}  skipped — ${why}`);
        entry({ file: null, lengthSec: planLengthSec, reuseKey: null, status: "skipped" }, [...notes, why]);
        continue;
      }
      // Trimmed to the scene's length, and never past the file's end — unless
      // the render plays it at another speed, which the kit cannot carry
      // (`sourceClipPlacement`): then the whole original, and a warning.
      const { lengthSec, warning: speedWarning } = sourceClipPlacement(plan, planLengthSec, media.duration);
      if (speedWarning !== null) warnings.push(speedWarning);
      reused++;
      seams.log(`${head} ${basename(original)}  ${secs(lengthSec)}  your clip: file, not rendered`);
      entry({ file: original, lengthSec, reuseKey: null, status: "reused" }, notes);
      if (!flags.clipsOnly) {
        timelineClips.push({
          url: urlFor(original),
          name: basename(original, extname(original)),
          fps: media.fps,
          width: media.width,
          height: media.height,
          durationSec: media.duration,
          hasAudio: media.hasAudio,
          startSec,
          lengthSec,
        });
      }
      continue;
    }

    const outPath = join(clipsDir, plan.fileName);
    // Relative to the kit folder, so the report stays true when it moves.
    const clipRel = `${KIT_CLIPS_DIRNAME}/${plan.fileName}`;
    const unrenderable = unrenderableReason(plan, (rel) => seams.exists(join(work, rel)));
    if (unrenderable !== null) {
      skipped++;
      seams.log(`${head} ${plan.fileName}  ${secs(planLengthSec)}  skipped — ${unrenderable}`);
      entry(
        { file: null, lengthSec: planLengthSec, reuseKey: null, status: "skipped" },
        [...notes, unrenderable],
      );
      continue;
    }
    if (needsRender(plan, previous, seams.exists(outPath), flags.force)) {
      seams.log(`${head} ${plan.fileName}  ${secs(planLengthSec)}`);
      if (serveUrl === null) {
        seams.log("  bundling the scene renderer (once per run)…");
        serveUrl = await seams.bundle(work);
      }
      const startedMs = seams.now().getTime();
      let lastPct = 0;
      await seams.renderClip(
        // The plan's rebased cue as is (SceneClipProps' why).
        { cue: plan.cue, theme, settings: { width: settings.width, height: settings.height, fps } },
        {
          outPath,
          publicDir: work,
          serveUrl,
          onProgress: (fraction) => {
            const pct = Math.floor(fraction * 100);
            if (pct >= lastPct + 25 && pct < 100) {
              lastPct = pct - (pct % 25);
              seams.log(`  ${lastPct}%`);
            }
          },
        },
      );
      rendered++;
      seams.log(`  ✓ rendered in ${secs((seams.now().getTime() - startedMs) / 1000)}`);
      entry({ file: clipRel, lengthSec: planLengthSec, reuseKey: plan.reuseKey, status: "rendered" }, notes);
    } else {
      reused++;
      seams.log(`${head} ${plan.fileName}  ${secs(planLengthSec)}  reused`);
      entry({ file: clipRel, lengthSec: planLengthSec, reuseKey: plan.reuseKey, status: "reused" }, notes);
    }
    if (!flags.clipsOnly) {
      timelineClips.push({
        url: urlFor(real(outPath)),
        name: basename(plan.fileName, extname(plan.fileName)),
        fps,
        width: settings.width,
        height: settings.height,
        durationSec: planLengthSec,
        hasAudio: false,
        startSec,
        lengthSec: planLengthSec,
      });
    }
  }

  // A `.mov` no current scene names belongs to a scene since hidden (or a
  // partial from a killed run). Named by scene id (plan decision 3), so the
  // survivors keep their names and Resolve its links; anything that is not
  // a `.mov` is the author's and stays.
  const named = new Set(plans.filter((p) => p.kind === "render").map((p) => p.fileName));
  const removed: string[] = [];
  for (const name of (await seams.readdir(clipsDir)).sort()) {
    if (!/\.mov$/i.test(name) || named.has(name)) continue;
    await seams.remove(join(clipsDir, name));
    removed.push(name);
    seams.log(`▸ removed ${KIT_CLIPS_DIRNAME}/${name} — no scene in the project names it any more`);
  }

  let timeline: string | null = null;
  if (!flags.clipsOnly) {
    const sourcePath = sourceIsFolder ? concatPath : resolve(project.source.path);
    if (sourceIsFolder) {
      warnings.push(
        `track 1 is ${SOURCE_CONCAT_BASENAME} in the work folder, the re-encoded join of the takes in ` +
          `${project.source.path} — not the original takes`,
      );
    }
    if (!seams.exists(sourcePath)) {
      warnings.push(`${sourcePath} is not on disk; Resolve will show track 1 offline until you relink it`);
    }
    const sourceMedia: KitTimelineMedia = {
      url: urlFor(real(sourcePath)),
      name: basename(sourcePath),
      fps: project.source.probe.fps,
      width: project.source.probe.width,
      height: project.source.probe.height,
      durationSec: project.source.probe.duration,
      hasAudio: project.source.probe.hasAudio,
    };
    const xml = buildFcpxmlKit({
      name: `${basename(sourcePath, extname(sourcePath))} kit`,
      // The output's frame size at the SOURCE's rate (plan decision 4):
      // track 1 is the source uncut, and Resolve conforms the 30 fps clips.
      sequence: { width: settings.width, height: settings.height, fps: project.source.probe.fps },
      source: sourceMedia,
      spans: props.spans,
      clips: timelineClips,
    });
    await seams.writeFile(join(kitDir, KIT_TIMELINE_BASENAME), xml);
    timeline = KIT_TIMELINE_BASENAME;
  }

  // captions.srt on every run, --clips-only included, whatever the render did
  // with captions: the subtitle track is for Resolve, where the author
  // decides (design kit-captions-layer.md, Part 1). Written directly, like
  // the timeline: it is rewritten whole on every run, and no later run
  // trusts it for anything. With no line to write, an older file is removed,
  // so the folder never offers subtitles the project no longer has.
  const srtPath = join(kitDir, KIT_SRT_BASENAME);
  const srt = kitCaptionsSrt(props.captionLines ?? []);
  if (srt.text !== null) {
    await seams.writeFile(srtPath, srt.text);
  } else {
    if (seams.exists(srtPath)) await seams.remove(srtPath);
    seams.log(KIT_NO_CAPTIONS_MESSAGE);
  }

  // Every Linux-side path stays in the report, but a kit made in the Linux
  // filesystem names one per clip, and a screenful of the same warning hides
  // the summary under it: printed once, with the count and the first path.
  for (const w of warnings) seams.log(`⚠ ${w}`);
  if (linuxWarnings.length === 1) seams.log(`⚠ ${linuxWarnings[0]!.warning}`);
  if (linuxWarnings.length > 1) {
    seams.log(
      `⚠ ${linuxWarnings.length} files are inside the Linux filesystem (first: ${linuxWarnings[0]!.path}); ` +
        "Resolve may ask you to relink them — every path is in kit-report.json",
    );
  }
  warnings.push(...linuxWarnings.map((w) => w.warning));

  // Written only once the run is complete: the next run trusts it for
  // reuse, and a report describing clips a cancelled run never made would
  // let them pass for done.
  const report: KitReport = {
    version: 1,
    createdAt: seams.now().toISOString(),
    kitVersion: KIT_VERSION,
    timeline,
    clips,
    warnings,
    captions: { srt: srt.text !== null ? KIT_SRT_BASENAME : null, lines: srt.lines, skipped: srt.skipped },
  };
  await seams.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  seams.log(
    `✓ kit: ${plans.length} clip${plans.length === 1 ? "" : "s"} — ${rendered} rendered, ` +
      `${reused} reused, ${skipped} skipped`,
  );
  seams.log(`  folder: ${kitDir}`);
  if (timeline !== null) seams.log(`  In Resolve: ${KIT_RESOLVE_HINT}`);
  if (srt.text !== null) seams.log(`  Subtitles: ${KIT_SUBTITLES_HINT}`);
  return {
    kitDir,
    report,
    clips: plans.length,
    rendered,
    reused,
    skipped,
    timeline: timeline !== null,
    removed,
    captions: srt.lines,
  };
}

// ---- The live seams -----------------------------------------------------------

/** The real filesystem, ffprobe, Remotion and child process. */
export function liveKitSeams(): KitSeams {
  let cachedCfg: ReturnType<typeof loadConfig> | null = null;
  const cfg = (): ReturnType<typeof loadConfig> => (cachedCfg ??= loadConfig());
  let concurrency: number | null = null;
  const tabs = (): number => {
    if (concurrency === null) {
      const r = kitConcurrency(cfg().renderConcurrency, cpus().length);
      if (r.warning) console.log(r.warning);
      concurrency = r.concurrency;
    }
    return concurrency;
  };
  let procVersion: string | null = null;
  if (process.platform === "linux") {
    try {
      procVersion = readFileSync("/proc/version", "utf8");
    } catch {
      procVersion = null;
    }
  }
  return {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text),
    exists: existsSync,
    realpath: (path) => realpathSync(path),
    stat: (path) => {
      try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readdir: (path) => readdir(path),
    remove: (path) => rm(path, { force: true }),
    probe: (path) => probe({ ffmpegPath: cfg().ffmpegPath, ffprobePath: cfg().ffprobePath }, path),
    stageFonts: (theme, dirs) => {
      stageBundledFonts(theme, dirs);
    },
    bundle: async (publicDir) => {
      const { bundleRenderEntry } = await import("@ossclip/renderer");
      return bundleRenderEntry(publicDir);
    },
    renderClip: async (props, opts) => {
      const { makeCancelSignal, partialClipPath, renderSceneClip } = await import("@ossclip/renderer");
      // Ctrl-C must stop the render, not orphan its browser (produce's
      // 2026-08-19 field report), and a listener suppresses node's default
      // exit — so it goes on around each render only, and between renders
      // Ctrl-C exits at once with nothing half-written. Inside one, the
      // cancel reaches renderMedia even while the composition is still being
      // selected (Remotion's signal replays a cancel to a late subscriber).
      //
      // Everything this listener owes the user happens SYNCHRONOUSLY, on the
      // first signal (§162, found driving it): Remotion 4.0.499's browser
      // runner adds its own SIGINT listener once Chrome is up, which kills
      // the browser and calls `process.exit(130)` on the spot
      // (BrowserRunner.js). This one was added first, so it runs first — but
      // nothing awaited after it ever does, so a message or an unlink left
      // to the rejected render's catch was simply never reached.
      const cancel = makeCancelSignal();
      const signals: Array<"SIGINT" | "SIGTERM"> = [];
      const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
        signals.push(signal);
        const action = renderSignalAction("rendering", signals.length);
        if (action.cancel) cancel.cancel();
        if (signals.length === 1) {
          rmSync(partialClipPath(opts.outPath), { force: true });
          console.log(KIT_CANCELLED_MESSAGE);
        }
        if (action.exitNow) {
          if (action.note) console.log(action.note);
          rmSync(partialClipPath(opts.outPath), { force: true });
          process.exit(signals[0] === "SIGINT" ? 130 : 143);
        }
      };
      const onSigint = (): void => onSignal("SIGINT");
      const onSigterm = (): void => onSignal("SIGTERM");
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      try {
        await renderSceneClip(props, {
          outPath: opts.outPath,
          publicDir: opts.publicDir,
          serveUrl: opts.serveUrl,
          browserExecutable: cfg().browserExecutable,
          concurrency: tabs(),
          cancelSignal: cancel.cancelSignal,
          onProgress: opts.onProgress,
        });
      } catch (err) {
        if (signals.length > 0) throw new KitCancelledError(signals[0] === "SIGINT" ? 130 : 143);
        throw err;
      } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      }
      // A signal after the render finished: the clip is whole and stays, and
      // the run stops as asked — before the next clip, not after the kit.
      if (signals.length > 0) throw new KitCancelledError(signals[0] === "SIGINT" ? 130 : 143);
    },
    replayProduce: ({ cmd, args, workdir }) =>
      new Promise((done) => {
        // The editor's Render spawn (edit.ts /api/render), down to the env:
        // OSSCLIP_REPLAY_WORKDIR makes produce warn loudly when it derives a
        // different workdir than the one whose overrides it was asked to apply.
        const child = spawn(cmd.execPath, [...cmd.execArgv, cmd.script, ...args], {
          cwd: cmd.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, OSSCLIP_REPLAY_WORKDIR: workdir },
        });
        const lines: string[] = [];
        const push = (chunk: Buffer): void => {
          for (const line of chunk.toString().split(/\r?\n/)) {
            if (line.trim() === "") continue;
            lines.push(line);
            if (lines.length > 40) lines.shift();
          }
        };
        child.stdout?.on("data", push);
        child.stderr?.on("data", push);
        child.on("error", (err) => done({ code: 1, tail: [...lines, `spawn failed: ${err.message}`].slice(-12) }));
        child.on("exit", (code) => done({ code: code ?? 1, tail: lines.slice(-12) }));
      }),
    now: () => new Date(),
    log: (line) => console.log(line),
    platform: process.platform,
    env: process.env,
    procVersion,
    cwd: process.cwd(),
  };
}
