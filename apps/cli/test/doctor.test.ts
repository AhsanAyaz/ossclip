import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { OssclipConfig } from "@ossclip/core";
import { formatDoctor, runDoctor, type DoctorProbes } from "../src/doctor";

const CFG: OssclipConfig = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  whisperPath: "whisper-cli",
  modelDir: "/home/u/.ossclip/models",
  model: "small.en",
};

/** Everything present — individual tests break exactly one thing. */
const healthy = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  binRuns: async () => true,
  exists: () => true,
  env: { GEMINI_API_KEY: "k" },
  platform: "darwin",
  nodeMajor: 22,
  editorPageDir: "/repo/apps/editor/dist",
  ...over,
});

const byName = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => {
  const hit = checks.find((c) => c.name.startsWith(name));
  if (!hit) throw new Error(`no check named ${name}`);
  return hit;
};

describe("ossclip doctor (R18 §90a)", () => {
  it("all prerequisites present → every check ok, no fixes", async () => {
    const checks = await runDoctor(CFG, healthy());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => c.fix === undefined)).toBe(true);
    expect(formatDoctor(checks)).toContain("All checks passed");
  });

  it("a missing binary fails its check with the env-var escape hatch named", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ binRuns: async (bin) => bin !== "ffmpeg" }),
    );
    const ffmpeg = byName(checks, "ffmpeg");
    expect(ffmpeg.ok).toBe(false);
    expect(ffmpeg.fix).toContain("OSSCLIP_FFMPEG");
    // Platform-specific: darwin says brew, linux says apt, windows says winget.
    expect(ffmpeg.fix).toContain("brew install ffmpeg");
    const linux = await runDoctor(
      CFG,
      healthy({ platform: "linux", binRuns: async (bin) => bin !== "ffmpeg" }),
    );
    expect(byName(linux, "ffmpeg").fix).toContain("apt install ffmpeg");
    const win = await runDoctor(
      CFG,
      healthy({ platform: "win32", binRuns: async (bin) => bin !== "ffmpeg" }),
    );
    expect(byName(win, "ffmpeg").fix).toContain("winget install ffmpeg");
  });

  it("every installable prerequisite's fix leads with `ossclip setup` (§90: setup is the ramp)", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ binRuns: async (bin) => bin === "brew", exists: () => false }),
    );
    for (const name of ["ffmpeg", "ffprobe", "whisper-cli", "whisper model"]) {
      expect(byName(checks, name).fix).toMatch(/^run `ossclip setup`/);
    }
  });

  it("windows gets a real whisper hint, not 'build from source'", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ platform: "win32", binRuns: async (bin) => bin !== "whisper-cli" }),
    );
    expect(byName(checks, "whisper-cli").fix).toContain("whisper-blas-bin-x64.zip");
    expect(byName(checks, "whisper-cli").fix).not.toContain("build whisper.cpp from source");
  });

  it("a missing model prints the exact download command for the CONFIGURED model", async () => {
    const checks = await runDoctor(CFG, healthy({ exists: () => false }));
    const model = byName(checks, "whisper model");
    expect(model.ok).toBe(false);
    expect(model.detail).toBe("/home/u/.ossclip/models/ggml-small.en.bin");
    expect(model.fix).toContain("curl -L -o /home/u/.ossclip/models/ggml-small.en.bin");
    expect(model.fix).toContain("ggml-small.en.bin");
  });

  it("an absolute model path is checked verbatim, not resolved into modelDir", async () => {
    const seen: string[] = [];
    await runDoctor(
      { ...CFG, model: "/models/custom.bin" },
      healthy({
        exists: (p) => {
          seen.push(p);
          return true;
        },
      }),
    );
    expect(seen).toContain("/models/custom.bin");
  });

  // Detection order changed 2026-08 (FINDINGS §132, antigravity provider):
  // subscription CLIs beat ambient env keys, and doctor's provider check
  // must state the same order auto-detection uses.
  it("provider: an agy CLI beats every key — the bin is the explicit choice", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({
        env: { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" },
        binRuns: async () => true,
      }),
    );
    expect(byName(checks, "LLM provider").detail).toContain("antigravity");
  });

  it("provider: agy absent + claude CLI present → claude-cli, before any key", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ env: { GEMINI_API_KEY: "g" }, binRuns: async (bin) => bin !== "agy" }),
    );
    expect(byName(checks, "LLM provider").detail).toContain("claude-cli");
  });

  it("provider: no CLIs → keys win in their own order", async () => {
    const noBins = async (bin: string) => bin !== "agy" && bin !== "claude";
    const viaGemini = await runDoctor(
      CFG,
      healthy({ env: { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }, binRuns: noBins }),
    );
    expect(byName(viaGemini, "LLM provider").detail).toContain("GEMINI_API_KEY");
    const viaKey = await runDoctor(
      CFG,
      healthy({ env: { ANTHROPIC_API_KEY: "k" }, binRuns: noBins }),
    );
    expect(byName(viaKey, "LLM provider").detail).toContain("ANTHROPIC_API_KEY");
  });

  it("provider: OSSCLIP_AGY_BIN is what the probe spawns, not a hardcoded 'agy'", async () => {
    const probed: string[] = [];
    await runDoctor(
      CFG,
      healthy({
        env: { OSSCLIP_AGY_BIN: "/custom/agy", OSSCLIP_CLAUDE_BIN: "/custom/claude" },
        binRuns: async (bin) => {
          probed.push(bin);
          return bin === "ffmpeg" || bin === "ffprobe" || bin === "whisper-cli";
        },
      }),
    );
    expect(probed).toContain("/custom/agy");
    expect(probed).toContain("/custom/claude");
  });

  it("no key and no CLI → the provider check fails, saying produce-only scope", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ env: {}, binRuns: async (bin) => bin !== "claude" && bin !== "agy" }),
    );
    const provider = byName(checks, "LLM provider");
    expect(provider.ok).toBe(false);
    expect(provider.detail).toContain("--produce");
    expect(provider.fix).toContain("ANTHROPIC_API_KEY or GEMINI_API_KEY");
    // Both subscription ramps are named — Antigravity joined Claude Code
    // as a keyless fix in the §132 wave.
    expect(provider.fix).toContain("antigravity.google");
    // The report counts it and points back at the fixes.
    expect(formatDoctor(checks)).toContain("1 check failed");
  });

  // Remote transcription (2026-09-01 weak-CPU field report): the machine
  // that needs it most is the one that never installed whisper.cpp, and
  // doctor printing two red lines on a working install is how a user
  // concludes the tool is broken.
  const REMOTE_CFG: OssclipConfig = { ...CFG, whisperUrl: "https://api.groq.com/openai/v1" };

  it("remote configured → a missing whisper-cli and model still pass, saying why", async () => {
    const checks = await runDoctor(
      REMOTE_CFG,
      healthy({ binRuns: async (bin) => bin !== "whisper-cli", exists: () => false }),
    );
    const whisper = byName(checks, "whisper-cli");
    expect(whisper.ok).toBe(true);
    expect(whisper.detail).toContain("not needed: remote transcription configured");
    // No fix line: there is nothing to fix.
    expect(whisper.fix).toBeUndefined();
    const model = byName(checks, "whisper model");
    expect(model.ok).toBe(true);
    expect(model.detail).toContain("not needed: remote transcription configured");
    expect(model.detail).toContain("/home/u/.ossclip/models/ggml-small.en.bin");
    expect(formatDoctor(checks)).toContain("All checks passed");
  });

  it("a local whisper that DOES work still reports its own path", async () => {
    // Having both is a supported install — `--whisper-backend local` is the
    // escape hatch, and it must not be reported as unavailable.
    const checks = await runDoctor(REMOTE_CFG, healthy());
    expect(byName(checks, "whisper-cli").detail).toBe("whisper-cli");
    expect(byName(checks, "whisper model").detail).toBe("/home/u/.ossclip/models/ggml-small.en.bin");
  });

  it("the remote line reports url · model · key presence — and makes no network call", async () => {
    const withKey = await runDoctor(
      { ...REMOTE_CFG, whisperRemoteModel: "whisper-large-v3" },
      healthy({ env: { GEMINI_API_KEY: "k", OSSCLIP_WHISPER_API_KEY: "gsk_x" } }),
    );
    const line = byName(withKey, "remote transcription");
    expect(line.ok).toBe(true);
    expect(line.detail).toContain("https://api.groq.com/openai/v1");
    expect(line.detail).toContain("model whisper-large-v3");
    expect(line.detail).toContain("OSSCLIP_WHISPER_API_KEY set");
    // The default model when none is configured, and the keyless wording:
    // a self-hosted server needs no key, so this must not read as a failure.
    const keyless = await runDoctor(REMOTE_CFG, healthy({ env: {} }));
    const noKey = byName(keyless, "remote transcription");
    expect(noKey.ok).toBe(true);
    expect(noKey.detail).toContain("model whisper-large-v3-turbo");
    expect(noKey.detail).toContain("fine for self-hosted");
  });

  it("unconfigured → no remote line at all, and the local checks fail as they always did", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ binRuns: async (bin) => bin !== "whisper-cli", exists: () => false }),
    );
    expect(checks.find((c) => c.name === "remote transcription")).toBeUndefined();
    expect(byName(checks, "whisper-cli").ok).toBe(false);
    expect(byName(checks, "whisper-cli").fix).toContain("OSSCLIP_WHISPER");
    expect(byName(checks, "whisper model").ok).toBe(false);
  });

  it("a missing editor page names the one-time build", async () => {
    const checks = await runDoctor(CFG, healthy({ editorPageDir: null }));
    const page = byName(checks, "editor page");
    expect(page.ok).toBe(false);
    expect(page.fix).toContain("pnpm build");
  });

  it("old node fails with the version floor named", async () => {
    const checks = await runDoctor(CFG, healthy({ nodeMajor: 20 }));
    expect(byName(checks, "node").ok).toBe(false);
    expect(byName(checks, "node").fix).toContain("Node ≥ 22");
  });
});

describe("CLI version reporting (R22 §113)", () => {
  it("reads the version from the manifest instead of a literal", () => {
    const src = readFileSync(new URL("../src/program.ts", import.meta.url), "utf8");
    // A hardcoded `.version("1.2.3")` is invisible until someone reads a bug
    // report against the wrong number: the literal stayed at 0.1.0 through
    // two releases while npm installed 0.1.2.
    expect(src).not.toMatch(/\.version\(\s*["'`]\d/);
    expect(src).toContain("package.json");
  });
});
