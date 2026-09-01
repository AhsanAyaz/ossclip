import { isAbsolute, join } from "node:path";
import type { OssclipConfig } from "@ossclip/core";
import {
  type BinaryAsset,
  MODELS,
  ffmpegAsset,
  modelUrl,
  validModelSources,
  whisperAsset,
  whisperModelPath,
} from "./manifest";
import { resolveWhisperBackend } from "../whisper-backend";

/**
 * The planning half of `ossclip setup` — pure over injected probes, like
 * doctor (R18 §90a), so every branch is unit-testable without a network or
 * a second OS. The IO half (download/extract/brew/prompt) lives in setup.ts.
 *
 * Ground rules:
 *  - Anything that already works is `satisfied` and never touched. A user's
 *    own ffmpeg on PATH, a hand-set OSSCLIP_WHISPER, a model already on
 *    disk — setup's job is to fill gaps, not to take over working installs.
 *  - `--force` re-provisions only what setup itself manages (paths under
 *    `<configDir>/bin`, or bare names that were never resolved) — it must
 *    never clobber a path the user pointed elsewhere on purpose.
 *  - No platform gets silence: where no strategy applies, the step is
 *    `manual` with the exact commands to run.
 */

export type StepKind = "ffmpeg" | "whisper" | "model" | "provider";
export type StepStatus = "satisfied" | "download" | "brew" | "manual" | "prompt";

export interface SetupStep {
  kind: StepKind;
  status: StepStatus;
  /** What was found, or what will happen — one line for the plan table. */
  detail: string;
  /** Set when status === "download". */
  asset?: BinaryAsset;
  /** Download size when known (binary asset or known model). */
  sizeMB?: number;
  /** brew formula when status === "brew"; the manual fix when "manual". */
  hint?: string;
}

export interface SetupProbes {
  binRuns(bin: string, arg: string): Promise<boolean>;
  exists(path: string): boolean;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
}

export interface SetupOptions {
  /** Resolved `~/.ossclip` (injected so tests don't touch the real home). */
  configDir: string;
  model: string;
  force: boolean;
  skipLlm: boolean;
}

export const managedBinDir = (configDir: string): string => join(configDir, "bin");

/** A path setup owns and may re-provision under --force. */
const isManaged = (path: string, configDir: string): boolean =>
  !isAbsolute(path) || path.startsWith(managedBinDir(configDir));

export async function planSetup(
  cfg: OssclipConfig,
  p: SetupProbes,
  opts: SetupOptions,
): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  const brewAvailable =
    p.platform === "darwin" ? await p.binRuns("brew", "--version") : false;

  // ffmpeg + ffprobe travel together: one archive provides both, and a
  // machine with one but not the other is a broken install either way.
  const ffmpegOk =
    (await p.binRuns(cfg.ffmpegPath, "-version")) &&
    (await p.binRuns(cfg.ffprobePath, "-version"));
  const ffmpegForceable = isManaged(cfg.ffmpegPath, opts.configDir);
  if (ffmpegOk && !(opts.force && ffmpegForceable)) {
    steps.push({ kind: "ffmpeg", status: "satisfied", detail: cfg.ffmpegPath });
  } else {
    const asset = ffmpegAsset(p.platform, p.arch);
    if (asset) {
      steps.push({
        kind: "ffmpeg",
        status: "download",
        detail: `static ffmpeg + ffprobe ${asset.version} (${asset.license} build)`,
        asset,
        sizeMB: asset.sizeMB,
      });
    } else if (brewAvailable) {
      steps.push({
        kind: "ffmpeg",
        status: "brew",
        detail: "ffmpeg + ffprobe via Homebrew",
        hint: "ffmpeg",
      });
    } else {
      steps.push({
        kind: "ffmpeg",
        status: "manual",
        detail: "no automated path for this platform",
        hint:
          p.platform === "darwin"
            ? "install Homebrew (https://brew.sh) then `brew install ffmpeg`, or set OSSCLIP_FFMPEG"
            : "install ffmpeg from https://ffmpeg.org and set OSSCLIP_FFMPEG",
      });
    }
  }

  // Remote transcription (2026-09-01 weak-CPU field report) makes whisper.cpp
  // and the model OPTIONAL: on the machine the report came from, downloading
  // a 1.5 GB model to run an engine that is too slow to use is exactly the
  // cliff remote exists to remove. Reported as `satisfied` with the reason,
  // never as a silent skip — and a local install that ALREADY works still
  // reports itself (ground rule one: setup never uninstalls, and a user who
  // has both keeps the `--whisper-backend local` escape hatch working).
  const remote = resolveWhisperBackend(undefined, cfg, p.env);
  const remoteDetail =
    remote.ok && remote.backend.kind === "remote"
      ? `remote transcription configured (${remote.backend.baseUrl}) — local whisper not needed`
      : null;

  const whisperOk = await p.binRuns(cfg.whisperPath, "--help");
  const whisperForceable = isManaged(cfg.whisperPath, opts.configDir);
  if (whisperOk && !(opts.force && whisperForceable)) {
    steps.push({ kind: "whisper", status: "satisfied", detail: cfg.whisperPath });
  } else if (remoteDetail !== null) {
    steps.push({ kind: "whisper", status: "satisfied", detail: remoteDetail });
  } else {
    const asset = whisperAsset(p.platform, p.arch);
    if (asset) {
      steps.push({
        kind: "whisper",
        status: "download",
        detail: `prebuilt whisper.cpp ${asset.version} (whisper-cli)`,
        asset,
        sizeMB: asset.sizeMB,
      });
    } else if (brewAvailable) {
      steps.push({
        kind: "whisper",
        status: "brew",
        detail: "whisper.cpp via Homebrew",
        hint: "whisper-cpp",
      });
    } else {
      steps.push({
        kind: "whisper",
        status: "manual",
        detail: "no automated path for this platform",
        hint:
          p.platform === "darwin"
            ? "install Homebrew (https://brew.sh) then `brew install whisper-cpp`, or set OSSCLIP_WHISPER"
            : "see https://github.com/ggml-org/whisper.cpp — build from source, then set OSSCLIP_WHISPER",
      });
    }
  }

  // The model: same resolution produce and doctor use (whisperModelPath).
  // `--force` never re-downloads a present model; a corrupt one is deleted
  // by hand.
  const model = opts.model;
  const modelPath = whisperModelPath(model, cfg.modelDir);
  const known = MODELS[model];
  if (p.exists(modelPath)) {
    steps.push({ kind: "model", status: "satisfied", detail: modelPath });
  } else if (remoteDetail !== null) {
    steps.push({ kind: "model", status: "satisfied", detail: remoteDetail });
  } else if (isAbsolute(model)) {
    steps.push({
      kind: "model",
      status: "manual",
      detail: `configured model is an absolute path that doesn't exist: ${model}`,
      hint: "put the file there, or set model to a name like small.en for setup to download",
    });
  } else {
    steps.push({
      kind: "model",
      status: "download",
      // The config's modelSources beats the curated/default hosts here for
      // the same reason it does at download time — the plan must name the
      // URL setup will actually fetch.
      detail: `${modelUrl(model, validModelSources(cfg.modelSources))} → ${modelPath}`,
      sizeMB: known?.sizeMB,
    });
  }

  // Provider, in doctor's detection order (agy → claude CLI → gemini key →
  // anthropic key; subscription CLIs beat ambient keys — FINDINGS §132,
  // antigravity provider). Setup can save a key, but only ever
  // interactively — never invented, never required (--skip-llm).
  const provider = (await p.binRuns(p.env.OSSCLIP_AGY_BIN ?? "agy", "--version"))
    ? "antigravity (agy CLI on PATH)"
    : (await p.binRuns(p.env.OSSCLIP_CLAUDE_BIN ?? "claude", "--version"))
      ? "claude-cli (logged-in Claude Code)"
      : p.env.GEMINI_API_KEY
        ? "gemini (GEMINI_API_KEY is set)"
        : p.env.ANTHROPIC_API_KEY
          ? "claude (ANTHROPIC_API_KEY is set)"
          : null;
  if (opts.skipLlm) {
    steps.push({
      kind: "provider",
      status: "satisfied",
      detail: provider ?? "skipped (--skip-llm) — needed for --produce only",
    });
  } else if (provider) {
    steps.push({ kind: "provider", status: "satisfied", detail: provider });
  } else {
    steps.push({
      kind: "provider",
      status: "prompt",
      detail: "no LLM provider found — setup will ask (Enter skips; only --produce needs one)",
    });
  }

  return steps;
}

export function formatPlan(steps: SetupStep[]): string {
  const lines = steps.map((s) => {
    const mark = s.status === "satisfied" ? "✓" : "▸";
    const size = s.sizeMB ? ` (~${s.sizeMB} MB)` : "";
    const action =
      s.status === "satisfied"
        ? s.detail
        : s.status === "download"
          ? `download${size}: ${s.detail}`
          : s.status === "brew"
            ? `brew install ${s.hint}`
            : s.status === "prompt"
              ? s.detail
              : `manual: ${s.hint}`;
    return `${mark} ${s.kind.padEnd(10)} ${action}`;
  });
  const totalMB = steps.reduce((n, s) => n + (s.status === "download" ? (s.sizeMB ?? 0) : 0), 0);
  if (totalMB > 0) lines.push(`\n  total download ~${totalMB} MB → everything lands under ~/.ossclip`);
  return lines.join("\n");
}
