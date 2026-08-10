import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { OssclipConfig } from "@ossclip/core";

/**
 * `ossclip doctor` (R18 §90a): check every prerequisite and print the exact
 * fix — because the install cliff is the adoption ceiling. Seven
 * preconditions stand between a first-time user and their first frame, and
 * every one that fails silently becomes a GitHub issue instead of a
 * one-line fix the tool could have printed itself.
 *
 * Since `ossclip setup` exists, doctor and setup are two halves of one
 * contract: setup is the fix doctor prints first, and doctor is the
 * verification setup ends with. The manual command stays on every fix line
 * for people who'd rather own their toolchain.
 *
 * Checks are pure over injected probes so the table is unit-testable; the
 * CLI wires the real spawn/existsSync in. The provider check MUST run after
 * `loadEnvFiles` (R16 §77) or a key living in `.env` reports a false
 * negative — `program.ts` loads env at module top, before any command runs.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** What was found (the path/provider that satisfied the check). */
  detail: string;
  /** The exact fix, present only when !ok. */
  fix?: string;
}

export interface DoctorProbes {
  /** Does spawning this binary work at all (any exit code counts)? */
  binRuns(bin: string, arg: string): Promise<boolean>;
  exists(path: string): boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeMajor: number;
  /** Resolved editor page dir, or null if no candidate exists. */
  editorPageDir: string | null;
}

/** brew on mac, apt on linux, winget/prebuilt on windows — generic covers the rest. */
const installHint = (
  platform: NodeJS.Platform,
  brew: string,
  apt: string,
  win: string,
  generic: string,
): string =>
  platform === "darwin" ? brew : platform === "linux" ? apt : platform === "win32" ? win : generic;

/** Every installable prerequisite leads with the one-command ramp. */
const viaSetup = (manual: string): string => "run `ossclip setup` — or manually: " + manual;

export async function runDoctor(cfg: OssclipConfig, p: DoctorProbes): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: p.nodeMajor >= 22,
    detail: `v${p.nodeMajor}`,
    ...(p.nodeMajor >= 22
      ? {}
      : { fix: "ossclip needs Node ≥ 22 — install from https://nodejs.org or via your version manager" }),
  });

  const ffmpegOk = await p.binRuns(cfg.ffmpegPath, "-version");
  checks.push({
    name: "ffmpeg",
    ok: ffmpegOk,
    detail: cfg.ffmpegPath,
    ...(ffmpegOk
      ? {}
      : {
          fix: viaSetup(
            installHint(
              p.platform,
              "brew install ffmpeg",
              "sudo apt install ffmpeg",
              "winget install ffmpeg",
              "install ffmpeg from https://ffmpeg.org",
            ) + " — or point OSSCLIP_FFMPEG (or config.json ffmpegPath) at the binary",
          ),
        }),
  });

  const ffprobeOk = await p.binRuns(cfg.ffprobePath, "-version");
  checks.push({
    name: "ffprobe",
    ok: ffprobeOk,
    detail: cfg.ffprobePath,
    ...(ffprobeOk
      ? {}
      : {
          fix: viaSetup(
            installHint(
              p.platform,
              "brew install ffmpeg (provides ffprobe)",
              "sudo apt install ffmpeg (provides ffprobe)",
              "winget install ffmpeg (provides ffprobe)",
              "ffprobe ships with ffmpeg — https://ffmpeg.org",
            ) + " — or set OSSCLIP_FFPROBE",
          ),
        }),
  });

  const whisperOk = await p.binRuns(cfg.whisperPath, "--help");
  checks.push({
    name: "whisper-cli",
    ok: whisperOk,
    detail: cfg.whisperPath,
    ...(whisperOk
      ? {}
      : {
          fix: viaSetup(
            installHint(
              p.platform,
              "brew install whisper-cpp",
              "download a prebuilt from https://github.com/ggml-org/whisper.cpp/releases",
              "download whisper-blas-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases",
              "build whisper.cpp from source: https://github.com/ggml-org/whisper.cpp",
            ) + " — or point OSSCLIP_WHISPER at your whisper-cli",
          ),
        }),
  });

  // Same resolution `produce` uses: an absolute model is a file path, a bare
  // name resolves inside modelDir as ggml-<name>.bin.
  const modelPath = isAbsolute(cfg.model) ? cfg.model : join(cfg.modelDir, `ggml-${cfg.model}.bin`);
  const modelOk = p.exists(modelPath);
  checks.push({
    name: `whisper model (${cfg.model})`,
    ok: modelOk,
    detail: modelPath,
    ...(modelOk
      ? {}
      : {
          fix: viaSetup(
            `mkdir -p ${cfg.modelDir} && curl -L -o ${modelPath} ` +
              `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${cfg.model}.bin`,
          ),
        }),
  });

  // Provider, in the same order auto-detection uses (agy → claude CLI →
  // gemini key → anthropic key): subscription CLIs beat ambient env keys
  // since 2026-08 — a logged-in CLI is an explicit, already-paid choice
  // (FINDINGS §132, antigravity provider). Bin overrides are honored so
  // doctor probes the same binary produce would spawn. Needed for --produce
  // only — the cut+captions path never touches an LLM — but doctor's
  // contract is "ready for the whole thing".
  const provider = (await p.binRuns(p.env.OSSCLIP_AGY_BIN ?? "agy", "--version"))
    ? "antigravity (agy CLI on PATH)"
    : (await p.binRuns(p.env.OSSCLIP_CLAUDE_BIN ?? "claude", "--version"))
      ? "claude-cli (logged-in Claude Code)"
      : p.env.GEMINI_API_KEY
        ? "gemini (GEMINI_API_KEY is set)"
        : p.env.ANTHROPIC_API_KEY
          ? "claude (ANTHROPIC_API_KEY is set)"
          : null;
  checks.push({
    name: "LLM provider",
    ok: provider !== null,
    detail:
      provider ??
      "no agy or claude CLI on PATH and no key set — needed for --produce; cut+captions works without",
    ...(provider !== null
      ? {}
      : {
          fix:
            "run `ossclip setup` (it can save a key for you), or " +
            "export ANTHROPIC_API_KEY or GEMINI_API_KEY (a .env file works — see README), " +
            "or install Claude Code (https://claude.com/claude-code) and log in, " +
            "or install Google Antigravity (https://antigravity.google) and log in",
        }),
  });

  checks.push({
    name: "editor page",
    ok: p.editorPageDir !== null,
    detail: p.editorPageDir ?? "not built — needed for `ossclip edit` only",
    ...(p.editorPageDir !== null
      ? {}
      : { fix: "run `pnpm build` once in the ossclip checkout (npm installs ship it prebuilt)" }),
  });

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines = checks.map((c) => {
    const head = `${c.ok ? "✓" : "✗"} ${c.name.padEnd(24)} ${c.detail}`;
    return c.fix ? `${head}\n  ↳ ${c.fix}` : head;
  });
  const missing = checks.filter((c) => !c.ok).length;
  lines.push(
    missing === 0
      ? "\nAll checks passed — you're ready to `ossclip produce`."
      : `\n${missing} check${missing === 1 ? "" : "s"} failed — fixes above, then re-run \`ossclip doctor\`.`,
  );
  return lines.join("\n");
}

/** The real probes the CLI wires in. */
export const realProbes = (editorPageDir: string | null): DoctorProbes => ({
  binRuns: (bin, arg) =>
    new Promise((resolve) => {
      // Existence is the question, not exit code — whisper-cli --help exits
      // nonzero and is still installed. Only a spawn error (ENOENT) fails.
      const child = spawn(bin, [arg], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", () => resolve(true));
    }),
  exists: existsSync,
  env: process.env,
  platform: process.platform,
  nodeMajor: Number.parseInt(process.versions.node, 10),
  editorPageDir,
});
