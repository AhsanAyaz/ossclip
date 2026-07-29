import { describe, expect, it } from "vitest";
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
    // Platform-specific: darwin says brew, linux says apt.
    expect(ffmpeg.fix).toContain("brew install ffmpeg");
    const linux = await runDoctor(
      CFG,
      healthy({ platform: "linux", binRuns: async (bin) => bin !== "ffmpeg" }),
    );
    expect(byName(linux, "ffmpeg").fix).toContain("apt install ffmpeg");
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
