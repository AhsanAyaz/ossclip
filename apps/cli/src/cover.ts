import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import {
  COVER_MAX_WORDS,
  COVER_PROVENANCE_BASENAME,
  ThemeSchema,
  coverHeadline,
  createFaceDetector,
  defaultTheme,
  loadConfig,
  measureCoverFrame,
  pickCoverFrame,
  probe,
  readCoverProvenance,
  run,
  writeCoverProvenance,
  type CoverFace,
  type CoverProvenance,
  type Theme,
} from "@ossclip/core";
import type { CoverCompProps } from "@ossclip/renderer";
import { artifactPath, ensureParentDir, expandHome } from "./paths";
import { lastFlagValue } from "./thumbnail-panel";

/**
 * The cover render step, as data (FINDINGS §31).
 *
 * `renderCover` takes a props object and an opts object, and until this
 * existed produce built both inline at its one call site. Three callers are
 * coming — produce, the `ossclip cover` subcommand and the editor's
 * regenerate endpoint — and two of them drifting is the failure this file
 * exists to prevent: a cover regenerated with a different `frame` or a
 * dropped `face` is not the same image, and nothing would say so.
 *
 * Pure, and no I/O: the arguments a render will be given are then assertable
 * without a browser, a bundle or a workdir — the `openCommand()` split.
 */
export interface CoverRenderArgs {
  /** The still in `publicDir`, by name — Remotion resolves it via staticFile. */
  frameFileName: string;
  /**
   * Banner headline, ALREADY through `coverHeadline`. "" means ship the frame
   * with no banner (the §34 case, where the source carries its own title) —
   * the composition treats empty as "the frame is the cover".
   */
  text: string;
  /** The RESOLVED theme, so the banner carries the config theme (F6). */
  theme: Theme;
  /**
   * The face in the COVER frame's own fractions. Passed through as-is: the
   * composition reads only `centerYFrac`/`sizeFrac` while `CoverFace` also
   * carries `centerXFrac`, and narrowing it here would be a change to what
   * produce ships today, not a fix.
   */
  face?: CoverFace;
  /** The OUTPUT frame this cover belongs to (R16 §76) — a landscape render
   * gets a landscape cover; the composition has no metadata hook of its own. */
  frame: { width: number; height: number };
  /** Where the still lives — the workdir for every current caller. */
  publicDir: string;
  outPath: string;
  browserExecutable?: string;
}

/** Exactly the pair `renderCover(props, opts)` is called with. */
export interface CoverRenderPlan {
  props: CoverCompProps;
  opts: { publicDir: string; outPath: string; browserExecutable?: string };
}

export function buildCoverRender(args: CoverRenderArgs): CoverRenderPlan {
  return {
    props: {
      frameFileName: args.frameFileName,
      text: args.text,
      theme: args.theme,
      face: args.face,
      frame: { width: args.frame.width, height: args.frame.height },
    },
    opts: {
      publicDir: args.publicDir,
      outPath: args.outPath,
      browserExecutable: args.browserExecutable,
    },
  };
}

/** The still produce extracts beside its cover, and the one a regeneration
 * reuses or overwrites. One spelling, because provenance records it by name. */
export const COVER_FRAME_BASENAME = "cover-frame.png";

/** The finished render as it lives in the workdir, before `moveFile` puts it
 * at `--out` — the fallback video when the out was moved or never rendered. */
const RENDER_RAW_BASENAME = "render-raw.mp4";

// ---- The recorded invocation (`<workdir>/command.json`) --------------------
// Lifted OUT of edit.ts (2026-08-19): `ossclip cover` needs the same
// out-resolution rule the thumbnail dest, the youtube markdown and the reveal
// endpoint already derive from, and a second spelling of it would let the CLI
// and the editor disagree about which file a replay writes — which for a
// cover means writing the JPEG beside a video nobody has.

/**
 * The invocation `produce` recorded into the workdir (R11 Task 4.1).
 * Validated on read — it's a file on disk like any other user data — and the
 * ONLY thing `/api/render` will ever spawn: the edit server binds locally, but
 * accepting a client-supplied command would make it a remote shell.
 */
export const RecordedCommandSchema = z.object({
  execPath: z.string(),
  execArgv: z.array(z.string()).default([]),
  script: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  out: z.string().optional(),
});
export type RecordedCommand = z.infer<typeof RecordedCommandSchema>;

/** `<workdir>/command.json`, or null when absent/corrupt — every caller
 * degrades to a fallback rather than failing over a convenience record. */
export async function readRecordedCommand(work: string): Promise<RecordedCommand | null> {
  const path = join(work, "command.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = RecordedCommandSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The recorded out as an absolute path (the top-level `out` when recorded,
 * else the argv's -o/--out resolved against the recorded cwd — the replay's
 * own resolution), or null when no out was ever recorded.
 */
export function recordedOutPath(cmd: RecordedCommand): string | null {
  const out = cmd.out ?? lastFlagValue(cmd.args, ["-o", "--out"]);
  if (out === undefined) return null;
  return resolve(cmd.cwd, expandHome(out));
}

/** `<out><ext>` from the recorded out, or null when no out was ever
 * recorded. Shared by the thumbnail dest, the youtube markdown and the
 * cover's own default destination. */
export async function recordedArtifactPath(work: string, ext: string): Promise<string | null> {
  const cmd = await readRecordedCommand(work);
  if (cmd === null) return null;
  const out = recordedOutPath(cmd);
  if (out === null) return null;
  return artifactPath(out, ext);
}

/**
 * How a video is written into provenance: workdir-relative when it LIVES in
 * the workdir (a folder run's concat mezzanine, `render-raw.mp4`), absolute
 * otherwise — a workdir that moved must still resolve its own intermediates,
 * and a source that lives elsewhere cannot be made relative to it. `relative`
 * escaping upward is the tell that it lives outside.
 */
export function provenanceVideoPath(work: string, videoPath: string): string {
  const rel = relative(work, videoPath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : videoPath;
}

/** The inverse: a provenance `sourceVideo` back to an absolute path. */
export function resolveProvenanceVideo(work: string, sourceVideo: string): string {
  return isAbsolute(sourceVideo) ? sourceVideo : join(work, sourceVideo);
}

// ---- The user's flags ------------------------------------------------------

/** The frame's video: the finished render or the original take. */
export const CoverFromSchema = z.enum(["final", "source"]);
export type CoverFrom = z.infer<typeof CoverFromSchema>;

/**
 * A timestamp, in seconds. Finite and non-negative — `--at -3` and `--at abc`
 * must be an error naming the flag, never a silent seek to zero.
 *
 * Exported because the editor's `/api/cover/regenerate` body parses `atSec`
 * through THIS schema: the CLI refusing a negative seek while the panel let
 * one through would be two spellings of the same rule, and only one of them
 * tested.
 */
export const CoverAtSecondsSchema = z.number().finite().nonnegative();

export interface CoverFlags {
  text?: string;
  atSec?: number;
  from: CoverFrom;
  outPath?: string;
}

/**
 * `ossclip cover`'s flags, parsed rather than coerced (CLAUDE.md): a typo'd
 * `--from finall` silently falling back to "final" is the same defect as
 * `--source-fit containn` falling back to `cover` — it renders a cover from
 * the wrong video and says nothing.
 *
 * Pure, and separate from the action, so the whole matrix is testable with no
 * commander instance and no workdir.
 */
export function parseCoverFlags(raw: {
  text?: unknown;
  at?: unknown;
  from?: unknown;
  out?: unknown;
}): CoverFlags {
  const from = CoverFromSchema.safeParse(raw.from ?? "final");
  if (!from.success) {
    throw new Error(`--from wants "final" or "source", got ${JSON.stringify(raw.from)}`);
  }
  let atSec: number | undefined;
  if (raw.at !== undefined) {
    // Number() only turns the argv STRING into a candidate; the judgement is
    // zod's, so "abc" (NaN) and "-3" are refused instead of seeking to 0.
    const parsed = CoverAtSecondsSchema.safeParse(
      typeof raw.at === "string" && raw.at.trim() !== "" ? Number(raw.at) : raw.at,
    );
    if (!parsed.success) {
      throw new Error(
        `--at wants a timestamp in seconds, 0 or more, got ${JSON.stringify(raw.at)}`,
      );
    }
    atSec = parsed.data;
  }
  const text = raw.text === undefined ? undefined : z.string().parse(raw.text);
  const out = raw.out === undefined ? undefined : z.string().parse(raw.out);
  return { text, atSec, from: from.data, outPath: out };
}

// ---- The three resolutions, pure ------------------------------------------

export interface CoverTextChoice {
  text: string;
  textSource: CoverProvenance["textSource"];
  /** What the command must PRINT — a headline that was trimmed, or a workdir
   * with no headline to reuse. Silence on either is how a user ships a cover
   * they did not write. */
  notes: string[];
}

/**
 * Which headline a regeneration renders.
 *
 * An explicit `--text` ALWAYS renders as a banner, even on a workdir whose
 * last produce suppressed one under §34 (the frame carried the source's own
 * title, so provenance holds `text: ""`). That is a decision, not an
 * oversight: re-running the §34 check needs `sourceText.regions`, which no
 * workdir persists, and a user who just typed a headline meant it. With no
 * `--text` the persisted text is reused VERBATIM — empty stays empty, so a
 * §34 cover regenerates as the bare frame it shipped as.
 */
export function resolveCoverText(args: {
  typed?: string;
  persisted: Pick<CoverProvenance, "text" | "textSource"> | null;
}): CoverTextChoice {
  if (args.typed !== undefined) {
    // Compared against the NORMALIZED input, not the raw one: coverHeadline
    // also collapses runs of whitespace, and reporting that as a trim would
    // cry wolf on every headline typed with two spaces.
    const normalized = args.typed.trim().replace(/\s+/g, " ");
    const text = coverHeadline(normalized);
    return {
      text,
      textSource: "user",
      notes:
        text === normalized
          ? []
          : // The cap is named as a CAP, not as the result: `coverHeadline`
            // truncates to `COVER_MAX_WORDS` and then pops trailing dangling
            // words, so a 9-word cap routinely yields 8 — and "trimmed to 9
            // words" printed above an 8-word headline is a line that is
            // simply false.
            [`▸ headline trimmed to fit the ${COVER_MAX_WORDS}-word cap: "${text}"`],
    };
  }
  if (args.persisted !== null) {
    return { text: args.persisted.text, textSource: args.persisted.textSource, notes: [] };
  }
  return {
    text: "",
    textSource: "beatsheet",
    notes: [
      `▸ no ${COVER_PROVENANCE_BASENAME} and no --text — shipping the frame with no banner ` +
        `(pass --text "…" to set one)`,
    ],
  };
}

export interface CoverFrameSource {
  path: string;
  /** produce's `cropFilter(detection.uniform)`, applied before the cover's own
   * centre crop. Only a `source` re-pick needs it: the finished render IS the
   * output frame already. */
  cropVf?: string;
}

/**
 * Which video an `--at` extraction reads. `exists` is injected so the whole
 * fallback ladder is testable without a filesystem — the `openCommand()`
 * split applied to a path decision.
 */
export function coverFrameSource(args: {
  from: CoverFrom;
  workdir: string;
  recordedOut: string | null;
  provenance: CoverProvenance | null;
  exists: (path: string) => boolean;
}): CoverFrameSource {
  if (args.from === "final") {
    if (args.recordedOut !== null && args.exists(args.recordedOut)) {
      return { path: args.recordedOut };
    }
    // The out was moved, deleted, or never rendered (`--no-render`): the
    // workdir's own pre-loudnorm render is the same picture.
    const raw = join(args.workdir, RENDER_RAW_BASENAME);
    if (args.exists(raw)) return { path: raw };
    throw new Error(
      `no finished video to read a frame from — ` +
        (args.recordedOut === null
          ? `command.json records no --out, and ${raw} is missing.`
          : `neither ${args.recordedOut} nor ${raw} is there.`) +
        `\n  Try --from source to re-pick from the original take.`,
    );
  }
  // Null is the file saying "the original take is unknown" — a cover first
  // built off the final render on a workdir that had no provenance. Refusing
  // is the honest answer: the alternative that shipped once was reading the
  // finished video and calling it the source (see `sourceVideo`'s comment in
  // packages/core/src/cover.ts).
  const recorded = args.provenance?.frame.sourceVideo ?? null;
  if (recorded === null) {
    throw new Error(
      `--from source needs ${COVER_PROVENANCE_BASENAME} to name the original take — ` +
        (args.provenance === null
          ? `this workdir has none`
          : `this one records no source video (its cover was built from the final render)`) +
        `.\n  Use --from final to read the finished render instead.`,
    );
  }
  const path = resolveProvenanceVideo(args.workdir, recorded);
  if (!args.exists(path)) {
    throw new Error(
      `the source video ${path} is gone (${COVER_PROVENANCE_BASENAME} recorded it).\n` +
        `  Use --from final to read the finished render instead.`,
    );
  }
  return { path, cropVf: args.provenance?.frame.cropVf ?? undefined };
}

export interface CoverDestination {
  /** Where THIS invocation writes the JPEG. */
  render: string;
  /** Where this project's cover LIVES — what `cover.json` records, and what
   * the editor's panel and the next flagless run follow. */
  canonical: string;
}

/**
 * The two destinations, which are NOT the same thing (2026-08-19).
 *
 * They were one — `--out` set the render target and was then persisted as
 * `cover.json`'s `out` — so a one-off `ossclip cover --out /tmp/preview.jpg`
 * permanently repointed the project's cover at /tmp: every later flagless run
 * wrote there, and the editor's panel followed it. An export is not a move.
 *
 * `canonical` therefore ignores the flag entirely: the destination the last
 * cover used, else `<recorded out>.cover.jpg`. `expandHome` on the USER half
 * only — the artifactPath default derives from an already-expanded recorded
 * out (2026-08-16, paths.ts).
 */
export function coverDestination(args: {
  flag?: string;
  provenanceOut?: string;
  recordedOut: string | null;
  cwd?: string;
}): CoverDestination {
  const canonical =
    args.provenanceOut ??
    (args.recordedOut !== null ? artifactPath(args.recordedOut, ".cover.jpg") : null);
  if (args.flag !== undefined) {
    const render = resolve(args.cwd ?? process.cwd(), expandHome(args.flag));
    // No canonical destination to protect — no prior cover and no recorded
    // out — so the flag is the only place this project's cover has ever
    // lived, and recording it redirects nothing.
    return { render, canonical: canonical ?? render };
  }
  if (canonical === null) {
    throw new Error(
      `no cover destination: this workdir has neither ${COVER_PROVENANCE_BASENAME} nor a ` +
        `recorded --out.\n  Pass --out <path>.`,
    );
  }
  return { render: canonical, canonical };
}

/**
 * The one line a one-off `--out` owes the user (2026-08-19), or null when
 * there is nothing to say because the two destinations are the same file.
 *
 * A run that renders elsewhere STILL persists its text and `textSource` into
 * `cover.json` — deliberately, so a later flagless run renders that same
 * headline to the canonical path. The gap that leaves is the whole reason
 * this exists: between the two runs the provenance describes a headline the
 * project's own `.cover.jpg` does not display, and silence about it is how a
 * user ships the OLD cover believing they just changed it.
 *
 * Pure and next to `coverDestination`, so the divergence rule is assertable
 * without a render or a workdir — the `openCommand()` split.
 */
export function coverExportNote(dest: CoverDestination): string | null {
  if (dest.render === dest.canonical) return null;
  return (
    `▸ one-off --out: this project's own cover ${dest.canonical} was NOT updated — ` +
    `re-run \`ossclip cover\` with no --out to write it there`
  );
}

// ---- Produce's side: a user-set headline is user-owned ---------------------

export interface CoverTextHold {
  text: string;
  textSource: CoverProvenance["textSource"];
  /** The ONE line produce prints about it — how the headline was chosen and
   * how to opt back out. */
  message?: string;
}

/**
 * Whether a later produce keeps the headline someone typed.
 *
 * Same posture as `overrides.json` and `thumbnail-concept-approved.json`:
 * a file the user owns beats what this run's beat sheet just generated, and
 * the run says so rather than silently overwriting an edit. `cover.json` is
 * the file; `--cover-text-reset` (or deleting it) opts back in.
 *
 * An EMPTY persisted user text is deliberately not held: produce persists the
 * text it rendered, so a §34 run (the frame carried the source's own title)
 * writes `text: ""`, and holding that would silently ban the banner from
 * every future run of this project.
 */
export function coverTextHold(args: {
  generated: string;
  persisted: Pick<CoverProvenance, "text" | "textSource"> | null;
  reset: boolean;
}): CoverTextHold {
  const held =
    args.persisted !== null &&
    args.persisted.textSource === "user" &&
    args.persisted.text.trim() !== "";
  if (held && args.reset) {
    return {
      text: args.generated,
      textSource: "beatsheet",
      message: "▸ cover: --cover-text-reset — back to the generated headline",
    };
  }
  if (held) {
    return {
      text: args.persisted!.text,
      textSource: "user",
      message:
        `▸ cover: keeping your headline "${args.persisted!.text}" ` +
        `(--cover-text-reset, or deleting ${COVER_PROVENANCE_BASENAME}, goes back to the generated one)`,
    };
  }
  return { text: args.generated, textSource: "beatsheet" };
}

export interface CoverBannerChoice {
  /** What the banner renders. "" is §34's suppression — the composition
   * treats empty as "the frame is the cover". */
  text: string;
  /** The line produce prints under its `cover from …s` line when the source
   * carried its own title, already indented for that block. Absent when there
   * was no §34 collision to report. */
  note?: string;
}

/**
 * §34, with the one exception the rule was never about: a headline the user
 * typed.
 *
 * §34 suppresses the banner when the frame already shows the source's own
 * on-screen title, because a GENERATED headline restating it says the same
 * thing twice in one image — a cover with one title beats a cover with two.
 * A user who typed a headline (`ossclip cover --text`, or the editor;
 * `textSource: "user"`) has already made that judgement themselves, so
 * suppressing it is not the §34 rule any more, it is a silent overwrite of
 * user intent — the exact failure `textSource: "user"` was introduced to
 * prevent, and the same posture that makes overrides.json user-owned.
 *
 * A blank user text takes the suppression path with the generated wording:
 * there is no banner either way, so there is nothing to say about keeping
 * one (`coverTextHold`'s empty-text rule, from the same reasoning).
 *
 * Pure, so the whole matrix is assertable without a render or a workdir.
 */
export function coverBannerText(args: {
  text: string;
  textSource: CoverProvenance["textSource"];
  sourceTitled: boolean;
}): CoverBannerChoice {
  if (!args.sourceTitled) return { text: args.text };
  if (args.textSource === "user" && args.text.trim() !== "") {
    return {
      text: args.text,
      note:
        "  ▸ source already has a title in this frame — keeping your headline anyway " +
        "(--cover-text-reset goes back to the generated one)",
    };
  }
  return {
    text: "",
    note: "  ▸ source already has a title in this frame — shipping it without a banner",
  };
}

// ---- Regeneration ----------------------------------------------------------

/** The slice of `render-props.json` a cover rebuild needs — SELECTIVE and
 * parsed, not cast: the file is user-visible and the editor rewrites its
 * theme, which is exactly how a regenerated cover picks up a theme change for
 * free (§corr.2). `production.json` carries neither the RESOLVED theme nor
 * the editor's edits, which is why this is the file that gets read. */
const CoverRenderPropsSchema = z.object({
  theme: ThemeSchema.optional(),
  settings: z.object({ width: z.number(), height: z.number() }).optional(),
  /** The take's whole-frame subject, for a re-pick's scoring — "screen"
   * zeroes the face weight (scoreCandidate's 2026-08-16 incident). */
  face: z.object({ subject: z.enum(["face", "screen"]).optional() }).optional(),
});

export interface CoverRegenerateOptions {
  /** An explicit headline. `coverHeadline` still applies. */
  text?: string;
  /** Extract a fresh still at this timestamp instead of reusing the current
   * one. Omitted is the cheap path: no ffmpeg runs at all. */
  atSec?: number;
  /** Which video `atSec` reads. Default "final" — what a scrubber over the
   * finished video gives you, burned-in captions and all. */
  from?: CoverFrom;
  /** A ONE-OFF destination as the USER typed it — `coverDestination` applies
   * the tilde expansion and the cwd anchor, and deliberately does not let it
   * change where this project's cover lives. */
  outPath?: string;
}

/** What a measured still came back with — the grabber's half of a pick. */
export interface CoverFrameMeasurement {
  sharpness: number;
  hasFace: boolean;
  face?: CoverFace;
}

/**
 * The I/O seams. `renderCover` is required by the editor's test suite (it
 * must never boot Remotion), and the frame seams are what let the fast path
 * PROVE it shells out to nothing — the `generateThumbnail` seam's pattern.
 */
export interface CoverSeams {
  renderCover?: (
    props: CoverCompProps,
    opts: { publicDir: string; outPath: string; browserExecutable?: string },
  ) => Promise<void>;
  /** Extract the still at `timeSec` into `framePath` and measure its face in
   * the COVER's own geometry. */
  grabFrame?: (req: {
    videoPath: string;
    timeSec: number;
    cropVf?: string;
    framePath: string;
    frame: { width: number; height: number };
  }) => Promise<CoverFrameMeasurement>;
  /** Choose a timestamp when there is no provenance to reuse and no `--at`. */
  pickFrame?: (req: {
    videoPath: string;
    cropVf?: string;
    subject?: "face" | "screen";
    /** Where the sampler's scratch frames go — the WORKDIR, never the
     * video's own folder: `--from final` reads the user's output directory,
     * and littering it with `cover-frame-*.gray` is not this command's right. */
    cacheDir: string;
  }) => Promise<{ timeSec: number } | null>;
  ffmpegPath?: string;
  ffprobePath?: string;
  browserExecutable?: string;
  log?: (line: string) => void;
}

/**
 * Regenerate a workdir's cover: seconds, and no video re-encode.
 *
 * THE call site for both `ossclip cover` and the editor's regenerate
 * endpoint. A second spelling of this would drift — a cover rebuilt with a
 * different frame, a dropped face or the wrong theme is not the same image,
 * and nothing on disk would say so.
 *
 * Returns the provenance it wrote, so the caller can report exactly what
 * shipped rather than re-reading the file it just wrote.
 */
export async function regenerateCover(
  workdir: string,
  opts: CoverRegenerateOptions = {},
  seams: CoverSeams = {},
): Promise<CoverProvenance> {
  const work = resolve(workdir);
  const log = seams.log ?? ((line: string) => console.log(line));
  // Lazily, and memoized: a fully-seamed call (the tests, and the editor's
  // stub) must not read the runner's real ~/.ossclip/config.json — edit.ts's
  // `loadCfg` seam is the same rule applied to reads.
  let cachedCfg: ReturnType<typeof loadConfig> | null = null;
  const cfg = (): ReturnType<typeof loadConfig> => (cachedCfg ??= loadConfig());

  const propsRaw: unknown = JSON.parse(
    await readFile(join(work, "render-props.json"), "utf8"),
  );
  const parsedProps = CoverRenderPropsSchema.safeParse(propsRaw);
  if (!parsedProps.success) {
    throw new Error(`render-props.json in ${work} is not valid: ${parsedProps.error.message}`);
  }
  const renderProps = parsedProps.data;
  const provenance = await readCoverProvenance(work);
  const cmd = await readRecordedCommand(work);
  const recordedOut = cmd === null ? null : recordedOutPath(cmd);

  const chosenText = resolveCoverText({ typed: opts.text, persisted: provenance });
  for (const note of chosenText.notes) log(note);

  // render-props first: it is the RESOLVED theme and the render's own output
  // frame, so an editor theme change (or a landscape re-render, R16 §76)
  // reaches the cover with no extra wiring. Provenance is the fallback for a
  // legacy props file that carries no settings block.
  const theme: Theme = renderProps.theme ?? defaultTheme;
  const frame = renderProps.settings ?? provenance?.size ?? { width: 1080, height: 1920 };
  const from = opts.from ?? "final";

  // Resolved BEFORE any ffmpeg runs, and the parent created here: paths.ts's
  // rule — a bad destination must fail in the first second, not after the
  // work. Cheap here, load-bearing for the frame path below.
  const dest = coverDestination({
    flag: opts.outPath,
    provenanceOut: provenance?.out,
    recordedOut,
  });
  ensureParentDir(dest.render);

  let frameRecord: CoverProvenance["frame"];
  if (opts.atSec === undefined && provenance !== null) {
    // THE common case — a text-only change — and the reason this feature
    // costs seconds: the still produce extracted is still on disk, so this
    // path runs no ffmpeg at all.
    const still = join(work, provenance.frame.fileName);
    if (!existsSync(still)) {
      throw new Error(
        `${provenance.frame.fileName} is gone from ${work}, so there is no still to re-use.\n` +
          `  Pass --at <seconds> to extract a fresh frame.`,
      );
    }
    frameRecord = provenance.frame;
    log(
      `▸ reusing ${provenance.frame.fileName} from ${provenance.frame.timeSec.toFixed(1)}s ` +
        `(${provenance.frame.source}) — no frame extraction`,
    );
  } else {
    const source = coverFrameSource({
      from,
      workdir: work,
      recordedOut,
      provenance,
      exists: existsSync,
    });
    const framePath = join(work, COVER_FRAME_BASENAME);
    let timeSec = opts.atSec;
    if (timeSec === undefined) {
      // No provenance AND no --at: nothing records which instant the shipped
      // cover came from, so re-pick one — and say so, because it will not be
      // the same frame the current cover shows.
      log(
        `▸ no ${COVER_PROVENANCE_BASENAME} in ${work} — re-picking a frame from ` +
          `${basename(source.path)} (it may not be the one the current cover uses)`,
      );
      const picked = await (seams.pickFrame ?? livePickFrame(seams, cfg))({
        videoPath: source.path,
        cropVf: source.cropVf,
        subject: renderProps.face?.subject,
        cacheDir: work,
      });
      if (picked === null) throw new Error(`no usable cover frame found in ${source.path}`);
      timeSec = picked.timeSec;
    }
    const measured = await (seams.grabFrame ?? liveGrabFrame(seams, cfg))({
      videoPath: source.path,
      timeSec,
      cropVf: source.cropVf,
      framePath,
      frame,
    });
    log(
      `▸ cover frame from ${timeSec.toFixed(1)}s of the ${from} video ` +
        `(${measured.hasFace ? "face" : "no face"}, sharpness ${measured.sharpness.toFixed(0)})`,
    );
    frameRecord = {
      source: from,
      timeSec,
      face: measured.face ?? null,
      hasFace: measured.hasFace,
      sharpness: measured.sharpness,
      fileName: COVER_FRAME_BASENAME,
      // PRESERVED, never re-derived from the video just read: both fields
      // describe the ORIGINAL TAKE (see `sourceVideo` in
      // packages/core/src/cover.ts for the day a `--from final` run wrote the
      // finished render's path here and `--from source` started silently
      // re-cutting the cover from it). With no prior provenance the take is
      // unknown — and it can only be a `--from final` run, since
      // `coverFrameSource` refuses `--from source` without a record.
      sourceVideo: provenance?.frame.sourceVideo ?? null,
      cropVf: provenance?.frame.cropVf ?? null,
    };
  }

  const plan = buildCoverRender({
    frameFileName: frameRecord.fileName,
    text: chosenText.text,
    theme,
    face: frameRecord.face ?? undefined,
    frame,
    publicDir: work,
    outPath: dest.render,
    // Only the REAL renderer needs a browser; a seamed call brings its own.
    browserExecutable:
      seams.browserExecutable ??
      (seams.renderCover === undefined ? cfg().browserExecutable : undefined),
  });
  const render =
    seams.renderCover ??
    (async (props, o) => {
      // Lazy, and the ONLY reason this module stays importable by the edit
      // server: a static @ossclip/renderer import would drag Remotion into a
      // deliberately dependency-free server (edit.ts's own import argument).
      const { renderCover } = await import("@ossclip/renderer");
      await renderCover(props, o);
    });
  await render(plan.props, plan.opts);

  const written: CoverProvenance = {
    version: 1,
    text: chosenText.text,
    textSource: chosenText.textSource,
    frame: frameRecord,
    size: frame,
    // The CANONICAL destination, not necessarily the file just written: a
    // one-off `--out` exports a copy, it does not move where this project's
    // cover lives (`coverDestination`).
    out: dest.canonical,
  };
  // Written AFTER the render succeeded, describing what that render used —
  // so the NEXT regeneration is the cheap path again.
  await writeCoverProvenance(work, written);
  log(`✓ cover → ${dest.render}`);
  // AFTER the ✓, because it qualifies the destination that line just named:
  // the JPEG went to the one-off path, and the provenance now describes a
  // headline the project's canonical cover does not show yet.
  const exportNote = coverExportNote(dest);
  if (exportNote !== null) log(exportNote);
  return written;
}

/** The live frame grabber: produce's exact still filter (`produce.ts`'s cover
 * block), then `measureCoverFrame` for the face in the COVER's geometry. */
function liveGrabFrame(
  seams: CoverSeams,
  cfg: () => ReturnType<typeof loadConfig>,
): NonNullable<CoverSeams["grabFrame"]> {
  return async (req) => {
    const ffmpegPath = seams.ffmpegPath ?? cfg().ffmpegPath;
    const scale =
      `scale=${req.frame.width}:${req.frame.height}:force_original_aspect_ratio=increase,` +
      `crop=${req.frame.width}:${req.frame.height}`;
    await run(ffmpegPath, [
      "-v", "error",
      "-ss", req.timeSec.toFixed(3),
      "-i", req.videoPath,
      "-frames:v", "1",
      "-vf", `${req.cropVf ? `${req.cropVf},` : ""}${scale}`,
      "-y", req.framePath,
    ]);
    if (!existsSync(req.framePath)) {
      // ffmpeg exits 0 having written nothing when the seek lands past the
      // end — a silent empty cover is the worst version of that.
      throw new Error(
        `no frame at ${req.timeSec.toFixed(1)}s of ${req.videoPath} — is the timestamp past the end?`,
      );
    }
    const detector = await createFaceDetector();
    const measured = await measureCoverFrame({ ffmpegPath }, req.videoPath, req.timeSec, {
      cacheDir: dirname(req.framePath),
      cropVf: req.cropVf,
      frameName: "cover-frame-at.gray",
      detectFace: (pixels, w, h) => {
        const d = detector(pixels, w, h);
        // pico returns [row, col, size, score] in detection-frame pixels, and
        // that frame is cropped exactly like the cover — so these fractions
        // are the cover's own geometry, not the source's.
        return d ? { centerXFrac: d[1] / w, centerYFrac: d[0] / h, sizeFrac: d[2] / h } : null;
      },
    });
    // A still that exists but measured short is a bad read, not a missing
    // frame: ship the cover with no face box rather than failing on it.
    return {
      sharpness: measured?.sharpness ?? 0,
      hasFace: measured?.hasFace ?? false,
      face: measured?.face,
    };
  };
}

/** The live re-pick: `pickCoverFrame` over the chosen video, the same
 * sharp/face/early scoring produce uses. */
function livePickFrame(
  seams: CoverSeams,
  cfg: () => ReturnType<typeof loadConfig>,
): NonNullable<CoverSeams["pickFrame"]> {
  return async (req) => {
    const tools = {
      ffmpegPath: seams.ffmpegPath ?? cfg().ffmpegPath,
      ffprobePath: seams.ffprobePath ?? cfg().ffprobePath,
    };
    const { duration } = await probe(tools, req.videoPath);
    const detector = await createFaceDetector();
    const picked = await pickCoverFrame(tools, req.videoPath, duration, {
      cacheDir: req.cacheDir,
      cropVf: req.cropVf,
      subject: req.subject,
      detectFace: (pixels, w, h) => {
        const d = detector(pixels, w, h);
        return d ? { centerXFrac: d[1] / w, centerYFrac: d[0] / h, sizeFrac: d[2] / h } : null;
      },
    });
    return picked === null ? null : { timeSec: picked.timeSec };
  };
}
