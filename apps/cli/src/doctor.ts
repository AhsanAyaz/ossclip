import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { OssclipConfig } from "@ossclip/core";
import { modelUrl, validModelSources, whisperModelPath } from "./setup/manifest";
import { WHISPER_API_KEY_ENV, resolveWhisperBackend } from "./whisper-backend";

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

  // Remote transcription (2026-09-01 weak-CPU field report) makes the next
  // two checks OPTIONAL rather than blocking: a machine that transcribes on
  // Groq has no reason to own whisper.cpp or a 1.5 GB model, and doctor
  // reporting two red lines on a working install is how a user concludes the
  // tool is broken. The LLM-provider posture, one level up: pass with a
  // detail that says why nothing is needed.
  const remote = resolveWhisperBackend(undefined, cfg, p.env);
  const remoteBackend = remote.ok && remote.backend.kind === "remote" ? remote.backend : null;
  const notNeeded = (found: string): string =>
    `${found} not found — not needed: remote transcription configured`;

  const whisperOk = await p.binRuns(cfg.whisperPath, "--help");
  checks.push({
    name: "whisper-cli",
    ok: whisperOk || remoteBackend !== null,
    detail: whisperOk ? cfg.whisperPath : remoteBackend !== null ? notNeeded(cfg.whisperPath) : cfg.whisperPath,
    ...(whisperOk || remoteBackend !== null
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

  // Same resolution `produce` uses (whisperModelPath — one rule, three
  // sites), and the same URL source: the fix line used to hold its own copy
  // of the ggerganov URL, which 404'd for curated/custom names and the
  // `curl -L` then saved the 404 HTML as a fake model.
  const modelPath = whisperModelPath(cfg.model, cfg.modelDir);
  const modelOk = p.exists(modelPath);
  checks.push({
    name: `whisper model (${cfg.model})`,
    ok: modelOk || remoteBackend !== null,
    detail: modelOk ? modelPath : remoteBackend !== null ? notNeeded(modelPath) : modelPath,
    ...(modelOk || remoteBackend !== null
      ? {}
      : {
          fix: viaSetup(
            `mkdir -p ${cfg.modelDir} && curl -L -o ${modelPath} ` +
              modelUrl(cfg.model, validModelSources(cfg.modelSources)),
          ),
        }),
  });

  // NO network call, unlike every other backend doctor could probe: a
  // transcription request costs the user's metered free tier, and `doctor` is
  // run repeatedly while fixing something else. This line reports the
  // CONFIGURATION — the three things a 401 or a 404 would be about — and the
  // provider's own status hints name the rest when a real run happens.
  // Omitted entirely when remote is not configured: the local install is the
  // default, and an extra "not configured" line for an opt-in feature is
  // noise on every other machine.
  if (remoteBackend !== null) {
    checks.push({
      name: "remote transcription",
      ok: true,
      detail:
        `${remoteBackend.baseUrl} · model ${remoteBackend.model} · ` +
        (remoteBackend.apiKey !== undefined
          ? `${WHISPER_API_KEY_ENV} set`
          : `no API key (fine for self-hosted; Groq needs ${WHISPER_API_KEY_ENV})`),
    });
  }

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
