/**
 * Approve (storyboard design §8; plan B2a Task 2; §169): the shot's draft
 * version rendered at the length the cut gives it now, as the clip the video
 * plays. Three stills at that length, the ProRes 4444 clip, and the clip
 * import that writes the VP9 copy under `clips/` the editor and the render
 * play. What the approval then does to the video is produce's (a replay
 * builds one ClipScene per approved shot, Task 3); this file only makes the
 * files and says what was made.
 *
 * Every side effect that needs a browser, a bundler or ffmpeg is behind
 * `ApproveDeps` (the `DrawDeps` split), so a test runs the whole flow with
 * fakes. The shot's own files are real: what is left beside approved.mov
 * when a render fails is most of what this file must get right.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { ShotApprovalSchema, clipKey, loadConfig, stageBundledFonts, type ShotApproval } from "@ossclip/core";
import {
  bundleDrawnScene,
  renderDrawnClip,
  renderDrawnStills,
  type CancelSignal,
  type DrawnRenderProps,
} from "@ossclip/renderer";
import { DRAW_KIT_VERSION } from "@ossclip/scenes/draw/reference";
import { importClip } from "../clip-import";
import { DRAW_STILL_TIMEOUT_MS, renderProps, stageRender, stagedAssetPaths, type DrawProject } from "../draw/draw-command";
import { approvedClipPath, ffprobeImageSize, loadShot, versionPaths } from "../draw/shot-store";

/**
 * A shot that cannot be approved as it stands: no draft, a draft whose code
 * is gone, a draft drawn against another kit, or a length that is not one.
 * Its own class so the editor's endpoint (Task 4) can answer it as the
 * author's to fix, apart from a render that failed.
 */
export class ApproveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApproveError";
  }
}

/** Every side effect `approveShot` has beyond the shot's own files. The live set is `liveApproveDeps()`. */
export interface ApproveDeps {
  readTextFile(path: string): string;
  /** sha1, hex: the hash `clipKey` is taken with, here and wherever a key is compared. */
  hashHex(text: string): string;
  bundle(a: { scenePath: string; workDir: string; publicDir: string }): Promise<string>;
  renderStills(a: { serveUrl: string; props: DrawnRenderProps; outDir: string; timeoutMs: number }): Promise<string[]>;
  renderClip(a: { serveUrl: string; props: DrawnRenderProps; outPath: string; cancelSignal?: CancelSignal }): Promise<void>;
  importClip(srcAbs: string, publicDir: string): Promise<{ src: string; durationSec: number }>;
  /** Fonts and assets into `publicDir`; returns the assets map the render props carry. */
  stage(project: DrawProject, publicDir: string, assetsDir: string | undefined): Promise<Record<string, string>>;
  /** A fresh, empty directory for one render's public files (never the workdir; renderer drawn/render.ts). */
  makeRenderDir(): string;
  removeDir(dir: string): void;
  log(line: string): void;
}

export interface ApproveArgs {
  workdir: string;
  shotId: string;
  /** The clip's length: `shotLengthSec` over the cut as it is now (design §8, step 1). */
  durationSec: number;
  project: DrawProject;
  assetsDir?: string;
  cancelSignal?: CancelSignal;
}

/** `storyboard/<id>/approved.mov`, workdir-relative and `/`-separated, as `ShotApproval.clip` stores it. */
function workdirRelative(workdir: string, abs: string): string {
  return relative(workdir, abs).split(sep).join("/");
}

/**
 * Renders the draft version at `durationSec`: three stills into the
 * version's stills dir (replacing the draft-length ones, design §8 step 2)
 * and the clip to `approvedClipPath`; imports the clip; returns the
 * approval.
 *
 * Does NOT write storyboard.json: the caller does, so a failed render
 * leaves the stored approval as it was. For the same reason the clip is
 * rendered to `approved.next.mov` and renamed over `approved.mov` only after
 * the import succeeded: the approval on disk names approved.mov as its
 * original, and a cancelled or failed Approve must leave that file the clip
 * the video already plays (`renderDrawnClip`'s own partial-file rename only
 * protects the name it is given).
 *
 * The import reads `approved.next.mov`, so its `clips/` name hashes that
 * path; every render has a new mtime, so each approval still gets a copy of
 * its own (clip-import.ts `clipOutputName`), and nothing derives the name
 * from approved.mov again.
 *
 * The stills come first because they are the quick check: a scene that
 * hangs fails at the still time limit, before the clip render that has none.
 */
export async function approveShot(a: ApproveArgs, deps: ApproveDeps): Promise<ShotApproval> {
  // The length comes from the server's own rule, but a NaN from an empty
  // time map would otherwise reach Remotion as a frame count (CLAUDE.md:
  // parsed, never coerced).
  const length = ShotApprovalSchema.shape.durationSec.safeParse(a.durationSec);
  if (!length.success) throw new ApproveError(`shot ${a.shotId}: a clip needs a positive length, got ${a.durationSec}`);
  const durationSec = length.data;

  // `approvedClipPath` first: it refuses an id that fails ShotIdSchema
  // before `loadShot` can touch any path built from it.
  const finalPath = approvedClipPath(a.workdir, a.shotId);
  const h = loadShot(a.workdir, a.shotId);
  if (h === null || h.draft === null) {
    throw new ApproveError(`shot ${a.shotId} has no draft to approve; draw it first`);
  }
  const version = h.draft;
  const drawn = h.versions.find((v) => v.n === version);
  // A draft drawn against another kit may use parts this kit no longer has,
  // or draws differently; its stills are not what this render would make,
  // and the clip key's kit version would claim otherwise (design §8).
  if (drawn === undefined || drawn.kitVersion !== DRAW_KIT_VERSION) {
    throw new ApproveError(
      `shot ${a.shotId} v${version} was drawn with drawing kit version ${drawn?.kitVersion ?? "unknown"}, ` +
        `not the current ${DRAW_KIT_VERSION}; redraw it with a note before approving`,
    );
  }
  const paths = versionPaths(a.workdir, a.shotId, version);
  if (!existsSync(paths.code)) throw new ApproveError(`the draft of shot ${a.shotId} is missing its code: ${paths.code}`);
  const code = deps.readTextFile(paths.code);
  const nextPath = join(dirname(finalPath), "approved.next.mov");

  const publicDir = deps.makeRenderDir();
  let imported: { src: string; durationSec: number };
  try {
    const assets = await deps.stage(a.project, publicDir, a.assetsDir);
    const props = renderProps({ durationSec }, a.project, assets);
    const serveUrl = await deps.bundle({ scenePath: paths.code, workDir: a.workdir, publicDir });
    try {
      deps.log(`▸ approving shot ${a.shotId} v${version} at ${durationSec} s: stills`);
      await deps.renderStills({ serveUrl, props, outDir: paths.stillsDir, timeoutMs: DRAW_STILL_TIMEOUT_MS });
      deps.log(`▸ approving shot ${a.shotId} v${version}: clip`);
      try {
        await deps.renderClip({ serveUrl, props, outPath: nextPath, ...(a.cancelSignal ? { cancelSignal: a.cancelSignal } : {}) });
        imported = await deps.importClip(nextPath, a.workdir);
        renameSync(nextPath, finalPath);
      } catch (err) {
        rmSync(nextPath, { force: true });
        throw err;
      }
    } finally {
      deps.removeDir(serveUrl);
    }
  } finally {
    deps.removeDir(publicDir);
  }

  const key = clipKey(
    { code, kitVersion: DRAW_KIT_VERSION, theme: a.project.theme, width: a.project.width, height: a.project.height, fps: a.project.fps, durationSec },
    deps.hashHex,
  );
  deps.log(`✓ shot ${a.shotId} v${version} approved: ${imported.src}`);
  // Parsed on the way out: the caller writes this into storyboard.json, and
  // a record `loadStoryboard` would refuse must not get that far.
  return ShotApprovalSchema.parse({
    version,
    durationSec,
    clipKey: key,
    clip: workdirRelative(a.workdir, finalPath),
    src: imported.src,
  });
}

/** The real bundler, browser and ffmpeg, through the same staging `ossclip draw` uses. */
export function liveApproveDeps(): ApproveDeps {
  const cfg = loadConfig();
  const log = (line: string): void => console.log(line);
  return {
    readTextFile: (p) => readFileSync(p, "utf8"),
    hashHex: (text) => createHash("sha1").update(text).digest("hex"),
    bundle: (a) => bundleDrawnScene(a),
    renderStills: (a) => renderDrawnStills({ ...a, browserExecutable: cfg.browserExecutable }),
    renderClip: (a) => renderDrawnClip({ ...a, browserExecutable: cfg.browserExecutable }),
    importClip: (srcAbs, publicDir) =>
      importClip(srcAbs, publicDir, { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath }),
    stage: async (project, publicDir, assetsDir) =>
      stagedAssetPaths(
        await stageRender(
          assetsDir !== undefined ? { assetsDir } : {},
          project,
          publicDir,
          { stageFonts: (theme, dirs) => void stageBundledFonts(theme, dirs), probeImageSize: ffprobeImageSize, log },
        ),
      ),
    makeRenderDir: () => mkdtempSync(join(tmpdir(), "ossclip-approve-public-")),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    log,
  };
}
