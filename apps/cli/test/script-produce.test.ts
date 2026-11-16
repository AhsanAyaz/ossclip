import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, alignCues, parseScript } from "@ossclip/core";
import { produce } from "../src/produce";
import { setReplayArgv } from "../src/replay-argv";

/**
 * `ossclip produce --script` end to end, no LLM (explainer plan Task 8 Step 4,
 * spec "No-LLM proof"): the real `produce` against the verify-ossclip
 * fixture's transcript and `fixtures/fixture.script.md`, planned by the mock
 * provider. And the G6 half: the same take WITHOUT `--script` never touches
 * the script path at all.
 *
 * The script functions are wrapped, not replaced: every call reaches the real
 * parser and aligner, and the wrapper only counts — the G6 claim is that a
 * run without `--script` makes zero calls, which only a call count can show.
 */
vi.mock("@ossclip/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ossclip/core")>();
  return { ...real, parseScript: vi.fn(real.parseScript), alignCues: vi.fn(real.alignCues) };
});

// The unit job has no ffmpeg (ci.yml) — the plan-sees-cut-words posture: a
// produce-driving test skips there instead of failing the gate.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const FIXTURES = new URL("../../../fixtures/", import.meta.url).pathname;

describe.skipIf(!hasFfmpeg)("produce --script, end to end with the mock provider", () => {
  let dir: string;
  let libraryDir: string;
  let schemaNames: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-script-"));
    libraryDir = mkdtempSync(join(tmpdir(), "ossclip-empty-library-"));
    // The fixture transcript's words end at 15.4s; the take is a little
    // longer, with a tone for audio (the transcript is injected, so whisper
    // never hears it).
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=18",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=18",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    copyFileSync(join(FIXTURES, "fixture.transcript.json"), join(dir, "transcript.json"));
    // The script and its clip live together, as a real script's do; the clip
    // is VP9 alpha in WebM, so the import takes the copy-through path.
    const scriptDir = join(dir, "script");
    mkdirSync(join(scriptDir, "clips"), { recursive: true });
    copyFileSync(join(FIXTURES, "fixture.script.md"), join(scriptDir, "fixture.script.md"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red@0.5:s=320x240:d=1.5:r=30,format=yuva420p",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
      "-y", join(scriptDir, "clips", "fixture-clip.webm"),
    ]);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.mocked(parseScript).mockClear();
    vi.mocked(alignCues).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    schemaNames = [];
    const real = MockProvider.prototype.complete;
    vi.spyOn(MockProvider.prototype, "complete").mockImplementation(function (this: MockProvider, req) {
      schemaNames.push(req.schemaName);
      return real.call(this, req);
    } as typeof real);
  });

  const run = (workdir: string, script?: string) =>
    produce(join(dir, "take.mp4"), {
      cleanup: "standard",
      libraryDir,
      render: false,
      mezzanine: false,
      youtube: false,
      confirmRepairs: false,
      transcript: join(dir, "transcript.json"),
      workdir,
      produce: true,
      provider: "mock",
      ...(script !== undefined ? { script } : {}),
    });

  const workdirOf = (root: string): string => {
    const [name] = readdirSync(root);
    return join(root, name!);
  };

  it("plans one scene per cue, the clip included, and reports every cue placed", async () => {
    const root = join(dir, "wd-script");
    const scriptPath = join(dir, "script", "fixture.script.md");
    // The argv a typed run would record (§129's stash), with the script given
    // RELATIVE: command.json must name it absolute, for the editor's replays.
    setReplayArgv(["produce", "take.mp4", "--script", "script/fixture.script.md"]);
    await run(root, scriptPath);
    const work = existsSync(join(root, "production.json")) ? root : workdirOf(root);

    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    expect(production.scenes).toHaveLength(3);
    expect(production.scenes.map((s: { component: string }) => s.component)).toEqual([
      "TitleCard",
      "StatCard",
      "ClipScene",
    ]);
    const clipScene = production.scenes.find((s: { component: string }) => s.component === "ClipScene");
    expect(clipScene.props.src).toMatch(/^clips\/[0-9a-f]{12}\.webm$/);
    // Copied, not re-encoded: a VP9 WebM through ffmpeg's VP9 decoder loses
    // its alpha. Same bytes in the workdir, which the editor serves.
    expect(readFileSync(join(work, clipScene.props.src))).toEqual(
      readFileSync(join(dir, "script", "clips", "fixture-clip.webm")),
    );

    // The project stores the text and where it came from (Re-plan reads it).
    expect(production.script.text).toBe(readFileSync(scriptPath, "utf8"));
    expect(production.script.sourcePath).toBe(scriptPath);
    expect(production.script.clips).toEqual([
      { path: "clips/fixture-clip.webm", src: clipScene.props.src, durationSec: expect.any(Number) },
    ]);

    const report = JSON.parse(readFileSync(join(work, "script-report.json"), "utf8"));
    expect(report.outcomes.map((o: { status: string }) => o.status)).toEqual(["placed", "placed", "placed"]);
    expect(report.outcomes.map((o: { component: string }) => o.component)).toEqual([
      "TitleCard",
      "ClipScene",
      "StatCard",
    ]);
    expect(report.outcomes.map((o: { line: number }) => o.line)).toEqual([15, 18, 23]);

    // Script mode never asks for a beat sheet, and never touches its cache.
    expect(schemaNames).toContain("script_plan");
    expect(schemaNames).not.toContain("beat_sheet");
    const files = readdirSync(work);
    expect(files.some((f) => f.startsWith("beatsheet-"))).toBe(false);
    expect(files.some((f) => f.startsWith("scriptplan-"))).toBe(true);
    // The cue report replaces the graphics accounting line in report.txt.
    const reportTxt = readFileSync(join(work, "report.txt"), "utf8");
    expect(reportTxt).toContain("placed 3 of 3 · skipped 0 · reported 0");
    expect(reportTxt).not.toContain("target is ~1 per");
    // The recorded command names the script's source, absolute.
    const command = JSON.parse(readFileSync(join(work, "command.json"), "utf8"));
    const args = command.args as string[];
    expect(args.filter((a) => a === "--script")).toHaveLength(1);
    expect(args[args.indexOf("--script") + 1]).toBe(scriptPath);
  }, 120_000);

  it("aligns against the cut as edited: a revived word places, a user-cut line skips at alignment (§158)", async () => {
    // The cut-and-review-first workflow (§158, 2026-11-16): the first real
    // project placed 11 of 22 cues because alignment saw the AUTOMATIC cut.
    // Here the author keeps the "um" the automatic cut removes (a veto) and
    // cuts the whole "Today … cool" line by hand, then adds the graphics.
    const root = join(dir, "wd-edited");
    const scriptPath = join(dir, "script", "edited.script.md");
    writeFileSync(
      scriptPath,
      [
        "🎬 Title card: welcome back",
        "🗣️ Hello everyone, welcome back.",
        "",
        "🎬 [StatCard] One filler: um",
        "🗣️ um",
        "",
        "🎬 clip: clips/fixture-clip.webm",
        "🗣️ Today I want to show you something cool.",
        "",
        "🎬 [StatCard] One number: the clean edit",
        "🗣️ This raw take becomes a clean edit automatically.",
        "",
      ].join("\n"),
    );
    // A cue's `line` is its 🎬 line, 1-based — the line directly above its
    // 🗣️, whose 0-based index is therefore the same number.
    const cueLine = (spoken: string) => readFileSync(scriptPath, "utf8").split("\n").indexOf(`🗣️ ${spoken}`);
    const umLine = cueLine("um");
    const clipLine = cueLine("Today I want to show you something cool.");
    const umIndex = 4; // fixture.transcript.json: "um" at 4.64–4.97s
    const todayIndex = 5;

    // Before any edit: the automatic cut removes "um", so its cue is the one
    // that cannot place, and the clip line places.
    await run(root, scriptPath);
    const work = workdirOf(root);
    const before = JSON.parse(readFileSync(join(work, "script-report.json"), "utf8")).outcomes as {
      line: number;
      status: string;
      reason?: string;
    }[];
    expect(before.find((o) => o.line === umLine)!.status).toBe("skipped");
    expect(before.find((o) => o.line === clipLine)!.status).toBe("placed");

    // The editor's edits: keep the "um", cut 5.2–9.0s ("Today … cool").
    writeFileSync(
      join(work, "overrides.json"),
      JSON.stringify({
        cleanup: { kept: [{ srcIn: 4.7, srcOut: 4.9 }] },
        cuts: [{ startSec: 4, endSec: 7.8, src: { startSec: 5.2, endSec: 9.0 } }],
      }),
    );
    vi.mocked(alignCues).mockClear();
    await run(root, scriptPath);

    const { aligned, skipped } = vi.mocked(alignCues).mock.results[0]!.value as ReturnType<typeof alignCues>;
    // The revived word is a candidate: the "um" cue sits on it.
    const um = aligned.find((a) => a.cue.line === umLine);
    expect(um).toMatchObject({ startWord: umIndex, endWord: umIndex, score: 1 });
    // The cut line never reaches the planner: skipped at ALIGNMENT, not
    // aligned and then dropped by the assembler for its cut anchor words.
    expect(aligned.some((a) => a.cue.line === clipLine || a.startWord === todayIndex)).toBe(false);
    expect(skipped.find((s) => s.cue.line === clipLine)).toMatchObject({ reason: "below-floor" });

    const after = JSON.parse(readFileSync(join(work, "script-report.json"), "utf8")).outcomes as {
      line: number;
      status: string;
      reason?: string;
    }[];
    const clipOutcome = after.find((o) => o.line === clipLine)!;
    expect(clipOutcome.status).toBe("skipped");
    expect(clipOutcome.reason).toMatch(/below the 0\.6 match floor/);
    expect(after.some((o) => o.reason?.startsWith("dropped:"))).toBe(false);
    // The edit changed the kept words, so the plan re-ran under a new key.
    expect(readdirSync(work).filter((f) => f.startsWith("scriptplan-"))).toHaveLength(2);
  }, 240_000);

  it("G6: without --script, no script code runs and nothing script-shaped is written", async () => {
    const root = join(dir, "wd-plain");
    await run(root);
    const work = existsSync(join(root, "production.json")) ? root : workdirOf(root);
    expect(vi.mocked(parseScript)).not.toHaveBeenCalled();
    expect(vi.mocked(alignCues)).not.toHaveBeenCalled();
    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    expect("script" in production).toBe(false);
    expect(existsSync(join(work, "script-report.json"))).toBe(false);
    expect(schemaNames).toContain("beat_sheet");
    expect(schemaNames).not.toContain("script_plan");
  }, 120_000);

  it("a missing script file fails before any work, naming the path", async () => {
    await expect(run(join(dir, "wd-missing"), join(dir, "nope.md"))).rejects.toThrow(
      `script file not found: ${join(dir, "nope.md")}`,
    );
    expect(vi.mocked(alignCues)).not.toHaveBeenCalled();
  });
});
