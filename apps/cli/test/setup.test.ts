import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfigPatch, type OssclipConfig } from "@ossclip/core";
import { MODELS, ffmpegAsset, whisperAsset } from "../src/setup/manifest";
import { formatPlan, planSetup, type SetupProbes } from "../src/setup/plan";
import { promptForProvider } from "../src/setup/provider";
import { download } from "../src/setup/download";
import { tarCandidates } from "../src/setup/extract";
import { openCommand } from "../src/open";

const CFG: OssclipConfig = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  whisperPath: "whisper-cli",
  modelDir: "/home/u/.ossclip/models",
  model: "small.en",
};

const OPTS = { configDir: "/home/u/.ossclip", model: "small.en", force: false, skipLlm: false };

/** Everything present — individual tests break exactly one thing (doctor's pattern). */
const healthy = (over: Partial<SetupProbes> = {}): SetupProbes => ({
  binRuns: async () => true,
  exists: () => true,
  platform: "linux",
  arch: "x64",
  env: { GEMINI_API_KEY: "k" },
  ...over,
});

const byKind = (steps: Awaited<ReturnType<typeof planSetup>>, kind: string) => {
  const hit = steps.find((s) => s.kind === kind);
  if (!hit) throw new Error(`no step ${kind}`);
  return hit;
};

describe("setup manifest (§90: the install cliff is the adoption ceiling)", () => {
  it("every supported platform×arch resolves ffmpeg to an asset or an explicit brew/manual path", () => {
    // The automated download matrix — darwin is deliberately null (brew).
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["win32", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ] as const) {
      const a = ffmpegAsset(platform, arch);
      expect(a, `${platform}/${arch}`).not.toBeNull();
      expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a?.url).toMatch(/^https:\/\/github\.com\//);
      expect(a?.sizeMB).toBeGreaterThan(0);
    }
    expect(ffmpegAsset("darwin", "arm64")).toBeNull();
  });

  it("whisper prebuilts cover win32 and linux; darwin is brew's job", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ] as const) {
      const a = whisperAsset(platform, arch);
      expect(a, `${platform}/${arch}`).not.toBeNull();
      expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(whisperAsset("darwin", "arm64")).toBeNull();
  });

  it("windows binaries carry .exe; posix ones don't", () => {
    expect(ffmpegAsset("win32", "x64")?.bins).toEqual(["ffmpeg.exe", "ffprobe.exe"]);
    expect(ffmpegAsset("linux", "x64")?.bins).toEqual(["ffmpeg", "ffprobe"]);
    expect(whisperAsset("win32", "x64")?.bins).toEqual(["whisper-cli.exe"]);
  });

  it("the model table pins size and upstream SHA-1 for every documented model", () => {
    for (const name of ["tiny.en", "base.en", "small.en", "medium.en"]) {
      const m = MODELS[name];
      expect(m, name).toBeDefined();
      expect(m?.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(m?.sizeMB).toBeGreaterThan(0);
    }
  });
});

describe("setup planner", () => {
  it("a fully healthy machine plans zero work", async () => {
    const steps = await planSetup(CFG, healthy(), OPTS);
    expect(steps.every((s) => s.status === "satisfied")).toBe(true);
    expect(formatPlan(steps)).not.toContain("download");
  });

  it("missing ffmpeg on linux-x64 → download the pinned static build", async () => {
    const steps = await planSetup(
      CFG,
      healthy({ binRuns: async (bin) => bin !== "ffmpeg" && bin !== "ffprobe" }),
      OPTS,
    );
    const ffmpeg = byKind(steps, "ffmpeg");
    expect(ffmpeg.status).toBe("download");
    expect(ffmpeg.asset?.url).toContain("linux64-gpl");
  });

  it("missing whisper on darwin → brew when brew exists, manual with the recipe when not", async () => {
    const withBrew = await planSetup(
      CFG,
      healthy({ platform: "darwin", binRuns: async (bin) => bin !== "whisper-cli" }),
      OPTS,
    );
    expect(byKind(withBrew, "whisper").status).toBe("brew");
    expect(byKind(withBrew, "whisper").hint).toBe("whisper-cpp");

    const noBrew = await planSetup(
      CFG,
      healthy({
        platform: "darwin",
        binRuns: async (bin) => bin !== "whisper-cli" && bin !== "brew",
      }),
      OPTS,
    );
    const step = byKind(noBrew, "whisper");
    expect(step.status).toBe("manual");
    expect(step.hint).toContain("brew.sh");
  });

  it("an unsupported platform degrades to manual, never to silence", async () => {
    const steps = await planSetup(
      CFG,
      healthy({ platform: "freebsd", binRuns: async () => false, exists: () => false, env: {} }),
      OPTS,
    );
    for (const kind of ["ffmpeg", "whisper"]) {
      const s = byKind(steps, kind);
      expect(s.status).toBe("manual");
      expect(s.hint).toBeTruthy();
    }
  });

  it("--force re-provisions managed paths but never a user's own absolute path", async () => {
    const forced = { ...OPTS, force: true };
    // Bare name (PATH) — setup may take over.
    const bare = await planSetup(CFG, healthy(), forced);
    expect(byKind(bare, "ffmpeg").status).toBe("download");
    // Managed path — setup owns it.
    const managed = await planSetup(
      { ...CFG, ffmpegPath: "/home/u/.ossclip/bin/ffmpeg-x/bin/ffmpeg" },
      healthy(),
      forced,
    );
    expect(byKind(managed, "ffmpeg").status).toBe("download");
    // User's own path — hands off, even under --force.
    const custom = await planSetup(
      { ...CFG, ffmpegPath: "/opt/myffmpeg/ffmpeg" },
      healthy(),
      forced,
    );
    expect(byKind(custom, "ffmpeg").status).toBe("satisfied");
  });

  it("a present model is satisfied; a missing known model plans a sized download", async () => {
    const steps = await planSetup(CFG, healthy({ exists: () => false }), OPTS);
    const model = byKind(steps, "model");
    expect(model.status).toBe("download");
    expect(model.sizeMB).toBe(466);
    expect(model.detail).toContain("ggml-small.en.bin");
  });

  it("provider: --skip-llm and a detected provider are both satisfied; neither prompts", async () => {
    // No agy and no claude (§132: the CLIs are now probed before the keys) —
    // "missing" must mean ALL four detection branches came up empty.
    const noCli = async (b: string) => b !== "claude" && b !== "agy";
    const skipped = await planSetup(CFG, healthy({ env: {}, binRuns: noCli }), {
      ...OPTS,
      skipLlm: true,
    });
    expect(byKind(skipped, "provider").status).toBe("satisfied");
    const missing = await planSetup(CFG, healthy({ env: {}, binRuns: noCli }), OPTS);
    expect(byKind(missing, "provider").status).toBe("prompt");
  });

  // Lockstep guard for §132: the planner duplicates doctor's detection order,
  // and the agy CLI must beat a key here exactly as it does there.
  it("provider: an installed agy CLI satisfies the step even with keys set", async () => {
    const steps = await planSetup(
      CFG,
      healthy({ env: { GEMINI_API_KEY: "g" }, binRuns: async () => true }),
      OPTS,
    );
    expect(byKind(steps, "provider").detail).toContain("antigravity");
  });

  it("the plan discloses the total download size up front", async () => {
    const steps = await planSetup(
      CFG,
      healthy({ binRuns: async (b) => b === "brew" || b === "claude", exists: () => false }),
      OPTS,
    );
    const text = formatPlan(steps);
    // 120 (ffmpeg linux64) + 9 (whisper) + 466 (small.en)
    expect(text).toContain("total download ~595 MB");
  });
});

describe("promptForProvider (the LLM step of setup)", () => {
  const io = (answers: string[]) => {
    const said: string[] = [];
    return {
      said,
      ask: async () => answers.shift() ?? "",
      say: (line: string) => void said.push(line),
    };
  };

  // §132: Antigravity is a keyless subscription CLI exactly like Claude Code
  // — choosing it must save NOTHING. A key invented here would be worse than
  // no answer: there is no key, and produce finds agy on PATH by itself.
  it("choice 4 (Antigravity) says nothing-to-save and writes no .env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-provider-"));
    const t = io(["4"]);
    await promptForProvider(t, dir);
    expect(t.said.join("\n")).toContain("agy CLI on PATH");
    expect(() => readFileSync(join(dir, ".env"))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the menu offers Antigravity as choice 4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-provider-"));
    const t = io([""]); // just Enter — skip
    await promptForProvider(t, dir);
    expect(t.said.some((l) => l.includes("4)") && l.includes("Antigravity"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("download (resume + integrity)", () => {
  const body = (text: string) =>
    new Response(new TextEncoder().encode(text), { status: 200 });

  it("fresh download lands, is hash-checked, and .part disappears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-dl-"));
    const dest = join(dir, "file.bin");
    // sha256 of "hello"
    const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    await download("https://x/file", dest, { sha256: sha, fetchImpl: async () => body("hello") });
    expect(readFileSync(dest, "utf8")).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an existing .part resumes with a Range header and appends on 206", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-dl-"));
    const dest = join(dir, "file.bin");
    writeFileSync(`${dest}.part`, "hel");
    let range: string | null = null;
    await download("https://x/file", dest, {
      fetchImpl: async (_url, init) => {
        range = new Headers(init?.headers).get("range");
        return new Response(new TextEncoder().encode("lo"), { status: 206 });
      },
    });
    expect(range).toBe("bytes=3-");
    expect(readFileSync(dest, "utf8")).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a checksum mismatch removes the partial and throws — never a corrupt install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-dl-"));
    const dest = join(dir, "file.bin");
    await expect(
      download("https://x/file", dest, {
        sha256: "0".repeat(64),
        fetchImpl: async () => body("evil"),
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(() => readFileSync(dest)).toThrow();
    expect(() => readFileSync(`${dest}.part`)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("saveConfigPatch", () => {
  it("merges over hand-edited config, preserving keys setup doesn't touch", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-cfg-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ speaker: "Ahsan", pricing: { x: { in: 1, out: 2 } }, model: "small.en" }),
    );
    saveConfigPatch({ ffmpegPath: "/managed/ffmpeg" }, dir);
    const after = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(after.speaker).toBe("Ahsan");
    expect(after.pricing).toEqual({ x: { in: 1, out: 2 } });
    expect(after.model).toBe("small.en");
    expect(after.ffmpegPath).toBe("/managed/ffmpeg");
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file (and dir) when absent", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ossclip-cfg-")), "deeper");
    const path = saveConfigPatch({ whisperPath: "/w" }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ whisperPath: "/w" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tarCandidates (§117: GNU tar can't read a zip)", () => {
  it("windows tries the system bsdtar by ABSOLUTE path before bare tar", () => {
    // Any box with Git for Windows — every GitHub runner — puts MSYS GNU tar
    // ahead of the system bsdtar on PATH, and GNU tar exits 128 on a zip.
    const c = tarCandidates("win32", { SystemRoot: "C:\\Windows" });
    expect(c[0]).toBe("C:\\Windows\\System32\\tar.exe");
    expect(c[1]).toBe("tar");
  });

  it("windows honours a relocated SystemRoot, and falls back when it is unset", () => {
    expect(tarCandidates("win32", { SystemRoot: "D:\\Win" })[0]).toBe("D:\\Win\\System32\\tar.exe");
    expect(tarCandidates("win32", {})[0]).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("posix just uses tar", () => {
    expect(tarCandidates("linux", {})).toEqual(["tar"]);
    expect(tarCandidates("darwin", {})).toEqual(["tar"]);
  });
});

describe("openCommand (the `open` spawn crashed everywhere but macOS)", () => {
  it("picks the platform's opener", () => {
    expect(openCommand("http://u", "darwin")).toEqual({ bin: "open", args: ["http://u"] });
    expect(openCommand("http://u", "linux")).toEqual({ bin: "xdg-open", args: ["http://u"] });
    // The empty string fills `start`'s title slot so the URL isn't eaten.
    expect(openCommand("http://u", "win32")).toEqual({
      bin: "cmd",
      args: ["/c", "start", "", "http://u"],
    });
  });

  // The thumbnail confirm reuses the same opener for FILE paths (viewer, not
  // browser) — every platform's opener treats them identically, so the rows
  // pin that a path rides through verbatim, exactly like a URL.
  it("opens file paths through the same per-platform opener", () => {
    expect(openCommand("/tmp/final.thumbnail.png", "darwin")).toEqual({
      bin: "open",
      args: ["/tmp/final.thumbnail.png"],
    });
    expect(openCommand("/tmp/final.thumbnail.png", "linux")).toEqual({
      bin: "xdg-open",
      args: ["/tmp/final.thumbnail.png"],
    });
    // A path with spaces is why the empty title arg is load-bearing: spawn
    // quotes the spaced arg, and without the empty string `start` would read
    // the quoted path as its window title and open nothing.
    expect(openCommand("C:\\out\\my talk.thumbnail.png", "win32")).toEqual({
      bin: "cmd",
      args: ["/c", "start", "", "C:\\out\\my talk.thumbnail.png"],
    });
  });
});
