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
  assembleScenes,
  buildCaptionLines,
  buildCutlist,
  createProvider,
  defaultTheme,
  detectSilences,
  extractAudio,
  formatCutReport,
  loadConfig,
  loudnorm,
  makeMezzanine,
  measureLevels,
  probe,
  produceScenes,
  run,
  runWhisper,
  type CleanupLevel,
  type Production,
  type ProviderName,
  type Scene,
  type Transcript,
} from "@ossclip/core";
import { renderProduction } from "@ossclip/renderer";

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
    const modelPath = isAbsolute(cfg.model) ? cfg.model : join(cfg.modelDir, `ggml-${cfg.model}.bin`);
    if (!existsSync(modelPath)) {
      throw new Error(
        `whisper model not found at ${modelPath}.\n` +
          `Download one, e.g.:\n  curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${cfg.model}.bin`,
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

  // ---- Scenes: hand-authored file, or the producer brain (PHASE1 §4) ----
  let scenes: Scene[] = [];
  if (opts.scenes) {
    scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(resolve(opts.scenes), "utf8")));
    console.log(`▸ scenes injected from ${opts.scenes} (${scenes.length})`);
  } else if (opts.produce) {
    const providerName = opts.provider ?? "claude";
    const cacheKey = createHash("sha1")
      .update(
        JSON.stringify([providerName, opts.llmModel, opts.intent, opts.cleanup, transcript.words.length]),
      )
      .digest("hex")
      .slice(0, 8);
    const sceneCache = join(work, `scenes-${cacheKey}.json`);
    if (existsSync(sceneCache)) {
      scenes = z.array(SceneSchema).parse(JSON.parse(await readFile(sceneCache, "utf8")));
      console.log(`▸ scenes cached (${scenes.length})`);
    } else {
      console.log(`▸ producing scenes (${providerName})…`);
      const result = await produceScenes(createProvider(providerName, opts.llmModel), {
        transcript,
        outputDuration: map.outputDuration,
        intent: opts.intent,
      });
      scenes = result.scenes;
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
    }
  }

  const theme = defaultTheme;
  const { cues: sceneCues, dropped } = assembleScenes(scenes, transcript, map);
  for (const d of dropped) console.log(`  ⚠ scene ${d.id} dropped: ${d.reason}`);
  if (sceneCues.length > 0) {
    console.log(
      `▸ ${sceneCues.length} scene(s) on stage: ` +
        sceneCues.map((c) => `${c.component}@${c.startSec.toFixed(1)}s`).join(", "),
    );
  }

  const production: Production = {
    version: 1,
    source: { path: input, probe: sourceProbe, audioPath },
    cleanup: opts.cleanup,
    intent: opts.intent,
    transcript,
    analysis,
    cutlist,
    scenes: scenes.length > 0 ? scenes : undefined,
    theme,
    render: { width: 1080, height: 1920, fps: 30 },
  };
  await writeFile(join(work, "production.json"), JSON.stringify(production, null, 2));

  const report = formatCutReport(production);
  await writeFile(join(work, "report.txt"), report);
  console.log("");
  console.log(report);
  console.log("");

  const captionLines = buildCaptionLines(transcript, map);

  let renderVideo = input;
  if (opts.mezzanine) {
    const mezz = join(work, "mezzanine.mp4");
    if (!existsSync(mezz)) {
      console.log("▸ building mezzanine (dense keyframes)…");
      await makeMezzanine(tools, input, mezz);
    }
    renderVideo = mezz;
  }

  const props = {
    videoFileName: basename(renderVideo),
    spans: [...map.spans],
    captionLines,
    sceneCues,
    theme,
    settings: production.render,
    outputDurationSec: map.outputDuration,
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
  console.log(`✓ done → ${outPath}`);
}
