import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_DIR, loadConfig, saveConfigPatch, type OssclipConfig } from "@ossclip/core";
import { MODELS, WHISPER_BUILD_HINT, modelUrl, type BinaryAsset } from "./manifest";
import { formatPlan, managedBinDir, planSetup, type SetupProbes, type SetupStep } from "./plan";
import { download, progressLine } from "./download";
import { extractArchive, findFile, markExecutable } from "./extract";
import { promptForProvider } from "./provider";

/**
 * `ossclip setup` — the whole install, one command (§90: the install cliff
 * is the adoption ceiling; this is the ramp). Downloads pinned static
 * ffmpeg and prebuilt whisper.cpp where upstream publishes them, brews on
 * macOS, fetches the transcription model with resume + checksum, offers to
 * save an LLM key, and records absolute paths in ~/.ossclip/config.json so
 * nothing touches PATH — that last part is the entire Windows story.
 *
 * Setup fills gaps and never takes over a working install: whatever
 * already runs is left exactly where it is. It ends by running the real
 * doctor, because setup's definition of done is doctor's definition of
 * healthy.
 */

export interface SetupCliOptions {
  model?: string;
  skipLlm: boolean;
  force: boolean;
  yes: boolean;
}

const probeBin = (bin: string, arg: string): Promise<boolean> =>
  new Promise((resolve) => {
    // Existence is the question, not exit code (same contract as doctor).
    const child = spawn(bin, [arg], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(true));
  });

export async function setup(opts: SetupCliOptions): Promise<void> {
  const cfg = loadConfig();
  const model = opts.model ?? cfg.model;
  const probes: SetupProbes = {
    binRuns: probeBin,
    exists: existsSync,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  };
  const steps = await planSetup(cfg, probes, {
    configDir: CONFIG_DIR,
    model,
    force: opts.force,
    skipLlm: opts.skipLlm,
  });

  console.log("ossclip setup — plan:\n");
  console.log(formatPlan(steps));
  console.log("");

  const interactive = process.stdin.isTTY === true && !opts.yes;
  const needsWork = steps.some((s) => s.status !== "satisfied");
  const failures: string[] = [];
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    if (needsWork && rl) {
      const answer = (await rl.question("Proceed? [Y/n] ")).trim().toLowerCase();
      if (answer === "n" || answer === "no") {
        console.log("▸ nothing changed.");
        return;
      }
    }

    const patch: Partial<OssclipConfig> = {};
    for (const step of steps) {
      // One step failing (a dropped download, a brew hiccup) must not throw
      // away the others' work — record it, keep going, save what succeeded,
      // and let the closing doctor run print the remaining fixes.
      try {
        await runStep(step);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${step.kind}: ${msg}`);
        console.error(`✗ ${step.kind} failed: ${msg}`);
      }
    }

    async function runStep(step: SetupStep): Promise<void> {
      switch (step.kind) {
        case "ffmpeg":
          if (step.status === "download" && step.asset) {
            const [ffmpegBin, ffprobeBin] = step.asset.bins;
            if (!ffmpegBin || !ffprobeBin) throw new Error("manifest bug: ffmpeg asset needs two bins");
            const dir = await provision("ffmpeg", step.asset);
            patch.ffmpegPath = mustFind(dir, ffmpegBin);
            patch.ffprobePath = mustFind(dir, ffprobeBin);
            await verifyRuns(patch.ffmpegPath, "-version", "ffmpeg");
            await verifyRuns(patch.ffprobePath, "-version", "ffprobe");
            console.log(`▸ ffmpeg ready: ${patch.ffmpegPath}`);
          } else if (step.status === "brew") {
            await brewInstall(step.hint ?? "ffmpeg");
            await verifyRuns("ffmpeg", "-version", "ffmpeg");
          } else if (step.status === "manual") {
            console.log(`✗ ffmpeg needs a manual step: ${step.hint}`);
          }
          break;
        case "whisper":
          if (step.status === "download" && step.asset) {
            const [whisperBin] = step.asset.bins;
            if (!whisperBin) throw new Error("manifest bug: whisper asset needs a bin");
            const dir = await provision("whisper", step.asset);
            const bin = mustFind(dir, whisperBin);
            // The probe matters here more than anywhere: a prebuilt that
            // doesn't run on this libc must fail NOW with the build recipe,
            // not half-configured at first transcription.
            await verifyRuns(bin, "--help", "whisper-cli", WHISPER_BUILD_HINT);
            patch.whisperPath = bin;
            console.log(`▸ whisper-cli ready: ${bin}`);
          } else if (step.status === "brew") {
            await brewInstall(step.hint ?? "whisper-cpp");
            await verifyRuns("whisper-cli", "--help", "whisper-cli", WHISPER_BUILD_HINT);
          } else if (step.status === "manual") {
            console.log(`✗ whisper-cli needs a manual step: ${step.hint}`);
          }
          break;
        case "model":
          if (step.status === "download") {
            const modelPath = isAbsolute(model)
              ? model
              : join(cfg.modelDir, `ggml-${model}.bin`);
            const info = MODELS[model];
            if (!info) {
              console.log(
                `▸ ${model} isn't in the pinned table — downloading without a checksum.`,
              );
            }
            console.log(`▸ downloading ggml-${model}.bin${info ? ` (~${info.sizeMB} MB)` : ""}…`);
            await download(modelUrl(model), modelPath, {
              sha1: info?.sha1,
              onProgress: progressLine(`ggml-${model}.bin`),
            });
            console.log(`▸ model ready: ${modelPath}`);
            if (opts.model && opts.model !== cfg.model) patch.model = opts.model;
          } else if (step.status === "manual") {
            console.log(`✗ model needs a manual step: ${step.hint}`);
          }
          break;
        case "provider":
          if (step.status === "prompt" && rl) {
            await promptForProvider(
              { ask: (q) => rl.question(q), say: (l) => console.log(l) },
              CONFIG_DIR,
            );
          } else if (step.status === "prompt") {
            console.log(
              "▸ no LLM provider configured (non-interactive run) — needed for --produce only; " +
                "set ANTHROPIC_API_KEY or GEMINI_API_KEY when you want it.",
            );
          }
          break;
      }
    }

    if (Object.keys(patch).length > 0) {
      const path = saveConfigPatch(patch);
      console.log(`▸ recorded in ${path}`);
    }
  } finally {
    rl?.close();
  }

  // Setup's exit criterion is doctor's: all green, or the exact fix per line.
  console.log("");
  const { runDoctor, formatDoctor, realProbes } = await import("../doctor");
  const { resolveEditorPageDir } = await import("../edit");
  const checks = await runDoctor(loadConfig(), realProbes(resolveEditorPageDir()));
  console.log(formatDoctor(checks));
  if (failures.length > 0) process.exitCode = 1;
}

/** Download an asset (with resume) and extract it under the managed bin dir. */
async function provision(kind: string, asset: BinaryAsset): Promise<string> {
  const archive = join(CONFIG_DIR, "downloads", basename(new URL(asset.url).pathname));
  const destDir = join(managedBinDir(CONFIG_DIR), `${kind}-${asset.version}`);
  console.log(`▸ downloading ${basename(archive)} (~${asset.sizeMB} MB)…`);
  await download(asset.url, archive, {
    sha256: asset.sha256,
    onProgress: progressLine(basename(archive)),
  });
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  await extractArchive(archive, destDir);
  for (const bin of asset.bins) {
    const found = findFile(destDir, bin);
    if (found) markExecutable(found);
  }
  // The archive did its job; ~160 MB of zip has no second life.
  rmSync(archive, { force: true });
  return destDir;
}

function mustFind(dir: string, bin: string): string {
  const found = findFile(dir, bin);
  if (!found) {
    throw new Error(
      `extracted archive doesn't contain ${bin} — upstream layout changed; ` +
        "please open an issue with this output",
    );
  }
  return found;
}

async function verifyRuns(bin: string, arg: string, name: string, hint?: string): Promise<void> {
  if (await probeBin(bin, arg)) return;
  throw new Error(
    `${name} was installed but doesn't run on this machine (${bin}).` +
      (hint ? `\nFallback: ${hint}` : ""),
  );
}

function brewInstall(formula: string): Promise<void> {
  console.log(`▸ brew install ${formula}…`);
  return new Promise((resolve, reject) => {
    const child = spawn("brew", ["install", formula], { stdio: "inherit" });
    child.on("error", (e) => reject(new Error(`brew failed to start: ${e.message}`)));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`brew install ${formula} exited ${code}`)),
    );
  });
}
