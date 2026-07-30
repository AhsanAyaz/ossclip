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

  it("provider: keys win in detection order, the claude CLI is the fallback", async () => {
    const viaKey = await runDoctor(CFG, healthy({ env: { ANTHROPIC_API_KEY: "k" } }));
    expect(byName(viaKey, "LLM provider").detail).toContain("ANTHROPIC_API_KEY");
    const viaCli = await runDoctor(
      CFG,
      healthy({ env: {}, binRuns: async (bin) => bin === "claude" || bin !== "nothing" }),
    );
    expect(byName(viaCli, "LLM provider").detail).toContain("claude-cli");
  });

  it("no key and no CLI → the provider check fails, saying produce-only scope", async () => {
    const checks = await runDoctor(
      CFG,
      healthy({ env: {}, binRuns: async (bin) => bin !== "claude" }),
    );
    const provider = byName(checks, "LLM provider");
    expect(provider.ok).toBe(false);
    expect(provider.detail).toContain("--produce");
    expect(provider.fix).toContain("ANTHROPIC_API_KEY or GEMINI_API_KEY");
    // The report counts it and points back at the fixes.
    expect(formatDoctor(checks)).toContain("1 check failed");
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
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    // A hardcoded `.version("1.2.3")` is invisible until someone reads a bug
    // report against the wrong number: the literal stayed at 0.1.0 through
    // two releases while npm installed 0.1.2.
    expect(src).not.toMatch(/\.version\(\s*["'`]\d/);
    expect(src).toContain("package.json");
  });
});
