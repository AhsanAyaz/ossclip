import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  LayoutSchema,
  SceneSchema,
  TimeMap,
  type KeptSpan,
  mapFromKeptSpans,
  TranscriptSchema,
  analyze,
  applyOverrides,
  applyRepairs,
  isParkedOverrideKey,
  parkedOverrideBaseKey,
  remapSceneOverrides,
  assembleScenes,
  buildCaptionLines,
  captionPackingFor,
  buildCutlist,
  canonicalizeDictionaryCasing,
  captionsNeedNastaliq,
  NASTALIQ_FONT_NAME,
  NASTALIQ_FONT_REL,
  nastaliqFontFile,
  buildZoomPlan,
  checkGrounding,
  rejectCtaKeyword,
  concatFolder,
  folderManifestKey,
  listFolderVideos,
  outInsideInputFolderMessage,
  outPathInsideInput,
  COVER_PROVENANCE_BASENAME,
  coverDecision,
  coverHeadline,
  coverInVideoWindow,
  COVER_IN_VIDEO_CAP_SEC,
  COVER_IN_VIDEO_FLOOR_SEC,
  readCoverProvenance,
  writeCoverProvenance,
  cropFilter,
  detectContentRect,
  letterboxedSeconds,
  type ContentRect,
  createFaceDetector,
  createProvider,
  createTieredProvider,
  defaultProviderName,
  fallbackProviderName,
  defaultTheme,
  detectSilences,
  dropHiddenCues,
  splitThenDropHidden,
  emptyOverrideDoc,
  extractAudio,
  encodeUploadAudio,
  REMOTE_UPLOAD_MAX_BYTES,
  createOpenAiCompatibleProvider,
  openaiTranscriptionsUrl,
  fillPlainCues,
  splitCues,
  landscapeLayout,
  formatCutReport,
  formatGraphicsAccounting,
  findBloopSpans,
  formatBloopSpan,
  findRetakeGroups,
  formatRetakeGroup,
  RESTART_PREFIX_CONFIDENCE,
  type RetakeGroup,
  formatUsageLine,
  formatUsageReport,
  formatYoutubeMarkdown,
  generateYoutubePack,
  stampedTranscript,
  YOUTUBE_APPROVED_BASENAME,
  YOUTUBE_PROMPT_VERSION,
  YoutubePackSchema,
  type YoutubePack,
  THUMBNAIL_APPROVED_BASENAME,
  THUMBNAIL_MODEL_DEFAULT,
  ThumbnailConceptApprovedSchema,
  ThumbnailConceptSchema,
  type ThumbnailConcept,
  type GenerateThumbnailImageOptions,
  approvedOverlayText,
  buildThumbnailPrompt,
  generateThumbnailConcept,
  generateThumbnailImage,
  portraitMimeType,
  thumbnailDecision,
  thumbnailImageCacheName,
  applyCleanupChoices,
  vetoedRemovals,
  dismissedRemovals,
  carveKeptTakes,
  resolveSplitPoints,
  resolveSrcTimingPins,
  applyUserCuts,
  pruneHidesInsideCuts,
  loadConfig,
  loudnorm,
  MAX_NORMALIZE_UPSCALE,
  MAX_MEAN_AREA_DISCARD,
  FACE_ONLY_MIN_FRAC,
  FACE_MIN_DETECTION_RATIO,
  ZOOM_MAX_SCALE,
  assessCueFraming,
  planNormalization,
  segmentIsFaceOnly,
  type WindowFace,
  type FaceBox,
  type FramingSegment,
  type NormalizePlan,
  makeMezzanine,
  mezzanineFileName,
  mezzanineScale,
  // The color-grade pipeline (2026-08-30): validation, the preset/LUT split,
  // the SVG filter spec preset grades ride render-props as, and the .cube
  // bake+hash LUT grades ride the mezzanine as.
  CONFIG_DIR,
  resolveColorGrade,
  resolveGradeToLook,
  gradeToSvgFilterSpec,
  parseCubeLut,
  bakeCube,
  lutHash,
  type ColorGrade,
  type SvgGradeFilterSpec,
  scaleContentTimeline,
  scaleFramingWindows,
  measureFace,
  measureFaceInWindows,
  pickCoverFrame,
  measureLevels,
  probe,
  produceScenes,
  PRODUCER_PROMPT_VERSION,
  type FramingContext,
  reclampPinnedTiming,
  reconcileCopy,
  repairTranscript,
  resolveTheme,
  run,
  runWhisper,
  whisperPromptFor,
  scanSourceText,
  ThemeSchema,
  type Theme,
  appendUsageRun,
  OverrideDocSchema,
  CLIP_SNAP_TOLERANCE,
  ClipWindowSchema,
  boundCutlistToWindow,
  formatClipTime,
  parseClipWindowPin,
  sliceRawTranscript,
  sliceRepairs,
  sliceTranscript,
  type Analysis,
  type AppliedRepair,
  type BeatSheet,
  BeatSheetSchema,
  type BeatsValidationIssue,
  type CleanupLevel,
  type ClipWindow,
  type Layout,
  type LlmEffort,
  type LlmProvider,
  type LlmUsage,
  AGY_PRINT_TIMEOUT,
  type Production,
  ossclipOutputPathFor,
  resolveOutputFrame,
  RESOLUTION_CHOICES,
  smallestSource,
  ResolutionChoiceSchema,
  // The --sfx path (2026-08-29): the library loader, the placement call, its
  // deterministic gate, and the resolver that turns word anchors into cues.
  loadSfxLibrary,
  sfxLibraryHash,
  // The `sfxBundledPack` config gate. It lives in core, not beside `resolveSfx`
  // below, because the edit server has to resolve it identically — its own
  // doc-comment has the reason.
  resolveSfxBundledPack,
  generateSfxPlan,
  resolveSfxCues,
  // Scene id → final start second, the scene-anchored placements' clock
  // (2026-08-29). Built from `sceneCues`, never from the raw plan.
  sceneStartSeconds,
  // The user's layer over that plan (Phase 3), and the schema the carried
  // forward plan is parsed back through.
  applySfxOverrides,
  ProductionSfxSchema,
  sfxStagedFile,
  formatSfxAccounting,
  SfxLevelSchema,
  SfxPlanSchema,
  SfxValidationIssueSchema,
  SFX_PROMPT_VERSION,
  type LoadedSfxSound,
  type SfxCue,
  type SfxLevel,
  type SfxPlacement,
  type SfxValidationIssue,
  type ProviderName,
  type ResolutionChoice,
  type Scene,
  type SceneComponentId,
  type Segment,
  type Transcript,
} from "@ossclip/core";
import { recordRecentProject } from "./edit";
import { binOnPath, detectionLine, fallbackLine } from "./llm-detect";
import {
  modelImpliedLanguage,
  modelUrl,
  validModelSources,
  whisperModelPath,
} from "./setup/manifest";
import { PhaseTimer, formatPhaseLine, type PhaseTimings } from "./phase-timing";
import {
  strandedOverrideSiblings,
  strandedPointerLine,
  workdirBaseName,
} from "./stranded-overrides";
import { editHint } from "./interactive/edit-hint";
import {
  COVER_FRAME_BASENAME,
  buildCoverRender,
  coverBannerText,
  coverTextHold,
  provenanceVideoPath,
} from "./cover";
import { artifactPath, ensureParentDir, expandHome, moveFile } from "./paths";
import { portraitOverridePath, resolvePortrait } from "./portrait-override";
import { approveThumbnailConcept, thumbnailRetryLoop } from "./interactive/thumbnail-approve";
import { isInteractive } from "./interactive/tty";
import { RenderTimelineHUD, StageAnimator, printProductionCompleteBanner } from "./ui/animation";
import { reconcileCaptionEdits } from "./caption-report";
import { overridesWriteLine, writeOverrideDoc } from "./overrides-write";
import { recordedProduceArgs } from "./replay-argv";
import { remoteWhisperHost, resolveWhisperBackend } from "./whisper-backend";
import { makeCancelSignal, renderCover, renderProduction } from "@ossclip/renderer";
import type { RenderPhase } from "@ossclip/renderer";
import {
  DEFAULT_FACE,
  coverTextRect,
  layoutSlots,
  regionsDuring,
  routeAroundSourceText,
} from "@ossclip/scenes/geometry";

/**
 * What a finished run tells its caller. The workdir is what the post-produce
 * editor offer opens; `rendered` is false for a --no-render run, which has
 * props but no video.
 */
export interface ProduceResult {
  workdir: string;
  out?: string;
  rendered: boolean;
  /**
   * Telemetry inputs (FINDINGS §134), surfaced here so the command layer can
   * build the event without produce() knowing telemetry exists. The duration
   * is only ever SENT as a bucket, and the provider is the resolved NAME —
   * never a key, never a path.
   */
  sourceDurationSec: number;
  sceneCount: number;
  /** Resolved provider name when the LLM ran; undefined without --produce. */
  llmProvider?: string;
  /**
   * Milliseconds per attributed phase (FINDINGS §140) — same contract as the
   * fields above: produce() surfaces the raw numbers, the command layer
   * buckets them before anything crosses the wire (`phaseBucketProps`). A
   * phase that never ran (cached transcript, --no-render) is absent, not 0.
   */
  phaseTimings: PhaseTimings;
}

/**
 * What produced the workdir's transcript.json — written beside it as
 * transcript-key.json (review fix, Urdu field test 2026-08-05). Parsed with
 * zod like the transcript itself: a hand-edited or truncated key must error,
 * not silently decide whether a cache is reused.
 */
export const TranscriptKeySchema = z.object({
  model: z.string(),
  language: z.string().optional(),
  /**
   * The dictionary the whisper `--prompt` was biased with (F4, 2026-08-16) —
   * a changed vocabulary changes what whisper decodes, so it re-keys the
   * cache exactly like the model does. Absent (old key files, no-dictionary
   * runs) means "no biasing".
   */
  dictionary: z.array(z.string()).optional(),
  /**
   * Whether whisper ran its TRANSLATE task (`-tr`, 2026-08-29). It changes
   * the decoded TEXT — Urdu speech comes back as English words — so it
   * re-keys the cache exactly like the language does, or a warm workdir
   * serves the Urdu-script transcript to a translate run. Absent (old key
   * files) means "no translation", the `dictionary` contract.
   */
  translate: z.boolean().optional(),
  /**
   * Which BACKEND decoded it (2026-09-01): `remote:<normalized endpoint>`, or
   * absent for local whisper.cpp — the `dictionary`/`translate` contract, so
   * every key file written before remote existed still reads as local. Two
   * engines on the same audio produce different words, so without this a warm
   * workdir serves the local transcript to a remote run (and vice versa) —
   * the exact staleness `language` and `translate` were added for. The
   * remote MODEL name rides in `model` above, so switching Groq models
   * re-keys through the existing field.
   */
  backend: z.string().optional(),
});
export type TranscriptKey = z.infer<typeof TranscriptKeySchema>;

/**
 * Whether the cached transcript answers the current request. Pure so all
 * four corners (matching key, differing key, keyless + default, keyless +
 * non-default) are testable without a workdir. A missing key means a workdir
 * from before the key existed; every one of those was transcribed with the
 * config-default model and no -l, so it is treated as exactly that — old
 * workdirs must not all re-transcribe spuriously, but a non-default request
 * against a keyless cache must.
 */
export function transcriptCacheReusable(
  recorded: TranscriptKey | null,
  requested: TranscriptKey,
  defaultModel: string,
): { reuse: boolean; recorded: TranscriptKey } {
  const effective = recorded ?? { model: defaultModel };
  return {
    reuse:
      effective.model === requested.model &&
      // "" and absent both mean whisper's en default — program.ts rejects an
      // empty code, but a key file predating that guard must not wedge.
      (effective.language ?? "") === (requested.language ?? "") &&
      // Absent and false are the same "no translation", so pre-flag key
      // files reuse under a non-translate request.
      (effective.translate ?? false) === (requested.translate ?? false) &&
      // Absent means LOCAL on both sides, so every pre-2026-09-01 key file
      // still reuses under a local request — and a remote request against
      // one of them re-transcribes, which is the point.
      (effective.backend ?? "") === (requested.backend ?? "") &&
      // ORDER-SENSITIVE by choice: the dictionary becomes whisper's --prompt
      // text verbatim, so a reordered list genuinely is a different decoder
      // input — treating it as equal would serve a transcript biased by a
      // prompt this run never sent. Absent and [] compare equal (both mean
      // "no biasing"), so pre-dictionary key files reuse under a
      // no-dictionary request.
      JSON.stringify(effective.dictionary ?? []) === JSON.stringify(requested.dictionary ?? []),
    recorded: effective,
  };
}

/**
 * The beat-sheet/scenes cache key: everything that changes the plan — which
 * prompt asked, who was asked, with what editorial steer, about which words,
 * in what frame. Pure and exported so the §78 posture ("a change that changes
 * the answer must change the key") is testable without a workdir.
 *
 * Two of these are new, and only one of them was a live bug:
 *  - `promptVersion` (the caller passes PRODUCER_PROMPT_VERSION) is the §78
 *    fix proper — before it, a warm workdir kept serving a sheet the OLD
 *    prompt wrote, exactly the failure YOUTUBE_PROMPT_VERSION exists for.
 *  - `aspect` is LATENT rather than active: it changes the user prompt (the
 *    LANDSCAPE block, R21 §101), but `--aspect 16:9` also derives its own
 *    `-16x9` workdir and this cache is a file inside it, so a portrait and a
 *    landscape plan of the same source cannot meet today. Keyed anyway —
 *    the collision is one workdir-naming change away, and the key should not
 *    depend on a different module's directory scheme to stay correct.
 */
export function beatSheetCacheKey(parts: {
  promptVersion: string;
  /** The primary on reads; on a §143 fallback WRITE, the provider that
   * actually answered — a plain name from the usage records. */
  providerName: string;
  llmModel?: string;
  /** The §143 effort knob — it steers the editorial call, so it changes the plan. */
  llmEffort?: LlmEffort;
  intent?: string;
  cleanup: CleanupLevel;
  forceComponent?: SceneComponentId;
  /** Framing constraints steer layout choice, so a re-measure must replan. */
  framing?: FramingContext;
  clipTargetSec?: number;
  clipWindow?: ClipWindow | null;
  /** The repaired transcript's TEXT — see the call site on why not the count. */
  words: readonly string[];
  aspect: "9:16" | "16:9";
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        parts.promptVersion,
        parts.providerName,
        parts.llmModel,
        parts.intent,
        parts.cleanup,
        parts.forceComponent ?? null,
        parts.framing ?? null,
        // §93f: the clip target and the RESOLVED window key the plan too —
        // without them a clip run and a full run of the same source would
        // collide and answer from each other's cache (the §78 failure
        // mode). Keyed POST-resolution so a replay that derives the same
        // window hits the same entries.
        parts.clipTargetSec ?? null,
        parts.clipWindow ? `${parts.clipWindow.startWord}:${parts.clipWindow.endWord}` : null,
        parts.words,
        parts.aspect,
        // The §143 effort knob — appended at the END, and only when SET: an
        // unconditional `?? null` would change the serialization of every
        // existing key and silently re-plan every warm workdir for users who
        // never touched the knob. §78 only demands that a DIFFERENT effort
        // miss; an unset one must keep hitting what it always hit.
        ...(parts.llmEffort !== undefined ? [parts.llmEffort] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}

/**
 * The beat-sheet cache keys to TRY, in priority order (§150).
 *
 * §143 split the cache: reads use the provider you asked for, writes file
 * under the one that actually answered. That is right for attribution and
 * wrong for re-runs — while agy keeps timing out, a run that asks for
 * antigravity reads a key nothing will ever write. It re-attempts, waits out
 * the whole print-timeout, falls back, and rewrites the key nobody reads.
 * Every re-render therefore re-plans, the plan differs each time, and editor
 * edits anchored to scenes the new plan no longer has are dropped — a
 * re-render silently rewriting an approved cut (2026-08-23: "edit for
 * scene-11 dropped — the plan no longer has that scene").
 *
 * So the read tries a second key, and exactly one: the provider THIS run
 * would fall back to anyway. Serving that sheet is not a substitution — it is
 * what this run would produce, without paying the timeout to rediscover it.
 * Anything looser (any provider's sheet, newest file wins) would hand a
 * claude-cli plan to someone who asked for gemini and got gemini.
 */
/**
 * The producer stamp already on disk, or undefined (§152).
 *
 * Read so a run that answered NOTHING can keep it. `production.json` is
 * rewritten on every produce, cached or not, and the stamp is rebuilt from
 * this run's usage records — which on a cached run are empty, so it fell
 * through to the provider we ASKED for and quietly overwrote a truthful
 * "antigravity → claude-cli" with "antigravity". Attribution belongs to the
 * run that produced the plan, and a cached run produced nothing.
 *
 * Tolerant on purpose: a missing, unreadable or stamp-less file all mean "no
 * prior attribution", which is the same answer a first run gives.
 */
export function existingProducerStamp(work: string): Production["producer"] | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as {
      producer?: Production["producer"];
    };
    return raw.producer;
  } catch {
    return undefined;
  }
}

/**
 * The `sfx` plan the workdir's LAST run wrote, or undefined (Phase 3).
 *
 * This is how a `--scenes` replay keeps its sound design. The editor's Render
 * pins the reviewed plan with `--scenes` and drops `--produce`
 * (render-replay-args.ts), so the run never reaches the placement call — and
 * the placement call is not what should decide, because the SCENES-REVIEWED
 * doctrine says a render started from the editor must reproduce what the user
 * reviewed. For SFX that reviewed state is exactly `production.json`'s plan
 * plus `overrides.json`'s edits on top of it: re-placing would hand the user a
 * different set of effects than the ones they just dragged, and skipping would
 * hand them silence.
 *
 * Tolerant like `existingProducerStamp` above — a missing, unreadable or
 * sfx-less file all mean "no prior sound design", which is what a first run
 * says too. Parsed through `ProductionSfxSchema`, never cast: production.json
 * is as hand-editable as anything else in the workdir, and a level of "MEME"
 * must not reach the report as a level.
 */
export function priorSfxPlan(work: string): { level: SfxLevel; placements: SfxPlacement[] } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as {
      sfx?: unknown;
    };
    if (raw.sfx === undefined) return undefined;
    const parsed = ProductionSfxSchema.safeParse(raw.sfx);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function beatCacheKeyCandidates(
  parts: Omit<Parameters<typeof beatSheetCacheKey>[0], "providerName">,
  providerName: string,
  fallbackName: string | undefined,
): string[] {
  const keys = [beatSheetCacheKey({ ...parts, providerName })];
  if (fallbackName && fallbackName !== providerName) {
    keys.push(beatSheetCacheKey({ ...parts, providerName: fallbackName }));
  }
  return keys;
}

/**
 * The clip-window cache key (`clipwindow-<hash>.json`), which answers a
 * different question — WHICH ~Ns of the take to keep (R19 §93) — but asks it
 * with the SAME producer prompt, via `produceScenes(…, clip: {…})`. So it
 * carries the same two fields `beatSheetCacheKey` gained, for the same
 * reasons:
 *  - `promptVersion`: without it, editing the producer prompt leaves every
 *    warm workdir serving a window that was resolved under the OLD prompt —
 *    the §78 failure mode, one call above where it was just fixed. The
 *    tradeoff is accepted deliberately: a version bump DOES throw away an
 *    already-resolved window and costs one LLM call to re-select it. That is
 *    the correct price. Planning a whole video against a window the current
 *    prompt would not have chosen is worse than an LLM call.
 *  - `aspect`: LATENT today, exactly as it is one function down — `--aspect
 *    16:9` derives its own `-16x9` workdir and this cache is a file inside
 *    it, so a portrait and a landscape selection of the same source cannot
 *    meet. Keyed anyway: the aspect reaches the prompt (both halves of it
 *    since the producerSystem change), and the key should not depend on a
 *    different module's directory scheme to stay correct.
 *
 * Deliberately NOT keyed, matching what the call site passes to the selection
 * call: cleanup, forced component and the clip window itself. The first two
 * do not reach this prompt, and the third is what it returns.
 */
export function clipWindowCacheKey(parts: {
  promptVersion: string;
  /** Same read/write split as `beatSheetCacheKey` (§143). */
  providerName: string;
  llmModel?: string;
  /** The §143 effort knob — the selection rides the same editorial call. */
  llmEffort?: LlmEffort;
  intent?: string;
  clipTargetSec: number;
  /** Framing constraints steer the selection call the same way (see above). */
  framing?: FramingContext;
  /** The repaired transcript's TEXT — the window is word-indexed into it. */
  words: readonly string[];
  aspect: "9:16" | "16:9";
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        parts.promptVersion,
        parts.providerName,
        parts.llmModel,
        parts.intent,
        parts.clipTargetSec,
        parts.framing ?? null,
        parts.words,
        parts.aspect,
        // Appended at the END, only when SET — beatSheetCacheKey's rule: an
        // unset effort must keep every existing key byte-identical.
        ...(parts.llmEffort !== undefined ? [parts.llmEffort] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}

/**
 * The provider that actually answered the call whose output is being cached
 * (2026-08-22, FINDINGS §143): after a timeout fallback the resolved
 * `providerName` names the provider that FAILED, and keying a cache write on
 * it would attribute the fallback's plan to a provider that never produced
 * it. Last matching record wins — retries and the fallback both append to the
 * usage log, so the last writer is the one whose answer survived. Pure and
 * exported so the attribution is testable without a workdir.
 */
export function actualProvider(
  usage: readonly LlmUsage[],
  schemaName: string,
  defaultName: string,
): string {
  for (let i = usage.length - 1; i >= 0; i--) {
    if (usage[i]!.schemaName === schemaName) return usage[i]!.provider;
  }
  return defaultName;
}

export interface ProduceOptions {
  out?: string;
  cleanup: CleanupLevel;
  transcript?: string;
  render: boolean;
  /**
   * This run is a `--review` (cut review step 1/3): `render` is already
   * false (reviewFlag resolved that in the action) and the editor opens on
   * the workdir afterwards. Produce only reads it to phrase the no-render
   * exit — "the editor is opening" instead of the `--no-render` skip line
   * plus an `ossclip edit` hint for an editor that is about to open itself.
   */
  review?: boolean;
  mezzanine: boolean;
  workdir?: string;
  inspect?: boolean;
  /** Override the measured silence threshold (dBFS). */
  noiseDb?: number;
  /** Hand-authored scenes JSON (Scene[]) — skips the LLM entirely. */
  scenes?: string;
  /** Run the producer brain to plan scenes. */
  produce?: boolean;
  intent?: string;
  provider?: ProviderName;
  llmModel?: string;
  /** Model for mechanical calls; "same" sends everything to the main model. */
  llmFastModel?: string;
  /**
   * `agy --effort` for the antigravity provider (§143). Already zod-parsed to
   * the union by program.ts — the CONFIG's `llmEffort` arrives separately, as
   * an unvalidated string, and `resolveLlmEffort` arbitrates.
   */
  llmEffort?: LlmEffort;
  /** Who is on camera — steers repair and exempts their name from grounding. */
  speaker?: string;
  /** Repair ASR mishearings before captions/producer/grounding (default on). */
  repair?: boolean;
  /** Override the whisper model for this run (A/B base.en vs small.en). */
  whisperModel?: string;
  /**
   * `-l` language code for whisper (e.g. "ur", "auto"). Unset keeps whisper's
   * English default — required for a non-English fine-tune, which otherwise
   * decodes garbage (Urdu field test 2026-08-05).
   */
  whisperLanguage?: string;
  /**
   * `--whisper-translate`: whisper's TRANSLATE task (`-tr`) — non-English
   * speech decoded straight to ENGLISH text. Distinct from
   * `whisperLanguage`, which says what is SPOKEN; the two are passed
   * together (whisper decodes better knowing the source language).
   */
  whisperTranslate?: boolean;
  /**
   * `--whisper-backend`, already zod-parsed to the union by program.ts
   * (2026-09-01 weak-CPU field report). Undefined means "not typed", which
   * is what lets a configured `whisperUrl` select remote — the flag is
   * mainly `local`, the per-run opt-out.
   */
  whisperBackend?: "local" | "remote";
  /**
   * Vocabulary terms for this run (`--dictionary`, F4 2026-08-16), already
   * split/trimmed by the action. Wholesale beats the config's `dictionary`
   * — typed-beats-config like the watermark, and never merged: a per-run
   * list is a deliberate substitution, not an addition.
   */
  dictionary?: string[];
  /** Debug: force every graphic moment to this component. */
  forceComponent?: SceneComponentId;
  /** Write a cover image beside the video (default on). */
  cover?: boolean;
  /** Explicit cover output path, overriding <out>.cover.jpg. */
  coverPath?: string;
  /**
   * `--cover-text-reset` — opt back into the GENERATED cover headline on a
   * workdir whose `cover.json` holds a user-typed one (`coverTextHold`).
   * Deleting `cover.json` does the same thing.
   */
  coverTextReset?: boolean;
  /** Treat the source as an already-edited reel with burned-in graphics. */
  sourceIsEdited?: boolean;
  /**
   * Spoken blooper marker (R27 §122) — `--blooper-marker blooper`. Saying it
   * on camera cuts the attempt it spoiled, back to that sentence's start.
   */
  blooperMarker?: string;
  /**
   * `--collapse-retakes` — legacy no-op (2026-08-16). Retake collapse (R27
   * §128) now runs automatically whenever `--blooper-marker` is given and
   * never otherwise (`inferredRetakesEnabled` quotes the user's rule). The
   * flag stays parseable so old command.json replays don't error; typing it
   * without a marker earns a notice instead of a silent ignore.
   */
  collapseRetakes?: boolean;
  /**
   * How the source meets the vertical frame. `cover` (default) crops it to
   * fill; `contain` shows the WHOLE frame inset against the backdrop, which is
   * the answer for a landscape take whose content matters beyond the speaker's
   * face.
   */
  sourceFit?: "cover" | "contain";
  /**
   * Output shape (R15). `9:16` is the vertical default every layout was tuned
   * for; `16:9` exports 1920×1080 for YouTube/desktop, where there is no
   * platform chrome to dodge and a landscape source needs no cropping at all.
   */
  aspect?: "9:16" | "16:9";
  /**
   * `--resolution <height>`: how big the output actually renders. `auto`
   * keeps what the source has (capped at 2160); an explicit height scales the
   * 1080-wide composition to it. Already validated by commander (or by
   * `ResolutionChoiceSchema` when it comes from the config), so this is a
   * choice, never a raw string. `resolveOutputFrame` owns the math and the
   * why; the value reaches THREE stages that would otherwise each pin 1080p:
   * the folder-concat target, the mezzanine, and the render's own scale.
   */
  resolution?: ResolutionChoice;
  /**
   * `--concurrency <n>`: how many browser tabs the render opens at once,
   * beating the config's `renderConcurrency` and the cpus-2 default
   * (`resolveRenderConcurrency`). Already validated by commander
   * (`concurrencyFlag`), so a number here is always a positive integer.
   */
  concurrency?: number;
  /**
   * `--clip <seconds>` (R19 §93): produce only the strongest ~N-second window
   * of a long take, chosen by the producer in the same editorial call as the
   * beat sheet. Requires `--produce`; a source already at or under the target
   * (+20% tolerance) is a no-op, not an error.
   */
  clip?: number;
  /**
   * `--clip-window <start:end>` (§93g): the RESOLVED window's word range,
   * recorded into `command.json` so the editor's Render replays the SAME
   * window with zero LLM calls. Written by clip runs; not for hand use.
   */
  clipWindow?: string;
  /**
   * `--no-zoom` (field complaint 2026-08-13): switches off BOTH automatic
   * camera-motion drivers — the idle push (zoom.ts) and EdlVideo's cut
   * punch-in — in one flag. The per-scene editor switch (`autoZoom`) already
   * existed, but the complaint was a whole take whose compounded motion
   * cropped the crown on a close-up, and per-scene relief for a global
   * problem is the wrong shape. `false` when typed; undefined means on.
   */
  zoom?: boolean;
  /**
   * `--watermark` / `--no-watermark` tri-state: true/false when TYPED,
   * undefined when not — undefined lets the config's `watermark` key supply
   * the default (`resolveWatermark`). Opt-in by design: the default is off
   * for everyone, because a forced watermark on an open-source tool reads as
   * a free-tier limitation; this is voluntary attribution.
   */
  watermark?: boolean;
  /**
   * `--cover-in-video` / `--no-cover-in-video` tri-state, the watermark's
   * contract verbatim: true/false when TYPED, undefined when not — undefined
   * lets the config's `coverInVideo` key supply the default
   * (`resolveCoverInVideo`). Default OFF: the overlay paints over the first
   * fraction of the hook, which only earns its place on the platforms that
   * ignore an uploaded cover.
   */
  coverInVideo?: boolean;
  /**
   * `--color-grade <look>` / `--no-color-grade` — the watermark's tri-state
   * carrying a VALUE: a string when typed (a preset id, or a `.cube`
   * filename — `colorGradeFlagValue` classifies by extension), `false` for a
   * typed --no-color-grade, undefined when neither so overrides.json and
   * then the config's `colorGrade` decide (`resolveProductionColorGrade`).
   * Deliberately unparsed in transit: validation warns-and-proceeds at the
   * use site, because a grade typo must cost the look, never the run.
   */
  colorGrade?: string | false;
  /**
   * `--youtube` / `--no-youtube` tri-state, the watermark's exact contract:
   * true/false when TYPED, undefined when not — undefined lets the config's
   * `youtube` key supply the default (`resolveYoutube`). One flag covers the
   * whole pack (SEO metadata + AI thumbnail) by user decision 2026-08-16.
   */
  youtube?: boolean;
  /**
   * `--portrait <path>`: the creator's portrait photo, the likeness
   * reference for the `--youtube` AI thumbnail. Typed-beats-config like the
   * dictionary; validated at USE (the thumbnail step), where an absent file
   * is a loud skip and the frame-grab cover stands.
   */
  portrait?: string;
  /**
   * `--audience <text>`: who watches the channel, steering BOTH the youtube
   * pack's titles/tags and the thumbnail concept. Typed-beats-config like
   * `--portrait`; the config's `audience` supplies the default, validated
   * with `typeof === "string"` at use.
   */
  audience?: string;
  /**
   * `--thumbnail-brief <text>`: the durable thumbnail steer, fed to the
   * concept call as a must-honor creator brief. Same typed-beats-config
   * contract as `audience` (config key `thumbnailBrief`).
   */
  thumbnailBrief?: string;
  /**
   * `--captions` / `--no-captions` tri-state: true/false when TYPED,
   * undefined when not. Unlike `watermark` above there is no config key —
   * undefined simply means the default, which is ON. Kept tri-state anyway
   * so command.json can pin the resolved flag state (`recordedProduceArgs`)
   * and a future config key or default change can never re-resolve an old
   * record differently.
   */
  captions?: boolean;
  /**
   * `--add-jump-cuts` / `--no-jump-cuts` tri-state: true/false when TYPED,
   * undefined when not ("auto", the default — punch, face-only). Resolved by
   * `resolveJumpCuts`; scope is the cut punch-in ONLY, narrower than `zoom`,
   * which kills every motion driver at once. Note `true` does NOT override
   * the face-only guard (`punchPlanFor` has the why) — it exists to beat a
   * future config-off, nothing else.
   */
  jumpCuts?: boolean;
  /**
   * `<input>` a DIRECTORY: order its clips before concatenating them into the
   * source produce runs on (folder-input-brief.md). `name` (default) is a
   * plain codepoint sort, matching `ls`; `mtime` is oldest-first. Ignored for
   * a file input.
   */
  sort?: "name" | "mtime";
  /**
   * `--sfx` (2026-08-29): place sound effects from the loaded pack on the
   * beats the producer planned. Tri-state like `watermark` — true/false when
   * TYPED, undefined when not, so the config's `sfx` key can supply the
   * default (`resolveSfx`). Requires a beat sheet, so it rides `--produce`;
   * without one the step says so and skips.
   */
  sfx?: boolean;
  /**
   * `--sfx-level`: how much sound design (`subtle | normal | meme`). Already
   * zod-parsed to the union by program.ts, which also folds the implication
   * (`sfxFlag`: a typed level turns `sfx` on); the CONFIG's `sfxLevel` arrives
   * separately as an unvalidated value and `resolveSfxLevel` arbitrates.
   */
  sfxLevel?: SfxLevel;
  /**
   * Whether `--sort` was TYPED, as opposed to commander filling in its
   * `"name"` default. `sort` alone can't tell those apart, and `--sort` does
   * nothing on a file input — final-review fix wave, cheap minor c: print a
   * notice instead of silently ignoring a flag the user explicitly reached
   * for.
   */
  sortExplicit?: boolean;
}

/**
 * The effective watermark switch: a TYPED flag always wins (so
 * `--no-watermark` beats a config-on), and only then does the config supply
 * the default. The config side is `=== true`, never truthiness — the value
 * comes from a hand-editable JSON file loadConfig doesn't zod-parse, and a
 * typo'd `"watermark": "no"` coercing a credit ON is exactly the
 * parse-don't-coerce failure CLAUDE.md forbids; for an opt-in credit, off is
 * the only safe reading of anything malformed. Pure so the whole
 * flag × config matrix is testable without a config file on disk.
 */
export function resolveWatermark(
  flag: boolean | undefined,
  configValue: boolean | undefined,
): boolean {
  return flag ?? configValue === true;
}

/**
 * The effective `--resolution` — `resolveWatermark`'s precedence verbatim: a
 * TYPED flag always wins, and only then does the config supply the default.
 *
 * The config side is ZOD-PARSED rather than trusted: `loadConfig` hands back
 * whatever the hand-editable JSON held, and an unparsed `"4k"` would reach
 * `Number("4k")` inside `resolveOutputFrame` as NaN and size the whole render
 * off it. A malformed value earns one warning naming the key and falls back
 * to 1080 — the value every existing run already produces, so a typo costs a
 * message rather than a surprise 4K render (CLAUDE.md: parse, never coerce).
 * Pure, so the flag × config matrix is testable without a config file.
 */
export function resolveResolution(
  flag: ResolutionChoice | undefined,
  configValue: unknown,
): ResolutionChoice {
  if (flag !== undefined) return flag;
  if (configValue === undefined) return "1080";
  const parsed = ResolutionChoiceSchema.safeParse(configValue);
  if (parsed.success) return parsed.data;
  console.log(
    `⚠ config resolution ignored — expected one of ${RESOLUTION_CHOICES.join(", ")}, using 1080`,
  );
  return "1080";
}

/**
 * The effective `--cover-in-video` switch — resolveWatermark's semantics
 * verbatim: a TYPED flag always wins (so `--no-cover-in-video` beats a
 * config-on), and only then does the config supply the default. The config
 * side is `=== true`, never truthiness: a hand-edited `"coverInVideo": "yes"`
 * must not coerce an overlay onto the first frames of every render
 * (parse-don't-coerce, CLAUDE.md). Pure, so the whole flag × config matrix is
 * testable without a config file on disk.
 */
export function resolveCoverInVideo(
  flag: boolean | undefined,
  configValue: boolean | undefined,
): boolean {
  return flag ?? configValue === true;
}

/**
 * `--color-grade`'s value classified into the ColorGradeSchema shape: a value
 * ending in `.cube` names a LUT file in `~/.ossclip/luts`, anything else
 * names a preset. Sniffed by extension rather than split into two flags
 * because the user already knows which they typed — `kodak.cube` cannot be a
 * preset id (presets never carry a dot) and a preset id cannot be a LUT
 * (`.cube` is the one format the parser reads), so the classification is
 * lossless. Case-insensitive on the extension: `KODAK.CUBE` is the same file
 * on the case-preserving filesystems the LUT dir lives on. Validation is NOT
 * here — the shape goes through `resolveColorGrade` like every other layer.
 */
export function colorGradeFlagValue(value: string): { preset?: string; lut?: string } {
  return value.toLowerCase().endsWith(".cube") ? { lut: value } : { preset: value };
}

/**
 * The effective color grade across all three surfaces — override > flag >
 * config, `resolveWatermark`'s typed-beats-config precedence grown one layer:
 * the overrides doc is the editor's per-project say, so it beats even a typed
 * flag (the `resolveSrcTimingPins` rationale — a per-project decision made in
 * the editor outranks a per-run flag, never merges with it). An explicit
 * `false` at a switching layer (`colorGrade: false` in the doc, or a typed
 * `--no-color-grade`) is OFF, not fall-through: "no grade" is a decision, and
 * letting a lower layer overrule it would make the disable impossible to
 * express.
 *
 * Every layer is validated through `resolveColorGrade`, and an INVALID layer
 * is ignored — warned about by name, then the NEXT layer applies (decision
 * 2026-08-30): the alternative, an invalid override going all the way to
 * "off", would let one stale editor write silently strip the config grade a
 * channel's whole look depends on. Warnings are RETURNED, not printed
 * (`resolveSfxLevel`'s shape), so the whole matrix is testable without a TTY.
 * `source` names the winning layer so the ▸ line can say where a grade came
 * from — the watermark's "(from config; --no-… overrides)" visibility rule.
 */
export function resolveProductionColorGrade(p: {
  override: ColorGrade | false | undefined;
  flag: string | false | undefined;
  config: unknown;
}): { grade?: ColorGrade; source?: "override" | "flag" | "config"; warnings: string[] } {
  const warnings: string[] = [];
  if (p.override === false) return { warnings };
  if (p.override !== undefined) {
    // Schema-valid already (OverrideDocSchema parsed the doc), but the
    // unknown-preset check lives in resolveColorGrade, not the schema — this
    // is the layer where a preset the editor knew and this build doesn't
    // falls through instead of failing the doc.
    const r = resolveColorGrade(p.override, "overrides.json");
    if (r.grade) return { grade: r.grade, source: "override", warnings };
    if (r.warning) warnings.push(r.warning);
  }
  if (p.flag === false) return { warnings };
  if (p.flag !== undefined) {
    const r = resolveColorGrade(colorGradeFlagValue(p.flag), "--color-grade");
    if (r.grade) return { grade: r.grade, source: "flag", warnings };
    if (r.warning) warnings.push(r.warning);
  }
  // "config", not "config colorGrade": resolveColorGrade's warning already
  // spells the key (`⚠ <source> colorGrade ignored — …`).
  const r = resolveColorGrade(p.config, "config");
  if (r.grade) return { grade: r.grade, source: "config", warnings };
  if (r.warning) warnings.push(r.warning);
  return { warnings };
}

/**
 * `--sfx-level` implies `--sfx`: typing a level is asking for sound effects,
 * and a run that quietly did nothing because the boolean was missing is the
 * worst possible reading of it. Returns the tri-state `--sfx` carries —
 * `undefined` when neither was typed, so the config's `sfx` key still gets its
 * turn (`resolveSfx`). Pure, so the implication is testable without commander,
 * the `jumpCutsFlag` posture.
 */
export function sfxFlag(
  sfx: boolean | undefined,
  sfxLevel: SfxLevel | undefined,
): boolean | undefined {
  return sfxLevel !== undefined ? true : sfx;
}

/**
 * The effective `--sfx` switch — `resolveCoverInVideo`'s semantics verbatim: a
 * TYPED flag wins, and only then does the config's `sfx` supply the default,
 * `=== true` rather than truthy so a hand-edited `"sfx": "yes"` cannot coerce
 * sound effects onto every render.
 */
export function resolveSfx(flag: boolean | undefined, configValue: unknown): boolean {
  return flag ?? configValue === true;
}

/**
 * The effective `--sfx-level`. `resolveLlmEffort`'s shape — the warning is
 * RETURNED, not printed, so the resolution stays pure — and its precedence: a
 * typed flag beats a config key, and a malformed config key costs a warning
 * and the default rather than a coerced level. The default matters: `meme`
 * unlocks the meme-tagged sounds, so a typo must never fall UP into it.
 */
export function resolveSfxLevel(
  flag: SfxLevel | undefined,
  configValue: unknown,
): { level: SfxLevel; warning?: string } {
  if (flag !== undefined) return { level: flag };
  if (configValue === undefined) return { level: "normal" };
  const parsed = SfxLevelSchema.safeParse(configValue);
  if (parsed.success) return { level: parsed.data };
  return {
    level: "normal",
    warning: `⚠ config sfxLevel ignored — expected ${SfxLevelSchema.options.join("|")}, using normal`,
  };
}

/**
 * What `sfx-<key>.json` holds: the normalized plan plus the accounting a
 * cached re-run would otherwise have to invent — `planned` is the count the
 * MODEL returned, which nothing on disk could re-derive, and `issues` are the
 * planning drops the report explains the shortfall with (the beat-sheet
 * cache's `graphics`/`issues` rule, §78).
 *
 * Parsed on read, never trusted: a workdir file is as hand-editable as
 * anything else here, and a mangled one must cost a re-plan, not a crash.
 */
const SfxPlanCacheSchema = SfxPlanSchema.extend({
  planned: z.number().int().nonnegative().default(0),
  issues: z.array(SfxValidationIssueSchema).default([]),
});

/**
 * The placement-plan cache key: everything that changes the PLAN — which
 * prompt asked, about which words, against which beat sheet, at what level,
 * over which library. The §78 posture the beat sheet's key carries, and pure
 * for the same reason: "a change that changes the answer must change the key"
 * has to be assertable without a workdir or an LLM.
 *
 * `beatKey` folds the whole beat-sheet key in (provider, model, intent,
 * framing, clip window…) rather than restating it: the graphics plan is IN the
 * placement prompt, so a re-plan of the beats is a different question about
 * the same words. `libraryHash` is pack METADATA only (`sfxLibraryHash`), so
 * dropping a user pack in `~/.ossclip/sfx` invalidates while re-encoding an
 * mp3 does not.
 */
export function sfxCacheKey(parts: {
  promptVersion: number;
  beatKey: string;
  level: SfxLevel;
  libraryHash: string;
  /** The repaired transcript's TEXT — the beat key's rule, for the same reason. */
  words: readonly string[];
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        parts.promptVersion,
        parts.beatKey,
        parts.level,
        parts.libraryHash,
        parts.words,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}

/**
 * Where the cover image lives right now, most-specific first — the EDITOR
 * panel's ladder (`currentCoverImage` in edit.ts), deliberately the same one:
 * the destination the last cover render used (`cover.json`'s `out`), else
 * this run's `<out>.cover.jpg`. Two surfaces disagreeing about which file IS
 * the project's cover is how the overlay would end up showing a stale image
 * the panel says was replaced.
 *
 * Pure — the caller owns the `existsSync` walk — so the ladder is assertable
 * without a workdir. Note what it CANNOT return: the cover this run is about
 * to write, which does not exist yet (produce renders the cover after the
 * video). See the staging site for why that is the intended behavior.
 */
export function coverInVideoCandidates(p: {
  provenanceOut?: string | null;
  outPath: string;
}): string[] {
  const out: string[] = [];
  if (p.provenanceOut) out.push(p.provenanceOut);
  out.push(artifactPath(p.outPath, ".cover.jpg"));
  return out;
}

/**
 * Fixed subfolder the staged cover overlay lands in, never the public dir's
 * root — `SIDE_IMAGE_SUBDIR`'s reasoning applied to a file produce names
 * itself: the public dir can BE the user's own input folder (a --no-mezzanine
 * file run), and a root-level `cover-in-video.jpg` would silently overwrite a
 * file of theirs that happened to share the name. Nothing else writes into
 * this subfolder, so a collision is impossible by construction.
 */
export const COVER_IN_VIDEO_SUBDIR = "cover-in-video";

/**
 * The staged overlay's SERVED name, from the cover image being copied. Keeps
 * the source's own extension (lowercased) so a `.png` cover is not served as
 * a `.jpg`, and stays POSIX-literal — never `path.join` — because this string
 * is a URL read back by `staticFile()` and the editor's `/media/` mount, both
 * of which split on `/` only (sideImageDestRel's Windows lesson).
 */
export function coverInVideoFileName(source: string): string {
  return `${COVER_IN_VIDEO_SUBDIR}/cover${extname(source).toLowerCase()}`;
}

/**
 * The effective `--youtube` switch — resolveWatermark's semantics verbatim:
 * a TYPED flag always wins (so `--no-youtube` beats a config-on), and only
 * then does the config supply the default. The config side is `=== true`,
 * never truthiness, for the same parse-don't-coerce reason: the value comes
 * from a hand-editable JSON file loadConfig doesn't zod-parse, and a typo'd
 * `"youtube": "no"` must not switch a metadata+thumbnail pipeline ON. Off is
 * the only safe reading of anything malformed for an opt-in extra. Pure so
 * the flag × config matrix is testable without a config file on disk.
 */
export function resolveYoutube(
  flag: boolean | undefined,
  configValue: boolean | undefined,
): boolean {
  return flag ?? configValue === true;
}

/**
 * The effective `--llm-effort` — reasoning effort for the antigravity
 * provider's `agy --effort` flag (§143: exposed after the hang incident;
 * untested at real scale whether it moves the hang, but the knob existed and
 * we passed nothing). A TYPED flag always wins, and it arrives already
 * zod-parsed by program.ts; only the config value is checked here — the
 * `dictionary` posture, since it comes from hand-editable JSON loadConfig
 * doesn't zod-parse: exactly low|medium|high, or one warning and agy's
 * default, never a coerced effort level. Pure so the flag × config matrix is
 * testable without a config file on disk.
 */
export function resolveLlmEffort(
  flag: LlmEffort | undefined,
  configValue: unknown,
): { effort?: LlmEffort; warning?: string } {
  // Typed-beats-config, and typed also beats a MALFORMED config: the user
  // asking for an effort on the command line gets it, not a warning about a
  // config key they did not touch this run.
  if (flag !== undefined) return { effort: flag };
  if (configValue === undefined) return {};
  if (configValue === "low" || configValue === "medium" || configValue === "high") {
    return { effort: configValue };
  }
  return { warning: "⚠ config llmEffort ignored — expected low|medium|high" };
}

/**
 * How many browser tabs the render runs in parallel (2026-08-17 render-speed
 * pass). Precedence: `--concurrency` beats the config's `renderConcurrency`
 * beats the cpus-2 default (floor 2). The default is cpus-2 because the
 * render is decode-bound — every tab waits on OffthreadVideo's ffmpeg extract
 * workers — so saturating all cores with tabs starves the very processes the
 * tabs block on.
 *
 * The flag exists because cpus-2 is a CPU guess with no memory term in it
 * (2026-08-19 field case): a 14-core / 36GB Mac resolved to 12 tabs on a
 * 1080×1920 source and Chrome died WHOLE, twelve in-flight frames at a time.
 * `offthreadVideoCacheSizeInBytes` bounds the cache side of that
 * (render-options.ts); this is the hatch for the tab side, typed per run
 * rather than edited into a config file mid-investigation.
 *
 * The flag arrives already validated by commander (`concurrencyFlag` in
 * program.ts rejects a non-positive/non-integer at the front door, §93a), so
 * only the config value is checked here — the `dictionary` posture, since it
 * comes from hand-editable JSON loadConfig doesn't zod-parse: a positive
 * integer, or one warning and the default, never a coerced tab count. Pure so
 * the flag × config × cpu matrix is testable without a config file or real
 * cpus().
 */
export function resolveRenderConcurrency(
  flagValue: number | undefined,
  configValue: unknown,
  cpuCount: number,
): { concurrency: number; warning?: string } {
  const fallback = Math.max(2, cpuCount - 2);
  // Typed-beats-config, and typed also beats a MALFORMED config: the user
  // asking for 4 tabs on the command line gets 4, not a warning about a
  // config key they did not touch this run.
  if (flagValue !== undefined) return { concurrency: flagValue };
  if (configValue === undefined) return { concurrency: fallback };
  if (typeof configValue === "number" && Number.isInteger(configValue) && configValue > 0) {
    return { concurrency: configValue };
  }
  return {
    concurrency: fallback,
    warning: "⚠ config renderConcurrency ignored — expected a positive integer",
  };
}

/** What a signal that interrupted the render phase costs the caller. */
export interface RenderCancellation {
  /** Partial render output to delete before exiting. */
  removePaths: string[];
  /** Shell convention: 128 + the signal's number (SIGINT 2, SIGTERM 15). */
  exitCode: number;
  message: string;
}

/**
 * The decision half of Ctrl-C-cancels-the-render (2026-08-19 field report:
 * "Cancelling rerendering doesn't work" — nothing in the CLI handled SIGINT,
 * and no cancelSignal reached Remotion, so the browser and its ffmpeg
 * children kept going after the process was told to stop). The signal wiring
 * itself is I/O and lives at the render call site; what to delete and what to
 * exit with is decided here so it can be tested without a real render.
 *
 * `rawPath` is the workdir's `render-raw.mp4`, which a finished run
 * loudnorms and only THEN moves to the user's --out — so a cancel never has
 * an output file to mistake for a finished render. The raw partial is deleted
 * anyway: it is a truncated mp4 sitting in the workdir under the name the
 * next run reads, and a stale one there is the kind of thing that gets picked
 * up by hand and mailed to someone.
 *
 * Non-zero exit, because a cancelled render did not produce the video the
 * caller asked for — but 130/143 rather than 1, so a script can tell a
 * deliberate stop from a failure (the same distinction the editor's
 * /api/render/cancel draws, R16 §60).
 */
export function renderCancellation(
  signal: "SIGINT" | "SIGTERM",
  rawPath: string,
): RenderCancellation {
  return {
    removePaths: [rawPath],
    exitCode: signal === "SIGINT" ? 130 : 143,
    message: "▸ cancelled — partial output discarded",
  };
}

/**
 * Where the run is when a signal lands, collapsed to the three cases that
 * behave differently. `RenderPhase`'s "bundling" and "selecting" both collapse
 * to "pre-render": neither takes a cancelSignal, so neither can be stopped
 * cooperatively. "post-render" is the window between `renderMedia` resolving
 * and the handlers coming off in the `finally`.
 */
export type RenderSignalPhase = "pre-render" | "rendering" | "post-render";

/** Map the renderer's phase report onto what a signal can do about it. */
export function renderSignalPhaseOf(phase: RenderPhase): RenderSignalPhase {
  return phase === "rendering" ? "rendering" : "pre-render";
}

/** What the SIGINT/SIGTERM handler should do about the signal it just got. */
export interface RenderSignalAction {
  /** Fire the Remotion cancel signal. Free, and only `renderMedia` listens. */
  cancel: boolean;
  /**
   * Tear down and `process.exit` from INSIDE the handler, because nothing
   * downstream is going to stop on its own.
   */
  exitNow: boolean;
  /** Printed above the cancellation message when the exit needs explaining. */
  note?: string;
}

/**
 * The decision half of "Ctrl-C must never be a no-op" (2026-08-19 review of
 * the cancel feature). Registering a SIGINT listener SUPPRESSES node's default
 * terminate, so the cancel feature as first written made Ctrl-C *worse* than
 * before it existed in every phase the cancelSignal does not reach:
 *
 *  - "pre-render" — `bundle()` and `selectComposition()` take no cancelSignal
 *    in @remotion/renderer 4.0.499 (verified against the installed types; see
 *    RenderPhase in @ossclip/renderer). A cold bundle is tens of seconds, and
 *    minutes when Chrome is downloaded on first run, and for all of it Ctrl-C
 *    did NOTHING while the terminal looked hung. The handler must exit itself.
 *    That can orphan the Chrome `selectComposition` opened — but a bare Ctrl-C
 *    before the cancel feature did exactly the same, so it is not a
 *    regression, and a terminal that ignores Ctrl-C is worse than a stray
 *    browser process.
 *  - "rendering" — the one phase that IS cooperative: fire the signal and let
 *    Remotion tear the browser and its ffmpeg children down.
 *  - "post-render" — HONORED, not ignored: the caller stops before mastering
 *    and discards the raw render (see the tail check at the render call site).
 *
 * SECOND SIGNAL ALWAYS EXITS, in every phase. If Remotion's teardown wedges,
 * the user's only remaining move must not be `kill -9` from another terminal.
 */
export function renderSignalAction(
  phase: RenderSignalPhase,
  signalCount: number,
): RenderSignalAction {
  if (signalCount >= 2) {
    return {
      cancel: true,
      exitNow: true,
      note: "▸ second signal — exiting without waiting for the render to shut down",
    };
  }
  if (phase === "pre-render") {
    return {
      cancel: true,
      exitNow: true,
      note:
        "▸ cancelled while preparing the render — that phase cannot be interrupted " +
        "cleanly, so stopping the process",
    };
  }
  return { cancel: true, exitNow: false };
}

// Moved to paths.ts (2026-08-17, editor thumbnail panel): the edit server
// derives `<out>.thumbnail.png` from command.json's recorded out and must not
// import this module — produce.ts imports edit.ts (recordRecentProject), so
// the reverse edge would be a cycle, and this module's import graph drags the
// whole renderer into a server that is deliberately dependency-free.
// Re-exported so existing importers (tests) keep their path.
export { artifactPath } from "./paths";

/**
 * `--dictionary "JSON, ossclip"` → `["JSON", "ossclip"]`. Comma-separated in
 * ONE value because a variadic option fights the optional positional
 * `[input]` (see program.ts); split/trim/drop-empties here so a trailing
 * comma or doubled space never becomes an empty term in the whisper prompt.
 * `undefined` in, `undefined` out — "not typed" must survive to let the
 * config supply the dictionary. Pure so the split matrix is testable without
 * commander.
 */
export function dictionaryFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Consumer-side validation for the config's `dictionary` key — the
 * `watermark` posture applied to an array: the value comes from a
 * hand-editable JSON file loadConfig doesn't zod-parse, so a non-array, a
 * number in the list, or a term that trims to nothing means the whole key is
 * ignored (`undefined`) and the call site prints one warning naming the
 * problem. All-or-nothing on purpose: silently keeping the salvageable half
 * of a typo'd list would bias whisper with a vocabulary the user never
 * reviewed. Pure so the matrix is testable without a config file on disk.
 */
export function validDictionary(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((t) => typeof t === "string" && t.trim().length > 0)) return undefined;
  return value.map((t: string) => t.trim());
}

/**
 * The effective whisper `-l` for a run — typed-beats-config precedence like
 * `--dictionary`, with a third rung under both: the curated model table's
 * implied language (`modelImpliedLanguage`), so `--whisper-model medium-urdu`
 * alone decodes Urdu instead of silently decoding English garbage (the Urdu
 * field test's exact first-run failure, 2026-08-05). The config side is
 * typeof+trim, never truthiness — `language` comes from a hand-editable JSON
 * file loadConfig doesn't zod-parse, and a malformed value earns one warning
 * and falls through, never a coerced `-l`. `source` rides along so the call
 * site can say where a non-flag language came from. Pure so the whole
 * flag × config × model matrix is testable without a config file on disk.
 */
export function resolveWhisperLanguage(
  flag: string | undefined,
  configValue: unknown,
  modelImplied: string | undefined,
): { language: string | undefined; source: "flag" | "config" | "model" | null; warning?: string } {
  if (flag !== undefined) return { language: flag, source: "flag" };
  const configOk = typeof configValue === "string" && configValue.trim().length > 0;
  const warning =
    configValue !== undefined && !configOk
      ? "⚠ config language ignored — expected a non-empty language code string"
      : undefined;
  if (configOk) return { language: (configValue as string).trim(), source: "config" };
  if (modelImplied !== undefined) return { language: modelImplied, source: "model", ...(warning ? { warning } : {}) };
  return { language: undefined, source: null, ...(warning ? { warning } : {}) };
}

/**
 * The BASE theme a run starts from: the config's `theme` merged over
 * `defaultTheme` (F6, 2026-08-16). Precedence overall is overrides.json >
 * config theme > defaultTheme — this helper builds the bottom two layers,
 * and it must feed BOTH `resolveTheme`'s base and props.baseTheme: the
 * editor re-applies overrides onto `baseTheme`, so a reset there must fall
 * back to the user's global colors, not to factory defaults.
 *
 * All-or-nothing: `ThemeSchema.partial().safeParse` — one malformed key (a
 * numeric `accent`, an unknown-shaped value) voids the WHOLE config theme
 * with a warning naming the issue, because half-applying a palette the
 * schema rejected would render colors the user never chose. The warning is
 * RETURNED, not printed — pure, so the precedence matrix is testable without
 * a config file or a captured console.
 */
export function configuredBaseTheme(cfgTheme: unknown): { theme: Theme; warning?: string } {
  if (cfgTheme === undefined) return { theme: defaultTheme };
  const parsed = ThemeSchema.partial().strict().safeParse(cfgTheme);
  if (!parsed.success) {
    return {
      theme: defaultTheme,
      warning:
        `⚠ config theme ignored — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
    };
  }
  // Re-parse the merge so zod's defaults fill anything the partial left out —
  // the same construction defaultTheme itself uses.
  return { theme: ThemeSchema.parse({ ...defaultTheme, ...parsed.data }) };
}

/**
 * The concept cache's filename: keyed on who is asked, with what steer,
 * about which words (the Y2 pack-key shape) — audience/brief/titleAngle are
 * steer, so a changed one regenerates. ONE function shared by thumbnailStep
 * and the pre-render approval step, so the approval's cache seed can never
 * drift from the file the step would write. Pure so the key's inputs are
 * pinned by a test.
 */
export function thumbnailConceptCacheName(parts: {
  providerName: string;
  llmModel?: string;
  intent?: string;
  hook?: string;
  audience?: string;
  brief?: string;
  titleAngle?: string;
  transcriptWords: readonly string[];
}): string {
  const key = createHash("sha1")
    .update(
      JSON.stringify([
        parts.providerName,
        parts.llmModel ?? "",
        parts.intent ?? "",
        parts.hook ?? "",
        parts.audience ?? "",
        parts.brief ?? "",
        parts.titleAngle ?? "",
        parts.transcriptWords,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return `thumbnail-concept-${key}.json`;
}

/**
 * The workdir's approved YouTube pack, or undefined. The Y2 block checks
 * this FIRST (editor SEO panel, 2026-08-17 — thumbnailStep's approval-file
 * contract applied to the pack): once the editor persisted an edited pack,
 * a cache lookup or a fresh LLM call would silently discard the user's
 * words. Exported so the honor/leniency matrix is testable with a temp dir.
 *
 * Read-side leniency, unlike thumbnailStep's hard `.parse`: a corrupt
 * decision file here warns and falls through to the generate path — the pack
 * is a sidecar on a render that must not die over it (§112), and the next
 * editor save atomically replaces the file anyway.
 */
export async function readApprovedYoutubePack(
  work: string,
  log: (line: string) => void = console.log,
): Promise<YoutubePack | undefined> {
  const path = join(work, YOUTUBE_APPROVED_BASENAME);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = YoutubePackSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (parsed.success) return parsed.data;
    log(`  ⚠ ${YOUTUBE_APPROVED_BASENAME} is not a valid pack — regenerating instead`);
  } catch {
    log(`  ⚠ ${YOUTUBE_APPROVED_BASENAME} is not valid JSON — regenerating instead`);
  }
  return undefined;
}

/** Everything the AI thumbnail step (Y3) needs, gathered for testability. */
export interface ThumbnailStepArgs {
  /** The resolved `--youtube` switch — off means the whole step is silent. */
  youtube: boolean;
  /** Resolved `--portrait` / config path; existence is checked HERE. */
  portraitPath: string | undefined;
  /** GEMINI_API_KEY — env-only, never config (env.ts secrets rule). */
  apiKey: string | undefined;
  /** The image model slug (config `thumbnailModel` or the default). */
  model: string;
  work: string;
  outPath: string;
  /** The run's text provider — the concept call rides it, tier editorial. */
  provider: LlmProvider | undefined;
  providerName: string;
  llmModel: string | undefined;
  intent: string | undefined;
  hook: string | undefined;
  /** Resolved `--audience` / config — who the channel is for. */
  audience?: string;
  /** Resolved `--thumbnail-brief` / config — the durable must-honor steer. */
  brief?: string;
  /**
   * The youtube pack's first title, when the pack generated before this step
   * — the thumbnail must tell the same story as the title it ships under.
   */
  titleAngle?: string;
  transcriptWords: readonly string[];
  /**
   * The image-generation seam, pickCoverFrame's `detectFace` shape: tests
   * inject a stub here and therefore never import @google/genai.
   */
  generate?: (opts: GenerateThumbnailImageOptions) => Promise<Uint8Array>;
  /** Phase-timing wrapper for the concept LLM call; identity by default. */
  time?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (line: string) => void;
}

/**
 * What a successful thumbnail step hands back — more than the path, because
 * the post-generation retry loop ("regenerate with a note", 2026-08-16
 * thumbnail UX) reuses the exact concept, cache file and portrait bytes this
 * step generated with. Re-deriving any of them in the loop would let the two
 * drift (a different cache key regenerating a file the loop then never
 * overwrites).
 */
export interface ThumbnailStepResult {
  /** The written `<out>.thumbnail.png`. */
  path: string;
  /** The concept the image was prompted with — unchanged across retries. */
  concept: ThumbnailConcept;
  /** The workdir image cache the retry loop overwrites in place. */
  imageCachePath: string;
  /** The portrait as the inlineData shape the generate seam takes. */
  portrait: { data: string; mimeType: string };
}

/**
 * The `--youtube` AI thumbnail orchestration (Y3, 2026-08-16): decide,
 * concept, image, copy beside the output. Extracted from `produce()` so the
 * cache/degrade matrix is testable with an injected `generate` and a temp
 * dir — no SDK, no network.
 *
 * Additive to the cover pipeline by contract: EVERY exit short of success is
 * one loud line and `undefined`, and the frame-grab cover stands. Returns
 * the written `<out>.thumbnail.png` path (plus the retry loop's inputs) on
 * success.
 */
export async function thumbnailStep(args: ThumbnailStepArgs): Promise<ThumbnailStepResult | undefined> {
  const {
    generate = generateThumbnailImage,
    time = <T>(fn: () => Promise<T>) => fn(),
    log = console.log,
  } = args;
  const portraitExists = args.portraitPath ? existsSync(args.portraitPath) : false;
  const decision = thumbnailDecision(
    args.youtube,
    args.portraitPath,
    args.apiKey !== undefined && args.apiKey !== "",
    portraitExists,
  );
  if (decision !== "generate") {
    // youtube-off is the one silent exit: the user never opted in, so there
    // is nothing to explain. Every other skip is a run the user configured
    // for a thumbnail and didn't get one — say why, once.
    if (decision !== "skip-no-youtube") {
      const reason =
        decision === "skip-no-portrait"
          ? "no portrait — set `portrait` in ~/.ossclip/config.json or pass --portrait"
          : decision === "skip-no-key"
            ? "GEMINI_API_KEY not set"
            : `portrait not found: ${args.portraitPath}`;
      log(`▸ thumbnail: skipped (${reason}) — frame-grab cover stands`);
    }
    return undefined;
  }
  // The pre-render approval file, checked FIRST (2026-08-16 thumbnail UX):
  // the user approved — or explicitly skipped — this exact concept before
  // the render, so asking a model again here would discard their edit. The
  // skip variant is a LOUD skip: unlike youtube-off, the user opted in and
  // then declined this one thumbnail, and the line says how to revisit.
  const approvedPath = join(args.work, THUMBNAIL_APPROVED_BASENAME);
  let approved: ThumbnailConcept | undefined;
  if (existsSync(approvedPath)) {
    const parsed = ThumbnailConceptApprovedSchema.parse(
      JSON.parse(await readFile(approvedPath, "utf8")),
    );
    if ("skip" in parsed) {
      log(
        `▸ thumbnail: skipped (declined at concept approval — delete ` +
          `${THUMBNAIL_APPROVED_BASENAME} in the workdir to revisit) — frame-grab cover stands`,
      );
      return undefined;
    }
    approved = parsed;
  }
  const mimeType = portraitMimeType(args.portraitPath!);
  if (!mimeType) {
    log(
      `▸ thumbnail: skipped (unsupported portrait format "${args.portraitPath}" — ` +
        "use png, jpg, jpeg or webp) — frame-grab cover stands",
    );
    return undefined;
  }
  let concept: ThumbnailConcept;
  if (approved) {
    // No concept call, no concept cache — the approved file IS the concept.
    concept = approved;
    log("▸ thumbnail: using the approved concept");
  } else {
    if (!args.provider) {
      // The concept call rides the run's text provider (Y2's exactly); the
      // IMAGE key alone cannot write the concept, so no provider means no
      // thumbnail — loud, because the youtube gate was on.
      log("▸ thumbnail: skipped (no LLM provider for the concept) — frame-grab cover stands");
      return undefined;
    }

    // Concept cache (thumbnailConceptCacheName has the key's rationale).
    // Failures are never cached (§106).
    const conceptCache = join(args.work, thumbnailConceptCacheName(args));
    if (existsSync(conceptCache)) {
      concept = ThumbnailConceptSchema.parse(JSON.parse(await readFile(conceptCache, "utf8")));
      log("▸ thumbnail: concept cached");
    } else {
      try {
        const fresh = await time(() =>
          generateThumbnailConcept(args.provider!, {
            hook: args.hook,
            intent: args.intent,
            audience: args.audience,
            brief: args.brief,
            titleAngle: args.titleAngle,
            transcriptText: args.transcriptWords.join(" "),
          }),
        );
        // The schema caps CHARACTERS; approvedOverlayText caps WORDS (§35 —
        // overlay text at thumbnail size has a cover banner's 4-9 word
        // ceiling). Capped BEFORE caching so the cache and the image key hold
        // what is used.
        concept = { ...fresh, overlayText: approvedOverlayText(fresh.overlayText) };
        // §143 read/write split, same as the plan and repair caches: the
        // concept call rides the editorial provider and can fall back, so the
        // file goes under whoever actually answered.
        await writeFile(
          join(
            args.work,
            thumbnailConceptCacheName({
              ...args,
              providerName: actualProvider(
                args.provider.usage,
                "thumbnail_concept",
                args.providerName,
              ),
            }),
          ),
          JSON.stringify(concept, null, 2),
        );
      } catch (err) {
        log(
          `▸ thumbnail: concept failed (${err instanceof Error ? err.message : String(err)}) ` +
            "— frame-grab cover stands",
        );
        return undefined;
      }
    }
  }

  // Image cache — thumbnailImageCacheName has the key's rationale, and it is
  // shared with the editor's regenerate endpoint so the two callers can never
  // cache past each other.
  const portraitBytes = await readFile(args.portraitPath!);
  const imageCache = join(
    args.work,
    thumbnailImageCacheName(
      args.model,
      concept,
      createHash("sha1").update(portraitBytes).digest("hex"),
    ),
  );
  if (existsSync(imageCache)) {
    log("▸ thumbnail: image cached");
  } else {
    try {
      const bytes = await generate({
        apiKey: args.apiKey!,
        model: args.model,
        prompt: buildThumbnailPrompt(concept, true),
        portrait: { data: portraitBytes.toString("base64"), mimeType },
      });
      await writeFile(imageCache, bytes);
    } catch (err) {
      // NEVER cache a failure (§106), never fail the produce that just
      // rendered. The message rides VERBATIM — the model slug is
      // user-specified, and an unknown-model rejection is deterministic, so
      // no retry and no paraphrase (§132 posture).
      log(
        `▸ thumbnail: generation failed (${err instanceof Error ? err.message : String(err)}) ` +
          "— frame-grab cover stands",
      );
      return undefined;
    }
  }
  const dest = artifactPath(args.outPath, ".thumbnail.png");
  await copyFile(imageCache, dest);
  log(`✓ thumbnail → ${dest}`);
  return {
    path: dest,
    concept,
    imageCachePath: imageCache,
    portrait: { data: portraitBytes.toString("base64"), mimeType },
  };
}

/**
 * Whether inferred retake collapse (findRetakeGroups, R27 §128) runs at all.
 * Gated on the blooper marker, NOT on `--collapse-retakes` — user decision,
 * verbatim (2026-08-16): "Bloopers and retakes go hand-in-hand. Do not do
 * retakes without bloopers... If blooper is there, we do it, else we don't."
 * A marker the speaker says out loud is the signal that this recording style
 * leaves flubs in the take; without it, inferred cutting has no such
 * license. `--collapse-retakes` stays parseable (old command.json replays)
 * but inert. Trim-empty counts as absent: findBloopSpans refuses a blank
 * marker for the same reason. Pure so the gate matrix is testable without a
 * run.
 */
export function inferredRetakesEnabled(blooperMarker: string | undefined): boolean {
  return typeof blooperMarker === "string" && blooperMarker.trim().length > 0;
}

/**
 * RetakeGroup cuts → `buildCutlist`'s `retakes` entries. The exact-prefix
 * restart rule carries RESTART_PREFIX_CONFIDENCE (0.85) instead of the 0.9
 * default a similarity-matched retake earns — the group's `rule` is the only
 * place that distinction lives, and it's dropped by the flatMap, so the
 * confidence has to be attached here. Pure so the mapping is testable
 * without a run.
 */
export function retakeCutsFor(
  groups: readonly RetakeGroup[],
): { startWord: number; endWord: number; startSec: number; endSec: number; confidence?: number }[] {
  return groups.flatMap((g) =>
    g.cuts.map((c) =>
      g.rule === "exact-prefix" ? { ...c, confidence: RESTART_PREFIX_CONFIDENCE } : c,
    ),
  );
}

/**
 * How much of the source a cover crop into `frame` keeps, and on which axis.
 * Cover scales the picture until BOTH frame axes are filled, then trims
 * whichever source axis overflows: a source wider than the frame loses width
 * (kept = frameAspect / contentAspect), a narrower one loses height (the
 * inverse). `null` means either nothing is trimmed (matching aspects) or a
 * dimension is degenerate and no claim can be made. Orientation-neutral on
 * purpose: the old call-site warning was gated on `!landscape`, assuming a
 * 16:9 output never meaningfully crops a 16:9-ish source — and the
 * 2026-08-16 incident was exactly that, a 1.547:1 screen recording in a 16:9
 * frame with 13% of the height silently gone (28% post-normalization) and no
 * line in the log ever mentioning it. Pure so the whole orientation matrix
 * is testable without probing a real video.
 */
export function coverKeepFraction(
  content: { width: number; height: number },
  frame: { width: number; height: number },
): { axis: "width" | "height"; kept: number } | null {
  if (content.width <= 0 || content.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  const contentAspect = content.width / content.height;
  const frameAspect = frame.width / frame.height;
  if (contentAspect > frameAspect) return { axis: "width", kept: frameAspect / contentAspect };
  if (contentAspect < frameAspect) return { axis: "height", kept: contentAspect / frameAspect };
  return null;
}

/**
 * What the whole-take face measurement says the frame's SUBJECT is — the
 * same rule `segmentIsFaceOnly` (core) applies per segment, here on the
 * global median box that feeds `face` in render-props. "screen" tells the
 * stage's cover bias to stay centered instead of chasing the face: in the
 * 2026-08-16 incident the global 9-sample median landed on the camera PiP
 * (sizeFrac 0.119, bottom-right) and pinned objectPosY to 1.0, cutting the
 * speaker's head off at the top of every full-frame stretch — a PiP-sized
 * face must not steer the cover. Accepts `measureFace`'s own return shape
 * (null = no face found at all), and reads null the way segmentIsFaceOnly
 * does: no face, one below FACE_ONLY_MIN_FRAC, or one seen in under
 * FACE_MIN_DETECTION_RATIO of the samples means the picture is the subject.
 * Pure so the classification matrix is testable without a video or the
 * detector.
 */
export function faceSubject(faceBox: FaceBox | null): "face" | "screen" {
  if (!faceBox) return "screen";
  if (faceBox.sizeFrac < FACE_ONLY_MIN_FRAC) return "screen";
  return faceBox.framesSampled > 0 &&
    faceBox.framesDetected / faceBox.framesSampled >= FACE_MIN_DETECTION_RATIO
    ? "face"
    : "screen";
}

/**
 * Reunites commander's two jump-cut keys into the one tri-state
 * `ProduceOptions.jumpCuts`. Unlike the watermark pair — one key, positive
 * declared first so the untyped default stays undefined — this pair's
 * positive is spelled `--add-jump-cuts` (bare "--jump-cuts" reads as adding
 * CUTS, not the zooms that conceal them), and commander only folds a
 * negative onto the key its exact positive spelling owns: `--no-jump-cuts`
 * alone creates `jumpCuts` defaulting TRUE, while `--add-jump-cuts` lands on
 * `addJumpCuts`. So "typed --no-jump-cuts" is indistinguishable from "not
 * typed" by value — the caller passes commander's getOptionValueSource
 * verdict instead. Both typed is a contradiction and must be a loud error,
 * never a precedence rule the user has to memorize. Pure so the whole
 * flag matrix is testable without commander in the loop.
 */
export function jumpCutsFlag(
  addJumpCuts: boolean | undefined,
  noJumpCutsTyped: boolean,
): boolean | undefined {
  if (addJumpCuts === true && noJumpCutsTyped) {
    throw new Error("--add-jump-cuts contradicts --no-jump-cuts — pass at most one");
  }
  if (addJumpCuts === true) return true;
  return noJumpCutsTyped ? false : undefined;
}

/**
 * The effective jump-cut punch mode from the tri-state flag. "auto" (not
 * typed) and "force" (--add-jump-cuts) punch identically TODAY — the split
 * exists so a future config key can turn the default off while a typed
 * --add-jump-cuts still beats it, resolveWatermark's flag-beats-config
 * precedence declared before the config side even exists. Pure so the
 * matrix is testable without a flag parse.
 */
export type JumpCutsMode = "off" | "auto" | "force";

export function resolveJumpCuts(flag: boolean | undefined): JumpCutsMode {
  if (flag === true) return "force";
  if (flag === false) return "off";
  return "auto";
}

/**
 * Resolves `--review` against the two flags it overlaps: produce without
 * rendering, then open the editor to review the cut — so the ONE render
 * happens from the editor's Render button, not before the user could look.
 *
 * `--review --no-render` is agreement, not a contradiction — both point the
 * same way (don't render here), unlike the jump-cuts pair — so it resolves
 * silently. `--review --no-open-editor` IS the contradiction (reviewing is
 * opening the editor) and follows jumpCutsFlag's rule: a loud error, never a
 * precedence the user has to memorize. Without --review everything passes
 * through untouched, tri-states included. Pure so the whole matrix is
 * assertable without commander or a TTY.
 */
export function reviewFlag(
  review: boolean,
  render: boolean,
  openEditor: boolean | undefined,
): { render: boolean; openEditor: boolean | undefined } {
  if (!review) return { render, openEditor };
  if (openEditor === false) {
    throw new Error("--review contradicts --no-open-editor — reviewing means opening the editor");
  }
  return { render: false, openEditor: true };
}

/**
 * The one loud line for cleanup vetoes actually changing this run's cut (cut
 * review step 3) — the `▸ N user cut(s) removed …` voice, inverted: per
 * declined reason, how many removals came back and how much source time they
 * restore. Pure so the whole phrasing is assertable without running produce;
 * callers only print it when `vetoed` is non-empty (a silent no-change run
 * must stay silent, like the user-cut line's own `cuts.length > 0` gate).
 */
export function cleanupChoicesLine(vetoed: readonly Segment[], outputDuration: number): string {
  const byReason = new Map<string, { count: number; sec: number }>();
  for (const seg of vetoed) {
    const key = seg.reason ?? "unlabeled";
    const entry = byReason.get(key) ?? { count: 0, sec: 0 };
    entry.count += 1;
    entry.sec += seg.srcOut - seg.srcIn;
    byReason.set(key, entry);
  }
  const parts = [...byReason.entries()].map(
    ([reason, { count, sec }]) => `${count} ${reason} removal(s) (+${sec.toFixed(1)}s)`,
  );
  return `▸ cleanup choices kept ${parts.join(", ")} — ${outputDuration.toFixed(1)}s output`;
}

/**
 * The punch scale for spans the plan allows — ~1.5%, replacing the legacy 7%
 * (user decision 2026-08-16, "minimal, ~1%"): the 1.07 punch visibly SLID
 * screen content sideways at every cut on the incident's screen recording,
 * and even on a talking head a 7% lurch reads as the camera stumbling. Big
 * enough to break up the jump, small enough to pass as sensor noise.
 */
/**
 * How long a silent antigravity call runs before the spinner admits it (§149).
 * Well clear of the 17-46s a healthy call takes, so a normal run never shows
 * the notice, and well short of AGY_PRINT_TIMEOUT, so it lands while the wait
 * still has somewhere to go.
 */
export const AGY_SLOW_NOTICE_MS = 30_000;

export const FACE_PUNCH_SCALE = 1.015;

/**
 * The framing subject at a SOURCE time — which of the plan's segments owns
 * `srcSec`, with the same edge clamping as scenes' `framingWindowAtOutput`:
 * a time before the first segment reads as the first, after the last as the
 * last, so a span whose in-point rounds a hair past a boundary still gets a
 * segment's verdict rather than a hole. An empty timeline reads as "screen"
 * — no punch — because with no plan there is no evidence the frame is just
 * a face, and the guard's failure mode (sliding a screen share) is the
 * worse of the two. Pure so the lookup is testable against a fixture.
 */
export function framingSubjectAt(
  timeline: readonly FramingSegment[],
  srcSec: number,
): "face" | "screen" {
  if (timeline.length === 0) return "screen";
  if (srcSec < timeline[0]!.startSec) return timeline[0]!.subject;
  for (const seg of timeline) {
    if (srcSec >= seg.startSec && srcSec < seg.endSec) return seg.subject;
  }
  return timeline[timeline.length - 1]!.subject;
}

/**
 * The per-span jump-cut punch plan `render-props.punch` carries. THE
 * FACE-ONLY GUARD HOLDS IN EVERY MODE, "force" included: punching a screen
 * share slides its content — text visibly drifting is WORSE than the jump
 * the punch would conceal — so `--add-jump-cuts` overrides a (future)
 * config-off, never the guard. `spanIsFaceOnly` comes per span from the
 * framing timeline's subject at the span's source in-point, or from the
 * global `faceSubject` verdict when no plan exists. Mode "off" still emits
 * a full all-false mask rather than nothing: an ABSENT `punch` key is the
 * legacy 1.07-everywhere contract, the opposite of off. Pure so the
 * mode × subject matrix is testable without a produce run.
 */
export function punchPlanFor(
  spans: readonly KeptSpan[],
  mode: JumpCutsMode,
  spanIsFaceOnly: readonly boolean[],
): { scale: number; allowed: boolean[] } {
  if (mode === "off") return { scale: 1, allowed: spans.map(() => false) };
  return {
    scale: FACE_PUNCH_SCALE,
    allowed: spans.map((_, i) => spanIsFaceOnly[i] === true),
  };
}

/**
 * One face-only verdict per kept span, read where that span BEGINS — the
 * frame at the cut is what any motion driver scales. With a framing plan the
 * verdict is the plan's per-segment subject at the span's source in-point;
 * without one every span shares the global `faceSubject` verdict. Hoisted to
 * ONE mask because TWO motion drivers consume it — the jump-cut punch
 * (`punchPlanFor.allowed`) and the idle zoom (`buildZoomPlan.allowedClips`,
 * user decision 2026-08-16: "Face-only. If there's anything else, then no
 * zoom" — the idle push visibly SLID screen-recording content) — and they
 * must never disagree about who the subject is: a span the punch holds still
 * but the idle zoom pushes would slide the very content the guard exists to
 * protect. Pure so the timeline × subject matrix is testable without a
 * produce run.
 */
export function spanFaceMask(
  spans: readonly KeptSpan[],
  framingTimeline: readonly FramingSegment[] | null,
  globalSubject: "face" | "screen",
): boolean[] {
  return spans.map(
    (sp) =>
      (framingTimeline ? framingSubjectAt(framingTimeline, sp.srcIn) : globalSubject) === "face",
  );
}

/**
 * The measurement windows for a MEASURED per-span mask — each kept span's
 * SOURCE range over the full frame (`cropVf: ""`, the shape
 * `measureFaceInWindows` takes). This path only runs when no framing plan
 * exists, i.e. the content rects are uniform, so there is no per-segment
 * rect to crop to first. Pure so the span→window mapping is testable
 * without ffmpeg.
 */
export function spanFaceWindows(
  spans: readonly KeptSpan[],
): Array<{ startSec: number; endSec: number; cropVf: string }> {
  return spans.map((sp) => ({ startSec: sp.srcIn, endSec: sp.srcOut, cropVf: "" }));
}

/**
 * `spanFaceMask`'s sibling for the no-plan path, from MEASURED faces
 * (2026-08-16 v2 review): a screen recording with full-frame webcam
 * stretches has uniform content rects, so no framing plan exists and the
 * old fallback let the GLOBAL `faceSubject` verdict — "screen", because the
 * whole-take median landed on the 0.119 PiP — speak for every span. The
 * face-only stretches therefore got no punch concealment (raw jump cuts
 * visible on the face) and no idle zoom. With no plan to supply subjects,
 * the mask must be measured per span; the verdict rule is core's own
 * `segmentIsFaceOnly`, the same one the framing plan applies per segment.
 * `faces` is parallel to the spans that produced the windows. Pure so the
 * wiring is testable without spawning ffmpeg.
 */
export function spanFaceMaskFromFaces(faces: ReadonlyArray<WindowFace | null>): boolean[] {
  return faces.map((f) => segmentIsFaceOnly(f));
}

/**
 * Cache key for the measured per-span mask: the spans' SOURCE ranges plus
 * the source content hash. `measureFaceInWindows` itself does not cache
 * (its other caller feeds a bake output that is cached downstream), and a
 * ~55-span take is a few hundred single-frame ffmpeg spawns — too much to
 * repeat on every warm re-run. Keyed on source ranges so a re-cut
 * re-measures, and on the source identity so a same-shape cut of a
 * different take cannot borrow verdicts. Pure so the key's inputs are
 * pinned by a test.
 */
export function spanFaceCacheKey(spans: readonly KeptSpan[], sourceHash: string): string {
  return createHash("sha1")
    .update(JSON.stringify([sourceHash, spans.map((sp) => [sp.srcIn, sp.srcOut])]))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Whether captions are hidden this run: the flag saying OFF, or the editor's
 * doc-global `captionsHidden` override saying hidden. An OR, deliberately
 * NOT resolveWatermark's flag-beats-config precedence: the override is the
 * user's own saved edit, not a machine-supplied default a typed flag should
 * outrank — un-hiding belongs to the editor that wrote the override, so a
 * typed `--captions` cannot force captions back on over it. Strict
 * `=== false`/`=== true` on both sides: the override arrives zod-parsed,
 * but the flag is a tri-state where undefined means "not typed" — and
 * captions defaulting ON means anything short of an explicit off must read
 * as visible. Pure so the whole flag × override matrix is testable without
 * a workdir or an overrides.json on disk.
 */
export function resolveCaptionsHidden(
  flag: boolean | undefined,
  overrideHidden: boolean | undefined,
): boolean {
  return flag === false || overrideHidden === true;
}

/**
 * Caption packing per orientation (2026-08-16 v2 review, user screenshot:
 * "we can actually even have more letters at a time on the screen").
 * Landscape draws captions at 44px on a 1920px frame against portrait's
 * 64px on 1080px (`captionFontSizeFor`) — roughly 2.6× the horizontal text
 * budget (1920/44 ≈ 44 character-widths vs 1080/64 ≈ 17) — so the portrait
 * default's 3-word lines look sparse there; landscape packs 6 words over
 * 2.4s, double the core defaults. Portrait returns those defaults VERBATIM
 * — stated explicitly at the call site rather than changed in captions.ts,
 * because the core defaults are portrait's contract and its output must
 * stay byte-identical. Pure so the matrix is testable without a produce
 * run.
 */
// Moved to core (captions.ts) so the editor's live caption rebuild packs
// with the SAME matrix (cut-review rework follow-up: captions over revived
// material). Re-exported here so existing imports and tests keep working.
export { captionPackingFor } from "@ossclip/core";

function sha1File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha1");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

/**
 * Byte-for-byte comparison, used only to decide `planScreenshotSrcCopy`'s
 * `identical` input for a same-basename `side-images/` collision. Side
 * images are screenshots, not multi-gigabyte video — a size check plus a
 * full read is simpler and strictly more correct than hashing (no collision
 * risk to reason about) at a cost this call site never notices. IO glue,
 * kept out of the pure decision function on purpose.
 */
function filesIdentical(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Where a run's cache/work directory lives, keyed off `identity` — the input
 * file for an ordinary run, or the FOLDER itself for `produce <folder>`
 * (folder-input-brief.md: hashing is the caller's job because the two cases
 * hash different things — a file's bytes vs. a folder's path — this only
 * places the result). `--workdir` overrides the root; the identity's own
 * basename still names the subfolder so two different inputs sharing one
 * `--workdir` don't collide.
 */
function deriveWorkdir(
  identity: string,
  hash: string,
  workdirOpt: string | undefined,
  landscape: boolean,
): string {
  const workRoot = workdirOpt ? resolve(workdirOpt) : join(dirname(identity), ".ossclip");
  // The basename half is shared with the §131 stranded-edits scan so the
  // scan's matching can never drift from the naming it scans for.
  return join(workRoot, `${workdirBaseName(identity)}-${hash}${landscape ? "-16x9" : ""}`);
}

/**
 * Default output path when `--out` is not given. MUST be derived from the
 * ORIGINAL input the user typed, never from `input` after a folder run
 * reassigns it — review fix on the first cut of folder-input-brief.md: `input`
 * by render time is `<workdir>/source-concat.mp4`, so deriving the default
 * from it put `ossclip produce ~/Downloads/MyClips`'s output INSIDE the
 * hidden `.ossclip` workdir (`.../MyClips-<hash>/source-concat.ossclip.mp4`)
 * instead of beside the folder (`~/Downloads/MyClips.ossclip.mp4`), where a
 * file input's equivalent default already lands.
 */
export function defaultOutPath(originalInput: string): string {
  // Delegates to core so the refusal message's suggestion and the actual
  // default can never drift apart (and both strip the tab-completed trailing
  // slash — the 2026-08-18 hidden-dotfile-inside-the-folder field case).
  return ossclipOutputPathFor(originalInput);
}

/**
 * The ⚠ line a REPLAYED produce prints when it keys to a different workdir
 * than the one the editor launched it for (2026-08-18 field cascade, part
 * 3): the edit server sets OSSCLIP_REPLAY_WORKDIR to the workdir whose
 * command.json it is replaying; if the run then derives another workdir —
 * the folder's content changed since the record — the edits saved in the
 * old workdir's overrides.json silently stop applying, and nothing else in
 * the run says so. Pure (drift decision in, line out) so the comparison is
 * testable without spawning a replay; null when this isn't a replay or
 * nothing drifted.
 */
export function replayWorkdirWarning(
  replayedWorkdir: string | undefined,
  derivedWorkdir: string,
): string | null {
  if (replayedWorkdir === undefined || replayedWorkdir === "") return null;
  if (resolve(replayedWorkdir) === resolve(derivedWorkdir)) return null;
  return (
    `⚠ this run's workdir differs from the one the editor replayed — edits ` +
    `saved in ${join(replayedWorkdir, "overrides.json")} will NOT apply to ` +
    `this render (the input's content changed since that command was recorded)`
  );
}

/**
 * Which directory the Remotion render will bundle its `publicDir` from,
 * given the SAME `mezzanineWillBuild` boolean `produce()` computes once and
 * feeds to the real `renderVideo` assignment further down — passed in,
 * rather than recomputed here, so the two can never read a different answer
 * to "will a mezzanine get built" than each other.
 *
 * Finding 3 (final-review fix wave): `dirname(renderVideo)` is where
 * Remotion's `staticFile()` looks; a side-image accepted from some OTHER
 * directory (a folder run's clips folder, or — the reviewer's pre-existing
 * "latent" case — a file run's own folder once a mezzanine gets built)
 * passes the accept check and then 404s inside the render, after the run has
 * already spent the minutes getting there. The framing bake was the one path
 * that ever analysed a file other than `input` (always written into `work`);
 * since framing became render-props (2026-08-16) the caller passes
 * `inputIsAnalysisInput: true`, and the parameter survives as the contract —
 * any future non-input analysis file must live in `work` — with the
 * mezzanine build as the remaining path into `work`.
 */
export function planRenderPublicDir(p: {
  input: string;
  inputIsAnalysisInput: boolean;
  mezzanineWillBuild: boolean;
  work: string;
}): string {
  return !p.inputIsAnalysisInput || p.mezzanineWillBuild ? p.work : dirname(p.input);
}

/** Fixed subfolder every copied side-image lands in — see `planScreenshotSrcCopy`. */
export const SIDE_IMAGE_SUBDIR = "side-images";

/**
 * An http(s) URL `src` is ScreenshotFrame's own documented territory — the
 * component resolves `/^https?:\/\//` itself instead of calling
 * `staticFile()` (ScreenshotFrame.tsx) — so produce must pass it through
 * untouched: no filesystem lookup, no copy, no rewrite (audit fix: the
 * safe-src check used to reject a URL as "names a path, not a bare filename",
 * a misleading message about a shape the renderer explicitly supports).
 */
export function isRemoteScreenshotSrc(src: string): boolean {
  return /^https?:\/\//.test(src);
}

/** A bare filename: no separator of either flavor, and not a `.`/`..` segment. */
function isBareSafeName(name: string): boolean {
  return name.length > 0 && !/[\\/]/.test(name) && name !== "." && name !== "..";
}

/**
 * Whether an LLM-authored `ScreenshotFrame` `src` is safe to let drive
 * filesystem access AT ALL. Checked BEFORE the accept-list lookup, not just
 * before the copy — a crafted `src` could otherwise use `existsSync` itself
 * as a path-existence oracle. `src` is unconstrained free text the producer
 * invents from the transcript (R22 §112's comment on `ScreenshotFrameProps.
 * src` — "will happily invent... from the transcript"); a value containing a
 * path separator or a bare `.`/`..` segment is refused outright, never
 * sanitized down to a bare name and used anyway (CLAUDE.md: values from
 * outside are parsed, not coerced — a stripped `../../etc/passwd` silently
 * becoming `passwd` is exactly the kind of "looks handled" bug that rule
 * exists to prevent).
 *
 * ONE exception, and it is exactly one shape: `<SIDE_IMAGE_SUBDIR>/<bare
 * safe name>` — the self-namespaced form `produce()` itself writes back into
 * `production.json` post-copy (`planScreenshotSrcCopy`'s `destRel`).
 * `--scenes <path>` re-ingests a PRIOR run's scenes array as the documented
 * no-LLM tweak workflow (program.ts: "hand-authored scenes JSON — no LLM in
 * the loop"), and that array can legitimately already contain this exact
 * shape from the run it came from. Refusing it here would drop the image to
 * a placeholder on every `--scenes` re-run of a previously-produced project
 * — a regression this fix must not introduce while closing the traversal
 * hole. This is NOT a general "one slash is fine" rule: `side-images/../x`,
 * `side-images/a/b.png`, and `other/foo.png` all still fail below, since
 * only a first segment matching the fixed subfolder AND a bare name after
 * it qualifies.
 *
 * Deliberately NOT enforced as a zod `.refine` on `ScreenshotFrameProps.src`
 * itself: the schema has no notion of "this run's own accepted output," so
 * it can't distinguish the one safe slash-shape from every unsafe one
 * without duplicating this exact logic — and getting it wrong there would
 * reject produce's own accepted output on every future parse (the editor
 * re-parses `production.json` through this same schema). The boundary that
 * needs to refuse the LLM's raw guess (and allow its own prior output back
 * in) is produce()'s, not the schema's.
 */
export function isSafeScreenshotSrc(src: string): boolean {
  if (isBareSafeName(src)) return true;
  const parts = src.split("/");
  return parts.length === 2 && parts[0] === SIDE_IMAGE_SUBDIR && isBareSafeName(parts[1]!);
}

/**
 * What to do with an accepted side-image that has to leave `foundDir` and
 * land in the render's public dir. Landing inside a FIXED `side-images/`
 * subfolder (`SIDE_IMAGE_SUBDIR`, never the public dir's root) makes a
 * collision with a reserved pipeline filename (`mezzanine.mp4`,
 * `source-concat.mp4`, …) impossible BY CONSTRUCTION — those artifacts never
 * live in that subfolder — rather than something this function has to
 * detect. Important finding (final-review fix wave, second pass on Finding 3):
 * the original copy wrote straight to `join(publicDir, src)`, so a `src`
 * equal to `mezzanine.mp4` silently overwrote the real mezzanine BEFORE its
 * own `existsSync` guard ran, skipping the build and feeding a still image
 * to the renderer as `renderVideo`; on a folder run with mezzanine off, the
 * equivalent collision (`source-concat.mp4`) corrupted the actual analyzed
 * source for the run and every cache reuse after it. What namespacing
 * doesn't resolve on its own: whether the (now collision-free) destination
 * is free, already holds the identical bytes (a re-run, or two scenes
 * sharing one image — skip the redundant copy, still point `src` at it), or
 * holds something else under that name (two different images that happen to
 * share a basename — refuse rather than let the second clobber the first).
 */
export function planScreenshotSrcCopy(dest: {
  exists: boolean;
  identical: boolean;
}): "copy" | "skip-identical" | "conflict" {
  if (!dest.exists) return "copy";
  return dest.identical ? "skip-identical" : "conflict";
}

/**
 * The served relative URL a copied side-image is rewritten to. MUST be
 * POSIX-literal — never `path.join()` — because this string is a SERVED
 * URL, not a filesystem path: it gets written into `holder.props.src` and
 * read back by Remotion's `staticFile()`, which splits ONLY on `/`
 * (`static-file.js`: `path.split('/')`). `path.join()` uses the platform
 * separator, so on Windows this would silently become
 * `side-images\foo.png`, which `staticFile()` then encodes as ONE opaque
 * segment (`side-images%5Cfoo.png`) that matches nothing on disk — every
 * side-image render breaking on Windows, the exact shape of the 0.1.4→0.1.5
 * cautionary tale (CLAUDE.md's Releases section). Pulled out as its own
 * function so this literal can be pinned by a test independent of the
 * platform running that test.
 */
export function sideImageDestRel(src: string): string {
  return `${SIDE_IMAGE_SUBDIR}/${basename(src)}`;
}

/**
 * Frame-area share above which a layout's video slot is the SUBJECT rather
 * than an inset. `video-top` is 42% and full-bleed 100%; the pip bubble is 5%.
 */
const PRIMARY_VIDEO_SLOT_AREA = 0.2;

/**
 * Every layout's video-slot shape for the producer's framing brief: aspect
 * in OUTPUT pixels, plus whether the slot is the SUBJECT (see
 * PRIMARY_VIDEO_SLOT_AREA above) rather than an inset. `frame` must reach
 * layoutSlots itself, not just the pixel multiply: layoutSlots defaults to
 * PORTRAIT_FRAME, and the R15 split layouts change GEOMETRY with orientation
 * — split-left is a {w:1, h:0.5} stack in portrait but a {w:0.5, h:1} side
 * panel in landscape — so omitting it fed portrait slot fractions times
 * landscape pixel dims to the brief, marking the wrong layouts UNAVAILABLE
 * on every 16:9 run (latent since R15 landscape support; surfaced by the
 * 2026-08-16 incident audit). Pure so both orientations are testable
 * without an LLM run.
 */
export function layoutSlotAspects(frame: {
  width: number;
  height: number;
}): { layout: Layout; slotAspect: number; primary: boolean }[] {
  return LayoutSchema.options.map((layout) => {
    const v = layoutSlots(layout, DEFAULT_FACE, [], frame).video;
    return {
      layout,
      slotAspect: (v.rect.w * frame.width) / (v.rect.h * frame.height),
      primary: v.opacity > 0 && v.rect.w * v.rect.h >= PRIMARY_VIDEO_SLOT_AREA,
    };
  });
}

/**
 * One orphaned scene edit, one honest sentence. A parked key (`…#orphaned`,
 * handoff-edit-anchoring) matches no cue BY DESIGN, so it surfaces in
 * `applyOverrides`' orphan list on every run — and "dropped" would tell the
 * user an edit is gone while the doc still holds it, anchor intact, waiting
 * for a plan that has its words again. Pure so both sentences are testable
 * without a produce run.
 */
export function orphanEditLine(id: string): string {
  return isParkedOverrideKey(id)
    ? `  ⚠ edit for ${parkedOverrideBaseKey(id)} is parked — its words are not in this plan`
    : `  ⚠ edit for ${id} dropped — the plan no longer has that scene`;
}

async function preflight(bin: string, hint: string): Promise<void> {
  try {
    await run(bin, ["-version"], { allowNonZero: true });
  } catch {
    try {
      await run(bin, ["--help"], { allowNonZero: true });
    } catch {
      throw new Error(`'${bin}' not found. ${hint}`);
    }
  }
}

export async function produce(inputArg: string, opts: ProduceOptions): Promise<ProduceResult> {
  // First line on purpose: totalMs is the same wall clock program.ts wraps
  // around this call for duration_ms, so `other` in the printed breakdown is
  // genuinely "everything this run did that isn't an attributed phase" (§140).
  const phases = new PhaseTimer();
  const cfg = loadConfig();
  const baseCwd = process.env.INIT_CWD ?? process.cwd();
  // `let`, not `const`: a folder input is reassigned to the concat
  // intermediate below (folder-input-brief.md) so nothing past that point has
  // to know a folder was ever involved. `originalInput` keeps what the user
  // actually typed — review fix: the default --out path and the "beside the
  // video" image lookup both used to read the REASSIGNED `input`, which for a
  // folder run is a file inside the hidden workdir, not anything the user
  // would recognise.
  // expandHome first (2026-08-16 incident, see paths.ts): a `~/` path that
  // reaches us unexpanded — the wizard's text prompts, a quoted argv — must
  // never be resolved against cwd.
  const originalInput = isAbsolute(inputArg)
    ? inputArg
    : resolve(baseCwd, expandHome(inputArg));
  let input = originalInput;
  if (!existsSync(input)) throw new Error(`input not found: ${input}`);
  // Decided once, here — the out-path gate below and the folder pipeline
  // further down must read the same answer to "is this a folder run".
  const isFolder = statSync(input).isDirectory();

  // §93b: the window is an editorial judgement, and there is deliberately no
  // heuristic fallback — an automatically-guessed 60 seconds reads as a bug,
  // not a limitation. Refused up front, before any work is spent.
  if (opts.clip !== undefined) {
    if (opts.scenes) {
      throw new Error(
        "--clip cannot be combined with hand-authored --scenes — the window is the producer's call.",
      );
    }
    if (!opts.produce) {
      throw new Error(
        "--clip needs the producer's editorial judgement: add --produce. " +
          "There is no heuristic fallback for picking the window.",
      );
    }
  }
  if (opts.clipWindow !== undefined && opts.clip === undefined) {
    throw new Error("--clip-window is recorded by --clip runs for replay — pass --clip too.");
  }

  // Resolved HERE, not at the render section (2026-08-16 field incident): a
  // bad out path must fail (or be healed) in the first second, not at the
  // rename after a 50-minute render — a wizard-typed `~/Downloads/...`
  // resolved against cwd and the end-of-run rename ENOENT'd because the
  // parent never existed. mkdir over refusal: the path is the user's explicit
  // intent and creating a folder is what they'd do by hand; a genuinely
  // un-creatable path (permissions) still fails loudly, now upfront.
  const outArg = opts.out !== undefined ? expandHome(opts.out) : undefined;
  const outPath = outArg
    ? isAbsolute(outArg)
      ? outArg
      : resolve(baseCwd, outArg)
    : resolve(defaultOutPath(originalInput));
  // 2026-08-18 field cascade: an --out pointed INSIDE the input folder became
  // a 7th source clip on the next run — new content hash, fresh workdir,
  // EMPTY overrides — so the render silently dropped the user's saved edits
  // and the output duration doubled, three runs in a row. Refused BEFORE
  // ensureParentDir so the gate can't first mkdir a stray subfolder inside
  // the very input it is about to refuse. (Unreachable via the default out —
  // defaultOutPath lands BESIDE the folder — so only a typed --out can trip
  // it.)
  if (isFolder && outPathInsideInput(outPath, originalInput)) {
    throw new Error(outInsideInputFolderMessage(originalInput));
  }
  ensureParentDir(outPath);

  await preflight(cfg.ffmpegPath, "Run `ossclip setup`, install ffmpeg yourself (brew/apt/winget), or set OSSCLIP_FFMPEG.");
  await preflight(cfg.ffprobePath, "Run `ossclip setup`, install ffmpeg (provides ffprobe), or set OSSCLIP_FFPROBE.");

  // The output frame — every rect downstream is a fraction of THIS, and the
  // stage geometry now takes it as an argument rather than assuming portrait.
  const landscape = opts.aspect === "16:9";
  const frame = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const tools = { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath };

  // `--resolution` (2026-08-27), resolved before ANY stage that sizes pixels:
  // the folder concat, the mezzanine and the render each used to pin 1080p
  // independently, so a 4K take lost three quarters of its pixels before
  // anything looked at it. `auto` needs the SOURCE's size, which for a folder
  // means probing the clips here — the concat target is chosen before the
  // concatenated file (and its probe) exists.
  const resolution = resolveResolution(opts.resolution, cfg.resolution);
  const autoSource = async (): Promise<{ width: number; height: number } | null> => {
    if (resolution !== "auto") return null;
    if (isFolder && folderListing) {
      // Metadata-only probes, and only under `auto`: the default path adds no
      // ffprobe calls at all (the 4m32s probe-storm lesson, concat.ts:272).
      const sizes: Array<{ width: number; height: number }> = [];
      for (const entry of folderListing.entries) {
        try {
          const p = await probe(tools, join(input, entry.name));
          sizes.push({ width: p.width, height: p.height });
        } catch {
          // A clip that will not probe is the concat guard's problem, not
          // this sizing pass's — skip it rather than fail the run here.
        }
      }
      return smallestSource(sizes);
    }
    try {
      const p = await probe(tools, input);
      return { width: p.width, height: p.height };
    } catch {
      return null;
    }
  };
  const output = resolveOutputFrame({
    frame,
    source: (await autoSource()) ?? { width: 0, height: 0 },
    resolution,
  });
  if (output.scale !== 1) {
    console.log(`▸ resolution: ${output.width}x${output.height} (${resolution})`);
  }

  // Resolved ONCE for the whole run — whisper biasing, repair vouching and
  // caption casing must all see the same list, or the passes disagree about
  // what a term is spelled like. A typed --dictionary wholesale beats the
  // config (resolveWatermark's typed-beats-config precedence, no merging).
  const configDictionary = validDictionary(cfg.dictionary);
  if (opts.dictionary === undefined && cfg.dictionary !== undefined && configDictionary === undefined) {
    console.log("⚠ config dictionary ignored — expected an array of non-empty strings");
  }
  const dictionary = opts.dictionary ?? configDictionary ?? [];
  if (dictionary.length > 0) console.log(`▸ dictionary: ${dictionary.join(", ")}`);

  // Resolved ONCE for the whole run (§143): the provider call, both plan
  // cache keys and the command.json pin must all see the same effort, or a
  // replay re-plans under a knob the run never used.
  const { effort: llmEffort, warning: llmEffortWarning } = resolveLlmEffort(
    opts.llmEffort,
    cfg.llmEffort,
  );
  if (llmEffortWarning) console.log(llmEffortWarning);

  // The run's base theme (F6): config theme over defaultTheme, resolved once
  // and used for BOTH resolveTheme's base and props.baseTheme below — the
  // editor's reset must land on the user's global colors, not the factory's.
  const { theme: configBaseTheme, warning: themeWarning } = configuredBaseTheme(cfg.theme);
  if (themeWarning) console.log(themeWarning);

  // Folder input (folder-input-brief.md, 2026-08-05 field request). The
  // workdir hash is derived from the folder's CONTENT — `folderManifestKey`
  // over the enumerated clips — not the folder path. Review fix: a path-only
  // hash is stable across content changes, but everything else this run
  // caches into the same workdir (audio.wav, transcript.json, the
  // content-rect cache, the mezzanine) is keyed on EXISTENCE, not content. A
  // path-only hash meant adding a take rebuilt `source-concat.mp4` correctly
  // but silently reused all of those against the OLD concat, producing a
  // video with captions transcribed against a different edit. Hashing the
  // manifest content gives a folder input the same invariant a file input
  // already has via `sha1File`: content changes ⇒ a fresh workdir.
  // (`isFolder` itself is decided up top, beside the out-path gate.)
  // Final-review fix wave, cheap minor c: --sort only means anything for a
  // folder input; on a file it did nothing, silently. Gated on `sortExplicit`
  // (whether the user TYPED it) rather than on `opts.sort` itself, since
  // commander's own "name" default would otherwise print this on every plain
  // file run.
  if (!isFolder && opts.sortExplicit) {
    console.log("▸ --sort is ignored — <input> is a file, not a folder of clips");
  }
  let folderListing: Awaited<ReturnType<typeof listFolderVideos>> | undefined;
  let hash: string;
  if (isFolder) {
    folderListing = await listFolderVideos(input);
    hash = createHash("sha1")
      .update(folderManifestKey(folderListing.entries, opts.sort ?? "name"))
      .digest("hex")
      .slice(0, 8);
  } else {
    hash = (await sha1File(input)).slice(0, 8);
  }
  // expandHome at the call site so deriveWorkdir stays homedir-free.
  const work = deriveWorkdir(
    input,
    hash,
    opts.workdir !== undefined ? expandHome(opts.workdir) : undefined,
    landscape,
  );
  await mkdir(work, { recursive: true });
  console.log(`▸ workdir ${work}`);
  // See replayWorkdirWarning — set only by the edit server's /api/render
  // spawn, so a terminal run never sees it.
  const replayWarning = replayWorkdirWarning(process.env.OSSCLIP_REPLAY_WORKDIR, work);
  if (replayWarning !== null) console.log(replayWarning);

  // §131 residue: a folder re-key (clips renamed/added/removed → new content
  // hash) correctly lands in a fresh workdir, but any editor edits saved in
  // the PREVIOUS workdir's overrides.json don't carry over — and without this
  // pointer the user sees a clean produce and never learns where those edits
  // went. Gated on the current workdir lacking overrides.json: a warm re-run
  // that already has edits needs no pointer. Print-only by design — no
  // migration, no prompt — and best-effort: a courtesy line must never be the
  // reason a produce fails.
  if (isFolder && !existsSync(join(work, "overrides.json"))) {
    try {
      const workRoot = dirname(work);
      const entries = readdirSync(workRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const overrides = join(workRoot, d.name, "overrides.json");
          const st = existsSync(overrides) ? statSync(overrides) : null;
          return { name: d.name, hasOverrides: st !== null, mtimeMs: st?.mtimeMs ?? 0 };
        });
      const stranded = strandedOverrideSiblings({
        base: workdirBaseName(input),
        currentHash: hash,
        entries,
      });
      for (const name of stranded) console.log(strandedPointerLine(join(workRoot, name)));
    } catch {
      // Racing deletes/permissions while scanning siblings: drop the hint,
      // keep the run (§131 — the pointer is a courtesy, not a dependency).
    }
  }

  if (isFolder && folderListing) {
    const sort = opts.sort ?? "name";
    const result = await phases.time("ffmpeg", () =>
      // The concat target carries the RESOLVED size, not the base frame:
      // letterboxing every take into 1080p here would throw the pixels away
      // before the mezzanine or the render ever saw them (`--resolution`).
      concatFolder(tools, input, folderListing!, work, sort, {
        w: output.width,
        h: output.height,
      }),
    );
    console.log(
      `▸ folder: ${result.clips.length} clip(s), sorted by ${sort}, ` +
        `concat ${result.durationSec.toFixed(1)}s${result.cached ? " (cached)" : ""}`,
    );
    if (result.nonVideoCount > 0) {
      console.log(
        `  ${result.nonVideoCount} non-video file${result.nonVideoCount === 1 ? "" : "s"} ignored`,
      );
    }
    // Loud, not folded into the non-video count (2026-08-18 field cascade):
    // an ossclip output sitting in the clips folder means an earlier run
    // wrote it there, and the user should learn that before it surprises
    // them elsewhere. The filter itself is pure (isOssclipOutputName) and
    // runs inside listFolderVideos, before the workdir hash is derived.
    if (result.ossclipOutputCount > 0) {
      console.log(
        `▸ folder: skipped ${result.ossclipOutputCount} ossclip output ` +
          `file${result.ossclipOutputCount === 1 ? "" : "s"}`,
      );
    }
    // Order visible immediately (folder-input-brief.md) — a wrong order is a
    // silent bug otherwise, invisible until someone watches the whole thing.
    result.clips.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name} (${c.durationSec.toFixed(2)}s)`);
    });
    input = result.path;
  }

  const sourceProbe = await probe(tools, input);
  console.log(
    `▸ source ${sourceProbe.width}x${sourceProbe.height} @ ${sourceProbe.fps.toFixed(2)}fps · ${sourceProbe.duration.toFixed(2)}s`,
  );
  if (!sourceProbe.hasAudio) throw new Error("source has no audio stream — nothing to cut by");

  // §93c: a source already at or under the target is a no-op, not an error —
  // nobody should have to remember to drop the flag per input. The tolerance
  // matches the sentence-snap band, so "just over" doesn't force a selection.
  let clipTargetSec = opts.clip;
  if (
    clipTargetSec !== undefined &&
    sourceProbe.duration <= clipTargetSec * (1 + CLIP_SNAP_TOLERANCE)
  ) {
    console.log(
      `▸ source is ${sourceProbe.duration.toFixed(1)}s — already within the ` +
        `${clipTargetSec}s clip target (+${(CLIP_SNAP_TOLERANCE * 100).toFixed(0)}% tolerance); ` +
        "producing the whole take",
    );
    clipTargetSec = undefined;
  }

  const audioPath = join(work, "audio.wav");
  if (!existsSync(audioPath)) {
    const audioExtractAnim = isInteractive()
      ? new StageAnimator(
          "AUDIO STREAM",
          "Extracting 16kHz uncompressed audio stream from source...",
          "audio",
        ).start()
      : null;
    if (!audioExtractAnim) console.log("▸ extracting audio…");
    await extractAudio(tools, input, audioPath);
    if (audioExtractAnim) audioExtractAnim.stop();
  }

  // Letterbox detection (PLAN Task 7): a file's frame is not always its
  // picture — bars baked into the pixels wasted most of the video slot on one
  // real clip. Measured once, before anything geometric; every downstream
  // pass crops to the content rect so the bars stop existing.
  const letterboxAnim = isInteractive()
    ? new StageAnimator(
        "LETTERBOX SCANNER",
        "Scanning video for letterbox black bars & content boundaries...",
        "render",
      ).start()
    : null;
  const detection = await detectContentRect(tools, input, sourceProbe, { cacheDir: work });
  if (letterboxAnim) letterboxAnim.stop();
  const contentTimeline = detection.timeline;
  const cropVf = cropFilter(detection.uniform);
  if (detection.uniform && !detection.uniform.full) {
    console.log(
      `▸ source is letterboxed: content ${detection.uniform.w}×${detection.uniform.h} at ` +
        `x ${detection.uniform.x}, y ${detection.uniform.y} (bars trimmed everywhere downstream)`,
    );
  }


  let transcript: Transcript;
  const transcriptCache = join(work, "transcript.json");
  // Which model/language WROTE transcript.json, recorded beside it (review
  // fix, Urdu field test 2026-08-05): the cache used to be reused on
  // existence alone, so a warm workdir silently served the stale English
  // transcript on the first `--whisper-language ur` retry — the exact run
  // the flag exists for — and equally defeated the model A/B the
  // --whisper-model help text advertises.
  const transcriptKeyPath = join(work, "transcript-key.json");
  const requestedModel = opts.whisperModel ?? cfg.model;
  // Flag > config > the curated table's model-implied language (a non-English
  // fine-tune without `-l` decodes garbage — Urdu field test 2026-08-05).
  // Resolved BEFORE the key so a config/model-sourced language re-keys the
  // cache exactly like the typed flag does.
  const whisperLang = resolveWhisperLanguage(
    opts.whisperLanguage,
    cfg.language,
    modelImpliedLanguage(requestedModel),
  );
  if (whisperLang.warning) console.log(whisperLang.warning);
  if (whisperLang.source === "config" || whisperLang.source === "model") {
    console.log(
      `▸ whisper language: ${whisperLang.language} ` +
        `(from ${whisperLang.source === "config" ? "config" : `model ${requestedModel}`}; ` +
        `--whisper-language overrides)`,
    );
  }
  // Local whisper.cpp or an OpenAI-compatible server (2026-09-01 weak-CPU
  // field report). Resolved BEFORE the key, like the language, so what
  // actually decodes is what the cache is keyed on.
  const backendPick = resolveWhisperBackend(opts.whisperBackend, cfg, process.env);
  if (!backendPick.ok) throw new Error(backendPick.message);
  const backend = backendPick.backend;
  // BEFORE the key is built, so a translate request can never cross the
  // cache with a remote one: the OpenAI-compatible API translates on a
  // DIFFERENT endpoint with a DIFFERENT default model, and swapping both
  // behind one flag would be a surprise rather than a convenience.
  if (backend.kind === "remote" && opts.whisperTranslate === true) {
    throw new Error(
      "--whisper-translate needs the local backend (the OpenAI-compatible API translates on a " +
        "different endpoint and model) — use --whisper-backend local, or drop the flag.",
    );
  }
  const requestedKey: TranscriptKey = {
    // The REMOTE model name when remote — one field, both engines, so an
    // A/B between two Groq models re-keys the cache exactly like a local one.
    model: backend.kind === "remote" ? backend.model : requestedModel,
    ...(whisperLang.language !== undefined ? { language: whisperLang.language } : {}),
    // Spread-omitted on local so local key files stay byte-identical to
    // every one written before remote existed (the translate posture). The
    // URL goes through openaiTranscriptionsUrl so ".../v1" and ".../v1/"
    // key identically — a trailing slash is not a different server.
    ...(backend.kind === "remote"
      ? { backend: `remote:${openaiTranscriptionsUrl(backend.baseUrl)}` }
      : {}),
    // Omitted when off, so a non-translate run's key stays byte-identical to
    // every pre-flag key file (the dictionary posture).
    ...(opts.whisperTranslate === true ? { translate: true } : {}),
    // Omitted when empty, not written as [] — pre-dictionary key files have
    // no `dictionary` at all, and transcriptCacheReusable reads absent and
    // empty as the same "no biasing", so old workdirs must not re-transcribe.
    ...(dictionary.length > 0 ? { dictionary } : {}),
  };
  let cacheVerdict: ReturnType<typeof transcriptCacheReusable> | null = null;
  if (!opts.transcript && existsSync(transcriptCache)) {
    const recorded = existsSync(transcriptKeyPath)
      ? TranscriptKeySchema.parse(JSON.parse(await readFile(transcriptKeyPath, "utf8")))
      : null;
    cacheVerdict = transcriptCacheReusable(recorded, requestedKey, cfg.model);
  }
  if (opts.transcript) {
    // expandHome before resolve — same 2026-08-16 rule as --out (paths.ts).
    transcript = TranscriptSchema.parse(
      JSON.parse(await readFile(resolve(expandHome(opts.transcript)), "utf8")),
    );
    console.log(`▸ transcript injected from ${opts.transcript} (${transcript.words.length} words)`);
    // An injected transcript came from no whisper run at all, so any key left
    // by an earlier one would mislabel the cache this branch overwrites below.
    // Keyless-as-default keeps today's behavior: later default runs reuse it,
    // and only an explicit model/language request re-transcribes over it.
    await rm(transcriptKeyPath, { force: true });
  } else if (cacheVerdict?.reuse) {
    transcript = TranscriptSchema.parse(JSON.parse(await readFile(transcriptCache, "utf8")));
    console.log(`▸ transcript cached (${transcript.words.length} words)`);
  } else {
    if (cacheVerdict !== null) {
      const fmt = (k: TranscriptKey) => `${k.model}/lang ${k.language ?? "default"}`;
      console.log(
        `▸ transcript cache is for model ${fmt(cacheVerdict.recorded)} — ` +
          `re-transcribing with ${fmt(requestedKey)}`,
      );
    }
    if (backend.kind === "remote") {
      // No whisper binary and no model file on this branch — the whole point
      // of remote is that neither is installed (2026-09-01 field report).
      // ffmpeg still is: the upload sidecar is an encode.
      const host = remoteWhisperHost(backend.baseUrl);
      const uploadPath = join(work, "audio-upload.ogg");
      transcript = await phases.time("transcribe", async () => {
        await encodeUploadAudio(tools, audioPath, uploadPath);
        const bytes = statSync(uploadPath).size;
        if (bytes > REMOTE_UPLOAD_MAX_BYTES) {
          // Named here rather than paid for as somebody else's 413 after the
          // whole upload: chunking is out of scope for v1, so the error has
          // to carry both escape hatches itself.
          throw new Error(
            `the compressed audio is ${(bytes / 1_000_000).toFixed(1)} MB, over the ` +
              `${(REMOTE_UPLOAD_MAX_BYTES / 1_000_000).toFixed(0)} MB single-file limit for remote ` +
              `transcription (about 100 minutes of speech at this bitrate).\n` +
              `Transcribe locally with --whisper-backend local, split the take, or point ` +
              `OSSCLIP_WHISPER_URL at a server with a larger cap (Groq's dev tier allows 100 MB).`,
          );
        }
        const anim = isInteractive()
          ? new StageAnimator(
              "REMOTE ASR",
              `Transcribing via ${host} (${backend.model})...`,
              "whisper",
            ).start()
          : null;
        if (!anim) console.log(`▸ transcribing remotely (${host}, ${backend.model})…`);
        try {
          return await createOpenAiCompatibleProvider({
            baseUrl: backend.baseUrl,
            model: backend.model,
            ...(backend.apiKey !== undefined ? { apiKey: backend.apiKey } : {}),
          }).transcribe(uploadPath, {
            // From the KEY, like the local branch: whatever re-keys the cache
            // is what actually decoded, so the two can never disagree.
            language: requestedKey.language,
            prompt: whisperPromptFor(dictionary),
          });
        } finally {
          // In a finally, unlike the local branch's trailing stop(): an HTTP
          // failure here is EXPECTED (a wrong key, a rate limit), and a
          // spinner still animating would overwrite the hint the user needs.
          anim?.stop();
        }
      });
    } else {
      await preflight(
        cfg.whisperPath,
        "Run `ossclip setup`, install whisper.cpp yourself (https://github.com/ggml-org/whisper.cpp), or set OSSCLIP_WHISPER.",
      );
      const model = requestedKey.model;
      // whisperModelPath/modelUrl are THE resolution and URL sources (shared
      // with doctor and setup) — this error used to hold its own copy of the
      // ggerganov URL, which 404'd for curated/custom names and the suggested
      // `curl -L` then saved the 404 HTML as a fake model.
      const modelPath = whisperModelPath(model, cfg.modelDir);
      if (!existsSync(modelPath)) {
        throw new Error(
          `whisper model not found at ${modelPath}.\n` +
            `Run \`ossclip setup${model === cfg.model ? "" : ` --model ${model}`}\` to download it — or manually:\n` +
            `  curl -L -o ${modelPath} ${modelUrl(model, validModelSources(cfg.modelSources))}`,
        );
      }
      const whisperAnim = isInteractive()
        ? new StageAnimator(
            "WHISPER ASR",
            `Transcribing audio stream with ${basename(modelPath)}...`,
            "whisper",
          ).start()
        : null;
      if (!whisperAnim) console.log(`▸ transcribing (${basename(modelPath)})…`);
      transcript = await phases.time("transcribe", () =>
        runWhisper(
          {
            whisperPath: cfg.whisperPath,
            modelPath,
            outBase: join(work, "whisper"),
            // The RESOLVED language, not the raw flag — a config/model-implied
            // code must reach the spawn exactly as it reached the cache key.
            language: requestedKey.language,
            // Vocabulary biasing (F4) — undefined for an empty dictionary, so
            // the spawned args stay byte-identical to every pre-dictionary run.
            // From the KEY, like the language: whatever re-keys the cache is
            // what actually ran, so the two can never disagree.
            ...(requestedKey.translate === true ? { translate: true } : {}),
            prompt: whisperPromptFor(dictionary),
          },
          audioPath,
        ),
      );
      if (whisperAnim) whisperAnim.stop();
    }
    console.log(`▸ transcribed ${transcript.words.length} words`);
    await writeFile(transcriptKeyPath, JSON.stringify(requestedKey, null, 2));
  }
  await writeFile(transcriptCache, JSON.stringify(transcript, null, 2));

  const levels = await measureLevels({ ffmpegPath: cfg.ffmpegPath }, audioPath);
  console.log(
    `▸ levels: floor ${levels.floorDb.toFixed(1)} dB · speech ${levels.speechDb.toFixed(1)} dB ` +
      `→ silence threshold ${levels.thresholdDb.toFixed(1)} dB`,
  );
  const silencesAnim = isInteractive()
    ? new StageAnimator(
        "AUDIO SPECTRUM",
        "Analyzing speech cadence and silence thresholds...",
        "audio",
      ).start()
    : null;
  if (!silencesAnim) console.log("▸ analyzing silences…");
  const silences = await detectSilences(
    { ffmpegPath: cfg.ffmpegPath, noiseDb: opts.noiseDb ?? levels.thresholdDb },
    audioPath,
  );
  if (silencesAnim) silencesAnim.stop();
  // `let`, not `const` (R19 §93): a clip run re-derives all three from the
  // transcript sliced to the chosen window, further down.
  let analysis: Analysis = analyze(transcript, silences, sourceProbe.duration, levels);
  // Spoken blooper markers (R27 §122). Detected on the RAW transcript, before
  // repair — the repair pass reads a bare "blooper." as an oddity and has
  // already been observed proposing "break loop." for it. Detecting first
  // means the marker cannot be rewritten out from under the detector.
  // `silences` rides along so the cut can extend through the marker's own
  // trailing dead air — §18 stamp-stretch put the stamped end of a spoken
  // "blooper." 0.4s before its acoustic end (2026-08-16 incident, see
  // MAX_MARKER_BLEED_SEC in blooper.ts).
  let bloops = opts.blooperMarker ? findBloopSpans(transcript, opts.blooperMarker, silences) : [];
  if (opts.blooperMarker) {
    console.log(
      bloops.length > 0
        ? `▸ blooper marker "${opts.blooperMarker}": ${bloops.length} take(s) cut`
        : `▸ blooper marker "${opts.blooperMarker}": never said — nothing cut`,
    );
    for (const b of bloops) console.log(`  ▸ ${formatBloopSpan(transcript, b)}`);
  }
  // Deterministic retake collapse (R27 §128) — the flub the speaker did NOT
  // mark. Same RAW-transcript-before-repair ordering as the blooper marker
  // above and for the same reason: repair reading a stray restart as an
  // oddity would rewrite the exact pattern this looks for. Gated on the
  // marker, not --collapse-retakes (inferredRetakesEnabled has the user's
  // verbatim rule); the legacy flag typed alone earns a notice, not silence.
  const retakesEnabled = inferredRetakesEnabled(opts.blooperMarker);
  if (opts.collapseRetakes && !retakesEnabled) {
    console.log("▸ collapse-retakes: skipped — retake detection runs only with --blooper-marker");
  }
  let retakeGroups = retakesEnabled
    ? findRetakeGroups(transcript, analysis, { transparentMarker: opts.blooperMarker })
    : [];
  let retakes = retakeCutsFor(retakeGroups);
  if (retakesEnabled) {
    // `exact` never cuts anything — buildCutlist's own early return collapses
    // to one whole-duration `keep` regardless of what's in `retakes` — so
    // "N group(s), M take(s) cut" here was a claim the run never honored.
    // Same fact `valveFired` below already checks; gated the same way
    // (final-review fix wave, cheap minor b).
    if (opts.cleanup === "exact") {
      console.log("▸ retakes: --cleanup exact wins — nothing cut");
    } else {
      console.log(
        retakeGroups.length > 0
          ? `▸ retakes: ${retakeGroups.length} group(s), ${retakes.length} take(s) cut`
          : "▸ retakes: none found",
      );
      for (const g of retakeGroups) {
        for (const line of formatRetakeGroup(transcript, g).split("\n")) console.log(`  ▸ ${line}`);
      }
    }
  }
  let cutlist: Segment[] = buildCutlist({
    transcript,
    analysis,
    duration: sourceProbe.duration,
    level: opts.cleanup,
    bloops,
    retakes,
  });
  let map = new TimeMap(cutlist);
  // Known limit (§128): the sanity valve can cancel a legitimate retake cut
  // along with everything else if analysis went haywire elsewhere. Silence
  // there would be wrong — a collapse the user asked for quietly vanished.
  // Detected directly off buildCutlist's own valve shape (one `keep` segment
  // spanning the whole duration) rather than "no retake reason survived":
  // the merge step reassigns a removal's `reason` to whichever piece is
  // LONGER when it folds two removals together (cutlist.ts, `curDur >
  // prevDur`), so a retake genuinely cut but merged into a longer silence
  // removal would read as "no retake reason survived" even though the cut
  // happened — a false alarm the direct check can't produce.
  // `exact` also collapses to this exact single-keep shape (buildCutlist's
  // own early return) and is not the valve — "touch nothing" is the ask, not
  // a failure, so it's excluded here rather than misreported as one.
  const valveFired = opts.cleanup !== "exact" && cutlist.length === 1 && cutlist[0]!.kind === "keep";
  if (retakes.length > 0 && valveFired) {
    console.log(
      "  ⚠ retake collapse found a retake, but the sanity valve reset the whole cutlist — nothing was cut",
    );
  }

  // ---- Transcript repair (FINDINGS §17/§21) --------------------------------
  // Deliberately AFTER the cutlist: the cut is computed from raw ASR, so the
  // same input and --cleanup always produce the same edit whether or not an
  // LLM ran. Everything downstream that a viewer READS — captions, scene copy,
  // the grounding check — uses the repaired transcript instead, so a
  // mishearing can't reach the screen twice in two different spellings.
  const providerName = opts.provider ?? defaultProviderName(process.env, binOnPath);
  // Timeout fallback (2026-08-22, FINDINGS §143): agy hangs persistently on
  // the real beat-sheet call, and auto-detection picks it whenever the CLI is
  // on PATH. When the editorial call times out, ONE other provider answers
  // instead of the run dying, announced out loud: the user must know which
  // model planned their video.
  //
  // Function-scope because the beat CACHE needs it too (§150) — the key a
  // fallback wrote is the second key a re-run has to try, and computing it
  // twice would let the two drift into disagreeing about where the plan is.
  const llmFallbackName =
    providerName === "antigravity"
      ? fallbackProviderName(providerName, process.env, binOnPath)
      : undefined;
  let provider: LlmProvider | null = null;
  // --youtube brings its own provider (field gap, 2026-08-16): the user's
  // real command was `--youtube --llm antigravity` WITHOUT --produce, and the
  // pack skipped with "needs an LLM provider" — a flag that exists to call an
  // LLM must count as opting into one. This also turns transcript repair on
  // for such runs, which is the dictionary's caption-side fix ("Jason" →
  // "JSON") — biasing whisper alone does not correct what ASR already heard.
  const needsLlm = opts.produce === true || resolveYoutube(opts.youtube, cfg.youtube);
  if (needsLlm) {
    // Only when auto-detected: a typed --llm needs no explanation. The line
    // itself lives in llm-detect.ts so a drift test covers every provider —
    // the inline ternary this replaces printed the ANTHROPIC line for a
    // gemini-detected run (FINDINGS §132, antigravity provider).
    if (!opts.provider) {
      console.log(detectionLine(providerName));
    }
    provider = createTieredProvider(providerName, {
      model: opts.llmModel,
      fastModel: opts.llmFastModel ?? cfg.fastModel,
      fallback: llmFallbackName,
      onFallback: (info) => console.log(fallbackLine(info.from, info.to, info.schemaName)),
      // §143: rides the editorial antigravity call only — see TieringOptions.
      effort: llmEffort,
    });
  }

  let rawTranscript = transcript;
  let repairs: AppliedRepair[] = [];
  if (provider && opts.repair !== false) {
    // Parameterized on the provider so the WRITE below can re-key on who
    // actually answered (§143) — the same read/write split as the beat-sheet
    // caches, and load-bearing beyond attribution: repairs REWRITE the words,
    // and the words are an input to every plan cache key downstream. A repair
    // set cached under the provider that timed out would fork the transcript
    // lineage, and the fallback-written plan could never be reached by a
    // later run that names the fallback provider directly (measured
    // 2026-08-22: two repair caches, 10 vs 11 repairs — one applied
    // "Llama," → "LLaVA," — put the same take's beat sheets under keys no
    // other run computed).
    const repairKeyFor = (p: string): string =>
      createHash("sha1")
        .update(
          JSON.stringify([
            p,
            opts.llmModel,
            opts.llmFastModel ?? cfg.fastModel,
            opts.speaker ?? cfg.speaker,
            // The dictionary changes both the prompt and the vouched set (F4),
            // so cached repairs from a different vocabulary must not be reused.
            dictionary,
            rawTranscript.words.map((w) => w.text),
            // Repair runs on the EDITORIAL tier (repair.ts: deciding what a
            // person actually said is semantic work), so the §143 effort knob
            // changes its answers. Appended at the END, only when SET —
            // beatSheetCacheKey's rule: an unset effort must keep serving the
            // repairs every existing workdir already cached.
            ...(llmEffort !== undefined ? [llmEffort] : []),
          ]),
        )
        .digest("hex")
        .slice(0, 8);
    const repairCache = join(work, `repairs-${repairKeyFor(providerName)}.json`);
    if (existsSync(repairCache)) {
      const cached = JSON.parse(await readFile(repairCache, "utf8")) as AppliedRepair[];
      // Re-DECIDE from the cached PROPOSALS; never replay the stored verdicts
      // (field case 2026-08-18). What this cache exists to avoid is the LLM
      // CALL — the gates are code, and code gets fixed. Filtering to
      // `r.applied` here meant a gate fix could never reach a workdir that had
      // already cached a refusal: the Urdu run whose 11 correct repairs stayed
      // refused after the Latin-only `norm` was fixed, because produce replayed
      // the old verdicts instead of recomputing them. The vouched set rides
      // along for the same reason it always did — a dictionary-vouched
      // correction must clear the phonetic gate on replay too.
      const decided = applyRepairs(
        rawTranscript,
        cached.map(({ startWord, endWord, heard, correction }) => ({
          startWord,
          endWord,
          heard,
          correction,
        })),
        { dictionary },
      );
      repairs = decided.applied;
      transcript = decided.transcript;
      const now = repairs.filter((r) => r.applied).length;
      const before = cached.filter((r) => r.applied).length;
      // Re-decided verdicts are the truth from here on: persist them so the
      // report, the next run and this run cannot disagree about what applied.
      if (now !== before) await writeFile(repairCache, JSON.stringify(repairs, null, 2));
      console.log(
        `▸ repairs cached (${now} applied of ${cached.length} proposed` +
          `${now === before ? "" : `, re-decided from ${before}`})`,
      );
    } else {
      const repairAnim = isInteractive()
        ? new StageAnimator(
            "PHONETIC REPAIR",
            `Correcting ASR mishearings with ${providerName === "gemini" ? "Gemini 3.7 Flash" : providerName}...`,
            "ai",
          ).start()
        : null;
      const result = await phases.time("llm", () =>
        repairTranscript(provider!, rawTranscript, {
          speaker: opts.speaker ?? cfg.speaker,
          // Vouched terms (F4): named in the prompt AND exempt, when a
          // correction is built entirely of them, from the phonetic gate.
          dictionary,
          // A repair may not merge words across a cut.
          isCut: (startSec, endSec) =>
            cutlist.some(
              (s) => s.kind === "remove" && s.srcIn < endSec && s.srcOut > startSec,
            ),
        }),
      );
      if (repairAnim) repairAnim.stop();
      transcript = result.transcript;
      repairs = result.applied;
      if (result.error) {
        // NEVER cache a FAILURE (§106). `repairTranscript` fails soft — a
        // dead provider returns zero repairs, which on disk is
        // indistinguishable from "this take needed none". Caching it made the
        // failure permanent: every later run read `[]` and skipped the pass
        // entirely, so the mishearings stayed in the captions and no amount
        // of re-running could fix them. Same family as §78 — an artefact
        // describing a state that isn't the one it was produced under.
        console.log(
          `  ⚠ transcript repair unavailable: ${result.error}\n` +
            "    (not cached — the next run retries the pass)",
        );
      } else {
        // Written under the ANSWERING provider's key (§143): after a timeout
        // fallback these are the fallback's repairs, and the transcript
        // lineage they start must be reachable by a run that asks that
        // provider by name. The primary-keyed read above stays deliberate.
        await writeFile(
          join(
            work,
            `repairs-${repairKeyFor(actualProvider(provider.usage, "transcript_repair", providerName))}.json`,
          ),
          JSON.stringify(repairs, null, 2),
        );
      }
    }
    for (const r of repairs) {
      console.log(
        r.applied
          ? `  ▸ repaired "${r.heard}" → "${r.correction}"`
          : `  ⚠ repair refused: "${r.heard}" → "${r.correction}" (${r.rejected})`,
      );
    }
  }

  // ---- Framing measurement (PLAN Tasks A+B) --------------------------------
  /**
   * Mixed framing (option (a), decided with the author 2026-07-28): a source
   * that alternates framings gets ONE field of view — every segment windowed
   * to the tightest framing the take ever shows, placed on that segment's own
   * measured face. The PLAN is computed here, before the producer, because
   * the producer needs the framing brief: which word ranges are close shots,
   * and which layouts those rule out. The plan used to be BAKED into a
   * re-encoded file after the scenes existed; since 2026-08-16 it is emitted
   * as `framingTimeline` render-props instead (see the props assembly below).
   */
  let framingPlan: NormalizePlan | null = null;
  if (!detection.uniform) {
    const boxed = letterboxedSeconds(contentTimeline);
    console.log(
      `▸ source framing CHANGES mid-take: ${contentTimeline.length} segments, ` +
        `${boxed.toFixed(1)}s of ${sourceProbe.duration.toFixed(1)}s letterboxed`,
    );
    for (const seg of contentTimeline) {
      console.log(
        `  · ${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s ` +
          (seg.rect.full
            ? "full frame"
            : `content ${seg.rect.w}×${seg.rect.h} at x ${seg.rect.x}, y ${seg.rect.y}`),
      );
    }
    // Each segment's face, measured inside ITS OWN rect — a single median
    // across mixed framings averages two coordinate systems and points the
    // crop at neither (the old C5 gap; it put the eyes at the top of the
    // frame on the motivating clip).
    const faceMeasureAnim = isInteractive()
      ? new StageAnimator(
          "FACE TRACKING & FRAMING",
          `Measuring face geometry across ${contentTimeline.length} shot segments...`,
          "render",
        ).start()
      : null;
    const segmentFaces = await measureFaceInWindows(
      tools,
      input,
      contentTimeline.map((seg) => ({
        startSec: seg.startSec,
        endSec: seg.endSec,
        cropVf: cropFilter(seg.rect),
      })),
      { workDir: work },
    );
    if (faceMeasureAnim) faceMeasureAnim.stop();
    framingPlan = planNormalization(contentTimeline, segmentFaces, frame);
  }

  // ---- Scenes: hand-authored file, or the producer brain (PHASE1 §4) ----
  let scenes: Scene[] = [];
  /** Editorial output kept for the cover (§31): hook + its thumbnail form. */
  let beatSheet: { hook: string; coverText?: string } | undefined;
  /**
   * The FULL sheet, moments included — the graphics plan the SFX call needs in
   * context (a whoosh syncs with a graphic entrance). Separate from
   * `beatSheet` above, which is deliberately the cover's two fields: this one
   * exists only while a plan is in hand this run, and is undefined on the
   * paths that never had one (`--scenes`, a pre-`--sfx` scenes cache).
   */
  let fullSheet: BeatSheet | undefined;
  /** The graphics accounting line for report.txt (§118b), and the beat-sheet
   * issues that explain it. Cached alongside the beat sheet so a cached
   * re-run's report keeps the accounting instead of erasing it (§78). */
  let graphicsLine: string | undefined;
  let beatIssues: BeatsValidationIssue[] = [];
  /**
   * The `--sfx` plan: the level it was planned at and the placements that
   * survived `normalizeSfxPlan`, stored on production.json and resolved to
   * cues once the cut is final (`resolveSfxCues`). Undefined = this run has no
   * sound design at all, which is what an absent `sfx` field means.
   */
  let sfxPlan: { level: SfxLevel; placements: SfxPlacement[] } | undefined;
  /** The library the plan was made against — the resolver needs the same
   * sounds (gain, absPath) it planned over, and the stager needs their files. */
  let sfxSounds: LoadedSfxSound[] = [];
  /** Planning drops + the count the MODEL returned, carried to the one
   * accounting line the console and report.txt share (§118b's contract). */
  let sfxIssues: SfxValidationIssue[] = [];
  let sfxPlanned = 0;
  /** Whether the placement step actually ran — see the notice below the
   * scenes block for the runs where `--sfx` cannot reach it. */
  let sfxAttempted = false;
  // Resolved HERE, above the branch that uses it, so BOTH the placement step
  // and the "this run has no beat sheet" notice read one answer. Typed beats
  // config for the switch; the level is zod-parsed out of the config, never
  // coerced (`resolveSfxLevel`).
  const sfxOn = resolveSfx(opts.sfx, cfg.sfx);
  const sfxLevelResolved = resolveSfxLevel(opts.sfxLevel, cfg.sfxLevel);
  if (sfxOn && sfxLevelResolved.warning) console.log(sfxLevelResolved.warning);
  const sfxLevel = sfxLevelResolved.level;
  // Which packs this machine offers (`sfxBundledPack`) — resolved next to the
  // level, and for the same reason: BOTH library loads below (the placement
  // step and the carry-forward branch) must read one answer, or a run would
  // plan against one library and stage from another.
  const sfxBundled = resolveSfxBundledPack(cfg.sfxBundledPack);
  if (sfxOn && sfxBundled.warning) console.log(sfxBundled.warning);
  /** The loader's opts, shared by both library loads. */
  const sfxLoad = { includeBundled: sfxBundled.include };
  /** Who planned this run (R16 §78) — stamped into production.json below. */
  let producerStamp: Production["producer"];
  /** The resolved `--clip` window (R19 §93) — set only on a clip run; feeds
   * `production.json`, the report, and the command.json pin below. */
  let clipWindow: ClipWindow | null = null;
  if (opts.scenes) {
    // expandHome before resolve — same 2026-08-16 rule as --out (paths.ts).
    scenes = z.array(SceneSchema).parse(
      JSON.parse(await readFile(resolve(expandHome(opts.scenes)), "utf8")),
    );
    console.log(`▸ scenes injected from ${opts.scenes} (${scenes.length})`);
  } else if (provider && opts.produce === true) {
    // `opts.produce`, not bare `provider` (2026-08-16): --youtube now brings
    // a provider for its metadata/repair, and the bare-provider gate silently
    // turned GRAPHICS on for a run that never asked for them — 12 surprise
    // scenes on a plain-cut video. A provider is a capability; --produce is
    // the consent.
    // Keyed on the repaired transcript's TEXT, not its word count: a repair
    // that swaps "coach and" for "code churn" leaves the count identical, and
    // a count-keyed cache would silently replan from the stale wording.
    // Camera-framing constraints for the producer (PLAN Tasks A+B): windows
    // and canvas from the normalization plan, slot shapes from the stage —
    // injected here because core must stay scenes-free. Only primary slots
    // (video is the subject) are subject to the head-fits rule; a pip bubble
    // is MEANT to be a tight head shot.
    const framingCtx = framingPlan
      ? {
          windows: framingPlan.segments.map((s, i) => ({
            startSec: s.startSec,
            endSec: s.endSec,
            faceFracOfCanvas: framingPlan.faceFracOfCanvas[i] ?? 0,
          })),
          canvasAspect: framingPlan.canvas.width / framingPlan.canvas.height,
          layouts: layoutSlotAspects(frame),
          zoom: ZOOM_MAX_SCALE,
        }
      : undefined;
    // ---- Clip window resolution (R19 §93) ---------------------------------
    // Authority order: the command.json pin (§93g — the editor's Render must
    // replay the SAME window) > the workdir's window cache > ONE extended
    // beat-sheet call (§93d). Pin and cache both yield a window with zero LLM
    // calls; only a first run selects.
    let clipFresh: Awaited<ReturnType<typeof produceScenes>> | null = null;
    if (clipTargetSec !== undefined) {
      // Parts split from the key so the WRITE below can re-key on the
      // provider that actually answered (§143) without restating them.
      const windowKeyParts = {
        promptVersion: PRODUCER_PROMPT_VERSION,
        llmModel: opts.llmModel,
        llmEffort,
        intent: opts.intent,
        clipTargetSec,
        framing: framingCtx,
        words: transcript.words.map((w) => w.text),
        aspect: landscape ? ("16:9" as const) : ("9:16" as const),
      };
      const windowKey = clipWindowCacheKey({ ...windowKeyParts, providerName });
      const clipWindowCache = join(work, `clipwindow-${windowKey}.json`);
      if (opts.clipWindow) {
        clipWindow = parseClipWindowPin(transcript, opts.clipWindow);
        console.log(
          `▸ clip window pinned by the recorded command: words ` +
            `${clipWindow.startWord}–${clipWindow.endWord}`,
        );
      } else if (existsSync(clipWindowCache)) {
        clipWindow = ClipWindowSchema.parse(JSON.parse(await readFile(clipWindowCache, "utf8")));
        console.log("▸ clip window cached");
      } else {
        console.log(`▸ selecting the strongest ~${clipTargetSec}s window (${providerName})…`);
        clipFresh = await phases.time("llm", () =>
          produceScenes(provider!, {
            transcript,
            outputDuration: clipTargetSec!,
            intent: opts.intent,
            speaker: opts.speaker ?? cfg.speaker,
            forceComponent: opts.forceComponent,
            framing: framingCtx,
            clip: { targetSec: clipTargetSec! },
            aspect: landscape ? "16:9" : "9:16",
          }),
        );
        clipWindow = clipFresh.clip!.window;
        for (const note of clipFresh.clip!.notes) console.log(`  ▸ ${note}`);
        // The WRITE keys on the provider that actually answered; the READS
        // above stay keyed on the primary — both deliberate (2026-08-22,
        // FINDINGS §143). After a timeout fallback the window is the
        // fallback's work: filing it under agy would let an agy-keyed read
        // claim a window agy never chose, and would hide it from a later
        // `--llm claude-cli` run that should hit it. The price of the
        // primary-keyed read is that a repeat agy run re-attempts agy (10
        // minutes, today) before falling back again — accepted over ever
        // serving a cache whose label lies.
        await writeFile(
          join(
            work,
            `clipwindow-${clipWindowCacheKey({
              ...windowKeyParts,
              providerName: actualProvider(provider.usage, "clip_beat_sheet", providerName),
            })}.json`,
          ),
          JSON.stringify(clipWindow, null, 2),
        );
      }

      // Slice the pipeline state to the window (§93.1), then let everything
      // downstream — captions, scenes, zoom, the editor — run unchanged on
      // the slice. The raw transcript slices by TIME (repairs may change word
      // counts, so raw and repaired index spaces need not line up); repairs
      // shift with it so production.json stays a reproducible pair.
      console.log(
        `▸ clip: ${formatClipTime(clipWindow.startSec)}–${formatClipTime(clipWindow.endSec)} ` +
          `of ${formatClipTime(sourceProbe.duration)} — ${clipWindow.reason}`,
      );
      const rawSlice = sliceRawTranscript(rawTranscript, clipWindow);
      repairs = sliceRepairs(repairs, rawSlice.offset, rawSlice.transcript.words.length);
      rawTranscript = rawSlice.transcript;
      transcript = sliceTranscript(transcript, clipWindow);
      analysis = analyze(rawTranscript, silences, sourceProbe.duration, levels);
      // Re-detect on the SLICE: word indices moved, so the spans found against
      // the full take no longer address the same words.
      // Full-source `silences` on a sliced transcript is correct on purpose:
      // sliceRawTranscript keeps SOURCE seconds on every word stamp, so the
      // bleed extension compares like with like.
      bloops = opts.blooperMarker
        ? findBloopSpans(rawTranscript, opts.blooperMarker, silences)
        : [];
      retakeGroups = retakesEnabled
        ? findRetakeGroups(rawTranscript, analysis, { transparentMarker: opts.blooperMarker })
        : [];
      retakes = retakeCutsFor(retakeGroups);
      cutlist = boundCutlistToWindow(
        buildCutlist({
          transcript: rawTranscript,
          analysis,
          duration: sourceProbe.duration,
          level: opts.cleanup,
          bloops,
          retakes,
        }),
        clipWindow,
        sourceProbe.duration,
      );
      map = new TimeMap(cutlist);
    }

    // Parts split from the key for the same §143 reason as the clip window:
    // the writes below re-key on the provider that actually answered.
    const beatKeyParts = {
      promptVersion: PRODUCER_PROMPT_VERSION,
      llmModel: opts.llmModel,
      llmEffort,
      intent: opts.intent,
      cleanup: opts.cleanup,
      forceComponent: opts.forceComponent,
      framing: framingCtx,
      clipTargetSec,
      clipWindow,
      words: transcript.words.map((w) => w.text),
      aspect: landscape ? ("16:9" as const) : ("9:16" as const),
    };
    // Two keys, tried in order: the provider asked for, then the one this run
    // would fall back to anyway (§150). Without the second, a workdir whose
    // plan was written by a fallback can never be read again while the primary
    // keeps failing — every re-render re-plans, and edits anchored to scenes
    // the new plan drops go with it.
    const cacheKeys = beatCacheKeyCandidates(beatKeyParts, providerName, llmFallbackName);
    const cacheKey = cacheKeys[0]!;
    const hitKey =
      cacheKeys.find((k) => existsSync(join(work, `scenes-${k}.json`))) ?? cacheKey;
    const sceneCache = join(work, `scenes-${hitKey}.json`);
    // The cover needs the editorial copy, which is not in the scene list — a
    // cached run must still be able to write one.
    // Same key the scenes came from — the hook and cover copy belong to THAT
    // plan, and pairing a cached scene list with a different sheet's hook
    // would caption the video with copy for a plan it is not showing.
    const beatCache = join(work, `beatsheet-${hitKey}.json`);
    if (clipFresh) {
      // The selection call already planned the scenes (§93d: ONE editorial
      // call chooses the window and the beats inside it) — adopt them and
      // cache under the post-resolution key so re-runs and replays hit it.
      scenes = clipFresh.scenes;
      beatSheet = { hook: clipFresh.beatSheet.hook, coverText: clipFresh.beatSheet.coverText };
      fullSheet = clipFresh.beatSheet;
      console.log(`▸ hook: ${clipFresh.beatSheet.hook}`);
      console.log(
        `▸ planned ${clipFresh.beatSheet.moments.length} moments, ${scenes.length} scenes` +
          (clipFresh.failures.length > 0
            ? ` (${clipFresh.failures.length} fell back to TitleCard)`
            : ""),
      );
      for (const issue of clipFresh.beatIssues) {
        console.log(`  ⚠ moment ${issue.moment}: ${issue.issue}`);
      }
      beatIssues = clipFresh.beatIssues;
      // `transcript` is the slice here — the space the accounting was made in.
      graphicsLine = formatGraphicsAccounting(
        clipFresh.graphics.delivered,
        clipFresh.graphics.asked,
        transcript,
      );
      // Written under the ANSWERING provider's key (§143, same rule as the
      // clip-window write above): the adopted sheet came from the ONE
      // clip_beat_sheet call, which may have been the fallback's.
      const adoptKey = beatSheetCacheKey({
        ...beatKeyParts,
        providerName: actualProvider(provider.usage, "clip_beat_sheet", providerName),
      });
      await writeFile(join(work, `scenes-${adoptKey}.json`), JSON.stringify(scenes, null, 2));
      await writeFile(
        join(work, `beatsheet-${adoptKey}.json`),
        JSON.stringify(
          { ...beatSheet, moments: fullSheet.moments, graphics: graphicsLine, issues: beatIssues },
          null,
          2,
        ),
      );
    } else if (existsSync(sceneCache)) {
      scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(sceneCache, "utf8")));
      // Naming the fallback is the same obligation the live fallback line has
      // (§143: the user must know which model planned their video). A silent
      // hit here would let a claude-cli plan read as an antigravity one purely
      // because it came from disk this time.
      console.log(
        hitKey === cacheKey
          ? `▸ scenes cached (${scenes.length})`
          : `▸ scenes cached (${scenes.length}) — planned by ${llmFallbackName}, which ${providerName} fell back to`,
      );
      if (existsSync(beatCache)) {
        // Pre-§118b caches carry no accounting — the report then simply
        // omits the graphics section rather than guessing one.
        const cached = JSON.parse(await readFile(beatCache, "utf8")) as {
          hook: string;
          coverText?: string;
          moments?: unknown;
          graphics?: string;
          issues?: BeatsValidationIssue[];
        };
        beatSheet = { hook: cached.hook, coverText: cached.coverText };
        graphicsLine = cached.graphics;
        beatIssues = cached.issues ?? [];
        // The MOMENTS ride the cache too (2026-08-29, --sfx): this file used to
        // keep only the cover's two fields, so a cached run had no graphics
        // plan to put in front of the placement call — and "produce once, add
        // --sfx later" is the normal way anyone reaches this feature. Parsed,
        // not trusted (a hand-edited or pre-`--sfx` file simply has no
        // `moments`), and its absence costs the SFX step alone: everything the
        // cache did before this is read above and unaffected.
        const sheet = BeatSheetSchema.safeParse({
          hook: cached.hook,
          coverText: cached.coverText,
          moments: cached.moments,
        });
        if (sheet.success) fullSheet = sheet.data;
      }
    } else {
      const aiAnim = isInteractive()
        ? new StageAnimator(
            "AI SCENE SYNTHESIZER",
            `Planning editorial beats & graphics with ${providerName === "gemini" ? "Gemini 3.7 Flash" : providerName}...`,
            "ai",
          ).start()
        : null;
      if (!aiAnim) console.log(`▸ producing scenes (${providerName})…`);
      if (opts.forceComponent) console.log(`▸ forcing every graphic to ${opts.forceComponent}`);
      // A hung agy is indistinguishable from a working one on screen: the
      // 2026-08-23 field run sat on this spinner for 605.9s with no hint that
      // a budget existed or that a recovery was coming, which reads as a
      // freeze rather than as waiting (§149). Only antigravity has a
      // print-timeout and a fallback, so only it gets the notice — and only
      // once the call is actually slow, so a healthy run never sees it.
      const slowNotice =
        aiAnim && providerName === "antigravity"
          ? setTimeout(
              () =>
                // Short on purpose: StageAnimator clamps the subtitle to the
                // terminal width and floors that at 40 columns, and the first
                // draft lost the budget to "falling back to the n...". The
                // number is the only part that changes what the user does
                // (wait vs. Ctrl-C), so it has to survive the clamp.
                aiAnim.update(`agy not replying — falling back at ${AGY_PRINT_TIMEOUT}...`),
              AGY_SLOW_NOTICE_MS,
            )
          : undefined;
      const result = await phases
        .time("llm", () =>
          produceScenes(provider!, {
            transcript,
            outputDuration: map.outputDuration,
            intent: opts.intent,
            speaker: opts.speaker ?? cfg.speaker,
            forceComponent: opts.forceComponent,
            framing: framingCtx,
            aspect: landscape ? "16:9" : "9:16",
          }),
        )
        .finally(() => clearTimeout(slowNotice));
      if (aiAnim) aiAnim.stop();
      scenes = result.scenes;
      beatSheet = { hook: result.beatSheet.hook, coverText: result.beatSheet.coverText };
      fullSheet = result.beatSheet;
      console.log(`▸ hook: ${result.beatSheet.hook}`);
      console.log(
        `▸ planned ${result.beatSheet.moments.length} moments, ${scenes.length} scenes` +
          (result.failures.length > 0 ? ` (${result.failures.length} fell back to TitleCard)` : ""),
      );
      for (const issue of result.beatIssues) {
        console.log(`  ⚠ moment ${issue.moment}: ${issue.issue}`);
      }
      beatIssues = result.beatIssues;
      graphicsLine = formatGraphicsAccounting(
        result.graphics.delivered,
        result.graphics.asked,
        transcript,
      );
      // Cache props only — overrides are user-owned and live in overrides.json,
      // never in production.json (that file is derived and every `produce`
      // run overwrites it, per the merge rule in `overrides.ts`).
      // Keyed on who answered the beat_sheet call (§143) — see the clip-window
      // write above for why reads stay primary-keyed while writes do not.
      const freshKey = beatSheetCacheKey({
        ...beatKeyParts,
        providerName: actualProvider(provider.usage, "beat_sheet", providerName),
      });
      await writeFile(join(work, `scenes-${freshKey}.json`), JSON.stringify(scenes, null, 2));
      await writeFile(
        join(work, `beatsheet-${freshKey}.json`),
        JSON.stringify(
          { ...beatSheet, moments: fullSheet.moments, graphics: graphicsLine, issues: beatIssues },
          null,
          2,
        ),
      );
    }

    // ---- Sound effects (`--sfx`): the placement call -----------------------
    // HERE, inside the producer branch, because the placement prompt needs the
    // graphics plan in front of it (Approach A: a whoosh syncs with a graphic
    // entrance) — and because a beat sheet is the one thing this feature
    // cannot do without. `--scenes` and a plain run never reach this block;
    // the notice for that case is printed by the caller below.
    if (sfxOn) {
      sfxAttempted = true;
      const library = loadSfxLibrary(sfxLoad);
      for (const issue of library.issues) console.log(`  ⚠ sfx pack ${issue.pack}: ${issue.issue}`);
      if (library.sounds.length === 0) {
        // Warn and continue, never kill: an empty library is a packaging or a
        // user-pack problem, and it costs sound effects, not the video.
        console.log("  ⚠ sfx: no usable sounds in the library — skipping sound effects");
      } else {
        sfxSounds = library.sounds;
        const sfxKey = sfxCacheKey({
          promptVersion: SFX_PROMPT_VERSION,
          // The beat key, not its parts: the graphics plan is IN this prompt,
          // so a different sheet is a different question (see `sfxCacheKey`).
          beatKey: hitKey,
          level: sfxLevel,
          libraryHash: sfxLibraryHash(library.sounds),
          words: beatKeyParts.words,
        });
        const sfxCache = join(work, `sfx-${sfxKey}.json`);
        if (existsSync(sfxCache)) {
          // Parsed, never trusted — a cache file is as hand-editable as any
          // other artefact in the workdir. A malformed one is a re-plan, not a
          // crash, so it falls through to the call below.
          const cached = SfxPlanCacheSchema.safeParse(
            JSON.parse(await readFile(sfxCache, "utf8")),
          );
          if (cached.success) {
            sfxPlan = { level: sfxLevel, placements: cached.data.placements };
            sfxPlanned = cached.data.planned;
            sfxIssues = cached.data.issues;
            console.log(`▸ sfx cached (${sfxPlan.placements.length} placement(s), level ${sfxLevel})`);
          }
        }
        if (!sfxPlan && fullSheet === undefined) {
          // The one case the cache cannot cover: a workdir planned before
          // `--sfx` existed (or by a pre-2026-08-29 build) has scenes but no
          // moments, so there is no graphics plan to place against. Say what
          // to do rather than silently rendering a mute video.
          console.log(
            "  ⚠ sfx: this workdir's cached plan has no beat sheet to place against — " +
              "re-plan (delete its scenes-*.json) to get sound effects",
          );
        } else if (!sfxPlan) {
          console.log(`▸ placing sound effects (level ${sfxLevel})…`);
          const result = await phases.time("llm", () =>
            generateSfxPlan(provider!, transcript, fullSheet!, library.sounds, sfxLevel),
          );
          sfxPlan = { level: sfxLevel, placements: result.plan.placements };
          sfxPlanned = result.planned;
          sfxIssues = result.issues;
          await writeFile(
            sfxCache,
            // The accounting rides the cache for §78's reason, the same one
            // `graphics`/`issues` ride the beat-sheet cache: a cached re-run
            // must be able to print the SAME accounting line rather than
            // erasing it, and `planned` is a count only the call itself knew.
            JSON.stringify(
              { placements: sfxPlan.placements, planned: sfxPlanned, issues: sfxIssues },
              null,
              2,
            ),
          );
        }
        for (const issue of sfxIssues) {
          console.log(`  ⚠ sfx placement ${issue.placement}: ${issue.issue}`);
        }
      }
    }
  }

  // `--sfx` on a run that never reached the placement call — `--scenes` (which
  // is what the editor's Render replays), or a plain cut with no producer at
  // all.
  //
  // The plan carries FORWARD from the workdir's last `production.json` here
  // (Phase 3), and that is the scenes-reviewed doctrine applied to sound: an
  // editor render replays the REVIEWED state, and for SFX the reviewed state
  // is the prior plan plus overrides.json's edits on top of it (`priorSfxPlan`
  // has the full argument). The level comes from that record too — the user
  // reviewed effects placed at THAT level, and re-reading `--sfx-level` here
  // would describe them with a number they were never planned under. It is
  // written back below like any other run's plan, so a chain of editor renders
  // never breaks.
  //
  // No prior record is the only case left with nothing to carry: never a
  // silent ignore, and the message names the missing half rather than the flag
  // the user typed.
  if (sfxOn && !sfxAttempted) {
    const prior = priorSfxPlan(work);
    if (prior === undefined) {
      console.log(
        "  ⚠ sfx: sound effects are placed against the producer's beat sheet — " +
          "add --produce (the editor's re-plan) to get them",
      );
    } else {
      // The same library the producer branch loads, and for the same two
      // consumers: the resolver needs each sound's gain and path, the stager
      // needs its file. An empty library costs the effects, never the video.
      const library = loadSfxLibrary(sfxLoad);
      for (const issue of library.issues) console.log(`  ⚠ sfx pack ${issue.pack}: ${issue.issue}`);
      if (library.sounds.length === 0) {
        console.log("  ⚠ sfx: no usable sounds in the library — skipping sound effects");
      } else {
        sfxSounds = library.sounds;
        sfxPlan = prior;
        // `planned` is the reviewed plan's own size: this run made no model
        // call, so the only honest denominator for "N of M planned placed" is
        // what the user approved (the cached-plan branch's rule — the count
        // belongs to the plan, not to the run).
        sfxPlanned = prior.placements.length;
        console.log(
          `▸ sfx carried forward from the reviewed plan ` +
            `(${prior.placements.length} placement(s), level ${prior.level})`,
        );
      }
    }
  }

  // Every LLM call is behind us — repair, beat sheet, one per scene — so this
  // is where a run can finally answer "what did that cost" (FINDINGS §36).
  // A cached run legitimately spends nothing, and says so rather than
  // reporting a zero that looks like a bug.
  if (provider) {
    console.log(
      provider.usage.length === 0
        ? "▸ llm: no calls — repairs and scenes came from the workdir cache"
        : formatUsageLine(provider.usage, cfg.pricing),
    );
    // APPEND, never replace (R16 §78): a fully-cached re-run makes no calls,
    // and overwriting the file with `records: []` erased which provider had
    // planned the video. A malformed or pre-§78 file is a valid input — it
    // becomes the history's first entry rather than an error.
    const logPath = join(work, "usage.json");
    let existing: unknown = {};
    try {
      existing = JSON.parse(await readFile(logPath, "utf8"));
    } catch {
      existing = {};
    }
    const log = appendUsageRun(
      existing,
      { at: new Date().toISOString(), records: provider.usage, provider: providerName },
      cfg.pricing,
    );
    await writeFile(logPath, JSON.stringify(log, null, 2));
    // …and stamp it onto the artefact it explains, so `production.json` says
    // who planned it without a second file to cross-reference.
    const last = log.runs[log.runs.length - 1]!;
    // `last.provider` derives from records[0] — the FIRST call's provider,
    // which after a §143 timeout fallback is the primary that failed the
    // editorial call. The stamp answers "who planned this", so it is built
    // from the records that ANSWERED (`failed` attempts stay in usage.json
    // and every report — their cost is real — but a stamp listing the failed
    // attempt's placeholder model read "planned by claude-cli
    // (antigravity-default)" after a fallback run, 2026-08-22). Providers in
    // first-seen order, the same " → " rendering the usage report uses;
    // single-provider runs stamp exactly as before.
    const answered = provider.usage.filter((r) => !r.failed);
    const providersSeen = [...new Set(answered.map((r) => r.provider))];
    // A run that answered NOTHING must not restamp the artefact (§152). On a
    // fully cached run `answered` is empty, `last.provider` is the run we just
    // appended — whose provider is the one we ASKED for — and the stamp
    // silently rewrote a truthful "antigravity → claude-cli" into
    // "antigravity", crediting the plan to a provider that never produced it.
    // The plan did not change this run, so neither does its attribution.
    const priorStamp = existingProducerStamp(work);
    if (answered.length === 0 && priorStamp) {
      producerStamp = priorStamp;
    } else {
      producerStamp = {
        provider:
          providersSeen.length > 1
            ? providersSeen.join(" → ")
            : providersSeen[0] ?? last.provider ?? providerName,
        // `last.models` already excludes failed attempts' models (usage.ts,
        // same §143 rule) — a stamp that listed the timed-out placeholder read
        // "planned by claude-cli (antigravity-default)" after a fallback run.
        models: last.models,
        cached: last.cached,
        at: last.at,
      };
    }
  }

  // The overlay and the caption under it must spell the same word (§21).
  // The repair pass runs before the producer, so they normally already agree;
  // this catches the residue where the producer read through a mishearing the
  // repair pass missed ("Orchestration Tax" over a caption reading "text").
  // Word count and timings are untouched, so scene anchors stay valid.
  if (scenes.length > 0) {
    const reconciled = reconcileCopy(transcript, scenes);
    transcript = reconciled.transcript;
    repairs = [...repairs, ...reconciled.applied];
    for (const r of reconciled.applied) {
      console.log(`  ▸ caption "${r.heard}" → "${r.correction}" (matches the on-screen copy)`);
    }
  }

  // Deterministic dictionary casing (F4) — LAST word edit before the caption
  // build: after the repair reassignment and reconcileCopy above, so nothing
  // can lower-case a term back after this. Exact-token matches only ("json."
  // → "JSON."; "Jason" stays — phonetic judgement is the repair pass's job,
  // see dictionary.ts). `rawTranscript` stays untouched on purpose:
  // production.json stores the RAW words that `analysis`/`cutlist` index.
  transcript = canonicalizeDictionaryCasing(transcript, dictionary);

  // Landscape keeps the frame whole (R15): the split-screen layouts are
  // vertical-format answers, and applying them to 16:9 crops the picture into
  // a letterbox for no gain. Remapped here — before assembly — so cues,
  // captions, the framing report and the editor all see one set of layouts.
  if (landscape) {
    const remapped = scenes.filter((sc) => landscapeLayout(sc.layout) !== sc.layout);
    for (const sc of remapped) {
      console.log(`  ▸ ${sc.id}: ${sc.layout} → ${landscapeLayout(sc.layout)} (landscape)`);
      sc.layout = landscapeLayout(sc.layout);
    }
    if (remapped.length > 0) {
      console.log(`▸ ${remapped.length} scene(s) re-laid out for the 16:9 frame`);
    }

    // Layout VARIETY (R21 §101): the first real landscape run put nearly
    // every graphic in a lower third — legal, monotonous, and for stack
    // components actively broken (a BulletList's legibility floor cannot fit
    // 0.18 of frame height; it rendered cropped). Two deterministic rules in
    // time order: stack components never take the shallow band, and no two
    // consecutive graphics share a layout. The prompt asks the producer for
    // the same variety (see the aspect hint); this pass is the guarantee.
    // The editor's per-scene layout override still wins over all of it.
    const STACK_COMPONENTS = new Set<string>(["BulletList", "ChatMock", "TerminalMock"]);
    const VARIETY_CYCLE: Array<Scene["layout"]> = [
      "lower-third",
      "split-right",
      "blurred-behind",
      "split-left",
    ];
    let prevLayout: Scene["layout"] | null = null;
    let varied = 0;
    for (const sc of scenes) {
      let want = sc.layout;
      if (STACK_COMPONENTS.has(sc.component) && want === "lower-third") want = "split-right";
      if (want === prevLayout) {
        const alternatives = VARIETY_CYCLE.filter(
          (l) => l !== prevLayout && !(STACK_COMPONENTS.has(sc.component) && l === "lower-third"),
        );
        want = alternatives[Math.max(0, VARIETY_CYCLE.indexOf(want)) % alternatives.length]!;
      }
      if (want !== sc.layout) {
        console.log(`  ▸ ${sc.id}: ${sc.layout} → ${want} (landscape variety)`);
        sc.layout = want;
        varied++;
      }
      prevLayout = want;
    }
    if (varied > 0) console.log(`▸ ${varied} scene(s) re-laid out for variety`);
  }

  // ---- The user's edit layer: loaded here for `cuts` (PLAN 2026-08-04
  // Task 4) -------------------------------------------------------------
  // Everything ELSE the doc carries (scene props, splits, retyped captions)
  // still applies further down, AFTER assembly and routing, exactly as
  // before this feature existed — see the comment there. `cuts` is the one
  // exception: it changes `map` itself, and every downstream consumer of
  // `map` below this point (assembly, captions, the zoom plan, render-props)
  // must see the POST-cut timeline, so the file has to be read and the cut
  // applied before any of that runs.
  const overridesPath = join(work, "overrides.json");
  let overrideDoc = emptyOverrideDoc();
  if (existsSync(overridesPath)) {
    const parsed = OverrideDocSchema.safeParse(
      JSON.parse(await readFile(overridesPath, "utf8")),
    );
    if (!parsed.success) {
      // Hand-editable user data: refuse rather than silently resetting it.
      throw new Error(`${overridesPath} is not valid: ${parsed.error.message}`);
    }
    overrideDoc = parsed.data;
  }
  // ---- Cleanup choices: the user's veto over the AUTOMATIC cutlist (cut
  // review step 3) ------------------------------------------------------
  // Applied here — the same load `cuts` rides, before `applyUserCuts` — and
  // in exactly this order on purpose: cleanup vetoes reshape the PROPOSAL,
  // then user cuts subtract from the result as they always did, so a user
  // cut drawn over a vetoed pause still cuts (an explicit user action
  // outranks a veto). The proposal itself is captured FIRST for
  // `production.json`'s `cutlistProposed` — the resolution is lossy (a
  // vetoed removal merges into a plain keep), and the editor's checkboxes
  // re-derive the veto state from proposal + choices through the same
  // `applyCleanupChoices` this run used (ProductionSchema has the full why).
  // Consumers of `map` ABOVE this point (the repair pass's isCut guard, the
  // producer's outputDuration hint) saw the pre-veto map: both are
  // conservative uses — a refused word-merge across a span that comes back,
  // a duration hint a few seconds short — never a wrong cut.
  const cutlistProposed = cutlist;
  const cleanupVetoed = vetoedRemovals(cutlist, overrideDoc.cleanup);
  // Dismissed proposals ("not a retake", cut-review rework 2026-08-26)
  // re-keep exactly like vetoes — applyCleanupChoices owns the union — but
  // get their own line: a dismissal is "the classification was wrong", not
  // "kept this once", and the two must not read as one number.
  const cleanupDismissed = dismissedRemovals(cutlist, overrideDoc.cleanup);
  if (cleanupVetoed.length > 0 || cleanupDismissed.length > 0) {
    cutlist = applyCleanupChoices(cutlist, overrideDoc.cleanup);
    map = new TimeMap(cutlist);
    if (cleanupVetoed.length > 0) console.log(cleanupChoicesLine(cleanupVetoed, map.outputDuration));
    if (cleanupDismissed.length > 0) {
      const sec = cleanupDismissed.reduce((s, seg) => s + (seg.srcOut - seg.srcIn), 0);
      console.log(
        `▸ dismissed ${cleanupDismissed.length} marker(s) — ${sec.toFixed(1)}s kept as footage`,
      );
    }
  }
  // `applyUserCuts`'s `priorMap`: a cut's `startSec`/`endSec` (when it has
  // no `src` yet) and any already-re-anchored splits/pins are expressed
  // relative to whatever render-props the user was LAST looking at, not the
  // fresh automatic `map` this run just rebuilt — reusing `map` as "the
  // frame the doc is in" gets it wrong the moment ANYTHING drifts (review
  // fix wave finding 1 — confirmed for real on the dogfood workdir, where an
  // unrelated blooper-matching change put "output 31s" 5.8s away from where
  // the user actually pointed when they drew the cut). The PREVIOUS run's
  // `render-props.json` is exactly that frame; `null` (no readable
  // render-props.json — first-ever produce, or a corrupt workdir) is passed
  // through as-is rather than defaulting to `map` — `applyUserCuts` needs to
  // tell "no prior frame to compare against" apart from "available and
  // happens to equal `map`" (finding 3's re-anchor gate depends on it).
  const priorRenderProps = join(work, "render-props.json");
  let priorMap: TimeMap | null = null;
  if (existsSync(priorRenderProps)) {
    try {
      const prev = JSON.parse(await readFile(priorRenderProps, "utf8")) as { spans?: KeptSpan[] };
      if (prev.spans) priorMap = mapFromKeptSpans(prev.spans);
    } catch {
      // Unreadable/corrupt — treated the same as no prior run.
    }
  }
  const cutResult = applyUserCuts(overrideDoc, cutlist, map, priorMap);
  cutlist = cutResult.cutlist;
  map = cutResult.map;
  overrideDoc = cutResult.doc;
  // Backfill `splits[].src` ONCE for src-less legacy entries (cut-review
  // rework, 2026-08-26) — the `resolveCutSourceRanges` posture applied to
  // splits: after `applyUserCuts`, a legacy `at` speaks THIS run's clock
  // (remapped when the frames differed), so `map.toSource(at)` is exact.
  // Gated on `priorMap` like the cuts resolution: with no prior render-props
  // the frame `at` was drawn against is unknowable, and a guessed src would
  // be a wrong anchor forever. `at` stays verbatim — the historical record,
  // per SplitSchema.
  let splitSrcResolved = false;
  if (priorMap !== null) {
    const withSrc = overrideDoc.splits.map((s) => {
      if (s.src !== undefined || s.at === undefined) return s;
      splitSrcResolved = true;
      return { ...s, src: Math.round(map.toSource(s.at) * 1000) / 1000 };
    });
    if (splitSrcResolved) {
      overrideDoc = { ...overrideDoc, splits: withSrc };
      console.log(`▸ anchored ${withSrc.filter((s) => s.src !== undefined).length} split(s) to source time`);
    }
  }
  if (overrideDoc.cuts.length > 0) {
    console.log(
      `▸ ${overrideDoc.cuts.length} user cut(s) removed ${cutResult.removedSec.toFixed(1)}s ` +
        `of output (${map.outputDuration.toFixed(1)}s remaining)`,
    );
  }
  // Printed regardless of `cutResult.changed`: a missing-render-props
  // fallback (see `resolveCutSourceRanges`) is a decision worth saying out
  // loud even on a run that ends up writing nothing. The actual
  // `overrides.json` write — gated on `changed` — happens further down,
  // beside `render-props.json`'s own write (see the comment there for why).
  for (const r of cutResult.reports) console.log(`  ⚠ ${r}`);

  // Retire hides whose words this run's FINAL cutlist removes (§59b
  // revisited): the "captions + video" delete writes a hide (instant
  // preview) plus a cut (this run), and once the cut lands the cut
  // supersedes the hide — see `pruneHidesInsideCuts`. Pruned HERE, before
  // `reconcileCaptionEdits` applies the hide layer, so the retired keys
  // never surface as "the cut removed it" drop lines on this or any later
  // run. The doc write itself goes through the one sanctioned overrides.json
  // write further down, gated alongside `cutResult.changed`.
  const hidePrune = pruneHidesInsideCuts(overrideDoc, cutlist);
  overrideDoc = hidePrune.doc;
  const hidesPruned = hidePrune.pruned.length > 0;
  if (hidesPruned) {
    console.log(
      `▸ captions: ${hidePrune.pruned.length} hidden-word override(s) retired — their words are cut`,
    );
  }

  const { cues: assembled, dropped } = assembleScenes(scenes, transcript, map);
  for (const d of dropped) console.log(`  ⚠ scene ${d.id} dropped: ${d.reason}`);

  // Re-key scene edits whose positional id no longer means the moment they
  // were made on (handoff-edit-anchoring; §137 is the caption precedent — in
  // the field, scene-4 was a TerminalMock in one plan and a FlowDiagram in
  // the next, and the user's edit landed on the impostor). Placed HERE,
  // before ANY consumer of `overrideDoc.scenes`: the first `applyOverrides`
  // pass, `splitThenDropHidden` and the pinned-timing reclamp all join by id,
  // and a stale key at any of them bakes the misapply this plan exists to
  // kill — a `hidden` on a renumbered scene would hide the impostor, not the
  // moved moment. `assembled` is enough for the match: the remap reads only
  // anchored graphic cues, and take ids (which don't exist until the fill)
  // carry no anchors and are left untouched by design. Notes are non-empty
  // exactly when the doc changed, which is what earns the write-back its
  // turn at the sanctioned write below.
  const sceneRemap = remapSceneOverrides(overrideDoc, assembled);
  overrideDoc = sceneRemap.doc;
  for (const n of sceneRemap.notes) console.log(`  ▸ ${n}`);
  const sceneKeysRemapped = sceneRemap.notes.length > 0;

  // ---- Framing plan → props (2026-08-16 incident) --------------------------
  // The plan used to be BAKED here: every window cropped, scaled and
  // re-encoded into a content-<hash>.mp4 that replaced the source for the
  // whole rest of the pipeline. That was irreversible — a bad crop's only
  // remedy was deleting the baked file — and invisible: the bake path also
  // suppressed the `sourceSize` keys in render-props, so the editor could
  // not even see the crop it was fighting. The plan now travels as DATA
  // (`framingTimeline`, emitted with the props below) and the renderer
  // applies each window as a transform the editor can see and counteract.
  // Old workdirs' baked content-*.mp4 stay on disk, inert: their own
  // render-props reference them by name and must keep rendering.
  let fitFallback = false;
  if (framingPlan) {
    const plan = framingPlan;
    if (plan.ok) {
      console.log(
        `▸ framing: ${plan.segments.length} windows rendered from props (no re-encode)`,
      );
    } else {
      fitFallback = true;
      // A refusal names the number that tripped the gate. The upscale bound
      // is softness; the discard bound is picture loss — the 2026-08-16
      // incident's plan discarded 37% of the frame area and the old log
      // (upscale-only) never said so. The per-segment screen-loss bound has
      // no single headline number, so it reads as the residual case.
      const why = [
        ...(plan.coverUpscale > MAX_NORMALIZE_UPSCALE
          ? [`would upscale ×${plan.coverUpscale.toFixed(2)} > ${MAX_NORMALIZE_UPSCALE}`]
          : []),
        ...(plan.areaDiscardWeighted > MAX_MEAN_AREA_DISCARD
          ? [`would discard ${(plan.areaDiscardWeighted * 100).toFixed(0)}% of the picture`]
          : []),
      ];
      console.log(
        `  ⚠ strip too small to unify (${
          why.length > 0 ? why.join("; ") : "a screen segment would lose its content"
        }) — letterboxed stretches render FITTED at natural size; ` +
          `framing will visibly change at ${contentTimeline.length - 1} boundaries`,
      );
    }
  }
  const contentRect: ContentRect = detection.uniform ?? {
    x: 0, y: 0, w: sourceProbe.width, h: sourceProbe.height, full: true,
  };
  /** The picture's dimensions — what every geometric consumer reasons about. */
  const content = { width: contentRect.w, height: contentRect.h };
  // Computed ONCE and reused by both the accepted-side-image public-dir
  // check below and the real mezzanine build further down — one boolean,
  // not two independent copies of the same condition that could silently
  // drift apart (Finding 3, final-review fix wave: that drift is exactly
  // what let an accepted image 404 inside Remotion's staticFile()).
  // The old `analysisInput === input` term is gone WITH the bake: the bake
  // was the only thing that ever pointed analysis at a different file, so
  // with framing as props the analysis input IS the source, always.
  const mezzanineWillBuild = opts.mezzanine || !contentRect.full;

  // Face measurement (FINDINGS §13): one static crop offset per source,
  // measured rather than guessed; cached in the workdir like the transcript.
  const faceSamples = 9;
  const faceSampleAnim = isInteractive()
    ? new StageAnimator(
        "FACE POSITIONING",
        `Sampling ${faceSamples} frames for speaker eye-line & crop framing...`,
        "render",
      ).start()
    : null;
  const faceBox = await measureFace(tools, input, sourceProbe.duration, {
    cacheDir: work,
    cropVf,
    samples: faceSamples,
  });
  if (faceSampleAnim) faceSampleAnim.stop();
  console.log(
    faceBox
      ? `▸ face at ${(faceBox.centerYFrac * 100).toFixed(0)}% down the frame, ` +
          `${(faceBox.sizeFrac * 100).toFixed(0)}% tall ` +
          `(${faceBox.framesDetected}/${faceBox.framesSampled} frames` +
          `${faceBox.framesRotated ? `, ${faceBox.framesRotated} recovered by tilt sweep` : ""})`
      : // A miss must be LOUD (PLAN Task 8): the silent fallback to the
        // assumed selfie framing is how a wrong crop shipped unnoticed.
        `▸ no face detected in ${faceSamples} sampled frames — using the ASSUMED framing; ` +
          "the crop may be wrong, check the output",
  );

  // Whatever the source's aspect doesn't share with the frame, a cover crop
  // trims — and how much is arithmetic, not opinion. Said out loud because
  // the result LOOKS deliberate — a tight talking head — and nothing else in
  // the run would mention that the desk, the screen and the second person
  // are simply gone. Orientation-neutral on purpose: the old `!landscape`
  // gate assumed a 16:9 output never crops a 16:9-ish source, and the
  // 2026-08-16 incident (a 1.547:1 screen recording in a 16:9 frame — 13% of
  // the height silently gone, 28% post-normalization) shipped without a word.
  const coverKeep = coverKeepFraction(content, frame);
  if (opts.sourceFit !== "contain" && coverKeep && coverKeep.kept < 0.95) {
    console.log(
      `▸ source is ${(content.width / content.height).toFixed(2)}:1 — a full-frame crop keeps ` +
        `${(coverKeep.kept * 100).toFixed(0)}% of its ${coverKeep.axis}. ` +
        "Use --source-fit contain to show the whole frame instead.",
    );
  }

  // ---- Route around the source's own burned-in text (FINDINGS §26) --------
  // Fed a finished reel, ossclip would otherwise stack its layer on an
  // existing one — cropping through the source's title and then restating it
  // underneath. Graphics move to a clear slot or are skipped; captions never
  // are, they just relocate.
  //
  // Behind --source-is-edited since R27 §120. The detector cannot tell burned-in
  // GRAPHICS from text that is simply in the room, and on a raw take at a desk
  // it read the background monitors as 45 bands of "source text". The cost is
  // not cosmetic: every graphic was then moved and SHRUNK to a free band —
  // a BulletList pinned to its 36px font floor, a FlowDiagram's slot halved
  // (0.54 → 0.27, type 71 → 35), and a ScreenshotFrame slid onto the speaker's
  // face. Routing around a hazard only pays when there is a hazard, and only
  // the user knows whether their source is already edited.
  const sourceText = opts.sourceIsEdited
    ? await scanSourceText(tools, input, sourceProbe.duration, {
        cacheDir: work,
        assumeEdited: true,
        cropVf,
      })
    : { regions: [], assumed: false, framesSampled: 0 };
  if (sourceText.regions.length > 0) {
    console.log(
      sourceText.assumed
        ? "▸ --source-is-edited: assuming burned-in text in the title and caption bands"
        : `▸ source already has on-screen text in ${sourceText.regions.length} band(s) ` +
            `(${sourceText.framesSampled} frames sampled)`,
    );
  }
  // Detection reports SOURCE time; everything downstream — cues, captions, the
  // crop — is output time. Identical only while nothing is cut, so convert
  // rather than let a cut silently slide every region out of place. Regions
  // whose window is entirely removed drop out with it.
  const textRegions = sourceText.regions.flatMap((r) => {
    if (!Number.isFinite(r.endSec)) return [{ ...r, startSec: 0, endSec: map.outputDuration }];
    const startSec = map.toOutputClamped(r.startSec);
    const endSec = map.toOutputClamped(r.endSec);
    return endSec > startSec ? [{ ...r, startSec, endSec }] : [];
  });
  // The frame matters here: the splits separate by X in 16:9, so routing that
  // assumed portrait decided against geometry that is not what renders (§120).
  const routed = routeAroundSourceText(assembled, textRegions, frame);
  for (const r of routed.relayouts) {
    console.log(`  ▸ scene ${r.id}: ${r.from} → ${r.to} (source text in the way)`);
  }
  for (const m of routed.moved) {
    console.log(
      `  ▸ scene ${m.id}: graphic moved into the free band at ` +
        `${(m.y * 100).toFixed(0)}-${((m.y + m.h) * 100).toFixed(0)}%`,
    );
  }
  // Name the destination layout and stop there. The target is whichever
  // alternate the component declares that videoObstacleFor clears, and the
  // two answers do not look alike: `blurred-behind` blurs and dims the
  // picture (clause 3), while `graphic-only` hides it outright at opacity 0
  // (clause 1). Three components declare each, so promising a blurred
  // backdrop would have been a lie half the time (§120).
  for (const o of routed.overlaid) {
    console.log(
      `  ▸ scene ${o.id}: ${o.from} → ${o.to} (no room clear of the video — ` +
        `moved to ${o.to})`,
    );
  }
  for (const s of routed.skipped) console.log(`  ⚠ scene ${s.id} skipped: ${s.reason}`);

  // Source-text routing picks from a component's `altLayouts`, which include
  // the vertical split layouts — so in landscape it can hand back exactly what
  // the remap above removed. Re-assert the constraint on its OUTPUT, and say
  // when that costs a text dodge: the graphic keeps whatever free-band rect
  // routing gave it, but the frame stays whole (R15).
  if (landscape) {
    for (const c of routed.cues) {
      const want = landscapeLayout(c.layout);
      if (want === c.layout) continue;
      console.log(
        `  ▸ ${c.id}: ${c.layout} → ${want} (landscape; source-text routing had moved it)`,
      );
      c.layout = want;
    }
  }

  // ---- The user's edit layer (SPEC: direct manipulation) -------------------
  // `overrideDoc` was already loaded above (before assembly, so `cuts` could
  // reshape `map` in time) — applied here, AFTER assembly and routing, so
  // hand edits sit on top of whatever the producer just planned. Never
  // written to production.json — that file is ours to overwrite.
  // Src-anchored pins (SceneTimingSchema) resolved onto THIS run's clock
  // before anything merges them — the same posture as `resolveSplitPoints`
  // below, and the reason `applyOverrides` never takes a map. A LOCAL doc,
  // deliberately not written back over `overrideDoc`: its `timing` entries
  // are now output seconds, and letting one of those reach the sanctioned
  // overrides.json write would spend the source anchor and put the pin back
  // on a clock the next re-cut moves.
  const pinnedDoc = resolveSrcTimingPins(overrideDoc, map);
  for (const r of pinnedDoc.reports) console.log(`  ⚠ ${r}`);
  const { cues: editedCues } = applyOverrides(routed.cues, pinnedDoc.doc);
  // Scenes the user deleted in the editor drop here — their windows become
  // plain takes in the fill below, which is Task C's payoff for Task A.
  // `splitThenDropHidden`, not a bare `dropHiddenCues`: this runs before
  // `splitCues` below, so a hidden ROOT id (`scene-6`) used to erase its
  // whole pre-split window — both the half it names and the half a stored
  // split (R16 §61) had already carved off — before that split ever got a
  // chance to separate them (PLAN 2026-08-04 Task 1, bug 3).
  const { cues: visibleCues, hidden: hiddenIds } = splitThenDropHidden(editedCues, overrideDoc);
  if (hiddenIds.length > 0) {
    console.log(`▸ ${hiddenIds.length} scene(s) hidden by the edit layer: ${hiddenIds.join(", ")}`);
  }
  // Config theme as the BASE (F6): overrides.json > config theme >
  // defaultTheme. The same `configBaseTheme` feeds props.baseTheme below.
  const theme = resolveTheme(configBaseTheme, overrideDoc);

  // A pin freezes a scene's ABSOLUTE time against whatever its neighbours'
  // timing was when it was set. This same plan may since have re-anchored
  // those neighbours (a `--cleanup` level change, new source material), so
  // the pin can now overlap one of them or leave the array out of time
  // order — re-clamp it here, the same way the editor clamps a pinned nudge
  // at drag time, rather than letting an overlap reach `SceneLayer`/
  // `buildCaptionLines`.
  const { cues: reclamped, adjusted } = reclampPinnedTiming(visibleCues);
  for (const id of adjusted) {
    console.log(`  ⚠ pinned timing for ${id} overlapped a re-planned neighbour — clamped back in bounds`);
  }

  // Fill the timeline (PLAN 2026-07-30 Task A): every gap between graphic
  // cues becomes a plain take, split at the cuts so a block never straddles
  // one. Then a SECOND override pass, because the user's framing edits on
  // `take-*` ids target cues that only exist after the fill. That pass is a
  // no-op on the graphic cues it already touched — same component ⇒ no swap
  // ⇒ the prop merge is idempotent — so do not "simplify" it away. Orphans
  // are reported from THIS pass: only now does the id universe include the
  // takes, so a `take-2-1` edit whose take merged away reports here instead
  // of every take id reporting on the first pass.
  // Kept/dismissed removal edges ride along as extra clipStarts (cut-review
  // rework, 2026-08-26): a veto merges two kept spans into one, which would
  // otherwise change the clip count and silently re-target every `take-N`
  // framing edit after it (§155's misapply class). With the edges preserved,
  // the fill still cuts where the boundaries were, and `carveKeptTakes`
  // below owns the revived middle.
  const keptRangesForCarve = [
    ...cleanupVetoed.map((seg) => ({ srcIn: seg.srcIn, srcOut: seg.srcOut })),
    ...cleanupDismissed.map((seg) => ({ srcIn: seg.srcIn, srcOut: seg.srcOut, dismissed: true })),
  ];
  const keptEdgeStarts = keptRangesForCarve.flatMap((r) => {
    const a = map.toOutput(r.srcIn);
    const b = map.toOutput(r.srcOut);
    return [...(a !== null ? [a] : []), ...(b !== null ? [b] : [])];
  });
  const filled0 = fillPlainCues(reclamped, {
    outputDurationSec: map.outputDuration,
    clipStarts: [...map.spans.map((s) => s.outIn), ...keptEdgeStarts],
  });
  // Revived material as a first-class block — same carve the editor previews
  // with (`carveKeptTakes`'s one-implementation-two-callers doc), so
  // `take-kept-*` ids exist server-side and framing edits on them land in
  // the second override pass below instead of orphaning.
  const { cues: filled, reports: carveReports } = carveKeptTakes(filled0, keptRangesForCarve, map);
  for (const r of carveReports) console.log(`  ⚠ ${r}`);
  // User splits (R16 §61) — after the fill so takes split like scenes, and
  // before the final override pass so edits on the `id@<split id>` halves land
  // (the suffix is the split's own minted id, §137, not its time). A
  // split whose ROOT was a graphic scene already happened once inside
  // `splitThenDropHidden` above (PLAN 2026-08-04 Task 1) — re-running it here
  // is a no-op for that scene (the split point sits exactly on the joint
  // between the two halves, matching neither), so this call stays the one
  // that actually cuts TAKE ids, which don't exist until the fill just ran.
  // Resolved onto THIS run's clock: `src` (the recut-immune anchor) wins,
  // src-less legacy entries pass their re-anchored `at` through, and a src
  // sitting in removed material is inert with a report (resolveSplitPoints'
  // doc owns the posture).
  const resolvedSplits = resolveSplitPoints(overrideDoc.splits, map);
  for (const r of resolvedSplits.reports) console.log(`  ⚠ ${r}`);
  const split = splitCues(filled, resolvedSplits.points);
  if (overrideDoc.splits.length > 0) {
    console.log(`▸ ${overrideDoc.splits.length} scene split(s) from the edit layer`);
  }
  // `pinnedDoc.doc` again, not `overrideDoc`: this pass is on the SAME clock
  // as the first (the split above does not move time), and a src pin that
  // reached here unresolved would be ignored rather than applied.
  const { cues: mergedCues, orphans: rawOrphans } = applyOverrides(split, pinnedDoc.doc);
  // Halves of a TAKE the user deleted after splitting: a take id only exists
  // once the fill above runs, so its `id@<split id>` half couldn't have been seen by
  // `splitThenDropHidden` earlier (that pass only ever saw graphic scenes).
  // Scene halves were already caught above; this is a no-op for them. Same
  // order as the editor's live memo.
  const { cues: sceneCues, hidden: hiddenHalves } = dropHiddenCues(mergedCues, overrideDoc);
  if (hiddenHalves.length > 0) {
    console.log(`▸ ${hiddenHalves.length} split half(s) hidden by the edit layer`);
  }
  // A hidden scene's id is absent from the filled list by construction —
  // that's a deletion doing its job, not a lost edit.
  const orphans = rawOrphans.filter((id) => !hiddenIds.includes(id));
  const editedCount = Object.keys(overrideDoc.scenes).length;
  if (editedCount > 0) {
    console.log(`▸ applied your edits to ${editedCount - orphans.length - hiddenIds.length} scene(s)`);
  }
  for (const id of orphans) {
    console.log(orphanEditLine(id));
  }

  const graphicCues = sceneCues.filter((c) => c.kind !== "plain");
  if (graphicCues.length > 0) {
    console.log(
      `▸ ${graphicCues.length} scene(s) on stage, ` +
        `${sceneCues.length - graphicCues.length} plain take(s) filling the gaps: ` +
        graphicCues.map((c) => `${c.component ?? c.id}@${c.startSec.toFixed(1)}s`).join(", "),
    );
  }

  // Grounding post-check (FINDINGS §14a): flags label tokens the take never
  // says — a hallucinated hook label is visible here without watching the video.
  //
  // Checked against the copy that will actually RENDER, overrides included
  // (R27 §124). It used to read the producer's raw scenes, so it was wrong in
  // both directions: it kept reporting invented copy the user had already
  // fixed by hand — the warning outlived the defect, which teaches people to
  // ignore warnings — and it never looked at copy the user typed themselves.
  // `checkGrounding` already merges a scene's `overrides` slot; nothing was
  // filling it from `overrides.json`.
  const scenesAsRendered = scenes.map((s) => {
    const edit = overrideDoc.scenes[s.id]?.props;
    return edit && Object.keys(edit).length > 0
      ? { ...s, overrides: { ...s.overrides, ...edit } }
      : s;
  });
  const groundingIssues = checkGrounding(scenesAsRendered, transcript, opts.speaker ?? cfg.speaker);
  for (const g of groundingIssues) {
    console.log(`  ⚠ grounding: ${g.component} ${g.sceneId} ${g.field} "${g.token}" — not in the take`);
  }

  // CTA-keyword post-check: the keyword mechanic renders ONE shape of ask, and
  // a "reply with a number" prompt is not it. Dropping the prop here — before
  // the cue, the scene file and the caption track ever read it — is what makes
  // ChatMock fall back to rendering the exchange the producer actually planned
  // (`chatBubbles` collapses to a single bubble only while a keyword is set).
  const ctaRejections: Array<{ sceneId: string; keyword: string; reason: string }> = [];
  for (const holder of [...scenes, ...graphicCues]) {
    const kw = holder.props?.keyword;
    if (typeof kw !== "string" || kw.length === 0) continue;
    const reason = rejectCtaKeyword(kw);
    if (!reason) continue;
    delete (holder.props as Record<string, unknown>).keyword;
    ctaRejections.push({ sceneId: holder.id, keyword: kw, reason });
  }
  // Scenes and cues carry the same resolved props, so each rejection is seen
  // twice; report the word once.
  for (const r of [...new Map(ctaRejections.map((r) => [r.keyword, r])).values()]) {
    console.log(`  ⚠ CTA keyword dropped — ${r.reason}`);
  }

  // ScreenshotFrame `src` must name a file that EXISTS (R22 §112). The
  // producer reads the transcript and will happily invent a plausible
  // filename from it — a take that says "CLAUDE.md" produced
  // `src: "claude.md"` — and Remotion treats an unloadable image as a fatal
  // render error, so the whole run died at 40% after four minutes of work.
  // The prop is optional and the component already draws a styled
  // placeholder without it, so dropping the bad reference degrades exactly
  // the way the schema intended. Checked against the directories that can
  // become the render's public dir: the workdir (mezzanine path) and the
  // source's own folder (--no-mezzanine) — which for a FOLDER run is
  // `dirname(input)` no longer, review fix: `input` was already reassigned
  // to `source-concat.mp4` inside `work` by this point, so `dirname(input)`
  // IS `work` and that branch was silently checking the same directory
  // twice. `originalInput` (the folder itself) is the natural place someone
  // would actually drop an image for a folder run.
  //
  // Finding 3 (final-review fix wave): accepting an image from a sideDir is
  // NOT the same as the render being able to load it — Remotion's
  // `staticFile()` only ever looks in ONE directory, `dirname(renderVideo)`.
  // `planRenderPublicDir` computes that same directory from the
  // `mezzanineWillBuild` boolean set above (shared with the real
  // `renderVideo` assignment further down, so the two can't disagree about
  // which directory wins). An image accepted from a sideDir that isn't THAT
  // directory used to pass this check and then 404 mid-render — a failure
  // that surfaced only after the whole pipeline had already spent its budget
  // getting there. The fix is to make the two agree by construction: copy
  // the file into the render's public dir the moment it's accepted from
  // anywhere else. This also retires the "latent" file-input+mezzanine case
  // the reviewer found pre-existing: an image beside a source video that
  // then gets mezzanine'd (the default) was accepted from `dirname(input)`
  // but the mezzanine's public dir is `work` — same failure shape, one
  // branch earlier.
  //
  // Second pass (Important, unsanitized copy destination): `src` drove a
  // read-only `existsSync` before this fix, which was an acceptable risk;
  // once it also drove `mkdirSync(recursive) + copyFileSync` destinations,
  // an unconstrained LLM-authored string became a write primitive. Every
  // `src` is checked with `isSafeScreenshotSrc` BEFORE the lookup (not just
  // before the copy), and every copy lands under `SIDE_IMAGE_SUBDIR` via
  // `planScreenshotSrcCopy` — see those two functions for why.
  const srcRejections: Array<{
    sceneId: string;
    src: string;
    reason: "unsafe" | "not-found" | "conflict";
  }> = [];
  const srcCopies: Array<{ src: string; from: string; destRel: string }> = [];
  const sideDirs = isFolder ? [work, originalInput] : [work, dirname(input)];
  const renderPublicDirPath = planRenderPublicDir({
    input,
    // Literal since the framing bake became render-props (2026-08-16): the
    // bake was the only path that ever analysed a file other than the input.
    // The parameter (and its platform matrix test) stays, because it encodes
    // the contract "a non-input analysis file must live in `work`" — the
    // thing any future re-introduction of such a file has to get right.
    inputIsAnalysisInput: true,
    mezzanineWillBuild,
    work,
  });
  for (const holder of [...scenes, ...graphicCues]) {
    const src = holder.props?.src;
    if (typeof src !== "string" || src.length === 0) continue;
    // A remote URL is the renderer's job, not a file to look up or copy —
    // see `isRemoteScreenshotSrc` for why this must come before the safe-src
    // check (which would otherwise reject it with a misleading message).
    if (isRemoteScreenshotSrc(src)) continue;
    if (!isSafeScreenshotSrc(src)) {
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "unsafe" });
      continue;
    }
    const foundDir = sideDirs.find((dir) => existsSync(join(dir, src)));
    if (!foundDir) {
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "not-found" });
      continue;
    }
    if (foundDir === renderPublicDirPath) continue; // already where the render will look
    // `sideImageDestRel` is POSIX-literal (see its own comment for why);
    // `destAbs` below is a normal `join()` since it IS a filesystem path,
    // not a served URL.
    const destRel = sideImageDestRel(src);
    const destAbs = join(renderPublicDirPath, destRel);
    const sourceAbs = join(foundDir, src);
    const destExists = existsSync(destAbs);
    const plan = planScreenshotSrcCopy({
      exists: destExists,
      identical: destExists && filesIdentical(sourceAbs, destAbs),
    });
    if (plan === "conflict") {
      // A DIFFERENT file already answers to this basename in side-images/ —
      // refuse rather than let one scene's image silently clobber another's
      // (same "warn + drop" treatment as not-found, not an overwrite).
      delete (holder.props as Record<string, unknown>).src;
      srcRejections.push({ sceneId: holder.id, src, reason: "conflict" });
      continue;
    }
    if (plan === "copy") {
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(sourceAbs, destAbs);
      srcCopies.push({ src, from: foundDir, destRel });
    }
    // `skip-identical` and `copy` both end with the file at `destAbs` —
    // rewrite the prop so `staticFile()` resolves the NEW location, not the
    // original bare name (which no longer lives at the public dir's root).
    (holder.props as Record<string, unknown>).src = destRel;
  }
  for (const r of [...new Map(srcRejections.map((r) => [r.src, r])).values()]) {
    const why =
      r.reason === "unsafe"
        ? "names a path, not a bare filename — refusing to let it drive a file lookup"
        : r.reason === "conflict"
          ? `a DIFFERENT file already answers to "${basename(r.src)}" in ${SIDE_IMAGE_SUBDIR}/`
          : `not found in the workdir or ${isFolder ? "the source folder" : "beside the source video"}`;
    console.log(`  ⚠ image "${r.src}" ${why} — rendering the frame as a placeholder instead`);
  }
  for (const c of [...new Map(srcCopies.map((c) => [c.src, c])).values()]) {
    console.log(`  ▸ image "${c.src}" copied into ${c.destRel} (found in ${c.from})`);
  }
  // Audit fix: on a --no-mezzanine file run the render's public dir is the
  // source video's OWN folder, so the copies above just wrote a
  // `side-images/` subfolder into a directory the user owns — say so rather
  // than leaving them to discover an unexplained folder beside their input.
  if (srcCopies.length > 0 && renderPublicDirPath !== work) {
    console.log(
      `  ▸ note: rendering without a mezzanine serves images from the source's folder — ` +
        `created ${SIDE_IMAGE_SUBDIR}/ in ${renderPublicDirPath}`,
    );
  }

  // ---- Sound effects: word anchors → cues, and the files they name --------
  // AFTER the cut is final (`applyUserCuts` above) and after the public dir is
  // known, because both are inputs: a placement anchored to a word the user's
  // own cut removed is dropped here, and the copies must land where
  // `staticFile()` will look.
  let sfxCues: SfxCue[] = [];
  /** Planning drops + render drops, counted together by the one accounting
   * line the console and report.txt share (`formatSfxAccounting`). */
  let sfxAllIssues: SfxValidationIssue[] = sfxIssues;
  let sfxLine: string | undefined;
  if (sfxPlan) {
    // The user's layer FIRST (Phase 3): retimes, swaps, gains, mutes and the
    // placements they added themselves, applied before any of the resolver's
    // arithmetic so a dragged effect is timed, cut-checked and mixed exactly
    // like a planned one. `sfxPlan` itself is left alone — production.json
    // stores the MODEL's plan, which is what these edit keys are derived from
    // (`sfxPlacementKey`), and folding them in would re-key the whole layer on
    // the next run.
    const edited = applySfxOverrides(sfxPlan.placements, overrideDoc.sfx);
    for (const d of edited.dropped) {
      console.log(
        d.reason === "stale key"
          ? `  ⚠ sfx edit "${d.key}" no longer matches any planned placement — ` +
              `the re-plan dropped it`
          : `  ⚠ sfx edit "${d.key}" matches more than one placement — applied to the first`,
      );
    }
    // The accounting's denominator moves with the user's layer, because the
    // layer changes the SIZE of the plan the resolver saw: a mute REMOVES a
    // placement (it was un-planned by the user, not dropped by the pipeline)
    // and an add appends one. Without this, muting an effect would print as a
    // reasonless "1 dropped" and adding one as "6 of 5 planned placed".
    sfxPlanned += edited.placements.length - sfxPlan.placements.length;
    const resolved = resolveSfxCues(edited.placements, transcript, map, sfxSounds, {
      // The real check, injected (the resolver stays pure): a pack deleted
      // between planning and this render must cost the cue here, not a
      // Remotion 404 after the render has spent its minutes.
      exists: existsSync,
      // The scene timing context, from `sceneCues` — the FINAL list, with the
      // user's moves, trims, splits, pins and deletes already applied. That is
      // the whole point of the scene link (2026-08-29): a whoosh placed "as
      // the TitleCard enters" fired at a word, so moving the card in the
      // editor left the sound behind. Reading the producer's raw `scenes`
      // here instead would rebuild that bug exactly.
      sceneStarts: sceneStartSeconds(sceneCues),
    });
    sfxCues = resolved.cues;
    sfxAllIssues = [...sfxIssues, ...resolved.dropped];
    for (const d of resolved.dropped) console.log(`  ⚠ sfx: ${d.issue}`);
    // Staged into the render's public dir AND the workdir when they differ,
    // for the Nastaliq font's reason verbatim: the render bundles
    // `dirname(renderVideo)`, `ossclip edit` serves the workdir, and both
    // mounts fetch the same served name. Only the sounds actually CUED are
    // copied — the library is a menu, not a payload.
    const staged = new Set(sfxCues.map((c) => c.soundFile));
    for (const sound of sfxSounds) {
      const rel = sfxStagedFile(sound);
      if (!staged.has(rel)) continue;
      for (const dir of new Set([renderPublicDirPath, work])) {
        // `join` on the filesystem side where `rel` itself stays
        // POSIX-literal — it is a served URL, these are paths (the
        // `sideImageDestRel` split).
        const dest = join(dir, ...rel.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(sound.absPath, dest);
      }
    }
    sfxLine = formatSfxAccounting(sfxCues.length, sfxPlanned, sfxPlan.level, sfxAllIssues);
    console.log(`▸ ${sfxLine}`);
  }

  const production: Production = {
    version: 1,
    // `originalInput`, not `input`: for a folder run `input` is by now
    // `<workdir>/source-concat.mp4`, and `source.path` only feeds
    // `report.txt`'s printed "source:" line (checked — nothing resolves a
    // file against it) — so it should say what the user actually pointed
    // produce at (final-review fix wave, cheap minor a), same fix shape as
    // `defaultOutPath` above.
    source: { path: originalInput, probe: sourceProbe, audioPath, face: faceBox },
    cleanup: opts.cleanup,
    intent: opts.intent,
    // The RAW transcript, because `analysis` and `cutlist` index into it —
    // storing the repaired one here would leave those pointing at words that
    // no longer exist. Repairs are kept alongside so the repaired transcript
    // stays derivable (`applyRepairs`) rather than being a second truth.
    transcript: rawTranscript,
    repairs: repairs.length > 0 ? repairs : undefined,
    analysis,
    // The APPLIED truth vs the PROPOSAL — see ProductionSchema for why both
    // are recorded: `cutlist` keeps the report/exporters honest about what
    // happened; `cutlistProposed` keeps the declined categories recoverable
    // for the editor (a vetoed removal merges into a plain keep, so the
    // resolved list alone cannot name what was declined).
    cutlist,
    cutlistProposed,
    ...(clipWindow && clipTargetSec !== undefined
      ? { clip: { targetSec: clipTargetSec, ...clipWindow } }
      : {}),
    scenes: scenes.length > 0 ? scenes : undefined,
    // The PLAN, not the cues: word anchors survive a re-cut and the editor
    // edits them (Phase 3), while `render-props.json` carries the resolved
    // instants. Absent when this run has no sound design, so a no-`--sfx`
    // production.json is byte-identical to a pre-feature one.
    sfx: sfxPlan,
    producer: producerStamp,
    theme,
    // The EFFECTIVE output size, not the base frame (`--resolution`): this is
    // what the file on disk actually is, and it is read downstream by the
    // mezzanine's scale decision, the NLE exports and the editor — all of
    // which would otherwise describe a 1080p file that isn't there.
    render: { width: output.width, height: output.height, fps: 30 },
  };
  await writeFile(join(work, "production.json"), JSON.stringify(production, null, 2));

  let report = formatCutReport(production);
  // §93h: a tool that discards 19 of 20 minutes owes the user an account of
  // why those 19 — the window, its share of the take, and the model's reason.
  if (clipWindow && clipTargetSec !== undefined) {
    const dur = clipWindow.endSec - clipWindow.startSec;
    report +=
      `\nclip window (--clip ${clipTargetSec}):\n` +
      `  ${formatClipTime(clipWindow.startSec)}–${formatClipTime(clipWindow.endSec)} of ` +
      `${formatClipTime(sourceProbe.duration)} (${dur.toFixed(1)}s selected, ` +
      `${((dur / sourceProbe.duration) * 100).toFixed(0)}% of the take)\n` +
      `  reason: ${clipWindow.reason}\n`;
  }
  // §122: a cut that takes whole sentences owes the user the words it took —
  // the timestamps above say WHERE, not what was lost.
  if (bloops.length > 0) {
    report +=
      `\nbloopers cut (you said "${opts.blooperMarker}" — FINDINGS §122):\n` +
      bloops.map((b) => `  ${formatBloopSpan(rawTranscript, b)}`).join("\n") +
      "\n";
  }
  // §128: same reasoning as §122's block above, for the flub the speaker did
  // NOT say a marker over — kept / cut (with similarity) / ignored as a
  // hallucination (with its silence fraction), in the words `report.txt`
  // already trusts. Runs automatically with --blooper-marker (2026-08-16
  // gate decision, inferredRetakesEnabled); a clean run recorded here is
  // still the promotion evidence the §128 appendix asks for.
  if (retakeGroups.length > 0) {
    report +=
      "\nretakes collapsed (runs with --blooper-marker — FINDINGS §128):\n" +
      retakeGroups.map((g) => formatRetakeGroup(rawTranscript, g)).join("\n") +
      "\n";
  }
  // PLAN 2026-08-04 Task 4: the removed ranges themselves are already in the
  // report above (`formatCutReport` walks `production.cutlist`, and the
  // subtracted spans carry `reason: "user"`) — this section is specifically
  // for what a cut MOVED: a decision that landed on a cut edge must be
  // visible here, never silently repositioned.
  if (cutResult.changed && cutResult.reports.length > 0) {
    report +=
      "\noverrides re-anchored by your cut (nothing moved silently):\n" +
      cutResult.reports.map((r) => `  ${r}`).join("\n") +
      "\n";
  }
  const landed = repairs.filter((r) => r.applied);
  if (landed.length > 0) {
    report +=
      "\ntranscript repairs (mishearings corrected before captions — FINDINGS §17/§21):\n" +
      landed.map((r) => `  "${r.heard}" → "${r.correction}"`).join("\n") +
      "\n";
  }
  const refused = repairs.filter((r) => !r.applied);
  if (refused.length > 0) {
    report +=
      "\nrepairs refused (proposed but not a mishearing):\n" +
      refused.map((r) => `  "${r.heard}" → "${r.correction}": ${r.rejected}`).join("\n") +
      "\n";
  }
  if (groundingIssues.length > 0) {
    report +=
      "\ngrounding warnings (labels the take never says — FINDINGS §14):\n" +
      groundingIssues
        .map((g) => `  ${g.component} ${g.sceneId} ${g.field}: "${g.token}"`)
        .join("\n") +
      "\n";
  }
  // §118b: the graphics count justified in the artefact, like every cut is —
  // delivered vs asked and why, then the scheduler's own account of what it
  // demoted. The shortfall issue repeats the accounting line, so it is the
  // one issue not reprinted here.
  if (graphicsLine) {
    report +=
      `\n${graphicsLine} (FINDINGS §118)\n` +
      beatIssues
        .filter((i) => !i.issue.startsWith("graphics:"))
        .map((i) => `  ⚠ moment ${i.moment}: ${i.issue}\n`)
        .join("");
  }
  // The SFX accounting, the graphics block's contract exactly (§118b): ONE
  // formatter feeds the console line printed above and this one, so the two
  // can never say different things about the same run. The drops are listed
  // under it for the same reason the beat issues are listed under the graphics
  // line — the number alone does not say WHICH effect went missing.
  if (sfxLine) {
    report +=
      `\n${sfxLine}\n` +
      sfxAllIssues.map((i) => `  ⚠ placement ${i.placement}: ${i.issue}\n`).join("");
  }
  if (provider) {
    report += formatUsageReport(provider.usage, cfg.pricing);
    // A cached run has no usage block to print, and used to leave the report
    // silent about who planned the video (R16 §78) — the same erasure the
    // usage log had. Name the provider it is reusing.
    if (provider.usage.length === 0 && producerStamp) {
      report +=
        `\nllm: no calls this run — planned by ${producerStamp.provider}` +
        (producerStamp.models.length > 0 ? ` (${producerStamp.models.join(", ")})` : "") +
        `, reused from the workdir cache\n`;
    }
  }
  // R21 §105 — the standard honesty line, in the artefact people forward.
  report +=
    "\nnote: the cut, captions and graphics are AI-generated — review the output before publishing.\n";
  await writeFile(join(work, "report.txt"), report);
  console.log("");
  console.log(report);
  console.log("");

  const baseCaptionLines = buildCaptionLines(transcript, map, {
    // GRAPHIC cues only: a plain take is presentationally a gap, and letting
    // the fill's derived boundaries re-split caption lines would change
    // caption output for zero visual reason (PLAN Task A4.4).
    breakpoints: graphicCues.flatMap((c) => [c.startSec, c.endSec]),
    // Orientation-dependent packing (captionPackingFor has the budget math):
    // portrait gets the core defaults verbatim, landscape doubles them.
    ...captionPackingFor(landscape),
  });
  // §137 (Task 6 review, Critical 1): the caption half of a run — migrate the
  // doc's keys, apply what applies, and account for the rest — is one pure
  // pass in `caption-report.ts`, and this is its I/O.
  //
  // MIGRATION RUNS HERE, not only in the editor. The editor's is in memory and
  // `edits.load` leaves the doc CLEAN, so `onRender` (which saves only when
  // dirty) sends a user who opened an old project, saw every retype come back
  // on screen, and clicked Render straight into this function with the
  // untouched legacy doc — and `applyCaptionEdits` matched nothing, so the
  // render shipped without a single retype after showing a state strictly more
  // convincing than the truth. None of the reasoning that keeps this call out
  // of `edit.ts` applies: `buildCaptionLines` just stamped a real `srcStart`
  // on every word above (`captions.ts:128`), so there is nothing to backfill
  // and no repair rule to duplicate.
  //
  // THE MIGRATED DOC IS WRITTEN BACK — the decision, stated: through the one
  // sanctioned `overrides.json` write further down, with its `.bak` and atomic
  // rename, never a second write here. A legacy key's resolvability DECAYS (it
  // is found by the word it names, so the next re-plan that rewrites that word
  // loses it for good), and this is the only durable repair in the product —
  // the editor's evaporates, as Critical 1 showed. The edits it could NOT
  // place stay in the doc regardless (`captionEditsToKeep`): they are printed
  // by name below, and a run that cannot anchor one today is not permission to
  // delete it — the next run, against a different cut, may place it (final
  // review, Critical 1).
  const captionWork = reconcileCaptionEdits(overrideDoc, baseCaptionLines, map);
  overrideDoc = captionWork.doc;
  const captionLines = captionWork.lines;
  const captionKeysReanchored = captionWork.reanchored;
  for (const line of captionWork.log) console.log(line);

  // Const re-binding of the accepted plan so its narrowing survives into the
  // `framingTimeline` map closure below — `framingPlan` is a `let`, and TS
  // drops a `let`'s narrowing inside callbacks.
  const acceptedFramingPlan = framingPlan?.ok ? framingPlan : null;
  // Hoisted out of the props spread because TWO consumers need it: the
  // render-props emission below and the per-span subject mask both motion
  // drivers gate on. Skipped under `--source-fit contain` — contain shows the
  // WHOLE frame, and a framing plan's cover windows would fight it — so the
  // subject gate reads the same timeline the renderer will actually see.
  const framingTimeline: FramingSegment[] | null =
    acceptedFramingPlan && opts.sourceFit !== "contain"
      ? acceptedFramingPlan.segments.map(
          (s, i): FramingSegment => ({
            startSec: s.startSec,
            endSec: s.endSec,
            window: s.window,
            subject: acceptedFramingPlan.subject[i] ?? "screen",
            bias: acceptedFramingPlan.bias[i] ?? { x: 0.5, y: 0.5 },
          }),
        )
      : null;
  const jumpCutsMode = resolveJumpCuts(opts.jumpCuts);
  const globalSubject = faceSubject(faceBox);
  // ONE verdict array feeds BOTH motion drivers (spanFaceMask has the why) —
  // computed before either plan so neither can be built from a stale or
  // re-derived copy that disagrees with the other.
  //
  // 2026-08-16 v2 review: with NO framing plan (uniform content rects) the
  // old flat `spanFaceMask(…, null, globalSubject)` let the whole-take PiP
  // verdict speak for the full-frame face stretches inside a screen
  // recording, so those spans lost punch concealment and idle zoom — the
  // mask must be MEASURED per span instead (spanFaceMaskFromFaces has the
  // full why). Cached: `measureFaceInWindows` itself does not cache, and a
  // ~55-span take is a few hundred single-frame ffmpeg spawns.
  let spanIsFaceOnly: boolean[];
  if (framingTimeline) {
    spanIsFaceOnly = spanFaceMask(map.spans, framingTimeline, globalSubject);
  } else {
    const spanFaceCache = join(work, `face-spans-${spanFaceCacheKey(map.spans, hash)}.json`);
    let measured: boolean[] | null = null;
    if (existsSync(spanFaceCache)) {
      measured = z.array(z.boolean()).length(map.spans.length)
        .parse(JSON.parse(await readFile(spanFaceCache, "utf8")));
    } else {
      const maskAnim = isInteractive()
        ? new StageAnimator(
            "SUBJECT TRACKING",
            `Measuring who the subject is across ${map.spans.length} kept spans...`,
            "render",
          ).start()
        : null;
      try {
        const spanFaces = await measureFaceInWindows(
          tools,
          input,
          spanFaceWindows(map.spans),
          { workDir: work },
        );
        measured = spanFaceMaskFromFaces(spanFaces);
        await writeFile(spanFaceCache, JSON.stringify(measured));
      } catch (err) {
        // NEVER cache a FAILURE (§106) — and the punch/zoom are polish, not
        // the product, so a dead measurement falls back to the whole-take
        // verdict (the pre-2026-08-16 behavior) rather than killing the run.
        console.log(
          `  ⚠ per-span face measurement failed (${err instanceof Error ? err.message : String(err)})` +
            " — every span shares the whole-take verdict this run",
        );
      } finally {
        if (maskAnim) maskAnim.stop();
      }
    }
    spanIsFaceOnly = measured ?? spanFaceMask(map.spans, null, globalSubject);
    if (measured) {
      const faceSpans = measured.filter(Boolean).length;
      console.log(
        `▸ subject per span (measured): ${faceSpans} face-only, ` +
          `${measured.length - faceSpans} screen`,
      );
    }
  }
  // The jump-cut punch plan (Task 6): mode from the flag pair, gated per
  // span by who the subject is where that span BEGINS — the frame at the
  // cut is what the punch scales. Without a framing plan every span shares
  // the whole-take verdict, the same `face.subject` the stage bias reads.
  const punch = punchPlanFor(map.spans, jumpCutsMode, spanIsFaceOnly);

  // Micro zoom punches (FINDINGS §15) reversing at real phrase breaks (§18).
  // Breaths are source-time; TimeMap has no span mapper, so both ends go
  // through toOutputClamped — a pause that was cut collapses to one instant,
  // which is still a boundary (a jump cut is a phrase break too).
  // One move per cut-free clip: ramp in, then hold. The clip starts ARE the
  // cuts — every point the source jumps — so a take that removed nothing is
  // one clip and gets exactly one slow push. Face-only since 2026-08-16
  // (same mask as the punch): a screen-subject clip gets NO push at all.
  const zoomOff = opts.zoom === false;
  const zoom = buildZoomPlan(map.outputDuration, {
    clipStarts: map.spans.map((s) => s.outIn),
    allowedClips: spanIsFaceOnly,
  });
  console.log(
    zoomOff
      ? "▸ zoom: off (--no-zoom) — static camera; jump cuts land unconcealed"
      : `▸ zoom: ${zoom.zoomedClips} clip(s) zoomed, ${zoom.staticClips} static ` +
          `(screen subject), ${zoom.rampSec}s push then hold ` +
          `(${zoom.segments.length} segments)`,
  );

  // ---- Per-scene framing (plan step D) ------------------------------------
  // A slot wider than the source canvas is cover-cropped VERTICALLY, so it
  // shows only a fraction of the canvas height and the face grows by the
  // inverse. `video-top` is a wide band against a portrait canvas, which is
  // why a close-up moment placed there loses its crown. Not fixable by
  // cropping — the pixels a wide band wants do not exist in a portrait
  // close-up — so it is REPORTED here, and the producer is what has to stop
  // choosing that layout for those moments (steps A and B).
  if (framingPlan) {
    const toSource = (outSec: number): number => {
      for (const sp of map.spans) {
        if (outSec >= sp.outIn && outSec < sp.outOut) return sp.srcIn + (outSec - sp.outIn);
      }
      return map.spans[map.spans.length - 1]?.srcOut ?? outSec;
    };
    // Only layouts where the video IS the subject. A `pip-bubble` is a small
    // circular inset and a `graphic-only` slot is not even drawn (opacity 0):
    // a tight head-shot is what a bubble is FOR, so judging it against the
    // same head-fits rule would report a defect for working as designed.
    const issues = assessCueFraming(
      graphicCues.flatMap((c) => {
        // `frame` must reach layoutSlots, not just the pixel multiply below —
        // it defaults to PORTRAIT_FRAME, and the R15 split layouts change
        // geometry with orientation (split-left: {w:1, h:0.5} stacked in
        // portrait, {w:0.5, h:1} side panel in landscape), so omitting it
        // judged 16:9 cues against portrait slot shapes. Latent since R15
        // landscape support; see layoutSlotAspects for the twin brief-side bug.
        const v = layoutSlots(c.layout, DEFAULT_FACE, [], frame).video;
        if (v.opacity <= 0 || v.rect.w * v.rect.h < PRIMARY_VIDEO_SLOT_AREA) return [];
        return [{
          id: c.id,
          layout: c.layout,
          startSec: toSource(c.startSec),
          endSec: toSource(c.endSec),
          slot: { width: v.rect.w * frame.width, height: v.rect.h * frame.height },
        }];
      }),
      framingPlan.segments,
      framingPlan.faceFracOfCanvas,
      framingPlan.canvas,
      ZOOM_MAX_SCALE,
    );
    const tight = issues.filter((f) => f.headFracOfSlot > 1);
    for (const f of tight) {
      console.log(
        `  ⚠ ${f.cueId} (${f.layout}): head is ${(f.headFracOfSlot * 100).toFixed(0)}% of its ` +
          `video slot — the crop will trim it. This layout is too wide for how close ` +
          `the speaker is here.`,
      );
    }
    if (issues.length > 0 && tight.length === 0) {
      const worst = issues.reduce((a, b) => (b.headFracOfSlot > a.headFracOfSlot ? b : a));
      console.log(
        `▸ framing: every scene fits its slot (tightest ${worst.cueId} at ` +
          `${(worst.headFracOfSlot * 100).toFixed(0)}% of its band)`,
      );
    }
  }

  let renderVideo = input;
  // A letterboxed source MUST go through the re-encode even under
  // --no-mezzanine: the bars are pixels in the file, and cropping them here is
  // what lets every layout and zoom downstream treat the picture as the frame.
  // The cropped file gets its own name so a pre-crop cache is never reused.
  // `mezzanineWillBuild` (computed once, above, with `contentRect`) — not a
  // second copy of this condition — so this can't drift from what
  // `planRenderPublicDir` already decided the accepted-image check against
  // (Finding 3, final-review fix wave).
  // Display-sized mezzanine (2026-08-17 render-speed pass): computed on the
  // POST-CROP picture (the crop runs first in the same ffmpeg pass, so
  // `contentRect` IS what the scale filter sees) against the OUTPUT
  // frame+fps. Deliberately null when no mezzanine will build (--no-mezzanine
  // on a bar-free source): there is no re-encode to scale, the render plays
  // the source itself, and the window emissions below must then stay in true
  // source pixels — which the identity `mezzFactor` below guarantees.
  // ---- Color grade (`--color-grade` / config `colorGrade` / the editor's
  // overrides.json) ---------------------------------------------------------
  // Resolved HERE, before the mezzanine encode, because the feature's two
  // halves split at exactly this seam: a PRESET grade rides render-props as
  // an SVG filter spec (the props assembly below), while a LUT grade is baked
  // INTO the mezzanine (ingest.ts's `lut` option) — ffmpeg's lut3d on the
  // encode pass costs nothing per rendered frame, where a 33³ trilinear
  // lookup in the browser would. Precedence and validation live in
  // `resolveProductionColorGrade`; every warning it returns prints once here,
  // and every failure path proceeds UNGRADED — a grade must cost the look at
  // worst, never the run.
  const gradeResolution = resolveProductionColorGrade({
    override: overrideDoc.colorGrade,
    flag: opts.colorGrade,
    config: cfg.colorGrade,
  });
  for (const w of gradeResolution.warnings) console.log(w);
  /** Preset grades: the spec render-props carries (absent = no grade). */
  let colorGradeSpec: SvgGradeFilterSpec | undefined;
  /** LUT grades: the baked .cube the mezzanine encode applies (absent = none). */
  let gradeLut: { path: string; hash: string } | undefined;
  if (gradeResolution.grade !== undefined) {
    // The watermark's visibility rule: a grade sourced anywhere but the
    // typed flag says so, so a config- or editor-sourced look never
    // surprises the author on upload.
    const gradeFromNote =
      gradeResolution.source === "config"
        ? " (from config; --no-color-grade overrides)"
        : gradeResolution.source === "override"
          ? " (editor override)"
          : "";
    const resolvedLook = resolveGradeToLook(gradeResolution.grade);
    if (resolvedLook.kind === "preset") {
      colorGradeSpec = gradeToSvgFilterSpec(resolvedLook);
      console.log(`▸ color grade: ${gradeResolution.grade.preset}${gradeFromNote}`);
    } else if (!mezzanineWillBuild) {
      // --no-mezzanine on a bar-free source: the render plays the source
      // file itself, so there is no encode to bake the LUT into. Warn and
      // proceed ungraded rather than force a mezzanine the user refused.
      console.log(
        `⚠ color grade skipped — a .cube LUT is baked into the mezzanine, ` +
          `and --no-mezzanine means this run doesn't build one`,
      );
    } else {
      try {
        // Basename only, enforced before any path math: `lut` is a NAME the
        // schema documents as living in ~/.ossclip/luts, and resolving a
        // separator-carrying value would turn a config key into a file probe
        // (the SfxAddedPlacement id's "nothing may ever resolve a path
        // against it" rule, applied at the one place this name meets the
        // filesystem).
        if (basename(resolvedLook.lutRef) !== resolvedLook.lutRef) {
          throw new Error(
            `"${resolvedLook.lutRef}" is not a bare filename — LUTs live in ${join(CONFIG_DIR, "luts")}`,
          );
        }
        const lutPath = join(CONFIG_DIR, "luts", resolvedLook.lutRef);
        const baseLut = parseCubeLut(readFileSync(lutPath, "utf8"));
        // Tweaks + intensity are baked into the cube (bakeCube composes
        // `params` on top of the base sample), so the hash keys the WHOLE
        // grade: change the intensity and the mezzanine filename changes
        // with it (`mezzanineFileName`'s existence-keyed cache).
        const cubeText = bakeCube({
          base: baseLut,
          params: resolvedLook.tweaks,
          intensity: resolvedLook.intensity,
        });
        const hash = lutHash(cubeText);
        const bakedPath = join(work, `grade-${hash}.cube`);
        await writeFile(bakedPath, cubeText);
        gradeLut = { path: bakedPath, hash };
        console.log(`▸ color grade: LUT ${resolvedLook.lutRef}${gradeFromNote}`);
      } catch (err) {
        // ENOENT and a malformed .cube land here alike: name the problem,
        // proceed ungraded. parseCubeLut's errors already carry the line.
        console.log(
          `⚠ color grade skipped — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const mezzScale = mezzanineWillBuild
    ? mezzanineScale(
        { width: contentRect.w, height: contentRect.h, fps: sourceProbe.fps },
        production.render,
        opts.sourceFit ?? "cover",
      )
    : null;
  if (mezzanineWillBuild) {
    // The scale decision rides the FILENAME (`mezzanineFileName` has the
    // why): mezzanine caching is existence-keyed, so a pre-pass full-res
    // mezzanine.mp4 must not satisfy a run that emits mezzanine-sized
    // windows — the scaled file rebuilds once under its own name.
    // `gradeLut?.hash` rides the name so a graded mezzanine can never satisfy
    // an ungraded run (or vice versa) — the LUT is pixels in the file, and
    // the cache is existence-keyed.
    const mezz = join(work, mezzanineFileName(!contentRect.full, mezzScale, gradeLut?.hash));
    if (!existsSync(mezz)) {
      const mezzAnim = isInteractive()
        ? new StageAnimator(
            "MEZZANINE ENCODE",
            contentRect.full
              ? "Building dense-keyframe mezzanine stream..."
              : "Building dense-keyframe mezzanine stream (trimming letterbox)...",
            "render",
          ).start()
        : null;
      if (!mezzAnim) {
        console.log(
          contentRect.full
            ? "▸ building mezzanine (dense keyframes)…"
            : "▸ building mezzanine (dense keyframes, letterbox bars trimmed)…",
        );
      }
      await makeMezzanine(tools, input, mezz, {
        cropVf: cropVf || undefined,
        scale: mezzScale ?? undefined,
        // The LUT grade's whole delivery: baked into the encode, so the
        // render (and the editor's preview, which plays the same file) see
        // graded pixels with no per-frame cost.
        lut: gradeLut,
      });
      if (mezzAnim) mezzAnim.stop();
    }
    if (mezzScale) {
      console.log(
        `▸ mezzanine: ${contentRect.w}x${contentRect.h}@${Math.round(sourceProbe.fps)} → ` +
          `${mezzScale.width}x${mezzScale.height}@${Math.round(mezzScale.fps)} ` +
          `(render-sized — decode is the render bottleneck)`,
      );
    }
    renderVideo = mezz;
  }
  // Window space must equal PLAYED-FILE space: the renderer's crop math
  // (`contentCoverBox` et al.) positions windows against the file it plays,
  // so a scaled mezzanine needs every pixel-space emission below scaled by
  // the same factor. Derived from the actual scaled dims — per axis, because
  // yuv420 even-rounding makes the two ratios differ by a hair — and
  // identity whenever the render plays an unscaled file (no mezzanine, or a
  // source already at display size). `playedFullFrame` is the matching
  // `sourceSize`: the framing/fit paths only ever fire with a FULL-frame
  // mezzanine (mixed framing ⇒ no uniform crop), so its base is the source's
  // own dims. Face fractions, `sourceAspect` and `sourceTextRegions` are
  // ratios/fractions — scale-invariant, untouched. The Premiere project
  // export stays in TRUE source space by construction: it cuts the ORIGINAL
  // file (`production.source`, path + probe) and consumes only seconds and
  // scales from render-props (spans, zoomPlan, punch), never these windows.
  const mezzFactor = mezzScale
    ? { x: mezzScale.width / contentRect.w, y: mezzScale.height / contentRect.h }
    : { x: 1, y: 1 };
  const playedFullFrame = mezzScale
    ? { width: mezzScale.width, height: mezzScale.height }
    : null;

  // Comment-CTA keyword (FINDINGS §16), scoped to the ask (FINDINGS §22).
  // Read off the timed CUE, not the untimed scene: the cue carries the same
  // resolved props AND the window, so the keyword can never come from a scene
  // that assembleScenes dropped, and the caption track knows exactly when the
  // ask is on screen. Quoting marks the word you type in the comments — every
  // other time the speaker merely says it, it must render plainly.
  // Captions are ON by default and stay so — only the OFF path announces
  // itself, naming WHICH surface turned them off: a silent-captions upload
  // must never leave the author guessing whether they typed the flag or the
  // editor's toggle did it. The flag reason wins the message when both are
  // true — it is the one visible in the command line being run. Resolved
  // BEFORE the CTA block below, because the CTA line's promise depends on it.
  const captionsHidden = resolveCaptionsHidden(opts.captions, overrideDoc.captionsHidden);
  if (captionsHidden) {
    console.log(
      opts.captions === false
        ? "▸ captions: off (--no-captions)"
        : "▸ captions: hidden by editor override",
    );
  }

  // Bundled Nastaliq for RTL captions (2026-08-17): the render must not
  // depend on the machine having an Arabic-script font — a Linux box has
  // none, and macOS/Windows each substitute a different one, so identical
  // render-props drew three different Urdu caption sets. Gated on the SAME
  // predicate CaptionTrack keys its @font-face on (`captionsNeedNastaliq`),
  // so pure-Latin runs copy nothing and render byte-identically. Staged into
  // the render's public dir AND the workdir when they differ (a
  // --no-mezzanine file run serves the render from the source's own folder,
  // but `ossclip edit` serves from the workdir — program.ts's
  // `dirname(propsPath)` — and both mounts fetch the same served URL).
  // `join` is correct here where NASTALIQ_FONT_REL itself must stay
  // POSIX-literal: these are filesystem paths, the REL is the served URL
  // (sideImageDestRel's Windows lesson).
  if (!captionsHidden && captionsNeedNastaliq(captionLines)) {
    const fontSrc = nastaliqFontFile();
    for (const dir of new Set([renderPublicDirPath, work])) {
      const dest = join(dir, NASTALIQ_FONT_REL);
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(fontSrc, dest);
      }
    }
    console.log(
      `▸ captions: RTL lines detected — bundled ${NASTALIQ_FONT_NAME} staged as ${NASTALIQ_FONT_REL}`,
    );
  }

  const ctaCue = [...graphicCues]
    .reverse()
    .find((c) => typeof c.props?.keyword === "string" && (c.props.keyword as string).length > 0);
  const ctaKeyword = ctaCue ? (ctaCue.props!.keyword as string) : undefined;
  const ctaWindow = ctaCue
    ? { startSec: ctaCue.startSec, endSec: ctaCue.endSec }
    : undefined;
  if (ctaKeyword) {
    // Gated on the captions resolution (review minor 1): "styled only at
    // X–Ys" on a captions-hidden run is a false promise — the styling rides
    // the caption track (ProductionComposition's mount gate), so the moment
    // the trade bites is the moment to say so.
    console.log(
      captionsHidden
        ? `▸ CTA keyword "${ctaKeyword}" styling skipped — captions hidden`
        : `▸ CTA keyword "${ctaKeyword}" styled only at ` +
            `${ctaWindow!.startSec.toFixed(1)}–${ctaWindow!.endSec.toFixed(1)}s`,
    );
  }

  // Resolved HERE, next to the props it feeds, and announced when on — the
  // one ▸ line is how a config-sourced credit stays visible per run instead
  // of surprising the author on upload.
  const watermark = resolveWatermark(opts.watermark, cfg.watermark);
  if (watermark) {
    console.log(
      `▸ watermark: "made with ossclip" in the top-left safe area` +
        `${opts.watermark === undefined ? " (from config; --no-watermark overrides)" : ""}`,
    );
  }

  // ---- Cover overlay on the opening frames (`--cover-in-video`) -----------
  // Resolved and staged HERE, next to the props it feeds, the watermark's
  // posture: one ▸ line when it is on, so a config-sourced overlay never
  // surprises the author on upload.
  //
  // THE STAGED FILE IS THE CURRENT COVER AT RENDER TIME, and that is the
  // whole state model: this run's own cover has not been rendered yet
  // (produce writes it after the video, from the finished render's own
  // geometry), so what gets copied is the cover the project has RIGHT NOW —
  // the one `ossclip cover`, the editor's regenerate button, or the previous
  // produce left behind, resolved down the panel's own ladder
  // (`coverInVideoCandidates`). A regenerated cover therefore lands in the
  // NEXT render and preview with no extra plumbing, exactly like a headline
  // edit in `cover.json`. A project with no cover on disk at all (the first
  // ever run) gets one ⚠ line and NO prop — an absent key is the
  // absent-means-off contract, so the render is byte-identical to an
  // overlay-less one rather than half-wired.
  //
  // Staged into the render's public dir AND the workdir when they differ, for
  // the Nastaliq font's reason verbatim: the render bundles
  // `dirname(renderVideo)`, `ossclip edit` serves the workdir at `/media/`,
  // and both mounts fetch the same name.
  const coverInVideoOn = resolveCoverInVideo(opts.coverInVideo, cfg.coverInVideo);
  let coverInVideo: { fileName: string; durationSec: number } | undefined;
  if (coverInVideoOn) {
    const candidates = coverInVideoCandidates({
      provenanceOut: (await readCoverProvenance(work))?.out,
      outPath,
    });
    const source = candidates.find((p) => existsSync(p));
    if (source === undefined) {
      // Deliberately does NOT promise this run's cover: `--no-cover` may mean
      // there will not be one, and a produce that says "next time" and then
      // never delivers is worse than one that names what it looked for.
      console.log(
        `  ⚠ cover in video: no cover image yet (looked for ` +
          `${candidates.join(", ")}) — no overlay this run; ` +
          `it uses the cover a previous run or \`ossclip cover\` leaves behind`,
      );
    } else {
      const fileName = coverInVideoFileName(source);
      for (const dir of new Set([renderPublicDirPath, work])) {
        // `join` on the filesystem side where `fileName` itself stays
        // POSIX-literal — these are paths, that is a served URL (the
        // Nastaliq staging's exact split).
        const dest = join(dir, fileName);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(source, dest);
      }
      // The window is derived from the OUTPUT clock's first word — the same
      // caption words the renderer draws, post-cut (core's coverInVideoWindow
      // owns the bounds). The first line WITH words, not `captionLines[0]`:
      // an empty leading line would read as "no speech" and take the cap.
      const durationSec = coverInVideoWindow(
        captionLines.find((l) => l.words.length > 0)?.words ?? [],
        { capSec: COVER_IN_VIDEO_CAP_SEC, floorSec: COVER_IN_VIDEO_FLOOR_SEC },
      );
      coverInVideo = { fileName, durationSec };
      console.log(
        `▸ cover in video: ${basename(source)} over the first ${durationSec.toFixed(2)}s` +
          `${opts.coverInVideo === undefined ? " (from config; --no-cover-in-video overrides)" : ""}`,
      );
    }
  }

  const props = {
    videoFileName: basename(renderVideo),
    spans: [...map.spans],
    captionLines,
    sceneCues,
    theme,
    // The PRISTINE, pre-override cues/theme — everything above this line
    // already has the CURRENT `overrides.json` baked in (so `sceneCues`/
    // `theme` are exactly what got rendered). The editor needs an unmerged
    // base to re-apply overrides onto instead: merging the live doc onto an
    // already-merged base is add-only, so a reset/un-pin/undo in a second
    // editing session would have nothing to fall back to and render as if
    // it never happened, even though `overrides.json` on disk is correct.
    baseSceneCues: routed.cues,
    // The CONFIG base, not defaultTheme (F6): the editor re-applies its
    // overrides onto this, so a theme reset there must land on the user's
    // global colors — falling to factory defaults would silently discard
    // ~/.ossclip/config.json's theme the first time anyone touched a color.
    baseTheme: configBaseTheme,
    baseCaptionLines,
    // The COMPOSITION's size, which is the BASE frame — never
    // `production.render` (2026-08-27). `production.render` describes the
    // FILE, and under `--resolution` those differ by the render's `scale`:
    // Remotion enlarges this composition by that factor, so sizing the
    // composition from the scaled dims applies it TWICE (2160×3840 became
    // 4320×7680 frames, which h264_videotoolbox refuses outright, at stitch
    // time, after every frame had been paid for). The Player reads these too,
    // and previewing at the base size is what keeps the editor cheap.
    settings: { ...frame, fps: production.render.fps },
    outputDurationSec: map.outputDuration,
    // The aspect travels with the measurement because the crop math needs it:
    // `object-fit: cover` spills vertically for a portrait source and
    // HORIZONTALLY for a landscape one, and the stage cannot tell which
    // without being told what shape the source is.
    face: faceBox
      ? {
          centerYFrac: faceBox.centerYFrac,
          centerXFrac: faceBox.centerXFrac,
          sizeFrac: faceBox.sizeFrac,
          // The CONTENT's shape, not the container's — with bars trimmed the
          // rendered video IS the content rect (PLAN Task 7). Since the
          // framing bake became props (2026-08-16), this is always the RAW
          // source's picture: `content` derives from `sourceProbe`, never
          // from a re-encoded canvas, so a framing plan no longer distorts
          // the aspect the stage crops against.
          sourceAspect: content.height > 0 ? content.width / content.height : undefined,
          // Whether the face IS the subject, by the same rule the framing
          // plan applies per segment. 2026-08-16 incident: the global
          // 9-sample median landed on the camera PiP and pinned objectPosY
          // to 1.0, decapitating the speaker at the top of the frame — a
          // PiP-sized face must not steer the cover. Absent (old props)
          // means "face", so pre-existing render-props render unchanged.
          subject: faceSubject(faceBox),
        }
      : null,
    // Emptied, not flattened-to-1: a plan of flat segments still reads as "a
    // plan exists" to every consumer, and the point of the flag is that no
    // motion layer exists at all.
    zoomPlan: zoomOff ? [] : zoom.segments,
    // Written only when OFF (watermark's absent-means-default contract): the
    // composition reads it to neutralise the cut punch-in — the second
    // motion driver, which zoomPlan alone can't reach.
    ...(zoomOff ? { staticCamera: true } : {}),
    ctaKeyword,
    ctaWindow,
    sourceTextRegions: textRegions,
    // Sent ONLY on the fit fallback (option (b)): a plan-framed mixed source
    // carries its windows in `framingTimeline` below, and a uniform source
    // had its bars cropped into the mezzanine — cropping either again at
    // render time would eat the picture twice. Rects and sourceSize are in
    // PLAYED-FILE pixels (`mezzFactor`/`playedFullFrame` above): the renderer
    // windows the file it plays, which a display-sized mezzanine has resampled.
    ...(fitFallback
      ? {
          contentTimeline: scaleContentTimeline(contentTimeline, mezzFactor),
          sourceSize:
            playedFullFrame ?? { width: sourceProbe.width, height: sourceProbe.height },
          contentCropMode: "fit" as const,
        }
      : {}),
    // The accepted framing plan, as DATA (2026-08-16 incident: the bake this
    // replaces was irreversible — deleting the re-encoded content-<hash>.mp4
    // was the only remedy — and it suppressed these very keys, so the editor
    // could not even see the crop). Mutually exclusive with the fit-fallback
    // spread by construction (`fitFallback` ⇔ `!plan.ok`), so `sourceSize`
    // is emitted by exactly one of them. Skipped under `--source-fit
    // contain`: contain shows the WHOLE frame, and a framing plan's cover
    // windows would fight it — the explicit flag wins over the inferred plan.
    ...(framingTimeline
      ? {
          // The plan's windows are TRUE source pixels (planNormalization
          // analyses the source); scaled here, at emission, into the pixel
          // space of the file the render plays — a display-sized mezzanine
          // resamples that space by `mezzFactor` (identity when unscaled).
          framingTimeline: scaleFramingWindows(framingTimeline, mezzFactor),
          // The PLAYED file's size — the scaled windows are in its pixels.
          sourceSize:
            playedFullFrame ?? { width: sourceProbe.width, height: sourceProbe.height },
        }
      : {}),
    // ALWAYS written, never absent-when-default like the flags around it:
    // an ABSENT `punch` is the LEGACY contract — EdlVideo's 1.07 punch on
    // every alternating span — kept so every pre-feature render-props.json
    // renders byte-identical to what it always did. Presence, even an
    // all-false "off" mask, is what opts a render into the face-only 1.015
    // behavior (punchPlanFor has the guard's why).
    punch,
    // `--source-fit contain`: show the whole frame instead of cropping it.
    // The size sent is the PICTURE's, not the container's — with bars trimmed
    // into the mezzanine the rendered video IS the content rect, and fitting
    // against the container's shape would inset a frame that no longer exists.
    // Listed after the fit fallback so it wins on a source that is both mixed
    // and asked to be shown whole. `playedFullFrame` when the mezzanine is
    // display-sized: it is that same picture, post-resample — the file the
    // renderer fits.
    ...(opts.sourceFit === "contain"
      ? { sourceFit: "contain" as const, sourceSize: playedFullFrame ?? content }
      : {}),
    // Written only when ON, matching the field's absent-means-off contract:
    // an off run's render-props.json stays byte-identical to a pre-watermark
    // one, so nothing downstream can tell the feature ever shipped.
    ...(watermark ? { watermark: true } : {}),
    // Written only when the overlay is BOTH switched on and backed by a file
    // that exists (the staging block above): absent means no overlay, so an
    // off run's render-props.json — and its rendered pixels — stay identical
    // to a pre-feature one.
    ...(coverInVideo ? { coverInVideo } : {}),
    // Same absent-means-default contract, polarity flipped (captions default
    // ON): written only when hidden, so a normal run's render-props.json
    // stays byte-identical to a pre-feature one. `captionsHiddenByFlag` is
    // the flag-only part, split out for the EDITOR alone: `captionsHidden`
    // bakes the override doc in, and the editor re-applies the CURRENT doc
    // onto pristine bases (see `baseSceneCues` above) — without the split,
    // its live preview either couldn't take a doc-sourced hide back after
    // an un-toggle (the add-only trap those bases exist for) or would show
    // captions that a command.json pinned with --no-captions will never
    // actually render.
    ...(captionsHidden ? { captionsHidden: true } : {}),
    ...(opts.captions === false ? { captionsHiddenByFlag: true } : {}),
    // `--sfx`, written only when there is something to play (the watermark's
    // absent-means-off contract): a run without sound effects keeps a
    // render-props.json — and an audio graph — byte-identical to a pre-feature
    // one, and the composition reads an absent key as silence, not as an empty
    // track it still has to mount.
    ...(sfxCues.length > 0 ? { sfxCues } : {}),
    // `--color-grade` PRESET looks, written only when one resolved (the
    // watermark's absent-means-off contract): the two-stage SVG filter spec
    // ({tableR, tableG, tableB, colorMatrix}, gradeToSvgFilterSpec) the
    // composition mounts over the video. A LUT grade deliberately writes
    // NOTHING here — it was baked into the mezzanine above, so the pixels
    // the renderer plays already carry it, and a spec on top would grade
    // twice.
    ...(colorGradeSpec ? { colorGrade: colorGradeSpec } : {}),
  };
  await writeFile(join(work, "render-props.json"), JSON.stringify(props, null, 2));

  // The one sanctioned overrides.json write (PLAN 2026-08-04 Task 4; see
  // `applyUserCuts`'s doc comment for why it's allowed at all) — computed
  // way back when `cutResult` was built, but the actual write waits until
  // HERE, immediately after `render-props.json`'s own write, deliberately
  // adjacent (review fix wave finding 2). A crash or Ctrl-C anywhere in
  // between (assembly, LLM captions, ffmpeg, face measurement — several
  // hundred lines of I/O that can throw) used to be able to land between the
  // OLD ordering's early overrides.json write and this one: overrides.json
  // would already describe the NEW (post-cut) frame while render-props.json
  // on disk still described the OLD one, so the NEXT run's `priorMap` —
  // reconstructed from that stale render-props.json — would be off by
  // exactly the cut's duration and silently double-shift every split and
  // pin. Writing render-props.json FIRST means the worst a crash between the
  // two can do is leave overrides.json one run stale relative to it — the
  // next run's `priorMap` then sees drift and re-anchors again, the same
  // recovery path finding 3 already has to support — never a false "nothing
  // changed" that quietly corrupts positions.
  // `cutResult.changed` OR a §137 caption-key migration that actually MOVED an
  // edit — the second is why this is no longer a bare cut check. Both are
  // re-anchorings of the user's doc to something the pipeline just recomputed,
  // and both go through the one sanctioned write; a separate write for the
  // migration would be a SECOND sanctioned write, which the comment above
  // exists to prevent.
  //
  // "ACTUALLY MOVED" is load-bearing and was not there at first (final review,
  // Critical 2). Gated on "the migration reported something" instead, this
  // fires on a run that repaired NOTHING — and since a caption migration is
  // independent of the cut, it fires on runs where the pre-§137 gate wrote
  // nothing at all.
  //
  // THEY DO NOT SHARE THE `.bak`, THOUGH, and that is the rest of the same
  // finding (final review round 2). `refreshBackup: cutResult.changed`, never
  // the gate: on the field workdir the caption migration re-anchors THREE
  // edits, so the gate legitimately fires while `cutResult.changed` is false —
  // and an unconditional refresh would then copy the already-damaged
  // `overrides.json` over `overrides.json.bak`, which is that user's only
  // pre-cut save and the only artefact their deleted split half can still be
  // recovered from (`legacySplitId`). Repairing the captions would destroy the
  // evidence for the split. `writeOverrideDoc` carries the full argument for
  // why a caption-only write has nothing worth backing up.
  // `hidesPruned` joins the gate for the same reason `captionKeysReanchored`
  // did: a hide retired by its own cut (`pruneHidesInsideCuts`) changes the
  // doc without changing the cut entries, and skipping the write would
  // re-report "the cut removed it" on every later run. It does NOT spend the
  // `.bak` — retiring a redundant key is not the cut re-anchoring the backup
  // exists to survive.
  // `sceneKeysRemapped` joins for the caption-migration reason: a scene edit
  // that followed its anchor to a new id (handoff-edit-anchoring) is keyed
  // right in memory but wrong on disk, and every re-keyed entry was just
  // printed by name. It does NOT spend the `.bak` — the remap moves keys, it
  // rewrites no values a user would need to recover.
  // `splitSrcResolved` joins for the sceneKeysRemapped reason: the source
  // anchor exists in memory but not on disk, and skipping the write would
  // re-resolve (and re-announce) it every run. It does NOT spend the `.bak`
  // — backfilling adds an anchor, it rewrites no value a user would need to
  // recover.
  if (cutResult.changed || captionKeysReanchored || hidesPruned || sceneKeysRemapped || splitSrcResolved) {
    await writeOverrideDoc(overridesPath, overrideDoc, { refreshBackup: cutResult.changed });
    console.log(overridesWriteLine(cutResult.changed));
  }

  // Resolved HERE — above the --no-render exit rather than at the thumbnail
  // gate / pack section below — so the gate, the post-render consumers AND
  // the command.json record (which both exits now write) all read one
  // answer. Typed-beats-config, `typeof` not truthiness (the `portrait`
  // posture): config.json is hand-edited and unparsed, and a
  // `"audience": true` typo must resolve to "no audience".
  const youtube = resolveYoutube(opts.youtube, cfg.youtube);
  // resolvePortrait (portrait-override.ts) carries the expandHome treatment
  // of the flag and config paths, and puts the workdir's portrait-override
  // ABOVE both (editor face swap, 2026-08-17): a per-project expression
  // chosen in the editor must survive CLI re-renders — the flag/config
  // portrait is the fallback headshot, and a replay silently reverting the
  // swapped face would undo the one thing the swap exists for.
  const portrait = resolvePortrait({
    overridePath: portraitOverridePath(work),
    flagPortrait: opts.portrait,
    cfgPortrait: cfg.portrait,
  })?.path;
  const audience = opts.audience ?? (typeof cfg.audience === "string" ? cfg.audience : undefined);
  const thumbnailBrief =
    opts.thumbnailBrief ?? (typeof cfg.thumbnailBrief === "string" ? cfg.thumbnailBrief : undefined);

  // Record THIS invocation so the editor's Render button can replay it (R11
  // Task 4). Nothing else can reconstruct it — production.json has the
  // source path, cleanup and intent, but not --produce, --out or the LLM
  // flags — and guessing would silently render a different video than the
  // one on screen. execArgv carries the module loader (tsx in dev), so the
  // replay works from source and from a compiled build alike.
  //
  // Written BEFORE the render/no-render fork, not after the render (cut-review
  // step 1): a --no-render workdir used to carry NO command.json at all, so
  // the editor's Render button 412'd with "run `ossclip produce` once from
  // the terminal" — a dead end that made `--review` (produce without
  // rendering, review in the editor, render ONCE from its Render button)
  // impossible. Every pin below is resolved by this point, so the record is
  // byte-identical to what the post-render write produced; the side effect is
  // that a crashed render now leaves a record its own Render button can
  // retry. recordedProduceArgs strips --review/--no-render at record, so the
  // replay actually renders instead of looping.
  //
  // The provider may have been AUTO-DETECTED from this shell's environment
  // (a GEMINI_/ANTHROPIC_ key exported here). The editor's Render replays
  // this argv from the EDIT SERVER's environment, which may not have that
  // key — and the auto-detection would then silently pick a DIFFERENT
  // provider (R16 §75). Pin the RESOLVED choice into the recorded args —
  // never the key itself; secrets stay out of the workdir — so a replay
  // uses the same configuration or fails loudly asking for it.
  // §93g: pin the RESOLVED window, exactly as §75 pinned the provider. The
  // editor's Render replays this argv; if replay re-asked the model and got a
  // slightly different window, every saved override — anchored to scene ids
  // and word indices — would land on the wrong words. The word range, not
  // just `--clip 60`, is what makes replay deterministic with zero LLM calls.
  //
  // §129: NOT process.argv. A wizard or bare-path run re-enters commander
  // with a BUILT argv while process.argv still holds the original invocation
  // (`ossclip <path>`, no `produce` literal, none of the wizard's answers) —
  // recording process.argv shipped a command that replays as
  // `ossclip <path> --llm …` and dies on "unknown option '--llm'".
  // recordedProduceArgs prefers the argv the re-entry stashed and falls back
  // to process.argv for a directly typed `ossclip produce …`, which stays
  // byte-identical to what was always recorded.
  // Watermark pin, same §75 shape, and in BOTH directions (review,
  // Important): the effective default comes from THIS machine's
  // ~/.ossclip/config.json, so an unpinned record replays differently
  // wherever that config differs — an off-run would silently gain a credit
  // under a later/foreign config-on, an on-run would silently lose it. The
  // RESOLVED state is always pinned; a typed flag is already in the argv and
  // the includes-guard leaves it alone.
  // Captions pin: the FLAG's resolved state (`opts.captions ?? true`), never
  // the override-inclusive `captionsHidden` — overrides.json travels with
  // the workdir and is re-read on every replay, so pinning --no-captions
  // because the EDITOR hid them would freeze an edit the user may later
  // undo in that same editor. See recordedProduceArgs for why the pin is
  // unconditional even though captions' default is config-independent today.
  // Jump-cuts pin: the RESOLVED mode, but only its typed states reach the
  // argv — "auto" has no flag spelling and stays unpinned (see
  // recordedProduceArgs for why that is safe today).
  // Cover-overlay pin: the watermark's config-dependent-default rationale
  // again, on the flag that paints the first frames — an unpinned record
  // would gain or lose the overlay under a later `coverInVideo` config edit.
  // Youtube pin: the watermark's config-dependent-default rationale exactly —
  // resolved both ways, so a later config edit can't flip what Render
  // replays. Portrait and dictionary pin the RESOLVED values (a path and
  // terms, never a secret) for the same reason; recordedProduceArgs owns
  // the non-empty/includes guards.
  const recordedArgs = recordedProduceArgs({
    llm: provider ? providerName : undefined,
    // The RESOLVED effort (§143), pinned like the dictionary: it may have
    // come from this machine's config, and it keys the plan caches — an
    // unpinned record would re-plan on replay after a config edit.
    llmEffort,
    clipWindow: clipWindow ? `${clipWindow.startWord}:${clipWindow.endWord}` : undefined,
    watermark,
    // The SWITCH's resolved state (`coverInVideoOn`), not "did an overlay
    // actually happen": a run whose cover was simply missing yet still
    // records `--cover-in-video` is correct — the pin exists so the replay
    // resolves the same way this run did, and by then the cover may well be
    // on disk. Same distinction the captions pin draws between the flag and
    // the editor's override.
    coverInVideo: coverInVideoOn,
    captions: opts.captions ?? true,
    jumpCuts: jumpCutsMode,
    dictionary,
    youtube,
    portrait,
    audience,
    thumbnailBrief,
    // The SFX switch and level, RESOLVED (flag + config folded) — the
    // watermark's rationale on a flag whose default is config-dependent
    // (`sfx`/`sfxLevel` in ~/.ossclip/config.json). Unpinned, the editor's
    // Render would place a DIFFERENT amount of sound design the moment that
    // config is edited, or none at all on a machine without it — and since
    // the replay carries the reviewed plan forward rather than re-placing
    // (`priorSfxPlan`), an unpinned `--sfx` is the difference between the
    // reviewed sound design and a silent video.
    sfx: sfxOn,
    sfxLevel,
  });
  // produce is the ONLY command that may write command.json — edit.ts's §129
  // heal prepends the "produce" literal to any record that doesn't start
  // with it, so a record made by `transcribe`/`analyze` (which run this same
  // pipeline with render: false, and used to be kept out by the write
  // sitting after the early return below) would heal into
  // `produce transcribe …` and replay garbage. Their argv cannot start with
  // "produce" (§129: the stash mirrors the parse that ran, and only
  // produce's re-entries stash), which is the gate.
  if (recordedArgs[0] === "produce") {
    await writeFile(
      join(work, "command.json"),
      JSON.stringify(
        {
          execPath: process.execPath,
          execArgv: process.execArgv,
          script: process.argv[1],
          args: recordedArgs,
          cwd: process.cwd(),
          out: outPath,
        },
        null,
        2,
      ),
    );
    // Every produce run is a project the picker should offer (R17 §83) —
    // best-effort, so a read-only home dir never fails the render.
    await recordRecentProject(work);
  }

  if (!opts.render) {
    // §140: the breakdown goes above the closing lines on both exits, so the
    // last thing on screen stays the success line and the edit hint.
    console.log(formatPhaseLine(phases.timings(), phases.totalMs()));
    if (opts.review === true) {
      // --review (step 1's report, fixed in step 3): the editor opens itself
      // right after this return, so the --no-render skip line plus an
      // `ossclip edit …` hint would tell the user to do what is already
      // happening. One line that says what comes next instead.
      console.log("▸ review: opening the editor — render once from its Render button");
    } else {
      console.log(`▸ skipping render (--no-render). Props at ${join(work, "render-props.json")}`);
      console.log(editHint(work));
    }
    return {
      workdir: work,
      rendered: false,
      sourceDurationSec: sourceProbe.duration,
      sceneCount: scenes.length,
      llmProvider: provider ? providerName : undefined,
      phaseTimings: phases.timings(),
    };
  }

  // outPath was resolved (and its parent healed) at produce start — see the
  // 2026-08-16 fail-fast block up top.
  const rawPath = join(work, "render-raw.mp4");
  const interactive = isInteractive();

  // ---- Thumbnail concept approval (thumbnail UX, 2026-08-16) --------------
  // BEFORE the render kickoff, after scene planning: the concept is the one
  // creative judgement the user previously only discovered after a
  // multi-minute render. Interactive runs approve (or edit, or skip) it
  // here; the file it writes is what thumbnailStep honors after render — and
  // what a non-TTY replay (the editor's Render) reuses, which is the whole
  // persistence story. The youtube/portrait/audience/brief resolutions this
  // gate reads moved above the --no-render exit (cut-review step 1) so the
  // command.json record pins the same answers on both exits.
  const geminiKey = process.env.GEMINI_API_KEY;
  const approvedConceptPath = join(work, THUMBNAIL_APPROVED_BASENAME);
  // The gate reuses thumbnailDecision (plus the mime check) so the prompt
  // never asks about a thumbnail the post-render step would skip anyway.
  const thumbnailWouldGenerate =
    provider != null &&
    portrait !== undefined &&
    thumbnailDecision(
      youtube,
      portrait,
      geminiKey !== undefined && geminiKey !== "",
      existsSync(portrait),
    ) === "generate" &&
    portraitMimeType(portrait) !== undefined;
  if (interactive && thumbnailWouldGenerate) {
    if (existsSync(approvedConceptPath)) {
      // A decision already on file IS the answer — re-asking a question the
      // user settled would make every warm re-run nag. The line names the
      // escape hatch instead.
      console.log(
        `▸ thumbnail: concept already decided (${THUMBNAIL_APPROVED_BASENAME} — delete it to revisit)`,
      );
    } else {
      // Seed from the concept cache when this exact steer was asked before
      // (a prior non-TTY run) — no titleAngle: the pack generates after
      // render, so the pre-render call cannot carry it and passes the hook
      // instead (see generateConcept below).
      const conceptCache = join(
        work,
        thumbnailConceptCacheName({
          providerName,
          llmModel: opts.llmModel,
          intent: opts.intent,
          hook: beatSheet?.hook,
          audience,
          brief: thumbnailBrief,
          transcriptWords: transcript.words.map((w) => w.text),
        }),
      );
      const initial = existsSync(conceptCache)
        ? ThumbnailConceptSchema.parse(JSON.parse(await readFile(conceptCache, "utf8")))
        : undefined;
      try {
        const approved = await approveThumbnailConcept({
          initial,
          generateConcept: async (note) => {
            const fresh = await phases.time("llm", () =>
              generateThumbnailConcept(provider!, {
                hook: beatSheet?.hook,
                intent: opts.intent,
                audience,
                brief: thumbnailBrief,
                note,
                transcriptText: transcript.words.map((w) => w.text).join(" "),
              }),
            );
            // The §35 word cap, thumbnailStep's exact treatment — approved
            // text must be the text the image is prompted with.
            return { ...fresh, overlayText: approvedOverlayText(fresh.overlayText) };
          },
        });
        await writeFile(approvedConceptPath, JSON.stringify(approved, null, 2));
      } catch (err) {
        // A concept-call failure must not block the render the user is
        // waiting on (§112 posture) — no approved file is written, and the
        // post-render step retries the concept on its own.
        console.log(
          `▸ thumbnail: concept approval unavailable (${err instanceof Error ? err.message : String(err)}) ` +
            "— the post-render step will try again",
        );
      }
    }
  }

  // --concurrency, else config renderConcurrency, else cpus-2 with a floor of
  // 2 (resolveRenderConcurrency has the precedence and the why: leave cores
  // for the ffmpeg decode workers every tab waits on). Resolved BEFORE the log
  // line below so the count can go INTO it — the 2026-08-19 whole-browser OOM
  // took a machine spec and arithmetic to diagnose, because no line of the
  // render's own output ever said how many tabs it opened.
  const renderConcurrency = resolveRenderConcurrency(
    opts.concurrency,
    cfg.renderConcurrency,
    cpus().length,
  );
  if (renderConcurrency.warning) console.log(renderConcurrency.warning);
  let renderHud: RenderTimelineHUD | null = null;
  if (interactive) {
    renderHud = new RenderTimelineHUD({
      totalDurationSec: map.outputDuration,
      sceneNames: scenes.map((s) => s.component),
      fps: 30,
      aspect: landscape ? "16:9" : "9:16",
    }).start();
  } else {
    console.log(`▸ rendering… (${renderConcurrency.concurrency} parallel tabs)`);
  }
  let lastPct = -10;
  // Ctrl-C must actually stop the render (2026-08-19 field report). Remotion
  // owns a browser and ffmpeg children that outlive a bare process death, so
  // stopping means handing renderMedia a cancelSignal and firing it — node's
  // default SIGINT handling would leave those orphaned.
  //
  // Registered around the RENDER PHASE ONLY, and removed in the finally: a
  // handler that outlived this phase would swallow Ctrl-C during the LLM and
  // whisper phases, which exit promptly today and must keep doing so.
  //
  // SIGTERM is wired for the same reason as SIGINT, plus one of its own: the
  // editor's /api/render/cancel (edit.ts) kills this process as a child, and
  // before this handler that kill left the browser behind. That path is
  // otherwise untouched — it already reports its own cancel. It also inherits
  // the dead-window fix below: the editor's Cancel button now kills the child
  // DURING bundling too, where the SIGTERM used to be swallowed and
  // /api/render kept answering 409 until the bundle finished on its own.
  const renderCancel = makeCancelSignal();
  // An array, not a `let`: the handler assigns from inside a closure, and TS's
  // flow analysis would still read a `let` as null in the catch below (it
  // narrowed the branch to `never`). First signal wins — hammering Ctrl-C must
  // not rewrite the verdict while the teardown is already running.
  const cancellations: RenderCancellation[] = [];
  // Where renderProduction is, so the handler knows whether the cancel signal
  // has anyone listening (renderSignalAction has the whole reasoning).
  // "pre-render" from the start: the handlers go on before the call.
  let signalPhase: RenderSignalPhase = "pre-render";
  let signalCount = 0;
  // Shared by all three places a cancel is finalised — the handler, the
  // rejected-render catch, and the post-render tail check.
  const finishCancel = (c: RenderCancellation, note?: string): never => {
    if (renderHud) renderHud.stop();
    if (note) console.log(note);
    // rmSync, not fs/promises rm: the handler path calls this and exits on the
    // next statement, and an awaited unlink would never get its turn.
    for (const path of c.removePaths) rmSync(path, { force: true });
    console.log(c.message);
    // Exits here rather than throwing: program.ts's catch would record this as
    // produce_failed and print "✗ <message>", dressing a deliberate stop as a
    // bug (R16 §60's distinction).
    process.exit(c.exitCode);
  };
  const onCancelSignal = (signal: "SIGINT" | "SIGTERM") => {
    signalCount += 1;
    if (cancellations.length === 0) cancellations.push(renderCancellation(signal, rawPath));
    const action = renderSignalAction(signalPhase, signalCount);
    if (action.cancel) renderCancel.cancel();
    if (action.exitNow) finishCancel(cancellations[0]!, action.note);
  };
  const onSigint = () => onCancelSignal("SIGINT");
  const onSigterm = () => onCancelSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await phases.time("render", () =>
      renderProduction(props, {
        publicDir: dirname(renderVideo),
        outPath: rawPath,
        browserExecutable: cfg.browserExecutable,
        concurrency: renderConcurrency.concurrency,
        // The composition stays 1080-wide and Remotion renders it larger
        // (`--resolution`) — rebuilding the stage at 2160 would keep
        // `captionFontSizeFor`'s absolute 64px and draw quarter-size captions.
        scale: output.scale,
        cancelSignal: renderCancel.cancelSignal,
        onPhase: (phase: RenderPhase) => {
          signalPhase = renderSignalPhaseOf(phase);
        },
        onProgress: (p) => {
          if (renderHud) {
            renderHud.setProgress(p);
          } else {
            const pct = Math.floor(p * 100);
            if (pct >= lastPct + 10) {
              lastPct = pct;
              process.stdout.write(`  ${pct}%\n`);
            }
          }
        },
      }),
    );
    // renderMedia resolved, so nothing is left to cancel cooperatively. Not a
    // phase the handler can exit from either — see the tail check below.
    signalPhase = "post-render";
  } catch (err) {
    // A cancelled renderMedia rejects like any other failure; only the
    // handler above can tell the two apart.
    const cancellation = cancellations[0];
    if (!cancellation) throw err;
    finishCancel(cancellation);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  // The TAIL CASE (2026-08-19 review): a signal landing after renderMedia
  // resolved but before the `finally` above took the handlers off used to be
  // swallowed outright — nothing threw, the run went on to loudnorm and
  // mastering, and the user got a complete video having pressed Ctrl-C. We
  // HONOR it: the user asked to stop, and stopping here costs only the
  // mastering pass, whereas ignoring it hands them the file they just said
  // they did not want. Nothing has been written to --out yet (moveFile is
  // below), so honoring here is still "no output", the same promise every
  // other cancel makes.
  const tailCancellation = cancellations[0];
  if (tailCancellation) finishCancel(tailCancellation);
  if (renderHud) renderHud.stop();

  const masterAnim = interactive
    ? new StageAnimator(
        "MASTERING",
        "Dual-pass loudness normalization (EBU R128 broadcast standard)...",
        "master",
      ).start()
    : null;
  if (!masterAnim) console.log("▸ normalizing loudness…");
  const normPath = join(work, "render-norm.mp4");
  await phases.time("ffmpeg", () => loudnorm(tools, rawPath, normPath));
  if (masterAnim) masterAnim.stop();
  // moveFile, not fs rename: an --out on another volume (external drive)
  // throws EXDEV at the very end of the run — the sibling trap to the
  // ENOENT ensureParentDir prevents upfront (paths.ts).
  await moveFile(normPath, outPath);

  // ---- Cover image (FINDINGS §31) -----------------------------------------
  // A separate file, not a burned-in intro: both platforms accept a custom
  // cover, so nothing has to be pickable from the video — and spending the
  // opening seconds on a title card fights the hook-in-2s policy directly.
  {
    // §35's cap applies here too: a cached beat sheet from before the fix, or
    // the hook fallback, must not slip a 13-word paragraph onto a thumbnail.
    const generatedCoverText = coverHeadline(beatSheet?.coverText ?? beatSheet?.hook ?? "");
    // A headline someone typed (`ossclip cover --text`, or the editor) is a
    // user-owned file, exactly like overrides.json and the approved thumbnail
    // concept: this run does NOT quietly replace it with a fresh beat sheet's
    // coverText. Read before the decision below, because it decides the text
    // the decision is made about.
    const priorCover = await readCoverProvenance(work);
    const heldCover = coverTextHold({
      generated: generatedCoverText,
      persisted: priorCover,
      reset: opts.coverTextReset === true,
    });
    if (heldCover.message) console.log(heldCover.message);
    const coverText = heldCover.text;
    // Urdu field run 2026-08-05: a run without --produce has no hook text,
    // and skipping the cover for that threw away the part that never needed
    // text — the sharpness-scored face frame. No headline now means a bare
    // frame, not no cover; see `coverDecision`'s doc comment.
    const cover = coverDecision(opts.cover !== false, coverText);
    if (cover !== "none") {
      const detector = await createFaceDetector();
      const pick = await pickCoverFrame(tools, input, sourceProbe.duration, {
        cacheDir: work,
        cropVf,
        // On a screen-subject take the face weight is zeroed (2026-08-16: a
        // Facebook reel face visible IN the screen recording won the cover
        // — scoreCandidate has the incident). Same whole-take verdict the
        // stage bias and the span mask fallback read.
        subject: faceSubject(faceBox),
        detectFace: (pixels, w, h) => {
          const d = detector(pixels, w, h);
          // pico returns [row, col, size, score] in detection-frame pixels,
          // and that frame is cropped exactly like the cover — so these
          // fractions are the cover's own geometry, not the source's.
          return d ? { centerXFrac: d[1] / w, centerYFrac: d[0] / h, sizeFrac: d[2] / h } : null;
        },
      });
      if (!pick) {
        console.log("▸ no usable cover frame found — skipping cover");
      } else {
        const frameName = COVER_FRAME_BASENAME;
        await run(cfg.ffmpegPath, [
          "-v", "error",
          "-ss", pick.timeSec.toFixed(3),
          "-i", input,
          "-frames:v", "1",
          "-vf", `${cropVf ? `${cropVf},` : ""}scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase,crop=${frame.width}:${frame.height}`,
          "-y", join(work, frameName),
        ]);
        // expandHome on the user half only — the artifactPath default derives
        // from the already-expanded outPath (2026-08-16, paths.ts).
        const coverPath = resolve(
          opts.coverPath !== undefined
            ? expandHome(opts.coverPath)
            : artifactPath(outPath, ".cover.jpg"),
        );
        // The §34 dedupe check and the band-placement log exist only to
        // route a banner around the frame's contents — a textless cover
        // (Urdu field run 2026-08-05) has no banner to place, so both are
        // skipped rather than run against text that isn't there.
        let bannerText = "";
        if (cover === "banner") {
          // §34: if the source's own title is up at this instant, the frame
          // already has a headline. Adding ours states the same claim twice in
          // one image — a cover with one title beats a cover with two.
          const sourceTitled = regionsDuring(
            sourceText.regions,
            pick.timeSec - 0.5,
            pick.timeSec + 0.5,
          ).length > 0;
          console.log(
            `▸ cover from ${pick.timeSec.toFixed(1)}s ` +
              `(${pick.hasFace ? "face" : "no face"}, sharpness ${pick.sharpness.toFixed(0)})…`,
          );
          // …unless the headline is the user's own, which §34 does not get to
          // erase (cover.ts's coverBannerText has the reasoning). Unchanged
          // for a generated headline, including the line it prints.
          const banner = coverBannerText({
            text: coverText,
            textSource: heldCover.textSource,
            sourceTitled,
          });
          if (banner.note) console.log(banner.note);
          // The band log is about routing a banner around the face, so it
          // follows whether there IS a banner — for a §34-suppressed cover
          // there is none, for a surviving user headline there is.
          if (banner.text !== "" && pick.face) {
            const band = coverTextRect(pick.face, frame);
            console.log(
              `  ▸ banner in the ${band.y + band.h / 2 < pick.face.centerYFrac ? "band above" : "band below"} ` +
                `the face (${(band.y * 100).toFixed(0)}-${((band.y + band.h) * 100).toFixed(0)}%)`,
            );
          }
          bannerText = banner.text;
        } else {
          console.log(
            `▸ cover from ${pick.timeSec.toFixed(1)}s ` +
              `(${pick.hasFace ? "face" : "no face"}, sharpness ${pick.sharpness.toFixed(0)}) ` +
              `— no banner text (run --produce for one)`,
          );
        }
        // The shared builder, not an inline props literal: `ossclip cover`
        // and the editor's regenerate endpoint call the same one, and two
        // spellings of these arguments drifting apart is the defect that
        // whole feature exists to prevent (cover.ts).
        const coverRender = buildCoverRender({
          frameFileName: frameName,
          text: bannerText,
          // The RESOLVED theme — so the cover's banner already carries the
          // config theme (F6) via resolveTheme's base, no separate wiring.
          theme,
          face: pick.face,
          // The cover is the OUTPUT's thumbnail — a landscape render gets a
          // landscape cover (R16 §76). The still was already extracted at
          // this size; only the composition disagreed.
          frame: { width: frame.width, height: frame.height },
          publicDir: work,
          outPath: coverPath,
          browserExecutable: cfg.browserExecutable,
        });
        await renderCover(coverRender.props, coverRender.opts);
        console.log(`✓ cover → ${coverPath}`);
        // Provenance, so the next headline change costs seconds instead of a
        // full re-render. Written AFTER the render succeeded and describing
        // what that render actually used — `pick.face` is the cover-crop
        // geometry nothing else on disk carries, and `cropVf` is not
        // reconstructible from the workdir either.
        //
        // Additive by contract (§112, the posture the YouTube pack block
        // below states): the video and the cover are already on disk, so a
        // failed sidecar write is one loud line, never a dead run.
        try {
          await writeCoverProvenance(work, {
            version: 1,
            text: bannerText,
            // "user" only when THIS run kept a headline someone typed
            // (coverTextHold above) — produce itself never authors one.
            textSource: heldCover.textSource,
            frame: {
              // produce keeps picking from the SOURCE — zero perturbation for
              // existing users. `ossclip cover` is the one that defaults to
              // the finished render.
              source: "source",
              timeSec: pick.timeSec,
              face: pick.face ?? null,
              hasFace: pick.hasFace,
              sharpness: pick.sharpness,
              fileName: frameName,
              // Workdir-relative when the video IS a workdir intermediate (a
              // folder run's concat mezzanine), absolute otherwise — the rule
              // `ossclip cover` reads it back with.
              sourceVideo: provenanceVideoPath(work, input),
              // cropFilter returns "" for an uncropped source; null says "no
              // crop" without a caller having to know that convention.
              cropVf: cropVf || null,
            },
            size: { width: frame.width, height: frame.height },
            out: coverPath,
          });
        } catch (err) {
          console.log(
            `  ⚠ could not write ${COVER_PROVENANCE_BASENAME} ` +
              `(${err instanceof Error ? err.message : String(err)}) — ` +
              `the cover shipped; a later headline change will re-pick the frame`,
          );
        }
      }
    }
  }

  // ---- YouTube pack (Y2, 2026-08-16) --------------------------------------
  // AFTER the cover block and additive to it: the pack never changes the
  // video or the cover, it only writes siblings — so a failure here degrades
  // to "no metadata file" on a render that already succeeded, never a dead
  // run (§112 posture). `youtube`/`portrait`/`audience`/`thumbnailBrief`
  // were resolved before the render kickoff — the concept-approval gate and
  // this section must read one answer.
  let youtubeMdPath: string | undefined;
  let thumbnailPath: string | undefined;
  // The pack's FIRST title, when it generated — the thumbnail concept's
  // titleAngle, so thumbnail and title tell one story. (The pre-render
  // approval could not carry it: the pack writes here, after render.)
  let packTitle: string | undefined;
  if (youtube) {
    // The approved file wins outright (readApprovedYoutubePack): no cache
    // lookup, no LLM call — and no provider needed, so an edited pack still
    // writes its markdown on a --youtube run that carries no --produce.
    let pack: YoutubePack | undefined = await readApprovedYoutubePack(work);
    if (pack) {
      console.log(
        "▸ youtube: metadata from your edited pack " +
          `(delete ${YOUTUBE_APPROVED_BASENAME} to regenerate)`,
      );
    } else if (!provider) {
      // The metadata call rides the run's LLM provider; a run without one
      // (no --produce) has nothing to call. Said out loud rather than
      // silently — the user typed/configured --youtube. The thumbnail (Y3)
      // is a separate API keyed by GEMINI_API_KEY and still attempts.
      console.log("▸ youtube: metadata needs an LLM provider — skipped (thumbnail unaffected)");
    } else {
      // Beat-sheet cache shape: keyed on everything that changes the answer —
      // who is asked, with what editorial steer, about which words.
      // Parameterized on the provider for the §143 read/write split: the
      // write below re-keys on who actually answered the pack call.
      const packKeyFor = (p: string): string => createHash("sha1")
        .update(
          JSON.stringify([
            // Prompt changes change the answer (the §78 posture): the v2
            // rewrite must not serve a pack cached under v1's questions.
            YOUTUBE_PROMPT_VERSION,
            p,
            opts.llmModel ?? "",
            // Appended only when set — the plan-cache rule (§78 via §143's
            // effort knob): an unset effort must keep every warm workdir's
            // key byte-identical, and a changed effort is a different answer.
            ...(llmEffort !== undefined ? [llmEffort] : []),
            opts.intent ?? "",
            // Steer, so part of the key — a changed audience is a different
            // pack, not a cache hit.
            audience ?? "",
            transcript.words.map((w) => w.text),
            // The stamped transcript's [m:ss] marks come from the CUT MAP,
            // not the words — a re-cut with identical words moves every
            // chapter stamp, and a word-only key would serve the stale
            // chapters (v2 review gap, 2026-08-17). Spans, rounded to ms,
            // pin the timeline the stamps were computed on.
            map.spans.map((s) => [Math.round(s.srcIn * 1000), Math.round(s.outIn * 1000)]),
          ]),
        )
        .digest("hex")
        .slice(0, 8);
      const packCache = join(work, `youtube-${packKeyFor(providerName)}.json`);
      if (existsSync(packCache)) {
        pack = YoutubePackSchema.parse(JSON.parse(await readFile(packCache, "utf8")));
        console.log("▸ youtube: metadata cached");
      } else {
        try {
          pack = await phases.time("llm", () =>
            generateYoutubePack(provider!, {
              // Sentence lines stamped with OUTPUT-clock times (prompt v2):
              // the words carry SOURCE seconds and `map` translates them, so
              // the chapters the model returns are measured, not guessed —
              // the one thing a paste-a-transcript prompt tool cannot do.
              transcriptText: stampedTranscript(transcript.words, map),
              intent: opts.intent,
              hook: beatSheet?.hook,
              coverText: beatSheet?.coverText,
              audience,
              durationSec: map.outputDuration,
            }),
          );
          // §143 read/write split, same as the plan and repair caches: the
          // pack files under whoever wrote it.
          await writeFile(
            join(
              work,
              `youtube-${packKeyFor(actualProvider(provider!.usage, "youtube_pack", providerName))}.json`,
            ),
            JSON.stringify(pack, null, 2),
          );
        } catch (err) {
          // NEVER cache a failure (§106), and never fail the produce that
          // just rendered over a metadata sidecar: one loud line, the video
          // and cover stand, the next run retries the call.
          console.log(
            `  ⚠ youtube metadata unavailable: ${err instanceof Error ? err.message : String(err)}\n` +
              "    (not cached — the next run retries the pass)",
          );
        }
      }
    }
    if (pack) {
      youtubeMdPath = artifactPath(outPath, ".youtube.md");
      await writeFile(youtubeMdPath, formatYoutubeMarkdown(pack));
      console.log(`✓ youtube pack → ${youtubeMdPath}`);
      packTitle = pack.titles[0];
    }
    // ---- AI thumbnail (Y3, 2026-08-16) ------------------------------------
    // Shares the gate and `portrait` above but not the provider's KEY — its
    // credential is GEMINI_API_KEY, env-only (secrets never in config.json,
    // env.ts:7-9 rule; env-file loading already ran at CLI entry), so a
    // metadata skip must not skip it. The concept call does still need the
    // run's text provider; thumbnailStep says so out loud when it's absent.
    // Consumer-side validation, the `portrait` posture above: config.json
    // is hand-edited and unparsed, so a non-string `thumbnailModel` falls
    // back to the default rather than reaching the API as garbage.
    const thumbnailModel =
      typeof cfg.thumbnailModel === "string" ? cfg.thumbnailModel : THUMBNAIL_MODEL_DEFAULT;
    const thumbnail = await thumbnailStep({
      youtube,
      portraitPath: portrait,
      apiKey: geminiKey,
      model: thumbnailModel,
      work,
      outPath,
      // The run's provider is `LlmProvider | null`; the step's "absent" is
      // undefined, matching thumbnailDecision's optional-argument shape.
      provider: provider ?? undefined,
      providerName,
      llmModel: opts.llmModel,
      intent: opts.intent,
      hook: beatSheet?.hook,
      audience,
      brief: thumbnailBrief,
      titleAngle: packTitle,
      transcriptWords: transcript.words.map((w) => w.text),
      time: (fn) => phases.time("llm", fn),
    });
    thumbnailPath = thumbnail?.path;
    if (thumbnail && interactive && geminiKey) {
      // Post-generation retry (thumbnail UX, 2026-08-16): the image call is
      // seconds where the render was minutes, so an unwanted result is cheap
      // to redo NOW — the concept stays fixed, only the image re-rolls with
      // the user's note.
      await thumbnailRetryLoop({
        imagePath: thumbnail.path,
        imageCachePath: thumbnail.imageCachePath,
        concept: thumbnail.concept,
        apiKey: geminiKey,
        model: thumbnailModel,
        portrait: thumbnail.portrait,
        generate: generateThumbnailImage,
      });
    }
  }
  // command.json was recorded above the --no-render exit (cut-review step 1)
  // — see the block before that fork for the §75/§93g/§129 pinning story.
  console.log(formatPhaseLine(phases.timings(), phases.totalMs()));
  console.log(`✓ done → ${outPath}`);
  if (isInteractive()) {
    printProductionCompleteBanner({
      outPath,
      // `opts.coverPath ?? artifactPath(...)`, matching the cover write above.
      // The old check here was `typeof opts.cover === "string"` — stale since
      // the cover/coverPath split, so an explicit --cover <path> banner'd the
      // default path instead of the file actually written.
      coverPath: opts.cover !== false ? opts.coverPath ?? artifactPath(outPath, ".cover.jpg") : undefined,
      youtubePath: youtubeMdPath,
      thumbnailPath,
      sourceDurationSec: sourceProbe.duration,
      outputDurationSec: map.outputDuration,
      sceneCount: scenes.length,
      llmProvider: provider ? providerName : undefined,
      renderTimeSec: phases.timings().render ? phases.timings().render! / 1000 : undefined,
    });
  }
  console.log(editHint(work));
  return {
    workdir: work,
    out: outPath,
    rendered: true,
    sourceDurationSec: sourceProbe.duration,
    sceneCount: scenes.length,
    llmProvider: provider ? providerName : undefined,
    phaseTimings: phases.timings(),
  };
}
