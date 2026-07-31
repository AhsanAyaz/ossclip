import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  LayoutSchema,
  SceneSchema,
  TimeMap,
  TranscriptSchema,
  analyze,
  applyOverrides,
  applyRepairs,
  assembleScenes,
  applyCaptionEdits,
  buildCaptionLines,
  buildCutlist,
  buildZoomPlan,
  checkGrounding,
  rejectCtaKeyword,
  coverHeadline,
  cropFilter,
  detectContentRect,
  letterboxedSeconds,
  type ContentRect,
  createFaceDetector,
  createProvider,
  createTieredProvider,
  defaultProviderName,
  defaultTheme,
  detectSilences,
  dropHiddenCues,
  emptyOverrideDoc,
  extractAudio,
  fillPlainCues,
  splitCues,
  landscapeLayout,
  formatCutReport,
  formatGraphicsAccounting,
  formatUsageLine,
  formatUsageReport,
  loadConfig,
  loudnorm,
  MAX_NORMALIZE_UPSCALE,
  ZOOM_MAX_SCALE,
  assessCueFraming,
  bakeNormalizedSource,
  planNormalization,
  type NormalizePlan,
  makeMezzanine,
  measureFace,
  measureFaceInWindows,
  pickCoverFrame,
  measureLevels,
  probe,
  produceScenes,
  reclampPinnedTiming,
  reconcileCopy,
  repairTranscript,
  resolveTheme,
  run,
  runWhisper,
  scanSourceText,
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
  type BeatsValidationIssue,
  type CleanupLevel,
  type ClipWindow,
  type LlmProvider,
  type Production,
  type ProviderName,
  type Scene,
  type SceneComponentId,
  type Segment,
  type Transcript,
} from "@ossclip/core";
import { recordRecentProject } from "./edit";
import { renderCover, renderProduction } from "@ossclip/renderer";
import {
  coverTextRect,
  layoutSlots,
  regionsDuring,
  routeAroundSourceText,
} from "@ossclip/scenes/geometry";

export interface ProduceOptions {
  out?: string;
  cleanup: CleanupLevel;
  transcript?: string;
  render: boolean;
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
  /** Who is on camera — steers repair and exempts their name from grounding. */
  speaker?: string;
  /** Repair ASR mishearings before captions/producer/grounding (default on). */
  repair?: boolean;
  /** Override the whisper model for this run (A/B base.en vs small.en). */
  whisperModel?: string;
  /** Debug: force every graphic moment to this component. */
  forceComponent?: SceneComponentId;
  /** Write a cover image beside the video (default on). */
  cover?: boolean;
  /** Explicit cover output path, overriding <out>.cover.jpg. */
  coverPath?: string;
  /** Treat the source as an already-edited reel with burned-in graphics. */
  sourceIsEdited?: boolean;
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
}

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
 * Frame-area share above which a layout's video slot is the SUBJECT rather
 * than an inset. `video-top` is 42% and full-bleed 100%; the pip bubble is 5%.
 */
const PRIMARY_VIDEO_SLOT_AREA = 0.2;

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

export async function produce(inputArg: string, opts: ProduceOptions): Promise<void> {
  const cfg = loadConfig();
  const input = resolve(inputArg);
  if (!existsSync(input)) throw new Error(`input not found: ${input}`);

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

  await preflight(cfg.ffmpegPath, "Run `ossclip setup`, install ffmpeg yourself (brew/apt/winget), or set OSSCLIP_FFMPEG.");
  await preflight(cfg.ffprobePath, "Run `ossclip setup`, install ffmpeg (provides ffprobe), or set OSSCLIP_FFPROBE.");

  // The output frame — every rect downstream is a fraction of THIS, and the
  // stage geometry now takes it as an argument rather than assuming portrait.
  const landscape = opts.aspect === "16:9";
  const frame = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const hash = (await sha1File(input)).slice(0, 8);
  const workRoot = opts.workdir ? resolve(opts.workdir) : join(dirname(input), ".ossclip");
  const work = join(
    workRoot,
    `${basename(input).replace(/\.[^.]+$/, "")}-${hash}${landscape ? "-16x9" : ""}`,
  );
  await mkdir(work, { recursive: true });
  const tools = { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath };

  console.log(`▸ workdir ${work}`);
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
    console.log("▸ extracting audio…");
    await extractAudio(tools, input, audioPath);
  }

  // Letterbox detection (PLAN Task 7): a file's frame is not always its
  // picture — bars baked into the pixels wasted most of the video slot on one
  // real clip. Measured once, before anything geometric; every downstream
  // pass crops to the content rect so the bars stop existing.
  const detection = await detectContentRect(tools, input, sourceProbe, { cacheDir: work });
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
  if (opts.transcript) {
    transcript = TranscriptSchema.parse(JSON.parse(await readFile(resolve(opts.transcript), "utf8")));
    console.log(`▸ transcript injected from ${opts.transcript} (${transcript.words.length} words)`);
  } else if (existsSync(transcriptCache)) {
    transcript = TranscriptSchema.parse(JSON.parse(await readFile(transcriptCache, "utf8")));
    console.log(`▸ transcript cached (${transcript.words.length} words)`);
  } else {
    await preflight(
      cfg.whisperPath,
      "Run `ossclip setup`, install whisper.cpp yourself (https://github.com/ggml-org/whisper.cpp), or set OSSCLIP_WHISPER.",
    );
    const model = opts.whisperModel ?? cfg.model;
    const modelPath = isAbsolute(model) ? model : join(cfg.modelDir, `ggml-${model}.bin`);
    if (!existsSync(modelPath)) {
      throw new Error(
        `whisper model not found at ${modelPath}.\n` +
          `Run \`ossclip setup${model === cfg.model ? "" : ` --model ${model}`}\` to download it — or manually:\n` +
          `  curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
      );
    }
    console.log(`▸ transcribing (${basename(modelPath)})…`);
    transcript = await runWhisper(
      { whisperPath: cfg.whisperPath, modelPath, outBase: join(work, "whisper") },
      audioPath,
    );
    console.log(`▸ transcribed ${transcript.words.length} words`);
  }
  await writeFile(transcriptCache, JSON.stringify(transcript, null, 2));

  const levels = await measureLevels({ ffmpegPath: cfg.ffmpegPath }, audioPath);
  console.log(
    `▸ levels: floor ${levels.floorDb.toFixed(1)} dB · speech ${levels.speechDb.toFixed(1)} dB ` +
      `→ silence threshold ${levels.thresholdDb.toFixed(1)} dB`,
  );
  console.log("▸ analyzing silences…");
  const silences = await detectSilences(
    { ffmpegPath: cfg.ffmpegPath, noiseDb: opts.noiseDb ?? levels.thresholdDb },
    audioPath,
  );
  // `let`, not `const` (R19 §93): a clip run re-derives all three from the
  // transcript sliced to the chosen window, further down.
  let analysis: Analysis = analyze(transcript, silences, sourceProbe.duration, levels);
  let cutlist: Segment[] = buildCutlist({
    transcript,
    analysis,
    duration: sourceProbe.duration,
    level: opts.cleanup,
  });
  let map = new TimeMap(cutlist);

  // ---- Transcript repair (FINDINGS §17/§21) --------------------------------
  // Deliberately AFTER the cutlist: the cut is computed from raw ASR, so the
  // same input and --cleanup always produce the same edit whether or not an
  // LLM ran. Everything downstream that a viewer READS — captions, scene copy,
  // the grounding check — uses the repaired transcript instead, so a
  // mishearing can't reach the screen twice in two different spellings.
  const providerName = opts.provider ?? defaultProviderName();
  let provider: LlmProvider | null = null;
  const needsLlm = opts.produce === true;
  if (needsLlm) {
    if (!opts.provider) {
      console.log(
        providerName === "claude-cli"
          ? "▸ no ANTHROPIC_API_KEY — using the Claude Code CLI (subscription auth)"
          : "▸ ANTHROPIC_API_KEY found — using the Claude API",
      );
    }
    provider = createTieredProvider(providerName, {
      model: opts.llmModel,
      fastModel: opts.llmFastModel ?? cfg.fastModel,
    });
  }

  let rawTranscript = transcript;
  let repairs: AppliedRepair[] = [];
  if (provider && opts.repair !== false) {
    const rawKey = createHash("sha1")
      .update(
        JSON.stringify([
          providerName,
          opts.llmModel,
          opts.llmFastModel ?? cfg.fastModel,
          opts.speaker ?? cfg.speaker,
          rawTranscript.words.map((w) => w.text),
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    const repairCache = join(work, `repairs-${rawKey}.json`);
    if (existsSync(repairCache)) {
      repairs = JSON.parse(await readFile(repairCache, "utf8")) as AppliedRepair[];
      transcript = applyRepairs(
        rawTranscript,
        repairs.filter((r) => r.applied),
      ).transcript;
      console.log(`▸ repairs cached (${repairs.filter((r) => r.applied).length})`);
    } else {
      const result = await repairTranscript(provider, rawTranscript, {
        speaker: opts.speaker ?? cfg.speaker,
        // A repair may not merge words across a cut.
        isCut: (startSec, endSec) =>
          cutlist.some(
            (s) => s.kind === "remove" && s.srcIn < endSec && s.srcOut > startSec,
          ),
      });
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
        await writeFile(repairCache, JSON.stringify(repairs, null, 2));
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
   * that alternates framings is NORMALIZED — every segment cropped to the
   * tightest field of view the take ever shows, placed on that segment's own
   * measured face, and baked into one uniform file. The PLAN is computed here,
   * before the producer, because the producer needs the framing brief: which
   * word ranges are close shots, and which layouts those rule out. The BAKE
   * itself runs after the scenes exist.
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
    framingPlan = planNormalization(contentTimeline, segmentFaces, frame);
  }

  // ---- Scenes: hand-authored file, or the producer brain (PHASE1 §4) ----
  let scenes: Scene[] = [];
  /** Editorial output kept for the cover (§31): hook + its thumbnail form. */
  let beatSheet: { hook: string; coverText?: string } | undefined;
  /** The graphics accounting line for report.txt (§118b), and the beat-sheet
   * issues that explain it. Cached alongside the beat sheet so a cached
   * re-run's report keeps the accounting instead of erasing it (§78). */
  let graphicsLine: string | undefined;
  let beatIssues: BeatsValidationIssue[] = [];
  /** Who planned this run (R16 §78) — stamped into production.json below. */
  let producerStamp: Production["producer"];
  /** The resolved `--clip` window (R19 §93) — set only on a clip run; feeds
   * `production.json`, the report, and the command.json pin below. */
  let clipWindow: ClipWindow | null = null;
  if (opts.scenes) {
    scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(resolve(opts.scenes), "utf8")));
    console.log(`▸ scenes injected from ${opts.scenes} (${scenes.length})`);
  } else if (provider) {
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
          layouts: LayoutSchema.options.map((layout) => {
            const v = layoutSlots(layout).video;
            return {
              layout,
              slotAspect: (v.rect.w * frame.width) / (v.rect.h * frame.height),
              primary: v.opacity > 0 && v.rect.w * v.rect.h >= PRIMARY_VIDEO_SLOT_AREA,
            };
          }),
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
      const windowKey = createHash("sha1")
        .update(
          JSON.stringify([
            providerName,
            opts.llmModel,
            opts.intent,
            clipTargetSec,
            framingCtx ?? null,
            transcript.words.map((w) => w.text),
          ]),
        )
        .digest("hex")
        .slice(0, 8);
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
        clipFresh = await produceScenes(provider, {
          transcript,
          outputDuration: clipTargetSec,
          intent: opts.intent,
          speaker: opts.speaker ?? cfg.speaker,
          forceComponent: opts.forceComponent,
          framing: framingCtx,
          clip: { targetSec: clipTargetSec },
          aspect: landscape ? "16:9" : "9:16",
        });
        clipWindow = clipFresh.clip!.window;
        for (const note of clipFresh.clip!.notes) console.log(`  ▸ ${note}`);
        await writeFile(clipWindowCache, JSON.stringify(clipWindow, null, 2));
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
      cutlist = boundCutlistToWindow(
        buildCutlist({
          transcript: rawTranscript,
          analysis,
          duration: sourceProbe.duration,
          level: opts.cleanup,
        }),
        clipWindow,
        sourceProbe.duration,
      );
      map = new TimeMap(cutlist);
    }

    const cacheKey = createHash("sha1")
      .update(
        JSON.stringify([
          providerName,
          opts.llmModel,
          opts.intent,
          opts.cleanup,
          opts.forceComponent ?? null,
          // The framing constraints steer layout choice, so a change in the
          // measured framing must invalidate the cached plan.
          framingCtx ?? null,
          // §93f: the clip target and the RESOLVED window key the plan too —
          // without them a clip run and a full run of the same source would
          // collide and answer from each other's cache (the §78 failure
          // mode). Keyed POST-resolution so a replay that derives the same
          // window hits the same entries.
          clipTargetSec ?? null,
          clipWindow ? `${clipWindow.startWord}:${clipWindow.endWord}` : null,
          transcript.words.map((w) => w.text),
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    const sceneCache = join(work, `scenes-${cacheKey}.json`);
    // The cover needs the editorial copy, which is not in the scene list — a
    // cached run must still be able to write one.
    const beatCache = join(work, `beatsheet-${cacheKey}.json`);
    if (clipFresh) {
      // The selection call already planned the scenes (§93d: ONE editorial
      // call chooses the window and the beats inside it) — adopt them and
      // cache under the post-resolution key so re-runs and replays hit it.
      scenes = clipFresh.scenes;
      beatSheet = { hook: clipFresh.beatSheet.hook, coverText: clipFresh.beatSheet.coverText };
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
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(
        beatCache,
        JSON.stringify({ ...beatSheet, graphics: graphicsLine, issues: beatIssues }, null, 2),
      );
    } else if (existsSync(sceneCache)) {
      scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(sceneCache, "utf8")));
      console.log(`▸ scenes cached (${scenes.length})`);
      if (existsSync(beatCache)) {
        // Pre-§118b caches carry no accounting — the report then simply
        // omits the graphics section rather than guessing one.
        const cached = JSON.parse(await readFile(beatCache, "utf8")) as {
          hook: string;
          coverText?: string;
          graphics?: string;
          issues?: BeatsValidationIssue[];
        };
        beatSheet = { hook: cached.hook, coverText: cached.coverText };
        graphicsLine = cached.graphics;
        beatIssues = cached.issues ?? [];
      }
    } else {
      console.log(`▸ producing scenes (${providerName})…`);
      if (opts.forceComponent) console.log(`▸ forcing every graphic to ${opts.forceComponent}`);
      const result = await produceScenes(provider, {
        transcript,
        outputDuration: map.outputDuration,
        intent: opts.intent,
        speaker: opts.speaker ?? cfg.speaker,
        forceComponent: opts.forceComponent,
        framing: framingCtx,
        aspect: landscape ? "16:9" : "9:16",
      });
      scenes = result.scenes;
      beatSheet = { hook: result.beatSheet.hook, coverText: result.beatSheet.coverText };
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
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(
        beatCache,
        JSON.stringify({ ...beatSheet, graphics: graphicsLine, issues: beatIssues }, null, 2),
      );
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
    producerStamp = {
      provider: last.provider ?? providerName,
      models: last.models,
      cached: last.cached,
      at: last.at,
    };
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

  const { cues: assembled, dropped } = assembleScenes(scenes, transcript, map);
  for (const d of dropped) console.log(`  ⚠ scene ${d.id} dropped: ${d.reason}`);

  // ---- Framing bake (plan step C / option (a)) ----------------------------
  // The MEASUREMENT ran before the producer (Tasks A+B need it in the beat-
  // sheet prompt); the BAKE stays here, after the scenes exist, so a future
  // scene-aware bake has the cues in scope. Moving measurement up changes no
  // edit decision — the cut is still computed on raw ASR above.
  let analysisInput = input;
  let analysisProbe = sourceProbe;
  let analysisCropVf = cropVf;
  let cacheTag = "";
  let fitFallback = false;
  if (framingPlan) {
    const plan = framingPlan;
    if (plan.ok) {
      const planHash = createHash("sha1").update(JSON.stringify(plan)).digest("hex").slice(0, 8);
      const baked = join(work, `content-${planHash}.mp4`);
      if (!existsSync(baked)) {
        console.log(
          `▸ normalizing framing: one ${plan.canvas.width}×${plan.canvas.height} field of view ` +
            `across ${plan.segments.length} segments (upscale ×${plan.coverUpscale.toFixed(2)})…`,
        );
        await bakeNormalizedSource(tools, input, plan, baked);
      } else {
        console.log(`▸ normalized framing cached (${basename(baked)})`);
      }
      analysisInput = baked;
      analysisProbe = await probe(tools, baked);
      analysisCropVf = "";
      cacheTag = basename(baked);
    } else {
      fitFallback = true;
      console.log(
        `  ⚠ strip too small to unify (would upscale ×${plan.coverUpscale.toFixed(2)} > ` +
          `${MAX_NORMALIZE_UPSCALE}) — letterboxed stretches render FITTED at natural size; ` +
          `framing will visibly change at ${contentTimeline.length - 1} boundaries`,
      );
    }
  }
  const contentRect: ContentRect = detection.uniform ?? {
    x: 0, y: 0, w: analysisProbe.width, h: analysisProbe.height, full: true,
  };
  /** The picture's dimensions — what every geometric consumer reasons about. */
  const content = { width: contentRect.w, height: contentRect.h };

  // Face measurement (FINDINGS §13): one static crop offset per source,
  // measured rather than guessed; cached in the workdir like the transcript.
  const faceSamples = 9;
  const faceBox = await measureFace(tools, analysisInput, analysisProbe.duration, {
    cacheDir: work,
    cropVf: analysisCropVf,
    cacheTag,
    samples: faceSamples,
  });
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

  // A landscape source loses most of its width to the vertical frame, and how
  // much is arithmetic, not opinion: cover-cropping displays the picture at
  // `height × aspect` and keeps only the frame's width of it. Said out loud
  // because the result LOOKS deliberate — a tight talking head — and nothing
  // else in the run would mention that the desk, the screen and the second
  // person are simply gone.
  if (!landscape && opts.sourceFit !== "contain" && content.height > 0) {
    const displayedW = frame.height * (content.width / content.height);
    if (displayedW > frame.width * 1.05) {
      console.log(
        `▸ source is ${(content.width / content.height).toFixed(2)}:1 — a full-frame crop keeps ` +
          `${((frame.width / displayedW) * 100).toFixed(0)}% of its width. ` +
          "Use --source-fit contain to show the whole frame instead.",
      );
    }
  }

  // ---- Route around the source's own burned-in text (FINDINGS §26) --------
  // Fed a finished reel, ossclip would otherwise stack its layer on an
  // existing one — cropping through the source's title and then restating it
  // underneath. Graphics move to a clear slot or are skipped; captions never
  // are, they just relocate.
  const sourceText = await scanSourceText(tools, analysisInput, analysisProbe.duration, {
    cacheDir: work,
    assumeEdited: opts.sourceIsEdited,
    cropVf: analysisCropVf,
    cacheTag,
  });
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
  const routed = routeAroundSourceText(assembled, textRegions);
  for (const r of routed.relayouts) {
    console.log(`  ▸ scene ${r.id}: ${r.from} → ${r.to} (source text in the way)`);
  }
  for (const m of routed.moved) {
    console.log(
      `  ▸ scene ${m.id}: graphic moved into the free band at ` +
        `${(m.y * 100).toFixed(0)}-${((m.y + m.h) * 100).toFixed(0)}%`,
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
  // Read AFTER assembly so hand edits sit on top of whatever the producer just
  // planned, and never in production.json — that file is ours to overwrite.
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
  const { cues: editedCues } = applyOverrides(routed.cues, overrideDoc);
  // Scenes the user deleted in the editor drop here — their windows become
  // plain takes in the fill below, which is Task C's payoff for Task A.
  const { cues: visibleCues, hidden: hiddenIds } = dropHiddenCues(editedCues, overrideDoc);
  if (hiddenIds.length > 0) {
    console.log(`▸ ${hiddenIds.length} scene(s) hidden by the edit layer: ${hiddenIds.join(", ")}`);
  }
  const theme = resolveTheme(defaultTheme, overrideDoc);

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
  const filled = fillPlainCues(reclamped, {
    outputDurationSec: map.outputDuration,
    clipStarts: map.spans.map((s) => s.outIn),
  });
  // User splits (R16 §61) — after the fill so takes split like scenes, and
  // before the final override pass so edits on the `id@ms` halves land.
  const split = splitCues(filled, overrideDoc.splits);
  if (overrideDoc.splits.length > 0) {
    console.log(`▸ ${overrideDoc.splits.length} scene split(s) from the edit layer`);
  }
  const { cues: mergedCues, orphans: rawOrphans } = applyOverrides(split, overrideDoc);
  // Halves the user deleted AFTER splitting: their hidden override targets an
  // `id@ms` id that only exists post-split, so the first drop above never saw
  // it. Same order as the editor's live memo.
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
    console.log(`  ⚠ edit for ${id} dropped — the plan no longer has that scene`);
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
  const groundingIssues = checkGrounding(scenes, transcript, opts.speaker ?? cfg.speaker);
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
  // the way the schema intended. Checked against the two directories that
  // can become the render's public dir: the workdir (mezzanine path) and
  // the source's own folder (--no-mezzanine).
  const srcRejections: Array<{ sceneId: string; src: string }> = [];
  for (const holder of [...scenes, ...graphicCues]) {
    const src = holder.props?.src;
    if (typeof src !== "string" || src.length === 0) continue;
    if (existsSync(join(work, src)) || existsSync(join(dirname(input), src))) continue;
    delete (holder.props as Record<string, unknown>).src;
    srcRejections.push({ sceneId: holder.id, src });
  }
  for (const r of [...new Map(srcRejections.map((r) => [r.src, r])).values()]) {
    console.log(
      `  ⚠ image "${r.src}" does not exist beside the video — ` +
        "rendering the frame as a placeholder instead",
    );
  }

  const production: Production = {
    version: 1,
    source: { path: input, probe: sourceProbe, audioPath, face: faceBox },
    cleanup: opts.cleanup,
    intent: opts.intent,
    // The RAW transcript, because `analysis` and `cutlist` index into it —
    // storing the repaired one here would leave those pointing at words that
    // no longer exist. Repairs are kept alongside so the repaired transcript
    // stays derivable (`applyRepairs`) rather than being a second truth.
    transcript: rawTranscript,
    repairs: repairs.length > 0 ? repairs : undefined,
    analysis,
    cutlist,
    ...(clipWindow && clipTargetSec !== undefined
      ? { clip: { targetSec: clipTargetSec, ...clipWindow } }
      : {}),
    scenes: scenes.length > 0 ? scenes : undefined,
    producer: producerStamp,
    theme,
    render: { ...frame, fps: 30 },
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
  });
  // The user's retyped caption words (editor, PLAN 2026-07-29 Task 7 scope
  // (a)). Guarded per word: a stale edit — the pipeline re-derived a
  // different word at that position — is dropped LOUDLY, never applied to
  // the wrong word and never silently forgotten.
  const { lines: captionLines, dropped: staleCaptionEdits } = applyCaptionEdits(
    baseCaptionLines,
    overrideDoc.captions,
  );
  const liveCaptionEdits = Object.keys(overrideDoc.captions).length - staleCaptionEdits.length;
  if (liveCaptionEdits > 0) console.log(`▸ ${liveCaptionEdits} caption word(s) retyped by the editor`);
  for (const d of staleCaptionEdits) {
    console.log(
      `  ⚠ caption edit at word ${d.index} dropped: expected "${d.expected}" there, ` +
        `the transcript now has "${d.found}"`,
    );
  }

  // Micro zoom punches (FINDINGS §15) reversing at real phrase breaks (§18).
  // Breaths are source-time; TimeMap has no span mapper, so both ends go
  // through toOutputClamped — a pause that was cut collapses to one instant,
  // which is still a boundary (a jump cut is a phrase break too).
  // One move per cut-free clip: ramp in, then hold. The clip starts ARE the
  // cuts — every point the source jumps — so a take that removed nothing is
  // one clip and gets exactly one slow push.
  const zoom = buildZoomPlan(map.outputDuration, {
    clipStarts: map.spans.map((s) => s.outIn),
  });
  console.log(
    `▸ zoom: ${zoom.clips} clip(s), ${zoom.rampSec}s push then hold ` +
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
        const v = layoutSlots(c.layout).video;
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

  let renderVideo = analysisInput;
  // A letterboxed source MUST go through the re-encode even under
  // --no-mezzanine: the bars are pixels in the file, and cropping them here is
  // what lets every layout and zoom downstream treat the picture as the frame.
  // The cropped file gets its own name so a pre-crop cache is never reused.
  // A NORMALIZED source skips this outright: the bake already carries the
  // mezzanine's encode settings, and re-encoding it would be a second
  // generation of loss for nothing.
  if (analysisInput === input && (opts.mezzanine || !contentRect.full)) {
    const mezz = join(work, contentRect.full ? "mezzanine.mp4" : "mezzanine-content.mp4");
    if (!existsSync(mezz)) {
      console.log(
        contentRect.full
          ? "▸ building mezzanine (dense keyframes)…"
          : "▸ building mezzanine (dense keyframes, letterbox bars trimmed)…",
      );
      await makeMezzanine(tools, input, mezz, { cropVf: cropVf || undefined });
    }
    renderVideo = mezz;
  }

  // Comment-CTA keyword (FINDINGS §16), scoped to the ask (FINDINGS §22).
  // Read off the timed CUE, not the untimed scene: the cue carries the same
  // resolved props AND the window, so the keyword can never come from a scene
  // that assembleScenes dropped, and the caption track knows exactly when the
  // ask is on screen. Quoting marks the word you type in the comments — every
  // other time the speaker merely says it, it must render plainly.
  const ctaCue = [...graphicCues]
    .reverse()
    .find((c) => typeof c.props?.keyword === "string" && (c.props.keyword as string).length > 0);
  const ctaKeyword = ctaCue ? (ctaCue.props!.keyword as string) : undefined;
  const ctaWindow = ctaCue
    ? { startSec: ctaCue.startSec, endSec: ctaCue.endSec }
    : undefined;
  if (ctaKeyword) {
    console.log(
      `▸ CTA keyword "${ctaKeyword}" styled only at ` +
        `${ctaWindow!.startSec.toFixed(1)}–${ctaWindow!.endSec.toFixed(1)}s`,
    );
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
    baseTheme: defaultTheme,
    baseCaptionLines,
    settings: production.render,
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
          // rendered video IS the content rect (PLAN Task 7).
          sourceAspect: content.height > 0 ? content.width / content.height : undefined,
        }
      : null,
    zoomPlan: zoom.segments,
    ctaKeyword,
    ctaWindow,
    sourceTextRegions: textRegions,
    // Sent ONLY on the fit fallback (option (b)): a normalized mixed source is
    // already one uniform file, and a uniform source had its bars cropped into
    // the mezzanine — cropping either again at render time would eat the
    // picture twice.
    ...(fitFallback
      ? {
          contentTimeline,
          sourceSize: { width: sourceProbe.width, height: sourceProbe.height },
          contentCropMode: "fit" as const,
        }
      : {}),
    // `--source-fit contain`: show the whole frame instead of cropping it.
    // The size sent is the PICTURE's, not the container's — with bars trimmed
    // into the mezzanine the rendered video IS the content rect, and fitting
    // against the container's shape would inset a frame that no longer exists.
    // Listed after the fit fallback so it wins on a source that is both mixed
    // and asked to be shown whole.
    ...(opts.sourceFit === "contain"
      ? { sourceFit: "contain" as const, sourceSize: content }
      : {}),
  };
  await writeFile(join(work, "render-props.json"), JSON.stringify(props, null, 2));

  if (!opts.render) {
    console.log(`▸ skipping render (--no-render). Props at ${join(work, "render-props.json")}`);
    return;
  }

  const outPath = resolve(opts.out ?? input.replace(/(\.[^.]+)?$/, ".ossclip.mp4"));
  const rawPath = join(work, "render-raw.mp4");
  console.log("▸ rendering…");
  let lastPct = -10;
  await renderProduction(props, {
    publicDir: dirname(renderVideo),
    outPath: rawPath,
    browserExecutable: cfg.browserExecutable,
    onProgress: (p) => {
      const pct = Math.floor(p * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}%\n`);
      }
    },
  });
  console.log("▸ normalizing loudness…");
  const normPath = join(work, "render-norm.mp4");
  await loudnorm(tools, rawPath, normPath);
  await rename(normPath, outPath);

  // ---- Cover image (FINDINGS §31) -----------------------------------------
  // A separate file, not a burned-in intro: both platforms accept a custom
  // cover, so nothing has to be pickable from the video — and spending the
  // opening seconds on a title card fights the hook-in-2s policy directly.
  if (opts.cover !== false) {
    // §35's cap applies here too: a cached beat sheet from before the fix, or
    // the hook fallback, must not slip a 13-word paragraph onto a thumbnail.
    const coverText = coverHeadline(beatSheet?.coverText ?? beatSheet?.hook ?? "");
    if (!coverText) {
      console.log("▸ no cover text (run --produce for one) — skipping cover");
    } else {
      const detector = await createFaceDetector();
      const pick = await pickCoverFrame(tools, analysisInput, analysisProbe.duration, {
        cacheDir: work,
        cropVf: analysisCropVf,
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
        const frameName = "cover-frame.png";
        await run(cfg.ffmpegPath, [
          "-v", "error",
          "-ss", pick.timeSec.toFixed(3),
          "-i", analysisInput,
          "-frames:v", "1",
          "-vf", `${analysisCropVf ? `${analysisCropVf},` : ""}scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase,crop=${frame.width}:${frame.height}`,
          "-y", join(work, frameName),
        ]);
        const coverPath = resolve(
          opts.coverPath ?? outPath.replace(/(\.[^.]+)?$/, ".cover.jpg"),
        );
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
        if (sourceTitled) {
          console.log("  ▸ source already has a title in this frame — shipping it without a banner");
        } else if (pick.face) {
          const band = coverTextRect(pick.face, frame);
          console.log(
            `  ▸ banner in the ${band.y + band.h / 2 < pick.face.centerYFrac ? "band above" : "band below"} ` +
              `the face (${(band.y * 100).toFixed(0)}-${((band.y + band.h) * 100).toFixed(0)}%)`,
          );
        }
        await renderCover(
          {
            frameFileName: frameName,
            text: sourceTitled ? "" : coverText,
            theme,
            face: pick.face,
            // The cover is the OUTPUT's thumbnail — a landscape render gets a
            // landscape cover (R16 §76). The still was already extracted at
            // this size; only the composition disagreed.
            frame: { width: frame.width, height: frame.height },
          },
          { publicDir: work, outPath: coverPath, browserExecutable: cfg.browserExecutable },
        );
        console.log(`✓ cover → ${coverPath}`);
      }
    }
  }
  // Record THIS invocation so the editor's Render button can replay it (R11
  // Task 4). Nothing else can reconstruct it — production.json has the
  // source path, cleanup and intent, but not --produce, --out or the LLM
  // flags — and guessing would silently render a different video than the
  // one on screen. execArgv carries the module loader (tsx in dev), so the
  // replay works from source and from a compiled build alike.
  // The provider may have been AUTO-DETECTED from this shell's environment
  // (a GEMINI_/ANTHROPIC_ key exported here). The editor's Render replays
  // this argv from the EDIT SERVER's environment, which may not have that
  // key — and the auto-detection would then silently pick a DIFFERENT
  // provider (R16 §75). Pin the RESOLVED choice into the recorded args —
  // never the key itself; secrets stay out of the workdir — so a replay
  // uses the same configuration or fails loudly asking for it.
  const recordedArgs = process.argv.slice(2);
  if (provider && !recordedArgs.includes("--llm")) {
    recordedArgs.push("--llm", providerName);
  }
  // §93g: pin the RESOLVED window, exactly as §75 pinned the provider. The
  // editor's Render replays this argv; if replay re-asked the model and got a
  // slightly different window, every saved override — anchored to scene ids
  // and word indices — would land on the wrong words. The word range, not
  // just `--clip 60`, is what makes replay deterministic with zero LLM calls.
  if (clipWindow && !recordedArgs.includes("--clip-window")) {
    recordedArgs.push("--clip-window", `${clipWindow.startWord}:${clipWindow.endWord}`);
  }
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
  console.log(`✓ done → ${outPath}`);
}
