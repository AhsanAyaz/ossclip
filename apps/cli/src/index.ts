#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod/v4";
import { CleanupLevelSchema, SceneComponentIdSchema } from "@ossclip/core";
import { STUDIO_ENTRY } from "@ossclip/renderer";
import { loadEnvFiles } from "./env";
import { produce } from "./produce";

// Before anything reads a provider key (R16 §77) — including the auto-detect
// order in `defaultProviderName`, which decides which model runs.
const envFiles = loadEnvFiles();

const program = new Command();

program
  .name("ossclip")
  .description(
    "local-first video producer: cuts silence and fillers, word-timed captions, " +
      "face-aware framing, LLM-planned code-rendered graphics",
  )
  .version("0.1.0");

program
  .command("produce")
  .description("transcribe → analyze → cut → captions → render")
  .argument("<input>", "input video file")
  .option("-o, --out <path>", "output video path (default: <input>.ossclip.mp4)")
  .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
  .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
  .option("--no-render", "stop after writing production.json / render props")
  .option(
    "--no-mezzanine",
    "render straight from the source instead of a dense-keyframe mezzanine " +
      "(also makes the source's folder the render server's public dir)",
  )
  .option("--noise-db <db>", "override the measured silence threshold, e.g. -30", parseFloat)
  .option("--workdir <dir>", "cache/work directory (default: <input dir>/.ossclip)")
  .option(
    "--aspect <ratio>",
    "output shape: 9:16 (vertical, default) or 16:9 (landscape, 1920x1080)",
    "9:16",
  )
  .option("--produce", "run the LLM producer brain to plan title cards & graphics", false)
  .option(
    "--clip <seconds>",
    "produce only the strongest ~N-second window of a long take (requires --produce; " +
      "a source already at or under the target is produced whole)",
    (v: string) => {
      // §93a: reject rather than coerce — `--clip 0`, negatives and typos must
      // not silently become "no clip" or NaN-length windows.
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError(`--clip wants a positive number of seconds, got "${v}"`);
      }
      return n;
    },
  )
  .option(
    "--clip-window <start:end>",
    "internal: the resolved highlight's word range, recorded into command.json by --clip " +
      "runs so the editor's Render replays the same window without an LLM call",
  )
  .option("--intent <text>", "what the video should be ('educational video about agents…')")
  .option(
    "--llm <provider>",
    "claude | claude-cli | gemini | mock. Default: claude if ANTHROPIC_API_KEY is set, " +
      "else claude-cli (your logged-in Claude Code — Pro/Max subscription, no API charges)",
  )
  .option("--llm-model <id>", "override the provider's default model")
  .option(
    "--llm-fast-model <id>",
    "model for mechanical calls (repair, scene props); 'same' disables tiering",
  )
  .option(
    "--speaker <who>",
    'who is on camera, e.g. "Ahsan, host of Code with Ahsan" — helps repair recognise mangled names',
  )
  .option("--scenes <path>", "hand-authored scenes JSON (Scene[]) — no LLM in the loop")
  .option(
    "--no-repair",
    "skip the ASR mishearing repair pass (captions then show the raw transcription)",
  )
  .option("--whisper-model <name>", "transcription model for this run, e.g. base.en | small.en | medium.en")
  .option(
    "--force-component <id>",
    "debug: render every graphic with this component (e.g. FlowDiagram) to exercise it on real copy",
  )
  .option(
    "--source-fit <mode>",
    "cover | contain. cover (default) crops the source to fill the vertical " +
      "frame; contain shows the WHOLE frame inset against the backdrop — the " +
      "answer for a landscape take whose content matters beyond the speaker",
    "cover",
  )
  .option(
    "--source-is-edited",
    "the source is already an edited reel with burned-in text — keep ossclip's graphics off it without waiting on detection",
  )
  .option("--no-cover", "skip the cover image written beside the video")
  .option("--cover <path>", "cover image output path (default: <out>.cover.jpg)")
  .action(async (input: string, opts) => {
    // Say which keys came from a file — never the keys themselves. A run that
    // picks a provider from a `.env` should say where that came from.
    if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
    const cleanup = CleanupLevelSchema.parse(opts.cleanup);
    const provider = opts.llm
      ? z.enum(["claude", "claude-cli", "gemini", "mock"]).parse(opts.llm)
      : undefined;
    const forceComponent = opts.forceComponent
      ? SceneComponentIdSchema.parse(opts.forceComponent)
      : undefined;
    // Parsed, not coerced: a typo'd `--source-fit containn` silently falling
    // back to cover is exactly the crop the flag exists to prevent.
    const sourceFit = z.enum(["cover", "contain"]).parse(opts.sourceFit);
    await produce(input, {
      out: opts.out,
      cleanup,
      transcript: opts.transcript,
      render: opts.render,
      mezzanine: opts.mezzanine,
      workdir: opts.workdir,
      aspect: opts.aspect === "16:9" ? "16:9" : "9:16",
      noiseDb: opts.noiseDb,
      produce: opts.produce,
      intent: opts.intent,
      provider,
      llmModel: opts.llmModel,
      llmFastModel: opts.llmFastModel,
      speaker: opts.speaker,
      scenes: opts.scenes,
      repair: opts.repair,
      whisperModel: opts.whisperModel,
      forceComponent,
      // commander gives `--no-cover` as cover:false and `--cover <path>` as a
      // string on the same key.
      sourceIsEdited: opts.sourceIsEdited === true,
      sourceFit,
      cover: opts.cover !== false,
      coverPath: typeof opts.cover === "string" ? opts.cover : undefined,
      clip: opts.clip,
      clipWindow: opts.clipWindow,
    });
  });

program
  .command("transcribe")
  .description("run the pipeline up to the transcript and cut report, no render")
  .argument("<input>", "input video file")
  .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
  .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
  .option("--noise-db <db>", "override the measured silence threshold, e.g. -30", parseFloat)
  .option("--workdir <dir>", "cache/work directory")
  .option("--whisper-model <name>", "transcription model for this run, e.g. base.en | small.en | medium.en")
  .action(async (input: string, opts) => {
    const cleanup = CleanupLevelSchema.parse(opts.cleanup);
    await produce(input, {
      cleanup,
      transcript: opts.transcript,
      render: false,
      mezzanine: false,
      workdir: opts.workdir,
      noiseDb: opts.noiseDb,
      whisperModel: opts.whisperModel,
    });
  });

program
  .command("studio")
  .description("open Remotion Studio on a produced composition (visual debugging)")
  .argument("<renderProps>", "path to a work dir's render-props.json")
  .option("--video-dir <dir>", "directory containing the source video (public dir)")
  .action(async (renderProps: string, opts) => {
    const propsPath = resolve(renderProps);
    const publicDir = opts.videoDir ? resolve(opts.videoDir) : dirname(propsPath);
    const child = spawn(
      "pnpm",
      ["exec", "remotion", "studio", STUDIO_ENTRY, `--props=${propsPath}`, `--public-dir=${publicDir}`],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("edit")
  .description("open the editing page on a produced workdir")
  // OPTIONAL since R17 §83: with no argument the editor opens on a project
  // picker — recent produce runs plus a folder browser — and the top bar's
  // Open button switches projects without restarting the server.
  .argument("[workdir]", "a work directory containing render-props.json")
  .option("--port <n>", "port to listen on", (v) => Number.parseInt(v, 10), 5174)
  .option("--no-open", "do not open a browser")
  .action(async (workdir: string | undefined, opts) => {
    const { startEditServer, resolveEditorPageDir } = await import("./edit");
    // An npm install ships the page prebuilt (editor-dist/); a clone builds
    // it once with `pnpm build`. A server that starts fine but 404s every
    // page request is the worst version of missing — fail loudly with the
    // fix instead.
    const pageDir = resolveEditorPageDir();
    if (pageDir === null) {
      throw new Error(
        "editor UI isn't built yet — run `pnpm build` " +
          "(or `pnpm --filter @ossclip/editor build`) once, then re-run `ossclip edit`.",
      );
    }
    const server = await startEditServer(workdir, { port: opts.port, pageDir });
    console.log(`▸ editor at ${server.url}`);
    if (opts.open) spawn("open", [server.url], { stdio: "ignore" });
  });

program
  .command("doctor")
  .description("check every prerequisite and print the exact fix for anything missing")
  .action(async () => {
    // Env files are loaded at module top (R16 §77) — BEFORE this runs — so a
    // provider key living in a `.env` is visible here, not a false negative.
    if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
    const { runDoctor, formatDoctor, realProbes } = await import("./doctor");
    const { resolveEditorPageDir } = await import("./edit");
    const { loadConfig } = await import("@ossclip/core");
    const checks = await runDoctor(loadConfig(), realProbes(resolveEditorPageDir()));
    console.log(formatDoctor(checks));
    if (checks.some((c) => !c.ok)) process.exit(1);
  });

program.parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
