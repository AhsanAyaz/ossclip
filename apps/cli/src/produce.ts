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
  applyOverrides,
  applyRepairs,
  assembleScenes,
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
  emptyOverrideDoc,
  extractAudio,
  formatCutReport,
  formatUsageLine,
  formatUsageReport,
  loadConfig,
  loudnorm,
  makeMezzanine,
  measureFace,
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
  summarizeUsage,
  OverrideDocSchema,
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
import { coverTextRect, regionsDuring, routeAroundSourceText } from "@ossclip/scenes/geometry";

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

  // Letterbox detection (PLAN Task 7): a file's frame is not always its
  // picture — bars baked into the pixels wasted most of the video slot on one
  // real clip. Measured once, before anything geometric; every downstream
  // pass crops to the content rect so the bars stop existing.
  const detection = await detectContentRect(tools, input, sourceProbe, { cacheDir: work });
  const contentTimeline = detection.timeline;
  /**
   * PLAN Task C: only a source with UNIFORM framing can be baked. A mixed
   * source alternates framings, so there is no single crop to apply — and its
   * letterboxed stretches hold a LANDSCAPE picture, which cannot become a
   * portrait frame by cropping alone. Those are cropped at render time, where
   * the stage already cover-crops a landscape source with the face bias.
   */
  const contentRect: ContentRect = detection.uniform ?? {
    x: 0, y: 0, w: sourceProbe.width, h: sourceProbe.height, full: true,
  };
  const cropVf = cropFilter(detection.uniform);
  if (detection.uniform && !detection.uniform.full) {
    console.log(
      `▸ source is letterboxed: content ${contentRect.w}×${contentRect.h} at ` +
        `x ${contentRect.x}, y ${contentRect.y} (bars trimmed everywhere downstream)`,
    );
  } else if (!detection.uniform) {
    const boxed = letterboxedSeconds(contentTimeline);
    console.log(
      `▸ source framing CHANGES mid-take: ${contentTimeline.length} segments, ` +
        `${boxed.toFixed(1)}s of ${sourceProbe.duration.toFixed(1)}s letterboxed ` +
        `(cropped per segment at render time, not baked)`,
    );
    for (const seg of contentTimeline) {
      console.log(
        `  · ${seg.startSec.toFixed(1)}–${seg.endSec.toFixed(1)}s ` +
          (seg.rect.full
            ? "full frame"
            : `content ${seg.rect.w}×${seg.rect.h} at x ${seg.rect.x}, y ${seg.rect.y}`),
      );
    }
  }
  /** The picture's dimensions — what every geometric consumer reasons about. */
  const content = { width: contentRect.w, height: contentRect.h };

  // Face measurement (FINDINGS §13): one static crop offset per source,
  // measured rather than guessed; cached in the workdir like the transcript.
  const faceSamples = 9;
  const faceBox = await measureFace(tools, input, sourceProbe.duration, {
    cacheDir: work,
    cropVf,
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
    provider = createTieredProvider(providerName, {
      model: opts.llmModel,
      fastModel: opts.llmFastModel ?? cfg.fastModel,
    });
  }

  const rawTranscript = transcript;
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
        speaker: opts.speaker ?? cfg.speaker,
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
      // Cache props only — overrides are user-owned and live in overrides.json,
      // never in production.json (that file is derived and every `produce`
      // run overwrites it, per the merge rule in `overrides.ts`).
      await writeFile(sceneCache, JSON.stringify(scenes, null, 2));
      await writeFile(beatCache, JSON.stringify(beatSheet, null, 2));
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
    await writeFile(
      join(work, "usage.json"),
      JSON.stringify(
        { records: provider.usage, totals: summarizeUsage(provider.usage, cfg.pricing) },
        null,
        2,
      ),
    );
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
    cropVf,
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
  const { cues: editedCues, orphans } = applyOverrides(routed.cues, overrideDoc);
  const editedCount = Object.keys(overrideDoc.scenes).length;
  if (editedCount > 0) {
    console.log(`▸ applied your edits to ${editedCount - orphans.length} scene(s)`);
  }
  for (const id of orphans) {
    console.log(`  ⚠ edit for ${id} dropped — the plan no longer has that scene`);
  }
  const theme = resolveTheme(defaultTheme, overrideDoc);

  // A pin freezes a scene's ABSOLUTE time against whatever its neighbours'
  // timing was when it was set. This same plan may since have re-anchored
  // those neighbours (a `--cleanup` level change, new source material), so
  // the pin can now overlap one of them or leave the array out of time
  // order — re-clamp it here, the same way the editor clamps a pinned nudge
  // at drag time, rather than letting an overlap reach `SceneLayer`/
  // `buildCaptionLines`.
  const { cues: reclamped, adjusted } = reclampPinnedTiming(editedCues);
  for (const id of adjusted) {
    console.log(`  ⚠ pinned timing for ${id} overlapped a re-planned neighbour — clamped back in bounds`);
  }

  const sceneCues = reclamped;
  if (sceneCues.length > 0) {
    console.log(
      `▸ ${sceneCues.length} scene(s) on stage: ` +
        sceneCues.map((c) => `${c.component}@${c.startSec.toFixed(1)}s`).join(", "),
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
  for (const holder of [...scenes, ...sceneCues]) {
    const kw = holder.props.keyword;
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
  if (provider) report += formatUsageReport(provider.usage, cfg.pricing);
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

  let renderVideo = input;
  // A letterboxed source MUST go through the re-encode even under
  // --no-mezzanine: the bars are pixels in the file, and cropping them here is
  // what lets every layout and zoom downstream treat the picture as the frame.
  // The cropped file gets its own name so a pre-crop cache is never reused.
  if (opts.mezzanine || !contentRect.full) {
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
    // The PRISTINE, pre-override cues/theme — everything above this line
    // already has the CURRENT `overrides.json` baked in (so `sceneCues`/
    // `theme` are exactly what got rendered). The editor needs an unmerged
    // base to re-apply overrides onto instead: merging the live doc onto an
    // already-merged base is add-only, so a reset/un-pin/undo in a second
    // editing session would have nothing to fall back to and render as if
    // it never happened, even though `overrides.json` on disk is correct.
    baseSceneCues: routed.cues,
    baseTheme: defaultTheme,
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
    // PLAN Task C. Sent ONLY for a mixed-framing source: a uniform one already
    // had its bars cropped into the mezzanine, and cropping to the same rect
    // again at render time would eat the picture twice.
    ...(detection.uniform
      ? {}
      : {
          contentTimeline,
          sourceSize: { width: sourceProbe.width, height: sourceProbe.height },
        }),
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
      const pick = await pickCoverFrame(tools, input, sourceProbe.duration, {
        cacheDir: work,
        cropVf,
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
          "-i", input,
          "-frames:v", "1",
          "-vf", `${cropVf ? `${cropVf},` : ""}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`,
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
          const band = coverTextRect(pick.face);
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
          },
          { publicDir: work, outPath: coverPath, browserExecutable: cfg.browserExecutable },
        );
        console.log(`✓ cover → ${coverPath}`);
      }
    }
  }
  console.log(`✓ done → ${outPath}`);
}
