/**
 * `ossclip draw` (experimental; storyboard design Phase A, plan Task 7;
 * §167): draw one shot from a one-sentence idea as LLM-written React code,
 * check it, render three stills, and redraw it from a typed note. Phase A's
 * whole question is whether drawn shots are usable, so this is the smallest
 * surface that answers it: one shot per run, no storyboard, nothing written
 * into the project's video.
 *
 *   ossclip draw <workdir> --shot <id> --idea "<text>" [--line …] [--duration …] [--assets <dir>]
 *   ossclip draw <workdir> --shot <id> --note "<text>"
 *   ossclip draw <workdir> --shot <id> --preview
 *
 * The decisions are core's (`drawShot`, the shot record) and the pure
 * helpers below; `runDraw` is the I/O around them with every side effect
 * that would need a browser, an LLM or ffmpeg behind `DrawDeps`, the kit.ts
 * split, so the whole command runs in a test with fakes. The shot's own
 * files are written for real (shot-store.ts); a test gives it a temp workdir.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  DRAW_PROMPT_VERSION,
  RenderSettingsSchema,
  ShotIdSchema,
  ThemeSchema,
  createProvider,
  defaultProviderName,
  defaultTheme,
  drawShot,
  loadConfig,
  stageBundledFonts,
  type DrawAttempt,
  type DrawIssue,
  type DrawRequest,
  type LlmProvider,
  type LlmUsage,
  type ProviderName,
  type ShotHistory,
  type Theme,
} from "@ossclip/core";
import {
  bundleDrawnScene,
  isBlankRgba,
  renderDrawnPreview,
  renderDrawnStills,
  type DrawnRenderProps,
} from "@ossclip/renderer";
import { DRAW_KIT_EXPORTS, DRAW_KIT_REFERENCE, DRAW_KIT_VERSION } from "@ossclip/scenes/draw/reference";
import { binOnPath, detectionLine } from "../llm-detect";
import { expandHome } from "../paths";
import { DrawSetupError, buildDrawCheck } from "./checks";
import { ffprobeImageSize, loadShot, saveShot, shotDir, stageAssets, versionPaths, type StagedAsset } from "./shot-store";
import { typecheckDrawnScene } from "./typecheck";

/** Design §5 step 3: a still that takes longer than this fails, and the version with it (Review Focus 2). */
export const DRAW_STILL_TIMEOUT_MS = 30_000;
export const DRAW_DEFAULT_DURATION_SEC = 4;
/** A shot is one beat of a talk: under two seconds nothing reads, past fifteen it is a scene of its own. */
export const DRAW_MIN_DURATION_SEC = 2;
export const DRAW_MAX_DURATION_SEC = 15;

const PROVIDER_NAMES = ["antigravity", "claude", "claude-cli", "gemini", "mock"] as const satisfies readonly ProviderName[];

// ---- The user's flags ------------------------------------------------------

export type DrawMode =
  | { kind: "idea"; idea: string; spokenLine: string; durationSec: number; assetsDir?: string }
  | { kind: "note"; text: string }
  | { kind: "preview" };

export interface DrawArgs {
  /** Absolute, already resolved the way `ossclip kit` resolves its argument. */
  workdir: string;
  shot: string;
  mode: DrawMode;
  /** Undefined: auto-detected, as produce does (`defaultProviderName`). */
  llm?: ProviderName;
  llmModel?: string;
  /**
   * Asked before every LLM call; true ends the draw (§169). The editor's job
   * runner passes its Stop here. The command line never does: Ctrl-C is its
   * stop, and leaves the version for the next load to discard.
   */
  shouldStop?: () => boolean;
  /**
   * The frame and theme to draw for, in place of production.json's (§169).
   * The editor server passes the live one (`liveDrawProject`): a shot drawn
   * in the editor must match the theme the author is looking at, which may
   * hold edits the last produce run has not seen.
   */
  project?: DrawProject;
}

/**
 * The flags, parsed rather than coerced (CLAUDE.md), every error naming its
 * flag and all of it before anything touches disk or an LLM. The idea's line,
 * duration and assets are stored with the shot and reused by every redraw
 * and preview, so they are refused beside `--note` and `--preview` rather
 * than silently ignored: a `--duration 8` typed with a note would otherwise
 * read as applied.
 */
export function parseDrawFlags(raw: {
  shot?: unknown;
  idea?: unknown;
  note?: unknown;
  preview?: unknown;
  line?: unknown;
  duration?: unknown;
  assets?: unknown;
  llm?: unknown;
  llmModel?: unknown;
}): Omit<DrawArgs, "workdir"> {
  if (raw.shot === undefined) throw new Error("--shot <id> is required: the name of the shot to draw, e.g. --shot intro");
  const shot = ShotIdSchema.safeParse(raw.shot);
  if (!shot.success) {
    throw new Error(
      `--shot wants lower-case letters, digits and dashes (starting with a letter or digit, at most 40), got ${JSON.stringify(raw.shot)}`,
    );
  }

  const text = (flag: string, value: unknown): string => {
    const parsed = z.string().trim().min(1).safeParse(value);
    if (!parsed.success) throw new Error(`${flag} wants some text, got ${JSON.stringify(value)}`);
    return parsed.data;
  };
  const preview = z.boolean().optional().safeParse(raw.preview);
  if (!preview.success) throw new Error(`--preview is a switch and takes no value, got ${JSON.stringify(raw.preview)}`);

  const modes = [raw.idea !== undefined && "--idea", raw.note !== undefined && "--note", preview.data === true && "--preview"].filter(
    (m): m is string => m !== false,
  );
  if (modes.length !== 1) {
    throw new Error(
      modes.length === 0
        ? 'say what to do: --idea "<text>" draws a new shot, --note "<text>" redraws it, --preview renders the draft'
        : `use one of --idea, --note and --preview, not ${modes.join(" and ")}`,
    );
  }

  const llm =
    raw.llm === undefined
      ? undefined
      : (() => {
          const parsed = z.enum(PROVIDER_NAMES).safeParse(raw.llm);
          if (!parsed.success) throw new Error(`--llm wants one of ${PROVIDER_NAMES.join(", ")}, got ${JSON.stringify(raw.llm)}`);
          return parsed.data;
        })();
  const llmModel = raw.llmModel === undefined ? undefined : text("--llm-model", raw.llmModel);

  let mode: DrawMode;
  if (raw.idea !== undefined) {
    let durationSec = DRAW_DEFAULT_DURATION_SEC;
    if (raw.duration !== undefined) {
      // A number typed as one: `4x`, `""` and `1e1` are errors, not 4, 0 and 10.
      const typed = z.string().regex(/^\d+(\.\d+)?$/).safeParse(raw.duration);
      const parsed = z.number().min(DRAW_MIN_DURATION_SEC).max(DRAW_MAX_DURATION_SEC).safeParse(typed.success ? Number(typed.data) : NaN);
      if (!parsed.success) {
        throw new Error(
          `--duration wants seconds from ${DRAW_MIN_DURATION_SEC} to ${DRAW_MAX_DURATION_SEC}, got ${JSON.stringify(raw.duration)}`,
        );
      }
      durationSec = parsed.data;
    }
    mode = {
      kind: "idea",
      idea: text("--idea", raw.idea),
      spokenLine: raw.line === undefined ? "" : text("--line", raw.line),
      durationSec,
      ...(raw.assets !== undefined ? { assetsDir: resolve(expandHome(text("--assets", raw.assets))) } : {}),
    };
  } else {
    for (const [flag, value] of [["--line", raw.line], ["--duration", raw.duration], ["--assets", raw.assets]] as const) {
      if (value !== undefined) {
        throw new Error(`${flag} goes with --idea only: a redraw and a preview reuse what the shot was drawn with`);
      }
    }
    if (raw.note !== undefined) {
      mode = { kind: "note", text: text("--note", raw.note) };
    } else {
      if (llm !== undefined || llmModel !== undefined) {
        throw new Error("--preview makes no LLM call; drop --llm and --llm-model");
      }
      mode = { kind: "preview" };
    }
  }
  return { shot: shot.data, mode, ...(llm !== undefined ? { llm } : {}), ...(llmModel !== undefined ? { llmModel } : {}) };
}

// ---- Pure pieces -------------------------------------------------------------

/**
 * The slice of `production.json` a drawn shot is drawn for: the output frame
 * and the theme. A project produced without a theme renders with
 * `defaultTheme`, the `ossclip cover` rule, so the shot matches its video.
 */
const DrawProductionSchema = z.object({ render: RenderSettingsSchema, theme: ThemeSchema.optional() });

export interface DrawProject {
  width: number;
  height: number;
  fps: number;
  theme: Theme;
}

export function drawProjectFrom(raw: unknown, path: string): DrawProject {
  const parsed = DrawProductionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not valid: ${parsed.error.message}`);
  const { width, height, fps } = parsed.data.render;
  return { width, height, fps, theme: parsed.data.theme ?? defaultTheme };
}

const ATTEMPT_LINE_ISSUES = 3;
const ATTEMPT_LINE_ERROR_MAX = 200;

/** One attempt as one line: `attempt 2: 1 issue (type, line 14)`, `attempt 1: provider error: …`, `attempt 3: ok`. */
export function attemptLine(n: number, attempt: Pick<DrawAttempt, "issues" | "error">): string {
  if (attempt.error !== undefined) {
    return `attempt ${n}: provider error: ${(attempt.error.split("\n")[0] ?? "").slice(0, ATTEMPT_LINE_ERROR_MAX)}`;
  }
  const k = attempt.issues.length;
  if (k === 0) return `attempt ${n}: ok`;
  const shown = attempt.issues.slice(0, ATTEMPT_LINE_ISSUES).map((i) => `${i.rule}, line ${i.line}`);
  if (k > ATTEMPT_LINE_ISSUES) shown.push("…");
  return `attempt ${n}: ${k} issue${k === 1 ? "" : "s"} (${shown.join("; ")})`;
}

/** An issue in full, as the failure summary prints it and the record stores it. */
export function issueText(i: DrawIssue): string {
  return `line ${i.line} [${i.rule}] ${i.message}`;
}

/** Why a version failed, from its last attempt: the provider's error or the issues in full. */
export function failureText(last: DrawAttempt | undefined): string {
  if (last === undefined) return "no attempt was made";
  if (last.error !== undefined) return `provider error: ${last.error}`;
  return last.issues.map(issueText).join("\n");
}

export interface StageTime {
  name: string;
  ms: number;
}

/** `  type check 1.2 s · bundle 3.1 s · stills 4.0 s`, the checks of one attempt that ran. */
export function stageTimesLine(stages: readonly StageTime[]): string {
  return `  ${stages.map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)} s`).join(" · ")}`;
}

/** `calls 2 · 41.3 s (draw 30.1 s, checks 9.8 s)`. */
export function costLine(calls: number, ms: { total: number; draw: number; checks: number }): string {
  const s = (v: number): string => (v / 1000).toFixed(1);
  return `calls ${calls} · ${s(ms.total)} s (draw ${s(ms.draw)} s, checks ${s(ms.checks)} s)`;
}

// ---- The command ------------------------------------------------------------

/**
 * Every side effect `runDraw` has beyond the shot's own files. The live set
 * is `liveDrawDeps()`; a test passes fakes and never starts a browser.
 */
export interface DrawDeps {
  readTextFile(path: string): string;
  createProvider(name: ProviderName, model: string | undefined): LlmProvider;
  /** The provider when `--llm` is not given (produce's auto-detection). */
  defaultProvider(): ProviderName;
  /** Throws for an install fault (draw/typecheck.ts); issues for the scene's own faults. */
  typecheck(scenePath: string): DrawIssue[];
  bundle(a: { scenePath: string; workDir: string; publicDir: string }): Promise<string>;
  renderStills(a: { serveUrl: string; props: DrawnRenderProps; outDir: string; timeoutMs: number }): Promise<string[]>;
  renderPreview(a: { serveUrl: string; props: DrawnRenderProps; outPath: string }): Promise<void>;
  /** True when every pixel of the PNG is fully transparent. */
  isBlank(png: string): Promise<boolean>;
  probeImageSize(path: string): Promise<{ width: number; height: number }>;
  stageFonts(theme: Theme, dirs: string[]): void;
  /** A fresh, empty directory for one render's public files (never the workdir; renderer drawn/render.ts). */
  makeRenderDir(): string;
  removeDir(path: string): void;
  /** Milliseconds, for the durations only. */
  now(): number;
  log(line: string): void;
}

export interface DrawRunResult {
  ok: boolean;
  /** The version drawn, or the draft previewed. Null for a stopped draw: its version was removed. */
  version: number | null;
  stills: string[];
  calls: number;
  seconds: number;
  /** Set when `shouldStop` ended the draw; `ok` is then false (§169). */
  stopped?: true;
  /**
   * The provider's usage records for this run, one per call that reported
   * one, for the caller to append to usage.json (plan B2a Global
   * Constraints: each LLM call lands there). Empty for a preview.
   */
  usage: LlmUsage[];
}

function readProject(workdir: string, deps: DrawDeps): DrawProject {
  const path = join(workdir, "production.json");
  if (!existsSync(path)) {
    throw new Error(`${workdir} has no production.json — run \`ossclip produce <video> --no-render\` on it first`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readTextFile(path));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return drawProjectFrom(raw, path);
}

/**
 * The stored assets folder must still be there: every run stages it afresh,
 * and a redraw without the logo the first draft placed would quietly draw a
 * different shot. Checked before any LLM call.
 */
function requireAssetsDir(h: Pick<ShotHistory, "id" | "assetsDir">): void {
  if (h.assetsDir === undefined) return;
  if (!existsSync(h.assetsDir) || !statSync(h.assetsDir).isDirectory()) {
    throw new Error(
      `shot ${h.id} was drawn with the assets in ${h.assetsDir}, which no longer exists; ` +
        "put the folder back, or draw the shot again under a new --shot id with --idea and --assets",
    );
  }
}

/**
 * Fonts and assets into a fresh render directory, the caller half of
 * `bundleDrawnScene`'s contract. Exported for Approve (storyboard/approve.ts),
 * which renders the same version again and must stage it the same way.
 */
export async function stageRender(
  h: Pick<ShotHistory, "assetsDir">,
  project: DrawProject,
  publicDir: string,
  deps: Pick<DrawDeps, "stageFonts" | "probeImageSize" | "log">,
): Promise<StagedAsset[]> {
  deps.stageFonts(project.theme, [publicDir]);
  if (h.assetsDir === undefined) return [];
  const staged = await stageAssets(h.assetsDir, publicDir, deps.probeImageSize);
  for (const w of staged.warnings) deps.log(`  ⚠ ${w}`);
  return staged.assets;
}

/** Each staged asset's name to the path the kit's `Asset` hands to `staticFile`. */
export function stagedAssetPaths(assets: readonly StagedAsset[]): Record<string, string> {
  return Object.fromEntries(assets.map((a) => [a.name, a.staticPath]));
}

/**
 * The props every render of a drawn version gets. Exported for Approve, which
 * passes the approved length as `durationSec` in place of the drawn one.
 */
export function renderProps(
  h: Pick<ShotHistory, "durationSec">,
  project: DrawProject,
  assets: Record<string, string>,
): DrawnRenderProps {
  return {
    durationSec: h.durationSec,
    width: project.width,
    height: project.height,
    fps: project.fps,
    theme: project.theme,
    assets,
  };
}

export async function runDraw(args: DrawArgs, deps: DrawDeps): Promise<DrawRunResult> {
  const started = deps.now();
  const project = args.project ?? readProject(args.workdir, deps);
  const existing = loadShot(args.workdir, args.shot);
  if (args.mode.kind === "preview") return runPreview(args, existing, project, deps, started);

  // ---- What this run draws from, all checked before the first call ----
  let h: ShotHistory;
  let redraw: { code: string; notes: { text: string }[]; note: { text: string } } | undefined;
  if (args.mode.kind === "idea") {
    // A shot with a draft changes by notes, so its idea, line and length
    // stay what its versions were drawn from. A shot with no draft (every
    // version failed) is drawn again from the idea: the retry design §5
    // offers after a failure (G8), with no other way to make one.
    if (existing !== null && existing.draft !== null) {
      throw new Error(
        `shot ${args.shot} is already drawn (draft v${existing.draft}); change it with --note "<what to change>", ` +
          "or draw a different shot under a new --shot id",
      );
    }
    if (args.mode.assetsDir !== undefined) requireAssetsDir({ id: args.shot, assetsDir: args.mode.assetsDir });
    const base: ShotHistory = existing ?? {
      id: args.shot,
      idea: "",
      spokenLine: "",
      durationSec: args.mode.durationSec,
      versions: [],
      draft: null,
      nextVersion: 1,
      notes: [],
      runs: [],
    };
    // Everything the idea carries is replaced, the assets folder included:
    // a retry without --assets is drawn without them.
    h = {
      ...base,
      idea: args.mode.idea,
      spokenLine: args.mode.spokenLine,
      durationSec: args.mode.durationSec,
      assetsDir: args.mode.assetsDir,
    };
    if (h.assetsDir === undefined) delete h.assetsDir;
  } else {
    if (existing === null) throw new Error(`shot ${args.shot} has not been drawn yet; draw it first with --idea "<text>"`);
    if (existing.draft === null) {
      throw new Error(
        `shot ${args.shot} has no version that passed its checks, so there is nothing for a note to change; ` +
          `draw it again with --idea "<text>"`,
      );
    }
    const draftCode = versionPaths(args.workdir, args.shot, existing.draft).code;
    if (!existsSync(draftCode)) throw new Error(`the draft of shot ${args.shot} is missing its code: ${draftCode}`);
    requireAssetsDir(existing);
    h = existing;
    redraw = {
      code: deps.readTextFile(draftCode),
      notes: existing.notes.map((n) => ({ text: n.text })),
      note: { text: args.mode.text },
    };
  }

  const publicDir = deps.makeRenderDir();
  try {
    const assets = await stageRender(h, project, publicDir, deps);
    const providerName = args.llm ?? deps.defaultProvider();
    // Only when auto-detected, produce's rule: a typed --llm needs no explanation.
    if (args.llm === undefined) deps.log(detectionLine(providerName));
    const provider = deps.createProvider(providerName, args.llmModel);

    // The version exists, without a result, before the first call: a run
    // killed from here on is recognisable and discarded on the next load,
    // and its number is spent (design §9; Review Focus 5).
    const n = h.nextVersion;
    const fromDraft = h.draft;
    h = {
      ...h,
      nextVersion: n + 1,
      versions: [...h.versions, { n, kitVersion: DRAW_KIT_VERSION, promptVersion: DRAW_PROMPT_VERSION }],
    };
    saveShot(args.workdir, h);
    const paths = versionPaths(args.workdir, args.shot, n);
    const props = renderProps(h, project, stagedAssetPaths(assets));
    deps.log(`▸ drawing shot ${args.shot} v${n} with ${providerName}${args.llmModel ? ` (${args.llmModel})` : ""}`);

    // The attempt lines are printed as they happen, from these two wrappers,
    // because one call can take a minute and three of them in silence look
    // like a hang. `drawShot` calls the provider and then the check, once per
    // attempt, so the counter below is the attempt number in both.
    let attempt = 0;
    const ms = { draw: 0, checks: 0 };
    /** The last stills rendered; on success, the passing attempt's, since it is the last check that ran. */
    let rendered: string[] = [];
    const timedProvider: LlmProvider = {
      name: provider.name,
      get usage() {
        return provider.usage;
      },
      complete: async (req) => {
        attempt += 1;
        const t0 = deps.now();
        try {
          return await provider.complete(req);
        } catch (err) {
          deps.log(attemptLine(attempt, { issues: [], error: err instanceof Error ? err.message : String(err) }));
          throw err;
        } finally {
          ms.draw += deps.now() - t0;
        }
      },
    };
    const check = buildDrawCheck({
      kitExports: DRAW_KIT_EXPORTS,
      // Every attempt of a version overwrites the one file: only the final
      // code of a version is kept (design §9's one file per version).
      scenePathFor: (code) => {
        mkdirSync(shotDir(args.workdir, args.shot), { recursive: true });
        writeFileSync(paths.code, code);
        return paths.code;
      },
      typecheck: (p) => timedStage("type check", () => deps.typecheck(p)),
      renderStills: async (scenePath) => {
        let serveUrl: string;
        try {
          serveUrl = await timedStage("bundle", () => deps.bundle({ scenePath, workDir: args.workdir, publicDir }));
        } catch (err) {
          throw new DrawSetupError(`drawn-scene bundle failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        try {
          rendered = await timedStage("stills", () =>
            deps.renderStills({ serveUrl, props, outDir: paths.stillsDir, timeoutMs: DRAW_STILL_TIMEOUT_MS }),
          );
          return rendered;
        } finally {
          deps.removeDir(serveUrl);
        }
      },
      isBlank: (png) => deps.isBlank(png),
    });
    // Each stage's time, per attempt: the gate (§167) records the type check,
    // bundle and still times, and draw/typecheck.ts leaves printing its time
    // to this command.
    let stageTimes: StageTime[] = [];
    function timedStage<T>(name: string, run: () => T): T {
      const t0 = deps.now();
      const done = (): void => {
        stageTimes.push({ name, ms: deps.now() - t0 });
      };
      let out: T;
      try {
        out = run();
      } catch (err) {
        done();
        throw err;
      }
      if (out instanceof Promise) return out.finally(done) as T;
      done();
      return out;
    }
    const timedCheck = async (code: string): Promise<DrawIssue[]> => {
      const t0 = deps.now();
      stageTimes = [];
      try {
        const issues = await check(code);
        deps.log(attemptLine(attempt, { issues }));
        if (stageTimes.length > 0) deps.log(stageTimesLine(stageTimes));
        return issues;
      } finally {
        ms.checks += deps.now() - t0;
      }
    };

    const req: DrawRequest = {
      idea: h.idea,
      spokenLine: h.spokenLine,
      durationSec: h.durationSec,
      width: project.width,
      height: project.height,
      kitReference: DRAW_KIT_REFERENCE,
      assets: assets.map(({ name, width, height, note }) => ({ name, width, height, ...(note !== undefined ? { note } : {}) })),
    };
    const result = await drawShot({
      provider: timedProvider,
      req,
      check: timedCheck,
      ...(redraw ? { redraw } : {}),
      ...(args.shouldStop ? { shouldStop: args.shouldStop } : {}),
    });

    // ---- The version's result, and the run, recorded ----
    const last = result.attempts[result.attempts.length - 1];
    const totalMs = deps.now() - started;
    const said = result.said ?? undefined;
    const usage = [...provider.usage];
    if (result.stopped) {
      // A stop is the author's, not the scene's: the version is neither ok
      // nor failed, so it leaves no version at all (§169). It is removed
      // here rather than left for the next `loadShot`: a version without a
      // result on disk means "a run is drawing this or died mid-draw", and
      // this run did neither. The editor reads with `peekShot`, which never
      // cleans up, so the debris would sit in the record and its files until
      // the next draw of this shot. Its number stays spent (design §9),
      // the draft and the notes are as they were, and no run is recorded:
      // a run names its version, and this one is gone. Its calls are still
      // paid for, so they go back in `usage`.
      rmSync(paths.code, { force: true });
      rmSync(paths.stillsDir, { recursive: true, force: true });
      h = { ...h, versions: h.versions.filter((v) => v.n !== n) };
      saveShot(args.workdir, h);
      deps.log(`■ shot ${args.shot} v${n} stopped after ${result.attempts.length} call${result.attempts.length === 1 ? "" : "s"}; no version kept`);
      deps.log(costLine(result.attempts.length, { total: totalMs, ...ms }));
      return { ok: false, stopped: true, version: null, stills: [], calls: result.attempts.length, seconds: totalMs / 1000, usage };
    }
    if (result.ok) {
      h = {
        ...h,
        versions: h.versions.map((v) => (v.n === n ? { ...v, result: "ok" as const, ...(said !== undefined ? { said } : {}) } : v)),
        draft: n,
        // The note is recorded on the version it changed, and only once it
        // produced a version: a redraw sends every earlier note as already
        // applied, and a note whose redraw failed never was.
        notes: redraw && fromDraft !== null ? [...h.notes, { onVersion: fromDraft, text: redraw.note.text }] : h.notes,
      };
    } else {
      // A failed version keeps its last code, the one that had every repair
      // (`drawShot`'s `code`), which is not always the last code written: an
      // attempt stopped by the static check never reaches the file. Its
      // stills are dropped for the same reason: they may be an earlier
      // attempt's drawing, beside code that is not.
      if (result.code !== null) writeFileSync(paths.code, result.code);
      else rmSync(paths.code, { force: true });
      rmSync(paths.stillsDir, { recursive: true, force: true });
      h = {
        ...h,
        versions: h.versions.map((v) =>
          v.n === n ? { ...v, result: { failed: failureText(last) }, ...(said !== undefined ? { said } : {}) } : v,
        ),
      };
    }
    const model = args.llmModel ?? provider.usage.find((u) => u.model !== undefined)?.model;
    h = {
      ...h,
      runs: [
        ...h.runs,
        {
          version: n,
          provider: providerName,
          ...(model !== undefined ? { model } : {}),
          calls: result.attempts.length,
          seconds: Math.round(totalMs / 100) / 10,
        },
      ],
    };
    saveShot(args.workdir, h);

    const stills = result.ok ? rendered : [];
    if (result.ok) {
      deps.log(`✓ shot ${args.shot} v${n}: ${said ?? "drawn"}`);
      for (const s of stills) deps.log(`  ${s}`);
    } else {
      deps.log(`✗ shot ${args.shot} v${n} failed after ${result.attempts.length} attempts; the last one's ${last?.error !== undefined ? "error" : "issues"}:`);
      for (const line of failureText(last).split("\n")) deps.log(`  ${line}`);
      if (result.code !== null) deps.log(`  its code: ${paths.code}`);
    }
    deps.log(costLine(result.attempts.length, { total: totalMs, ...ms }));
    return { ok: result.ok, version: n, stills, calls: result.attempts.length, seconds: totalMs / 1000, usage };
  } finally {
    deps.removeDir(publicDir);
  }
}

/** `--preview` (design §7): the draft at a quarter of the frame, from its own bundle. No LLM call, and the record is not written. */
async function runPreview(
  args: DrawArgs,
  h: ShotHistory | null,
  project: DrawProject,
  deps: DrawDeps,
  started: number,
): Promise<DrawRunResult> {
  if (h === null || h.draft === null) {
    throw new Error(`shot ${args.shot} has no draft to preview; draw it first with --idea "<text>"`);
  }
  const paths = versionPaths(args.workdir, args.shot, h.draft);
  if (!existsSync(paths.code)) throw new Error(`the draft of shot ${args.shot} is missing its code: ${paths.code}`);
  requireAssetsDir(h);
  const publicDir = deps.makeRenderDir();
  try {
    const assets = await stageRender(h, project, publicDir, deps);
    const serveUrl = await deps.bundle({ scenePath: paths.code, workDir: args.workdir, publicDir });
    try {
      mkdirSync(paths.stillsDir, { recursive: true });
      await deps.renderPreview({ serveUrl, props: renderProps(h, project, stagedAssetPaths(assets)), outPath: paths.preview });
    } finally {
      deps.removeDir(serveUrl);
    }
  } finally {
    deps.removeDir(publicDir);
  }
  const totalMs = deps.now() - started;
  deps.log(`✓ preview of shot ${args.shot} v${h.draft}`);
  deps.log(`  ${paths.preview}`);
  deps.log(`${(totalMs / 1000).toFixed(1)} s`);
  return { ok: true, version: h.draft, stills: [], calls: 0, seconds: totalMs / 1000, usage: [] };
}

// ---- The live dependencies ---------------------------------------------------

const execFileBuffer = promisify(execFile);

/**
 * A PNG's alpha through ffmpeg's raw RGBA output: the workspace has no PNG
 * decoder, and ffmpeg is already required (the renderer's browser tests read
 * stills back the same way). 128 MB covers a 4K frame (33 MB) with room.
 */
async function pngIsBlank(png: string): Promise<boolean> {
  const { stdout } = await execFileBuffer(
    loadConfig().ffmpegPath,
    ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
  );
  return isBlankRgba(stdout);
}

/** The real LLM, type check, bundler, browser and ffmpeg. */
export function liveDrawDeps(): DrawDeps {
  const cfg = loadConfig();
  return {
    readTextFile: (p) => readFileSync(p, "utf8"),
    createProvider: (name, model) => createProvider(name, model),
    defaultProvider: () => defaultProviderName(process.env, binOnPath),
    typecheck: (p) => typecheckDrawnScene(p),
    bundle: (a) => bundleDrawnScene(a),
    renderStills: (a) => renderDrawnStills({ ...a, browserExecutable: cfg.browserExecutable }),
    renderPreview: (a) => renderDrawnPreview({ ...a, browserExecutable: cfg.browserExecutable }),
    isBlank: pngIsBlank,
    probeImageSize: ffprobeImageSize,
    stageFonts: (theme, dirs) => {
      stageBundledFonts(theme, dirs);
    },
    makeRenderDir: () => mkdtempSync(join(tmpdir(), "ossclip-draw-public-")),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    now: () => performance.now(),
    log: (line) => console.log(line),
  };
}
