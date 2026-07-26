#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { CleanupLevelSchema } from "@ossclip/core";
import { STUDIO_ENTRY } from "@ossclip/renderer";
import { produce } from "./produce";

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
  .option("--mezzanine", "re-encode a dense-keyframe mezzanine before rendering", false)
  .option("--workdir <dir>", "cache/work directory (default: <input dir>/.ossclip)")
  .action(async (input: string, opts) => {
    const cleanup = CleanupLevelSchema.parse(opts.cleanup);
    await produce(input, {
      out: opts.out,
      cleanup,
      transcript: opts.transcript,
      render: opts.render,
      mezzanine: opts.mezzanine,
      workdir: opts.workdir,
    });
  });

program
  .command("transcribe")
  .description("run the pipeline up to the transcript and cut report, no render")
  .argument("<input>", "input video file")
  .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
  .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
  .option("--workdir <dir>", "cache/work directory")
  .action(async (input: string, opts) => {
    const cleanup = CleanupLevelSchema.parse(opts.cleanup);
    await produce(input, {
      cleanup,
      transcript: opts.transcript,
      render: false,
      mezzanine: false,
      workdir: opts.workdir,
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

program.parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
