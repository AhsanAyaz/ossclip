import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { run } from "./exec";

/**
 * Cover image selection (FINDINGS §31).
 *
 * Instagram and Facebook both accept a custom uploaded cover, so nothing has
 * to be pickable from the video's own frames — which is why ossclip writes a
 * separate `<out>.cover.jpg` rather than burning a title card into the head of
 * the reel. Spending the first 2-3 seconds on a static card would fight the
 * "hook in the first ~2s" policy directly, and a separate file can be
 * restyled without re-rendering a minute of video.
 *
 * This module picks WHICH frame. The banner is drawn by the renderer.
 */

// The §35 word cap lives in ./cover-headline — this file is node all the way
// down (node:fs, ./exec's child_process) and the EDITOR's cover panel needs
// `coverHeadline` at runtime through @ossclip/core/browser, which forbids a
// node built-in anywhere in its graph. Re-exported here so `@ossclip/core`'s
// surface is exactly what it was.
export { COVER_MAX_WORDS, coverHeadline } from "./cover-headline";

/**
 * What the cover step should emit.
 *
 * "textless" exists because of the Urdu field run 2026-08-05: a run without
 * `--produce` has no LLM hook text, and the old behavior skipped the cover
 * entirely — but frame selection needs no text at all, and the
 * sharpness-scored face frame is a clean thumbnail on its own. Only the
 * banner needs a headline; the pick does not, so a missing headline demotes
 * the cover to a bare frame instead of erasing it.
 */
export type CoverDecision = "banner" | "textless" | "none";

/**
 * Pure so the three-way outcome is testable without a video, ffmpeg, or a
 * beat sheet on disk — the same I/O split as `openCommand()`.
 */
export function coverDecision(coverEnabled: boolean, headline: string): CoverDecision {
  if (!coverEnabled) return "none";
  return headline.trim() ? "banner" : "textless";
}

/** Where the face sits in the COVER frame, as fractions of it. */
export interface CoverFace {
  centerXFrac: number;
  centerYFrac: number;
  sizeFrac: number;
}

export interface CoverCandidate {
  timeSec: number;
  /** Variance of the Laplacian — higher is sharper, lower is motion-blurred. */
  sharpness: number;
  hasFace: boolean;
  /** The box, when one was found — the banner routes around it (FINDINGS §33). */
  face?: CoverFace;
  score: number;
}

/**
 * Detection frame: the 9:16 cover frame at analysis size.
 *
 * Deliberately NOT face.ts's plain `scale`. That one measures the SOURCE, and
 * its fractions feed the video crop math. This one measures the COVER, which
 * is a centre crop to 1080×1920 — so it applies the identical crop first.
 * Without that, a face box measured on a stretched 16:9 source would place the
 * cover banner against geometry the cover does not have.
 */
const DET_W = 360;
const DET_H = 640;
export const COVER_CROP_VF =
  `scale=${DET_W}:${DET_H}:force_original_aspect_ratio=increase,crop=${DET_W}:${DET_H}`;

/**
 * Variance of the Laplacian over a grayscale frame — the standard cheap
 * sharpness measure. A frame caught mid-motion has most of its energy smeared
 * away and scores low, which is exactly what a cover must not be.
 */
export function laplacianVariance(pixels: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * pixels[i]! - pixels[i - 1]! - pixels[i + 1]! - pixels[i - w]! - pixels[i + w]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Score a candidate. On a "face" take a face is close to mandatory — a cover
 * without the speaker is a cover for a different video — and among frames
 * that have one, sharpness decides. Earlier frames win ties so the cover
 * matches the opening.
 *
 * On a "screen" take the face weight drops to ZERO (2026-08-16): a Facebook
 * reel playing inside a 21-minute screen recording put a STRANGER'S face on
 * the cover, because face×2 hunts any face at all and on a screen-subject
 * take every face in frame is content, not the speaker. Sharpness and
 * earliness alone pick that cover. Default "face" so portrait/talking-head
 * runs score exactly as before.
 */
export function scoreCandidate(c: {
  timeSec: number;
  durationSec: number;
  sharpness: number;
  hasFace: boolean;
  maxSharpness: number;
  subject?: "face" | "screen";
}): number {
  const faceWeight = c.subject === "screen" ? 0 : 2;
  const face = c.hasFace ? 1 : 0;
  const sharp = c.maxSharpness > 0 ? c.sharpness / c.maxSharpness : 0;
  const earliness = 1 - Math.min(1, c.timeSec / Math.max(1e-6, c.durationSec));
  return face * faceWeight + sharp + earliness * 0.3;
}

export interface PickCoverOptions {
  /** Frames to sample across the searched window. */
  samples?: number;
  /** Fraction of the take to search — the cover should match the opening. */
  searchFraction?: number;
  cacheDir?: string;
  /**
   * Locates the face in a sampled frame, in that frame's own fractions.
   * Returns the box rather than a boolean because the banner has to route
   * around it (FINDINGS §33), and the frame it was measured on is the only
   * frame whose geometry is certainly the cover's.
   */
  detectFace?: (pixels: Uint8Array, w: number, h: number) => CoverFace | null;
  /**
   * ffmpeg filter trimming the source to its content rect (PLAN Task 7),
   * applied BEFORE the cover's own centre crop — otherwise the cover frames a
   * canvas that is two-thirds baked-in black bar.
   */
  cropVf?: string;
  /**
   * The take's whole-frame subject (`faceSubject`'s verdict). "screen" zeroes
   * the face weight in `scoreCandidate` — see its doc comment for the
   * 2026-08-16 stranger's-face incident. Default "face".
   */
  subject?: "face" | "screen";
}

/**
 * Measure ONE candidate frame: extract it at `timeSec` through the crop math,
 * score its sharpness, and locate the face in the cover's own geometry.
 *
 * Extracted from `pickCoverFrame`'s sampling loop because `ossclip cover --at
 * <t>` needs exactly this for a single timestamp. A second implementation of
 * the cover crop would drift from this one — and a drifted crop puts the
 * banner against geometry the cover does not have, which is the whole reason
 * `COVER_CROP_VF` exists rather than face.ts's plain `scale`.
 *
 * Returns null on a short read: ffmpeg seeking past the end (or onto a
 * corrupt packet) writes fewer bytes than the detection frame, and measuring
 * that is measuring padding.
 */
export async function measureCoverFrame(
  tools: { ffmpegPath: string },
  videoPath: string,
  timeSec: number,
  opts: {
    cacheDir?: string;
    cropVf?: string;
    detectFace?: PickCoverOptions["detectFace"];
    /** Scratch file name — the sampler keeps one per sample so a crashed run
     * leaves no ambiguity about which frame it died on. */
    frameName?: string;
  } = {},
): Promise<{ timeSec: number; sharpness: number; hasFace: boolean; face?: CoverFace } | null> {
  const framePath = join(opts.cacheDir ?? ".", opts.frameName ?? "cover-frame.gray");
  await run(tools.ffmpegPath, [
    "-v", "error",
    "-ss", timeSec.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", `${opts.cropVf ? `${opts.cropVf},` : ""}${COVER_CROP_VF}`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "-y", framePath,
  ]);
  const pixels = new Uint8Array(await readFile(framePath));
  await unlink(framePath).catch(() => {});
  if (pixels.length < DET_W * DET_H) return null;
  const face = opts.detectFace?.(pixels, DET_W, DET_H) ?? undefined;
  return {
    timeSec,
    sharpness: laplacianVariance(pixels, DET_W, DET_H),
    hasFace: face !== undefined,
    face,
  };
}

/**
 * Pick the best cover frame from the take: sharp, face present, early.
 *
 * Note on "eyes open" (§31): pico's cascade locates a face box but carries no
 * eye state, and adding a landmark model for one thumbnail is not worth the
 * dependency — sharpness plus a face is what this measures. A blink is a real
 * residual risk; `--cover <path>` is the escape hatch.
 */
export async function pickCoverFrame(
  tools: { ffmpegPath: string },
  videoPath: string,
  durationSec: number,
  opts: PickCoverOptions = {},
): Promise<CoverCandidate | null> {
  const samples = opts.samples ?? 12;
  const searchFraction = opts.searchFraction ?? 0.2;
  const window = Math.max(1, durationSec * searchFraction);
  const candidates: CoverCandidate[] = [];
  const raw: Array<{
    timeSec: number;
    sharpness: number;
    hasFace: boolean;
    face?: CoverFace;
  }> = [];

  for (let i = 0; i < samples; i++) {
    const t = (window * (i + 0.5)) / samples;
    const measured = await measureCoverFrame(tools, videoPath, t, {
      cacheDir: opts.cacheDir,
      cropVf: opts.cropVf,
      detectFace: opts.detectFace,
      frameName: `cover-frame-${i}.gray`,
    });
    if (measured) raw.push(measured);
  }
  if (raw.length === 0) return null;

  const maxSharpness = Math.max(...raw.map((r) => r.sharpness));
  for (const r of raw) {
    candidates.push({
      ...r,
      score: scoreCandidate({ ...r, durationSec: window, maxSharpness, subject: opts.subject }),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}

// ---- Cover provenance (`<workdir>/cover.json`) ----------------------------
// Until this file existed, the ONLY thing that survived a cover render was the
// JPEG: changing a headline therefore meant a full re-render to re-derive the
// pick. Everything a faithful rebuild needs is recorded here so a regeneration
// is `renderCover` against a still that is already on disk.

/** The file the workdir keeps its cover provenance in. */
export const COVER_PROVENANCE_BASENAME = "cover.json";

/**
 * Annotated as `z.ZodType<CoverFace>` so the persisted shape and the in-memory
 * one cannot drift apart silently — adding a fraction to `CoverFace` without
 * adding it here is then a compile error, not a field that quietly stops
 * round-tripping.
 */
const CoverFaceSchema: z.ZodType<CoverFace> = z.object({
  centerXFrac: z.number(),
  centerYFrac: z.number(),
  sizeFrac: z.number(),
});

export const CoverProvenanceSchema = z.object({
  version: z.literal(1),
  /** The banner text as SHIPPED — already through `coverHeadline`, and "" for
   * the §34 case where the frame carried its own title. What was rendered,
   * not what was proposed. */
  text: z.string(),
  /** "user" means a headline someone typed, which a later produce must not
   * quietly overwrite with a fresh beat sheet's `coverText`. */
  textSource: z.enum(["beatsheet", "user"]),
  frame: z.object({
    /** Which video the still came from: the finished render or the source. */
    source: z.enum(["final", "source"]),
    timeSec: z.number(),
    /**
     * The load-bearing field. This is the COVER-CROP geometry — deliberately
     * NOT face.json's source-geometry measurement (see the `COVER_CROP_VF`
     * doc comment for why the two are different numbers). Without it nothing
     * can place the banner where the shipped cover placed it, and re-deriving
     * it costs an ffmpeg extraction plus a cascade sweep. That single fact is
     * what forced this whole file to exist.
     */
    face: CoverFaceSchema.nullable(),
    hasFace: z.boolean(),
    sharpness: z.number(),
    /** The still already on disk in the workdir (`cover-frame.png`) — a
     * text-only regeneration reuses it verbatim and runs no ffmpeg at all. */
    fileName: z.string(),
    /**
     * The ORIGINAL TAKE, and nothing else. Workdir-relative when the video
     * lives in the workdir (a folder run's `mezzanine.mp4`), absolute
     * otherwise: a workdir that moved must still resolve its own
     * intermediates.
     *
     * Nullable, and never overwritten by a regeneration (2026-08-19): this
     * field once recorded "whichever video the current frame was read from",
     * so one `ossclip cover` on its default `--from final` rewrote a
     * `mezzanine.mp4` here into the FINISHED render's path — after which
     * `--from source` silently re-cut the cover from the finished video,
     * burned-in captions, graphics and watermark included, while telling the
     * user it was reading the clean source. It also destroyed the only
     * on-disk record of where the take lives. `frame.source` already says
     * which video the current still came from, so this one has no second
     * job. Null means the take is genuinely unknown (a first regeneration off
     * the final video, with no prior provenance) — `--from source` then says
     * so instead of lying.
     */
    sourceVideo: z.string().nullable(),
    /** produce's `cropFilter(detection.uniform)`, and the SOURCE's — it is
     * meaningless against a final-video frame, so it travels with
     * `sourceVideo` under the same preserve-never-overwrite rule. Persisted
     * because it is NOT reconstructible from anything else on disk: the
     * letterbox detection that produced it is cached per source, and
     * re-picking a frame without it frames two-thirds baked-in black bar. */
    cropVf: z.string().nullable(),
  }),
  /** The OUTPUT frame the cover belongs to (R16 §76) — a landscape render
   * gets a landscape cover, and a rebuild must not revert to 1080×1920. */
  size: z.object({ width: z.number(), height: z.number() }),
  /** Absolute path of the written `.cover.jpg`. */
  out: z.string(),
});

export type CoverProvenance = z.infer<typeof CoverProvenanceSchema>;

/**
 * Read `<work>/cover.json`, or null when it is absent, corrupt, or fails the
 * schema. Never throws: a pre-feature workdir has no such file at all, and a
 * half-written one must degrade to "re-pick the frame" rather than brick the
 * command — the same GET-path posture as `readApprovedConcept`.
 */
export async function readCoverProvenance(work: string): Promise<CoverProvenance | null> {
  const path = join(work, COVER_PROVENANCE_BASENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = CoverProvenanceSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write `<work>/cover.json` atomically: tmp file, then rename.
 *
 * The editor and a `ossclip cover` run may read this at any moment, and a
 * half-written document would be worse than a stale one — the same reasoning
 * as the overrides save in edit.ts.
 */
export async function writeCoverProvenance(
  work: string,
  provenance: CoverProvenance,
): Promise<void> {
  const path = join(work, COVER_PROVENANCE_BASENAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(provenance, null, 2));
  await rename(tmp, path);
}
