import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, TimeMap } from "@ossclip/core";
import { produce, type ProduceOptions } from "../src/produce";
import { REVIEWED_SCENES_BASENAME, reviewedScenesText } from "../src/render-replay-args";
import { setReplayArgv } from "../src/replay-argv";
import { STORYBOARD_FILE, StoryboardFileError } from "../src/storyboard/storyboard-store";

/**
 * `ossclip produce --storyboard` end to end, no LLM (plan Task 3 Step 5;
 * §168): the real `produce` on the verify-ossclip fixture's transcript,
 * planned by the mock provider, never rendered. The script-produce harness:
 * an injected transcript, a synthetic take, and a spy that records every
 * schema the provider is asked for, so "no call was made" is a count.
 */

// The unit job has no ffmpeg (ci.yml): a produce-driving test skips there.
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

describe.skipIf(!hasFfmpeg)("produce --storyboard, end to end with the mock provider", () => {
  let dir: string;
  let libraryDir: string;
  let schemaNames: string[];
  let prompts: Map<string, string>;
  let lines: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-storyboard-"));
    libraryDir = mkdtempSync(join(tmpdir(), "ossclip-empty-library-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=18",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=18",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    copyFileSync(join(FIXTURES, "fixture.transcript.json"), join(dir, "transcript.json"));
  });
  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    schemaNames = [];
    prompts = new Map();
    const real = MockProvider.prototype.complete;
    vi.spyOn(MockProvider.prototype, "complete").mockImplementation(function (this: MockProvider, req) {
      schemaNames.push(req.schemaName);
      prompts.set(req.schemaName, req.user);
      return real.call(this, req);
    } as typeof real);
  });

  // What program.ts hands produce for `--storyboard --no-open-editor`:
  // `produce` implied, `render` off (storyboardFlag).
  const run = (workdir: string, extra: Partial<ProduceOptions> = {}) =>
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
      ...extra,
    });

  const workdirOf = (root: string): string =>
    existsSync(join(root, "production.json")) ? root : join(root, readdirSync(root)[0]!);

  it("plans the table, writes no scenes and no video, records --storyboard, and reports the plan", async () => {
    const root = join(dir, "wd-storyboard");
    setReplayArgv(["produce", "take.mp4", "--storyboard", "--no-open-editor"]);
    await run(root, { storyboard: true, intent: "show what the tool does" });
    const work = workdirOf(root);

    const sb = JSON.parse(readFileSync(join(work, STORYBOARD_FILE), "utf8"));
    expect(sb.version).toBe(1);
    expect(sb.intent).toBe("show what the tool does");
    expect(sb.shots.length).toBeGreaterThan(0);
    expect(sb.shots[0]).toMatchObject({ id: "s1", kept: true, origin: "planner", touched: false });

    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    // An empty scene list is left out of production.json, as on any run without scenes.
    expect(production.scenes).toBeUndefined();
    expect(readdirSync(work).some((f) => f.endsWith(".mp4") && f !== "take.mp4")).toBe(false);
    expect(existsSync(join(dir, "take.ossclip.mp4"))).toBe(false);

    // One planner call; no beat sheet, script plan, scene props or logo finder.
    expect(schemaNames.filter((n) => n === "storyboard_plan")).toHaveLength(1);
    for (const n of ["beat_sheet", "clip_beat_sheet", "script_plan", "logo_flags"]) expect(schemaNames).not.toContain(n);
    expect(schemaNames.some((n) => n.endsWith("_props"))).toBe(false);
    const files = readdirSync(work);
    expect(files.some((f) => f.startsWith("beatsheet-") || f.startsWith("scenes-") || f.startsWith("scriptplan-"))).toBe(false);
    expect(files.filter((f) => f.startsWith("storyboardplan-"))).toHaveLength(1);

    const command = JSON.parse(readFileSync(join(work, "command.json"), "utf8"));
    expect(command.args).toContain("--storyboard");
    // The explainer look, resolved with neither --look nor a config look, is pinned like any look.
    expect(command.args.slice(command.args.indexOf("--look"), command.args.indexOf("--look") + 2)).toEqual(["--look", "explainer"]);

    expect(lines).toContain(`▸ storyboard: ${sb.shots.length} shots planned (0 changed by limits)`);
    const report = readFileSync(join(work, "report.txt"), "utf8");
    expect(report).toContain("\nstoryboard plan:\n");
    expect(report).toMatch(/\n {2}s1 {2}\d+\.\d–\d+\.\d s {2}p1 {2}mock shot 1\n/);
    expect(report).toContain("logo finder: skipped (a storyboard run plans no overlays)");
  }, 120_000);

  it("a second run after the author's edit loads the table byte for byte and makes no plan call (Review Focus 2)", async () => {
    const root = join(dir, "wd-again");
    await run(root, { storyboard: true });
    const work = workdirOf(root);
    const path = join(work, STORYBOARD_FILE);
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.shots[0].idea = "the author's own idea: a bear juggles three clocks";
    edited.shots[0].touched = true;
    writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`);
    const bytes = readFileSync(path);

    schemaNames = [];
    lines = [];
    await run(root, { storyboard: true, intent: "a different intent" });
    expect(readFileSync(path)).toEqual(bytes);
    expect(schemaNames).not.toContain("storyboard_plan");
    const usage = JSON.parse(readFileSync(join(work, "usage.json"), "utf8"));
    const lastRun = usage.runs[usage.runs.length - 1];
    expect(lastRun.records.some((r: { schemaName: string }) => r.schemaName === "storyboard_plan")).toBe(false);
    expect(lines).toContain(`▸ storyboard: loaded ${edited.shots.length} shots (not planned again)`);
    expect(readFileSync(join(work, "report.txt"), "utf8")).toContain("the author's own idea: a bear juggles three clocks");
  }, 120_000);

  it("matches no library overlay, though the library names a spoken word (§168)", async () => {
    // The author's own report: a "Google" entry popped a logo over a drawn
    // shot on every storyboard run. The same library on a plain run places it.
    const lib = mkdtempSync(join(tmpdir(), "ossclip-library-"));
    // 1x1 transparent PNG.
    writeFileSync(
      join(lib, "today.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==", "base64"),
    );
    writeFileSync(
      join(lib, "library.json"),
      JSON.stringify({ entries: [{ id: "today", file: "today.png", names: ["today"], kind: "logo" }] }),
    );
    try {
      const plain = join(dir, "wd-overlay-plain");
      await run(plain, { libraryDir: lib, produce: false });
      expect(lines.some((l) => l.startsWith("▸ overlays: 1 placed"))).toBe(true);

      lines = [];
      const root = join(dir, "wd-overlay-storyboard");
      await run(root, { storyboard: true, libraryDir: lib });
      expect(lines.some((l) => l.startsWith("▸ overlays:"))).toBe(false);
      const production = JSON.parse(readFileSync(join(workdirOf(root), "production.json"), "utf8"));
      expect(production.overlays?.placements ?? []).toEqual([]);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  }, 120_000);

  it("stops on a storyboard.json that fails its schema, naming the file, and leaves it unchanged (Review Focus 4)", async () => {
    const root = join(dir, "wd-broken");
    await run(root, { storyboard: true });
    const work = workdirOf(root);
    const path = join(work, STORYBOARD_FILE);
    const broken = JSON.parse(readFileSync(path, "utf8"));
    broken.shots[0].priority = 9;
    writeFileSync(path, JSON.stringify(broken));
    const bytes = readFileSync(path);

    const err = await run(root, { storyboard: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoryboardFileError);
    expect((err as Error).message.startsWith(`${path}: shots.0.priority:`)).toBe(true);
    expect(readFileSync(path)).toEqual(bytes);
  }, 120_000);

  it("refuses each conflict before any work, naming the flags", async () => {
    const root = join(dir, "wd-conflicts");
    await expect(run(root, { storyboard: true, script: join(dir, "x.md") })).rejects.toThrow(
      "--storyboard and --script cannot be combined: each one is the whole plan.",
    );
    await expect(run(root, { storyboard: true, scenes: join(dir, "s.json") })).rejects.toThrow(
      "--storyboard and --scenes cannot be combined: each one is the whole plan.",
    );
    await expect(run(root, { storyboard: true, clip: 30 })).rejects.toThrow(
      "--storyboard and --clip cannot be combined: a storyboard plans the whole take.",
    );
    await expect(run(root, { assets: dir })).rejects.toThrow(
      "--assets only means something with --storyboard: they are the images its shots may use.",
    );
    await expect(run(root, { storyboard: true, assets: join(dir, "no-such-folder") })).rejects.toThrow(
      `--assets ${join(dir, "no-such-folder")} is not a folder`,
    );
    // Thrown before the workdir is made: nothing was hashed or transcribed.
    expect(existsSync(root)).toBe(false);
    expect(schemaNames).toEqual([]);
  });

  it("stores the --assets folder and lists its images to the planner without staging them", async () => {
    const assets = join(dir, "assets");
    mkdirSync(assets, { recursive: true });
    // A real 4x2 PNG, so the run's own ffprobe reads its size.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=4x2:d=1", "-frames:v", "1", "-y", join(assets, "logo.png")]);
    writeFileSync(join(assets, "assets.md"), "logo.png: the channel logo\n");
    const root = join(dir, "wd-assets");
    await run(root, { storyboard: true, assets });
    const work = workdirOf(root);
    expect(JSON.parse(readFileSync(join(work, STORYBOARD_FILE), "utf8")).assetsDir).toBe(assets);
    expect(prompts.get("storyboard_plan")).toContain("- logo.png: 4 x 2 px, the channel logo");
    expect(existsSync(join(work, "storyboard-assets"))).toBe(false);
  }, 120_000);

  /**
   * Approved shots become clip scenes (plan B2a Task 3; §169; storyboard
   * design §1 "Later runs", §8, §9). The approval is written onto the table by
   * hand, as Approve will write it: the draw and the render are Task 2's and
   * are not what is under test here; what produce does with the record is.
   */
  describe("approved shots", () => {
    const CLIP_SRC = "clips/0123456789ab.webm";
    const CLIP_SEC = 2.5;
    let webm: string;

    beforeAll(() => {
      webm = join(dir, "approved-clip.webm");
      execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", `color=c=red:s=64x64:rate=30:duration=${CLIP_SEC}`,
        "-c:v", "libvpx", "-b:v", "50k", "-y", webm,
      ]);
    });

    type Shot = { id: string; startWord: number; endWord: number; kept: boolean; approval?: unknown };
    const readTable = (work: string) => JSON.parse(readFileSync(join(work, STORYBOARD_FILE), "utf8")) as { shots: Shot[] };
    const writeTable = (work: string, sb: unknown) => writeFileSync(join(work, STORYBOARD_FILE), `${JSON.stringify(sb, null, 2)}\n`);
    const production = (work: string) => JSON.parse(readFileSync(join(work, "production.json"), "utf8"));

    /** A planned table in a fresh workdir, with s1 approved the way Approve records it. */
    const approvedProject = async (name: string): Promise<{ root: string; work: string; s1: Shot }> => {
      const root = join(dir, name);
      await run(root, { storyboard: true });
      const work = workdirOf(root);
      mkdirSync(join(work, "clips"), { recursive: true });
      copyFileSync(webm, join(work, CLIP_SRC));
      mkdirSync(join(work, "storyboard", "s1"), { recursive: true });
      // `clip` only has to name a file that exists: nothing in produce reads it.
      copyFileSync(webm, join(work, "storyboard", "s1", "approved.mov"));
      const sb = readTable(work);
      const s1 = sb.shots.find((s) => s.id === "s1")!;
      s1.approval = { version: 1, durationSec: CLIP_SEC, clipKey: "k1", clip: "storyboard/s1/approved.mov", src: CLIP_SRC };
      writeTable(work, sb);
      return { root, work, s1 };
    };

    const record = (s1: Shot) => ({
      shots: [{ id: "s1", startWord: s1.startWord, endWord: s1.endWord, clip: "storyboard/s1/approved.mov", src: CLIP_SRC, durationSec: CLIP_SEC }],
    });

    it("a --storyboard run places the approved shot as a ClipScene, records it, and makes no plan call", async () => {
      const { root, work, s1 } = await approvedProject("wd-approved");
      schemaNames = [];
      await run(root, { storyboard: true });

      const p = production(work);
      expect(p.scenes).toHaveLength(1);
      expect(p.scenes[0]).toMatchObject({
        id: "shot-s1",
        component: "ClipScene",
        anchor: { startWord: s1.startWord, endWord: s1.endWord },
        props: { src: CLIP_SRC, durationSec: CLIP_SEC, muted: true },
      });
      expect(p.storyboard).toEqual(record(s1));
      expect(schemaNames).not.toContain("storyboard_plan");
      for (const n of ["beat_sheet", "script_plan"]) expect(schemaNames).not.toContain(n);
      expect(schemaNames.some((n) => n.endsWith("_props"))).toBe(false);

      // Through the one assembly every scene list goes through (design §8): it
      // starts at the shot's first kept word and lasts the clip's own length.
      const cutlist = new TimeMap(p.cutlist);
      const firstKept = p.transcript.words
        .slice(s1.startWord, s1.endWord + 1)
        .map((w: { start: number; end: number; text: string }) => cutlist.mapWord(w))
        .find((m: unknown) => m !== null) as { start: number };
      const props = JSON.parse(readFileSync(join(work, "render-props.json"), "utf8"));
      const cue = props.sceneCues.find((c: { id: string }) => c.id === "shot-s1");
      expect(cue).toBeDefined();
      expect(cue.startSec).toBeCloseTo(firstKept.start, 6);
      expect(cue.endSec - cue.startSec).toBeCloseTo(CLIP_SEC, 6);
    }, 240_000);

    it("a pinned replay (the editor's Render) carries the storyboard record forward; a plain run drops it", async () => {
      const { root, work, s1 } = await approvedProject("wd-approved-replay");
      await run(root, { storyboard: true });
      const reviewed = join(work, REVIEWED_SCENES_BASENAME);
      writeFileSync(reviewed, reviewedScenesText(readFileSync(join(work, "production.json"), "utf8"))!);

      schemaNames = [];
      await run(root, { scenes: reviewed, produce: false });
      const p = production(work);
      expect(p.storyboard).toEqual(record(s1));
      expect(p.scenes.map((s: { id: string }) => s.id)).toEqual(["shot-s1"]);
      expect(schemaNames).not.toContain("storyboard_plan");

      // Design §1 "Later runs": a plain --produce plans from nothing and the
      // record is not written; storyboard.json stays on disk.
      await run(root);
      const plain = production(work);
      expect(plain.storyboard).toBeUndefined();
      expect(plain.scenes.some((s: { id: string }) => s.id === "shot-s1")).toBe(false);
      expect(existsSync(join(work, STORYBOARD_FILE))).toBe(true);
    }, 360_000);

    it("a dropped shot leaves the video and the record at the next --storyboard run", async () => {
      const { root, work } = await approvedProject("wd-approved-dropped");
      const sb = readTable(work);
      sb.shots.find((s) => s.id === "s1")!.kept = false;
      writeTable(work, sb);
      await run(root, { storyboard: true });
      const p = production(work);
      expect(p.scenes).toBeUndefined();
      expect(p.storyboard).toBeUndefined();
    }, 240_000);

    it("Review Focus 1: approved, then every word of the shot cut: the scene leaves the video and nothing throws", async () => {
      const { root, work, s1 } = await approvedProject("wd-approved-cut");
      const words = production(work).transcript.words as { start: number; end: number }[];
      const from = words[s1.startWord]!.start;
      const to = words[s1.endWord]!.end;
      // The editor's cut shape: source-anchored, so no prior frame is needed.
      writeFileSync(
        join(work, "overrides.json"),
        JSON.stringify({ cuts: [{ startSec: 0, endSec: 0, src: { startSec: from, endSec: to } }] }),
      );
      lines = [];
      await run(root, { storyboard: true });
      // Assembly drops it, the existing rule for any scene (design §8), so it
      // is not in the video: no cue in render-props.json, the drop named.
      expect(lines).toContain("  ⚠ scene shot-s1 dropped: anchor words were entirely cut");
      const props = JSON.parse(readFileSync(join(work, "render-props.json"), "utf8"));
      expect(props.sceneCues.some((c: { id: string }) => c.id === "shot-s1")).toBe(false);
      // production.json's `scenes` is the PLAN, word-anchored, as on every
      // run: a scene whose words are cut stays planned, so restoring the cut
      // brings the shot back. Likewise the approval is the author's work and
      // stays (design §8, "All the shot's words are cut": the storyboard
      // keeps its work), so the record still names the shot.
      const p = production(work);
      expect(p.scenes.map((s: { id: string }) => s.id)).toEqual(["shot-s1"]);
      expect(p.storyboard).toEqual(record(s1));
    }, 240_000);

    it("an editor-added graphic over the approved shot's words: the sync run keeps both (editor-added-graphics §2)", async () => {
      // A storyboard run plans no template graphics, so an added one is the
      // only way a title card reaches the video. Approving a shot over the
      // same words later must not lose either: assembly pushes one past the
      // other, as it does any two scenes (AG1).
      const { root, work, s1 } = await approvedProject("wd-approved-added");
      const words = production(work).transcript.words as { start: number; end: number }[];
      writeFileSync(
        join(work, "overrides.json"),
        JSON.stringify({
          addedScenes: [
            {
              id: "added-1",
              component: "TitleCard",
              props: { title: "Over the shot" },
              srcStart: words[s1.startWord]!.start,
              srcEnd: words[s1.endWord]!.end,
            },
          ],
        }),
      );
      lines = [];
      await run(root, { storyboard: true });
      const props = JSON.parse(readFileSync(join(work, "render-props.json"), "utf8"));
      const ids = (props.baseSceneCues as { id: string }[]).map((c) => c.id);
      expect(ids).toContain("shot-s1");
      expect(ids).toContain("added-1");
      expect("addedSceneIssues" in props).toBe(false);
      expect(lines.some((l) => l.includes("dropped"))).toBe(false);
      expect(production(work).scenes.map((s: { id: string }) => s.id)).toEqual(["shot-s1", "added-1"]);
    }, 240_000);

    it("Review Focus 5: an empty pinned plan on a storyboard project with no approval makes no planning call", async () => {
      // What the editor's Render spawns for it (edit.ts /api/render, §169):
      // `--storyboard` stripped, an empty `--scenes` file pinned.
      const root = join(dir, "wd-empty-pin");
      await run(root, { storyboard: true });
      const work = workdirOf(root);
      const pinned = join(work, REVIEWED_SCENES_BASENAME);
      writeFileSync(pinned, "[]\n");
      schemaNames = [];
      lines = [];
      await run(root, { scenes: pinned, produce: false });
      expect(lines).toContain(`▸ scenes injected from ${pinned} (0)`);
      for (const n of ["storyboard_plan", "beat_sheet", "clip_beat_sheet", "script_plan", "logo_flags"]) {
        expect(schemaNames).not.toContain(n);
      }
      expect(schemaNames.some((n) => n.endsWith("_props"))).toBe(false);
      const p = production(work);
      expect(p.scenes).toBeUndefined();
      expect(p.storyboard).toBeUndefined();
    }, 240_000);
  });

  it("a run without --storyboard is as before: no table, the beat sheet's scenes, no storyboard block", async () => {
    const root = join(dir, "wd-plain");
    await run(root);
    const work = workdirOf(root);
    expect(existsSync(join(work, STORYBOARD_FILE))).toBe(false);
    expect(readdirSync(work).some((f) => f.startsWith("storyboardplan-"))).toBe(false);
    expect(schemaNames).toContain("beat_sheet");
    expect(schemaNames).toContain("logo_flags");
    expect(schemaNames).not.toContain("storyboard_plan");
    // The scenes this exact run produced before `--storyboard` existed
    // (captured from the unchanged code, 2026-11-20).
    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    expect(production.scenes.map((s: { component: string; layout: string }) => [s.component, s.layout])).toEqual([
      ["TitleCard", "pip-bubble"],
      ["StatCard", "video-top"],
      ["FlowDiagram", "graphic-only"],
    ]);
    const report = readFileSync(join(work, "report.txt"), "utf8");
    expect(report).not.toContain("storyboard plan:");
    expect(lines.some((l) => l.startsWith("▸ storyboard:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("▸ look:"))).toBe(false);
  }, 120_000);
});
