#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod/v4";
import { CleanupLevelSchema, SceneComponentIdSchema } from "@ossclip/core";
import { STUDIO_ENTRY } from "@ossclip/renderer";
import { backfill, formatBackfill } from "./backfill";
import { loadEnvFiles } from "./env";
import { produce } from "./produce";

// Before anything reads a provider key (R16 §77) — including the auto-detect
// order in `defaultProviderName`, which decides which model runs.
const envFiles = loadEnvFiles();

const program = new Command();

program
  .name("ossclip")
  .description("open, local-first AI video producer — Phase 0: the cut")
  .version("0.0.1");

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
  .argument("<workdir>", "a work directory containing render-props.json")
  .option("--port <n>", "port to listen on", (v) => Number.parseInt(v, 10), 5174)
  .option("--no-open", "do not open a browser")
  .action(async (workdir: string, opts) => {
    const { startEditServer } = await import("./edit");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const pageDir = join(dirname(fileURLToPath(import.meta.url)), "../../editor/dist");
    // `apps/editor` is a Vite app — nothing builds it as part of installing
    // or running the CLI, so a user who never ran `vite build` gets a
    // server that starts fine but 404s on every request for the page
    // itself. Fail loudly with the fix instead of leaving them staring at
    // `{"error":"not found"}` in the browser.
    if (!existsSync(pageDir)) {
      throw new Error(
        `editor UI isn't built yet (looked in ${pageDir}) — run \`pnpm build\` ` +
          `(or \`pnpm --filter @ossclip/editor build\`) once, then re-run \`ossclip edit\`.`,
      );
    }
    const server = await startEditServer(workdir, { port: opts.port, pageDir });
    console.log(`▸ editor at ${server.url}`);
    if (opts.open) spawn("open", [server.url], { stdio: "ignore" });
  });

program
  .command("backfill")
  .description("recover the provider of workdirs produced before the usage log became append-only")
  .argument("<paths...>", "a work directory, or a root containing them (e.g. ~/Videos/.ossclip)")
  .option("--dry-run", "report what would change and write nothing", false)
  .option("--no-backup", "skip the .pre-backfill copies")
  .action(async (paths: string[], opts) => {
    // Only workdirs whose usage.json was emptied by a cached re-run are
    // touched, the provider comes from their own recorded argv, and anything
    // with a real run history is left alone — a recorded fact always beats a
    // reconstructed one.
    const results = await backfill(paths, { dryRun: opts.dryRun, backup: opts.backup });
    console.log(formatBackfill(results));
    if (opts.dryRun) console.log("(dry run — nothing was written)");
  });

program.parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
