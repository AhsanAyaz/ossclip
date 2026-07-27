import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  SceneSchema,
  TimeMap,
  TranscriptSchema,
  analyze,
  applyRepairs,
  assembleScenes,
  buildCaptionLines,
  buildCutlist,
  buildZoomPlan,
  checkGrounding,
  createFaceDetector,
  createProvider,
  defaultProviderName,
  defaultTheme,
  detectSilences,
  extractAudio,
  formatCutReport,
  loadConfig,
  loudnorm,
  makeMezzanine,
  measureFace,
  pickCoverFrame,
  measureLevels,
  probe,
  produceScenes,
  reconcileCopy,
  repairTranscript,
  run,
  runWhisper,
  scanSourceText,
  type AppliedRepair,
  type CleanupLevel,
  type LlmProvider,
  type Production,
  type ProviderName,
  type Scene,
  type SceneComponentId,
  type Transcript,
} from "@ossclip/core";
import { renderCover, renderProduction } from "@ossclip/renderer";
import { routeAroundSourceText } from "@ossclip/scenes/geometry";

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

  await preflight(cfg.ffmpegPath, "Install ffmpeg (brew install ffmpeg / apt install ffmpeg) or set OSSCLIP_FFMPEG.");
  await preflight(cfg.ffprobePath, "Install ffmpeg (provides ffprobe) or set OSSCLIP_FFPROBE.");

  const hash = (await sha1File(input)).slice(0, 8);
  const workRoot = opts.workdir ? resolve(opts.workdir) : join(dirname(input), ".ossclip");
  const work = join(workRoot, `${basename(input).replace(/\.[^.]+$/, "")}-${hash}`);
  await mkdir(work, { recursive: true });
  const tools = { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath };

  console.log(`▸ workdir ${work}`);
  const sourceProbe = await probe(tools, input);
  console.log(
    `▸ source ${sourceProbe.width}x${sourceProbe.height} @ ${sourceProbe.fps.toFixed(2)}fps · ${sourceProbe.duration.toFixed(2)}s`,
  );
  if (!sourceProbe.hasAudio) throw new Error("source has no audio stream — nothing to cut by");

  const audioPath = join(work, "audio.wav");
  if (!existsSync(audioPath)) {
    console.log("▸ extracting audio…");
    await extractAudio(tools, input, audioPath);
  }

  // Face measurement (FINDINGS §13): one static crop offset per source,
  // measured rather than guessed; cached in the workdir like the transcript.
  const faceBox = await measureFace(tools, input, sourceProbe.duration, { cacheDir: work });
  console.log(
    faceBox
      ? `▸ face at ${(faceBox.centerYFrac * 100).toFixed(0)}% down the frame, ` +
          `${(faceBox.sizeFrac * 100).toFixed(0)}% tall ` +
          `(${faceBox.framesDetected}/${faceBox.framesSampled} frames)`
      : "▸ no face detected — using the default crop bias",
  );

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
      "Install whisper.cpp (https://github.com/ggml-org/whisper.cpp) or set OSSCLIP_WHISPER.",
    );
    const model = opts.whisperModel ?? cfg.model;
    const modelPath = isAbsolute(model) ? model : join(cfg.modelDir, `ggml-${model}.bin`);
    if (!existsSync(modelPath)) {
      throw new Error(
        `whisper model not found at ${modelPath}.\n` +
          `Download one, e.g.:\n  curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
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
  const analysis = analyze(transcript, silences, sourceProbe.duration, levels);
  const cutlist = buildCutlist({
    transcript,
    analysis,
    duration: sourceProbe.duration,
    level: opts.cleanup,
  });
  const map = new TimeMap(cutlist);

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
    provider = createProvider(providerName, opts.llmModel);
  }

  const rawTranscript = transcript;
  let repairs: AppliedRepair[] = [];
  if (provider && opts.repair !== false) {
    const rawKey = createHash("sha1")
      .update(JSON.stringify([providerName, opts.llmModel, rawTranscript.words.map((w) => w.text)]))
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
        // A repair may not merge words across a cut.
        isCut: (startSec, endSec) =>
          cutlist.some(
            (s) => s.kind === "remove" && s.srcIn < endSec && s.srcOut > startSec,
          ),
      });
      transcript = result.transcript;
      repairs = result.applied;
      if (result.error) console.log(`  ⚠ transcript repair unavailable: ${result.error}`);
      await writeFile(repairCache, JSON.stringify(repairs, null, 2));
    }
    for (const r of repairs) {
      console.log(
        r.applied
          ? `  ▸ repaired "${r.heard}" → "${r.correction}"`
          : `  ⚠ repair refused: "${r.heard}" → "${r.correction}" (${r.rejected})`,
      );
    }
  }

  // ---- Scenes: hand-authored file, or the producer brain (PHASE1 §4) ----
  let scenes: Scene[] = [];
  /** Editorial output kept for the cover (§31): hook + its thumbnail form. */
  let beatSheet: { hook: string; coverText?: string } | undefined;
  if (opts.scenes) {
    scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(resolve(opts.scenes), "utf8")));
    console.log(`▸ scenes injected from ${opts.scenes} (${scenes.length})`);
  } else if (provider) {
    // Keyed on the repaired transcript's TEXT, not its word count: a repair
    // that swaps "coach and" for "code churn" leaves the count identical, and
    // a count-keyed cache would silently replan from the stale wording.
    const cacheKey = createHash("sha1")
      .update(
        JSON.stringify([
          providerName,
          opts.llmModel,
          opts.intent,
          opts.cleanup,
          opts.forceComponent ?? null,
          transcript.words.map((w) => w.text),
        ]),
      )
      .digest("hex")
      .slice(0, 8);
    const sceneCache = join(work, `scenes-${cacheKey}.json`);
    // The cover needs the editorial copy, which is not in the scene list — a
    // cached run must still be able to write one.
    const beatCache = join(work, `beatsheet-${cacheKey}.json`);
    if (existsSync(sceneCache)) {
      scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(sceneCache, "utf8")));
      console.log(`▸ scenes cached (${scenes.length})`);
      if (existsSync(beatCache)) {
        beatSheet = JSON.parse(await readFile(beatCache, "utf8")) as typeof beatSheet;
      }
    } else {
      console.log(`▸ producing scenes (${providerName})…`);
      if (opts.forceComponent) console.log(`▸ forcing every graphic to ${opts.forceComponent}`);
      const result = await produceScenes(provider, {
        transcript,
        outputDuration: map.outputDuration,
        intent: opts.intent,
        forceComponent: opts.forceComponent,
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
      // Cache props only — overrides are user-owned and live in production.json.
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(beatCache, JSON.stringify(beatSheet, null, 2));
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

  const theme = defaultTheme;
  const { cues: assembled, dropped } = assembleScenes(scenes, transcript, map);
  for (const d of dropped) console.log(`  ⚠ scene ${d.id} dropped: ${d.reason}`);

  // ---- Route around the source's own burned-in text (FINDINGS §26) --------
  // Fed a finished reel, ossclip would otherwise stack its layer on an
  // existing one — cropping through the source's title and then restating it
  // underneath. Graphics move to a clear slot or are skipped; captions never
  // are, they just relocate.
  const sourceText = await scanSourceText(tools, input, sourceProbe.duration, {
    cacheDir: work,
    assumeEdited: opts.sourceIsEdited,
  });
  if (sourceText.regions.length > 0) {
    console.log(
      sourceText.assumed
        ? "▸ --source-is-edited: assuming burned-in text in the title and caption bands"
        : `▸ source already has on-screen text in ${sourceText.regions.length} band(s) ` +
            `(${sourceText.framesSampled} frames sampled)`,
    );
  }
  const routed = routeAroundSourceText(assembled, sourceText.regions);
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
  const sceneCues = routed.cues;
  if (sceneCues.length > 0) {
    console.log(
      `▸ ${sceneCues.length} scene(s) on stage: ` +
        sceneCues.map((c) => `${c.component}@${c.startSec.toFixed(1)}s`).join(", "),
    );
  }

  // Grounding post-check (FINDINGS §14a): flags label tokens the take never
  // says — a hallucinated hook label is visible here without watching the video.
  const groundingIssues = checkGrounding(scenes, transcript);
  for (const g of groundingIssues) {
    console.log(`  ⚠ grounding: ${g.component} ${g.sceneId} ${g.field} "${g.token}" — not in the take`);
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
    scenes: scenes.length > 0 ? scenes : undefined,
    theme,
    render: { width: 1080, height: 1920, fps: 30 },
  };
  await writeFile(join(work, "production.json"), JSON.stringify(production, null, 2));

  let report = formatCutReport(production);
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
  await writeFile(join(work, "report.txt"), report);
  console.log("");
  console.log(report);
  console.log("");

  const captionLines = buildCaptionLines(transcript, map, {
    breakpoints: sceneCues.flatMap((c) => [c.startSec, c.endSec]),
  });

  // Micro zoom punches (FINDINGS §15) reversing at real phrase breaks (§18).
  // Breaths are source-time; TimeMap has no span mapper, so both ends go
  // through toOutputClamped — a pause that was cut collapses to one instant,
  // which is still a boundary (a jump cut is a phrase break too).
  const zoom = buildZoomPlan(captionLines, map.outputDuration, {
    pauses: analysis.breaths.map((b) => ({
      start: map.toOutputClamped(b.start),
      end: map.toOutputClamped(b.end),
    })),
  });
  console.log(
    zoom.source === "metronome"
      ? `▸ zoom: metronome fallback (no phrase boundaries found), ${zoom.segments.length} segments`
      : `▸ zoom: ${zoom.source} (${zoom.boundaries} phrase boundaries, ${zoom.segments.length} segments)`,
  );

  let renderVideo = input;
  if (opts.mezzanine) {
    const mezz = join(work, "mezzanine.mp4");
    if (!existsSync(mezz)) {
      console.log("▸ building mezzanine (dense keyframes)…");
      await makeMezzanine(tools, input, mezz);
    }
    renderVideo = mezz;
  }

  // Comment-CTA keyword (FINDINGS §16), scoped to the ask (FINDINGS §22).
  // Read off the timed CUE, not the untimed scene: the cue carries the same
  // resolved props AND the window, so the keyword can never come from a scene
  // that assembleScenes dropped, and the caption track knows exactly when the
  // ask is on screen. Quoting marks the word you type in the comments — every
  // other time the speaker merely says it, it must render plainly.
  const ctaCue = [...sceneCues]
    .reverse()
    .find((c) => typeof c.props.keyword === "string" && (c.props.keyword as string).length > 0);
  const ctaKeyword = ctaCue ? (ctaCue.props.keyword as string) : undefined;
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
    settings: production.render,
    outputDurationSec: map.outputDuration,
    face: faceBox ? { centerYFrac: faceBox.centerYFrac, sizeFrac: faceBox.sizeFrac } : null,
    zoomPlan: zoom.segments,
    ctaKeyword,
    ctaWindow,
    sourceTextRegions: sourceText.regions,
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
    const coverText = beatSheet?.coverText ?? beatSheet?.hook;
    if (!coverText) {
      console.log("▸ no cover text (run --produce for one) — skipping cover");
    } else {
      const detector = await createFaceDetector();
      const pick = await pickCoverFrame(tools, input, sourceProbe.duration, {
        cacheDir: work,
        hasFace: (pixels, w, h) => detector(pixels, w, h) !== null,
      });
      if (!pick) {
        console.log("▸ no usable cover frame found — skipping cover");
      } else {
        const frameName = "cover-frame.png";
        await run(cfg.ffmpegPath, [
          "-v", "error",
          "-ss", pick.timeSec.toFixed(3),
          "-i", input,
          "-frames:v", "1",
          "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
          "-y", join(work, frameName),
        ]);
        const coverPath = resolve(
          opts.coverPath ?? outPath.replace(/(\.[^.]+)?$/, ".cover.jpg"),
        );
        console.log(
          `▸ cover from ${pick.timeSec.toFixed(1)}s ` +
            `(${pick.hasFace ? "face" : "no face"}, sharpness ${pick.sharpness.toFixed(0)})…`,
        );
        await renderCover(
          { frameFileName: frameName, text: coverText, theme },
          { publicDir: work, outPath: coverPath, browserExecutable: cfg.browserExecutable },
        );
        console.log(`✓ cover → ${coverPath}`);
      }
    }
  }
  console.log(`✓ done → ${outPath}`);
}
