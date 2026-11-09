import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produce } from "../src/produce";

/**
 * The 2026-11-08 audit, end to end through the real `produce`: what the CLI
 * run decided about the words must survive the editor's Render, which replays
 * with `--scenes`, no `--produce`, and (on a `--no-youtube` project) no LLM
 * provider at all. That replay used to skip the repair block outright, so
 * the video rendered raw ASR — the user's confirmed picks gone.
 */
// The unit job has no ffmpeg (ci.yml) — the analyze/no-zoom/produce-timing
// posture: a produce-driving test skips there instead of failing the gate.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("produce: the editor's Render replay keeps what the CLI run decided", () => {
  let dir: string;
  let libraryDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-replay-repairs-"));
    libraryDir = mkdtempSync(join(tmpdir(), "ossclip-empty-library-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    const texts = ["use", "Versal", "or", "Etan", "to", "build", "agents", "today", "with", "no", "code"];
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: texts.map((text, i) => ({ text, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6, confidence: 0.99 })),
      }),
    );
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  });

  const base = () => ({
    cleanup: "standard" as const,
    libraryDir,
    render: false,
    mezzanine: false,
    youtube: false,
    confirmRepairs: false,
    transcript: join(dir, "transcript.json"),
  });
  type Prod = {
    repairs?: { heard: string; correction: string; applied: boolean }[];
    captionWords?: { text: string }[];
    transcript?: { words: { text: string }[] };
    scenes?: unknown[];
    clip?: unknown;
  };
  const read = (workdir: string): Prod =>
    JSON.parse(readFileSync(join(workdir, "production.json"), "utf8")) as Prod;
  const captionText = (workdir: string): string => {
    const props = JSON.parse(readFileSync(join(workdir, "render-props.json"), "utf8")) as {
      captionLines: { words: { text: string }[] }[];
    };
    return props.captionLines.flatMap((l) => l.words.map((w) => w.text)).join(" ");
  };

  it("repairs — cached AND user-confirmed — reach the captions and production.json on a provider-less replay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const workdir = join(dir, "wd");
    const first = await produce(join(dir, "take.mp4"), { ...base(), workdir, produce: true, provider: "mock" });
    // Seed what a real provider would have proposed: one sound-alike repair
    // the gates accept, one ("Etan" → "n8n") they refuse, which the user
    // then confirmed at the CLI picker.
    const cacheFile = readdirSync(first.workdir).find((f) => /^repairs-[0-9a-f]{8}\.json$/.test(f));
    expect(cacheFile).toBeDefined();
    writeFileSync(
      join(first.workdir, cacheFile!),
      JSON.stringify([
        { startWord: 1, endWord: 1, heard: "Versal", correction: "Vercel", applied: true },
        { startWord: 3, endWord: 3, heard: "Etan", correction: "n8n", applied: false },
      ]),
    );
    writeFileSync(
      join(first.workdir, "repair-decisions.json"),
      JSON.stringify({
        decisions: [
          { startWord: 1, endWord: 1, heard: "Versal", correction: "Vercel", keep: true },
          { startWord: 3, endWord: 3, heard: "Etan", correction: "n8n", keep: true },
        ],
        addedTerms: [],
      }),
    );
    await produce(join(dir, "take.mp4"), { ...base(), workdir, produce: true, provider: "mock" });
    expect(read(first.workdir).captionWords?.map((w) => w.text).slice(0, 4)).toEqual(["use", "Vercel", "or", "n8n"]);

    // The editor's Render: --scenes, no --produce, the recorded --llm, and
    // --no-youtube — so no provider is ever built on this run.
    const scenesPath = join(dir, "scenes-reviewed.json");
    writeFileSync(scenesPath, JSON.stringify(read(first.workdir).scenes ?? []));
    await produce(join(dir, "take.mp4"), { ...base(), workdir, scenes: scenesPath, provider: "mock" });

    const after = read(first.workdir);
    expect(after.repairs?.filter((r) => r.applied).map((r) => r.correction)).toEqual(["Vercel", "n8n"]);
    expect(after.captionWords?.map((w) => w.text).slice(0, 4)).toEqual(["use", "Vercel", "or", "n8n"]);
    // production.json's transcript stays RAW — analysis/cutlist index it.
    expect(after.transcript?.words.map((w) => w.text).slice(0, 4)).toEqual(["use", "Versal", "or", "Etan"]);
    const captions = captionText(first.workdir);
    expect(captions).toContain("Vercel");
    expect(captions).toContain("n8n");
    expect(captions).not.toContain("Versal");
    vi.restoreAllMocks();
  }, 180_000);

  it("a cached repair is re-decided with the speaker, like a fresh one (no picker ran)", async () => {
    // "Etan" → "Ahsan" fails the sound-alike gate unless the speaker name
    // vouches for it. The fresh pass passed the speaker; the cached re-decide
    // did not, so every later run (and every editor Render) refused what the
    // first run applied.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const workdir = join(dir, "wd-speaker");
    const opts = { ...base(), workdir, produce: true, provider: "mock", speaker: "Ahsan" };
    const first = await produce(join(dir, "take.mp4"), opts);
    const cacheFile = readdirSync(first.workdir).find((f) => /^repairs-[0-9a-f]{8}\.json$/.test(f));
    writeFileSync(
      join(first.workdir, cacheFile!),
      JSON.stringify([{ startWord: 3, endWord: 3, heard: "Etan", correction: "Ahsan", applied: true }]),
    );
    await produce(join(dir, "take.mp4"), opts);
    expect(read(first.workdir).repairs?.find((r) => r.heard === "Etan")?.applied).toBe(true);
    vi.restoreAllMocks();
  }, 180_000);

  it("a --clip project renders from the editor: --scenes with the recorded window pin", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const workdir = join(dir, "wd-clip");
    const clip = { clip: 3, clipWindow: "5:9" };
    const planned = await produce(join(dir, "take.mp4"), {
      ...base(),
      workdir,
      ...clip,
      produce: true,
      provider: "mock",
    });
    const scenesPath = join(dir, "scenes-clip.json");
    writeFileSync(scenesPath, JSON.stringify(read(planned.workdir).scenes ?? []));
    // Used to throw "--clip cannot be combined with hand-authored --scenes".
    await produce(join(dir, "take.mp4"), { ...base(), workdir, ...clip, scenes: scenesPath, provider: "mock" });
    const after = read(planned.workdir);
    expect(after.clip).toMatchObject({ startWord: 5, endWord: 9 });
    expect(after.transcript?.words.map((w) => w.text)).toEqual(["build", "agents", "today", "with", "no"]);
    vi.restoreAllMocks();
  }, 180_000);

  it("--clip-window with neither --produce nor --scenes is refused, not silently ignored", async () => {
    await expect(
      produce(join(dir, "take.mp4"), { ...base(), workdir: join(dir, "wd-bad"), clip: 3, clipWindow: "5:9" }),
    ).rejects.toThrow(/--clip-window replays a --clip run's plan/);
  });
});
