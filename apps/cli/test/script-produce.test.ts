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
import { MockProvider, SCRIPT_LANDSCAPE_RECT, alignCues, parseScript } from "@ossclip/core";
import { produce } from "../src/produce";
import { setReplayArgv } from "../src/replay-argv";
import { REVIEWED_SCENES_BASENAME, renderReplayArgs, reviewedScenesText } from "../src/render-replay-args";

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

  const run = (
    workdir: string,
    script?: string,
    extra: { aspect?: "9:16" | "16:9"; transcript?: string } = {},
  ) =>
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
      ...extra,
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

  it("a short line's scene is held to the minimum over the words after it, and the report says so (§161)", async () => {
    // "Today I want" is 1.4 s (words 5-7). The words after it ("to show you
    // something cool", 8-12) belong to no cue, "uh" (13) is cut, and the next
    // cue starts on "this" (14): held from 5.27 s, the scene may run to word
    // 12, which ends 3.7 s after the line began.
    const root = join(dir, "wd-min-length");
    const scriptPath = join(dir, "script", "short.script.md");
    writeFileSync(
      scriptPath,
      [
        "🎬 Title card: welcome back",
        "🗣️ Hello everyone, welcome back.",
        "",
        "🎬 [StatCard] One wish",
        "🗣️ Today I want",
        "",
        "🎬 [StatCard] One number: the clean edit",
        "🗣️ This raw take becomes a clean edit automatically.",
        "",
      ].join("\n"),
    );
    await run(root, scriptPath);
    const work = workdirOf(root);
    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    const anchors = (production.scenes as { anchor: { startWord: number; endWord: number } }[]).map((s) => [
      s.anchor.startWord,
      s.anchor.endWord,
    ]);
    // The welcome line cannot grow: the only word before the next cue is the
    // cut "um". The last line is already over four seconds.
    expect(anchors).toEqual([
      [0, 3],
      [5, 12],
      [14, 21],
    ]);
    const outcomes = JSON.parse(readFileSync(join(work, "script-report.json"), "utf8")).outcomes as {
      status: string;
      lengthened?: { fromSec: number; toSec: number };
    }[];
    expect(outcomes.map((o) => o.status)).toEqual(["placed", "placed", "placed"]);
    expect(outcomes[0]!.lengthened).toBeUndefined();
    // Both from the scene's real start (its entry word less the lead): to
    // the line's last word without the minimum, to its end with it. The
    // mock's card enters on "Today", the line's first word, so without the
    // minimum it would have lasted the whole 1.375 s line.
    expect(outcomes[1]!.lengthened!.fromSec).toBeCloseTo(1.375, 3);
    expect(outcomes[1]!.lengthened!.toSec).toBeGreaterThan(3);
    expect(outcomes[2]!.lengthened).toBeUndefined();
    const reportTxt = readFileSync(join(work, "report.txt"), "utf8");
    expect(reportTxt).toMatch(/StatCard at [\d.]+s, held [\d.]+s \([\d.]+s without the minimum\) — "One wish"/);
    expect(reportTxt).toContain("placed 3 of 3 (1 lengthened) · skipped 0 · reported 0");
  }, 120_000);

  it("an editor-added graphic is a cue on a script run and is no cue's outcome (editor-added-graphics §2)", async () => {
    // An added card over "to show you" (8-10), words no cue's line names.
    // The cue report answers for the script's own cues only: the same
    // outcome for each, whatever assembly does to their times.
    const root = join(dir, "wd-script-added");
    const scriptPath = join(dir, "script", "added.script.md");
    writeFileSync(
      scriptPath,
      [
        "🎬 Title card: welcome back",
        "🗣️ Hello everyone, welcome back.",
        "",
        "🎬 [StatCard] One number: the clean edit",
        "🗣️ This raw take becomes a clean edit automatically.",
        "",
      ].join("\n"),
    );
    await run(root, scriptPath);
    const work = workdirOf(root);
    const reportOf = () =>
      (JSON.parse(readFileSync(join(work, "script-report.json"), "utf8")).outcomes as {
        cueId: string;
        status: string;
        component?: string;
      }[]).map((o) => [o.cueId, o.status, o.component]);
    const before = reportOf();
    expect(before.map((o) => o[1])).toEqual(["placed", "placed"]);

    writeFileSync(
      join(work, "overrides.json"),
      JSON.stringify({
        addedScenes: [
          { id: "added-1", component: "TitleCard", props: { title: "Something cool" }, srcStart: 6.7278, srcEnd: 7.8954 },
        ],
      }),
    );
    await run(root, scriptPath);
    const props = JSON.parse(readFileSync(join(work, "render-props.json"), "utf8"));
    expect((props.baseSceneCues as { id: string }[]).some((c) => c.id === "added-1")).toBe(true);
    expect("addedSceneIssues" in props).toBe(false);
    expect(reportOf()).toEqual(before);
  }, 240_000);

  it("16:9 script: an editor-added graphic gets the same layout on the planning run and on the Render replay", async () => {
    // The script placement runs only with --script, which the Render strips;
    // a plan scene keeps its rect through production.json, but an added one
    // is rebuilt from the doc on every run (editor-added-graphics §2). So
    // the placement must leave it alone, or the cue the editor showed after
    // the planning run is not the one Render draws.
    const root = join(dir, "wd-script-added-16x9");
    const scriptPath = join(dir, "script", "added-16x9.script.md");
    writeFileSync(
      scriptPath,
      [
        "🎬 Title card: welcome back",
        "🗣️ Hello everyone, welcome back.",
        "",
        "🎬 [StatCard] One number: the clean edit",
        "🗣️ This raw take becomes a clean edit automatically.",
        "",
      ].join("\n"),
    );
    setReplayArgv(["produce", "take.mp4", "--script", scriptPath, "--aspect", "16:9"]);
    await run(root, scriptPath, { aspect: "16:9" });
    const work = workdirOf(root);
    writeFileSync(
      join(work, "overrides.json"),
      JSON.stringify({
        addedScenes: [
          { id: "added-1", component: "TitleCard", props: { title: "Something cool" }, srcStart: 6.7278, srcEnd: 7.8954 },
        ],
      }),
    );
    type Placed = { id: string; layout: string; graphicRect?: unknown };
    const addedCue = () => {
      const cue = (JSON.parse(readFileSync(join(work, "render-props.json"), "utf8")).baseSceneCues as Placed[]).find(
        (c) => c.id === "added-1",
      );
      return cue ? { layout: cue.layout, graphicRect: cue.graphicRect ?? null } : undefined;
    };
    await run(root, scriptPath, { aspect: "16:9" });
    const planned = addedCue();
    // TitleCard's default `pip-bubble`, through the ordinary landscape remap
    // only — which keeps a backdrop in a script project (§163) — and no rect.
    expect(planned).toEqual({ layout: "pip-bubble", graphicRect: null });

    const scenesPath = join(work, REVIEWED_SCENES_BASENAME);
    writeFileSync(scenesPath, reviewedScenesText(readFileSync(join(work, "production.json"), "utf8"))!);
    const prior = process.env.OSSCLIP_REPLAY_WORKDIR;
    process.env.OSSCLIP_REPLAY_WORKDIR = work;
    try {
      await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        libraryDir,
        render: false,
        mezzanine: false,
        youtube: false,
        confirmRepairs: false,
        transcript: join(dir, "transcript.json"),
        workdir: root,
        provider: "mock",
        aspect: "16:9",
        scenes: scenesPath,
      });
    } finally {
      if (prior === undefined) delete process.env.OSSCLIP_REPLAY_WORKDIR;
      else process.env.OSSCLIP_REPLAY_WORKDIR = prior;
    }
    expect(addedCue()).toEqual(planned);
  }, 360_000);

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

  it("G6, 16:9: without --script no scene gets a graphicRect and the layouts are as before", async () => {
    // The centred script placement (§161) and the variety pass's new skip
    // for planned rects must not reach a run without --script. The layouts
    // are the ones this exact run produced BEFORE that change was written.
    const root = join(dir, "wd-plain-16x9");
    await run(root, undefined, { aspect: "16:9" });
    const work = existsSync(join(root, "production.json")) ? root : workdirOf(root);
    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    const scenes = production.scenes as { component: string; layout: string; graphicRect?: unknown }[];
    expect(scenes.map((s) => [s.component, s.layout])).toEqual([
      ["TitleCard", "split-left"],
      ["StatCard", "lower-third"],
      ["FlowDiagram", "blurred-behind"],
    ]);
    expect(scenes.some((s) => "graphicRect" in s)).toBe(false);
    const props = JSON.parse(readFileSync(join(work, "render-props.json"), "utf8"));
    const cues = props.sceneCues as { kind?: string; component?: string; layout: string; graphicRect?: unknown }[];
    expect(cues.filter((c) => c.kind !== "plain").map((c) => [c.component, c.layout])).toEqual([
      ["TitleCard", "split-left"],
      ["StatCard", "lower-third"],
      ["FlowDiagram", "blurred-behind"],
    ]);
    expect(cues.some((c) => c.graphicRect !== undefined)).toBe(false);
  }, 120_000);

  it("16:9 script: slot components sit centred and full-bleed, the clip keeps the frame, an editor rect wins (§161)", async () => {
    const root = join(dir, "wd-script-16x9");
    const scriptPath = join(dir, "script", "fixture.script.md");
    await run(root, scriptPath, { aspect: "16:9" });
    const work = workdirOf(root);
    type Placed = { id: string; component?: string; kind?: string; layout: string; graphicRect?: unknown };
    const placement = (list: Placed[]) =>
      list.filter((c) => c.kind !== "plain").map((c) => [c.id, c.component, c.layout, c.graphicRect ?? null]);
    const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
    // TitleCard and StatCard are consecutive graphics once the clip is passed
    // over: the variety pass would have cycled the StatCard off full-bleed.
    expect(placement(production.scenes)).toEqual([
      ["scene-0", "TitleCard", "full-bleed", SCRIPT_LANDSCAPE_RECT],
      ["scene-2", "StatCard", "full-bleed", SCRIPT_LANDSCAPE_RECT],
      ["scene-1", "ClipScene", "full-bleed", null],
    ]);
    const readCues = () =>
      placement(JSON.parse(readFileSync(join(work, "render-props.json"), "utf8")).sceneCues as Placed[]);
    expect(readCues()).toEqual([
      ["scene-0", "TitleCard", "full-bleed", SCRIPT_LANDSCAPE_RECT],
      ["scene-1", "ClipScene", "full-bleed", null],
      ["scene-2", "StatCard", "full-bleed", SCRIPT_LANDSCAPE_RECT],
    ]);

    // The planned rect is a default, not a pin: the editor's drag is written
    // to overrides.json and wins on the next run.
    const hand = { x: 0.3, y: 0.2, w: 0.4, h: 0.4 };
    writeFileSync(join(work, "overrides.json"), JSON.stringify({ scenes: { "scene-0": { graphicRect: hand } } }));
    await run(root, scriptPath, { aspect: "16:9" });
    expect(readCues()).toEqual([
      ["scene-0", "TitleCard", "full-bleed", hand],
      ["scene-1", "ClipScene", "full-bleed", null],
      ["scene-2", "StatCard", "full-bleed", SCRIPT_LANDSCAPE_RECT],
    ]);
  }, 240_000);

  it("the planner's layout is ignored in a 16:9 script project and used in 9:16 (backdrop design §1)", async () => {
    // A real planner may set `layout`; the mock never does, so its reply gets
    // one here. On a full-frame card, `graphic-only` came out of the 16:9
    // remap as `blurred-behind`: the speaker blurred and dimmed under it.
    const scriptPath = join(dir, "script", "layout.script.md");
    writeFileSync(
      scriptPath,
      [
        "🎬 [CardRow] the three steps",
        "🗣️ Hello everyone, welcome back.",
        "",
        "🎬 [StatCard] One number: the clean edit",
        "🗣️ This raw take becomes a clean edit automatically.",
        "",
      ].join("\n"),
    );
    const spied = vi.mocked(MockProvider.prototype.complete);
    const passThrough = spied.getMockImplementation()!;
    spied.mockImplementation(async function (this: MockProvider, req) {
      const out = await passThrough.call(this, req);
      if (req.schemaName !== "script_plan") return out;
      const reply = out as { cues: Array<{ sceneKind: string }> };
      return req.schema.parse({
        cues: reply.cues.map((c) => (c.sceneKind === "CardRow" ? { ...c, layout: "graphic-only" } : c)),
      });
    } as typeof passThrough);
    const layouts = (root: string) => {
      const work = workdirOf(root);
      const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
      return (production.scenes as { component: string; layout: string }[]).map((s) => [s.component, s.layout]);
    };

    const landscape = join(dir, "wd-planner-layout-16x9");
    await run(landscape, scriptPath, { aspect: "16:9" });
    expect(layouts(landscape)).toEqual([
      ["CardRow", "full-bleed"],
      ["StatCard", "full-bleed"],
    ]);

    // 9:16 keeps using it, exactly as before this change.
    const portrait = join(dir, "wd-planner-layout-9x16");
    await run(portrait, scriptPath, { aspect: "9:16" });
    expect(layouts(portrait)).toEqual([
      ["CardRow", "graphic-only"],
      ["StatCard", "video-top"],
    ]);
  }, 240_000);

  it("a stored backdrop survives the editor's Render, which replays without --script (Review Focus 1)", async () => {
    // The editor's own layout change lives in overrides.json, which is applied
    // AFTER both landscape remaps (produce.ts), so it already survived. What
    // the remap rewrote is a PLANNED scene's layout: the Render pins
    // production.json's scenes as scenes-reviewed.json, and the first remap
    // turned `graphic-only` into `blurred-behind` and `pip-bubble` into
    // `split-left` on the way back in. The replay has no --script; the
    // project is a script project through its stored record alone.
    const root = join(dir, "wd-backdrop-replay");
    const scriptPath = join(dir, "script", "fixture.script.md");
    setReplayArgv(["produce", "take.mp4", "--script", scriptPath, "--aspect", "16:9"]);
    await run(root, scriptPath, { aspect: "16:9" });
    const work = workdirOf(root);
    const productionPath = join(work, "production.json");
    const productionText = readFileSync(productionPath, "utf8");

    const reviewed = JSON.parse(reviewedScenesText(productionText)!) as { id: string; layout: string }[];
    for (const s of reviewed) {
      if (s.id === "scene-0") s.layout = "graphic-only";
      if (s.id === "scene-2") s.layout = "pip-bubble";
    }
    const scenesPath = join(work, REVIEWED_SCENES_BASENAME);
    writeFileSync(scenesPath, JSON.stringify(reviewed, null, 2));
    // The argv the Render spawns: --script gone, the reviewed plan pinned.
    const recorded = JSON.parse(readFileSync(join(work, "command.json"), "utf8")).args as string[];
    const replayArgs = renderReplayArgs(recorded, { scenesPath });
    expect(replayArgs).not.toContain("--script");
    expect(replayArgs.slice(-2)).toEqual(["--scenes", scenesPath]);

    const replay = async () => {
      const prior = process.env.OSSCLIP_REPLAY_WORKDIR;
      process.env.OSSCLIP_REPLAY_WORKDIR = work;
      try {
        await produce(join(dir, "take.mp4"), {
          cleanup: "standard",
          libraryDir,
          render: false,
          mezzanine: false,
          youtube: false,
          confirmRepairs: false,
          transcript: join(dir, "transcript.json"),
          workdir: root,
          provider: "mock",
          aspect: "16:9",
          scenes: scenesPath,
        });
      } finally {
        if (prior === undefined) delete process.env.OSSCLIP_REPLAY_WORKDIR;
        else process.env.OSSCLIP_REPLAY_WORKDIR = prior;
      }
    };
    const cueLayouts = () =>
      (JSON.parse(readFileSync(join(work, "render-props.json"), "utf8")).sceneCues as {
        id: string;
        kind?: string;
        layout: string;
      }[])
        .filter((c) => c.kind !== "plain")
        .map((c) => [c.id, c.layout]);

    await replay();
    expect(cueLayouts()).toEqual([
      ["scene-0", "graphic-only"],
      ["scene-1", "full-bleed"],
      ["scene-2", "pip-bubble"],
    ]);
    // The record rode forward, so the next Render is a script project too.
    expect(JSON.parse(readFileSync(productionPath, "utf8")).script).toBeDefined();

    // The same replay of a project with NO stored script is remapped as
    // before (G6): the rule is keyed on the record, not on anything else.
    const production = JSON.parse(readFileSync(productionPath, "utf8"));
    delete production.script;
    writeFileSync(productionPath, JSON.stringify(production, null, 2));
    await replay();
    expect(cueLayouts()).toEqual([
      ["scene-0", "blurred-behind"],
      ["scene-1", "full-bleed"],
      ["scene-2", "split-left"],
    ]);
  }, 360_000);

  describe("a script sentence said twice back to back (script retakes, §166)", () => {
    // The fixture transcript has no punctuation and says nothing twice; this
    // one says the StatCard line twice, the first take short of its last word
    // (the EGM shape, design Overview), and stays inside the 18 s take. No
    // --blooper-marker: the similarity detector never runs (§128's gate), so
    // a retake cut here can only be the script pass's (design Decision 1).
    const said = [
      "Hello everyone, welcome back.",
      "This raw take becomes a clean edit.",
      "This raw take becomes a clean edit automatically.",
      "Thanks for watching.",
    ]
      .join(" ")
      .split(" ");
    const earlier = { first: 4, last: 10 }; // "This … edit." (the first take)
    const later = { first: 11, last: 18 }; // "This … automatically."
    const at = (i: number) => ({ start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.4 });
    let transcriptPath: string;
    let scriptPath: string;

    beforeAll(() => {
      transcriptPath = join(dir, "retake.transcript.json");
      writeFileSync(
        transcriptPath,
        JSON.stringify({ language: "en", words: said.map((text, i) => ({ text, ...at(i) })) }),
      );
      scriptPath = join(dir, "script", "retake.script.md");
      writeFileSync(
        scriptPath,
        [
          "🎬 Title card: welcome back",
          "🗣️ Hello everyone, welcome back.",
          "",
          "🎬 [StatCard] One number: the clean edit",
          "🗣️ This raw take becomes a clean edit automatically.",
          "",
        ].join("\n"),
      );
    });

    type Seg = { srcIn: number; srcOut: number; kind: string; reason?: string };
    const coversEarlierTake = (cutlist: Seg[]) =>
      cutlist.some(
        (s) =>
          s.kind === "remove" &&
          s.reason === "retake" &&
          s.srcIn <= at(earlier.first).start + 1e-6 &&
          s.srcOut >= at(earlier.last).end - 1e-6 &&
          // Never into the kept take (design section 5).
          s.srcOut <= at(later.first).start + 1e-6,
      );

    it("a --script run cuts the earlier take, records the pass, and reports it", async () => {
      const root = join(dir, "wd-script-retake");
      await run(root, scriptPath, { transcript: transcriptPath });
      const work = workdirOf(root);
      const production = JSON.parse(readFileSync(join(work, "production.json"), "utf8"));
      expect(coversEarlierTake(production.cutlist)).toBe(true);
      expect(production.script.retakePass).toBe(1);
      const reportTxt = readFileSync(join(work, "report.txt"), "utf8");
      expect(reportTxt).toContain("retakes found with the script (FINDINGS §166):");
      expect(reportTxt).toContain(
        'kept: "This raw take becomes a clean edit automatically."\n' +
          '  cut (said again 0 words later; script: "This raw take becomes a clean edit automatically."): ' +
          '"This raw take becomes a clean edit."',
      );
    }, 120_000);

    it("the editor's Render (--scenes, no --script) builds the same cutlist; a pre-pass record cuts as before (G6)", async () => {
      const root = join(dir, "wd-script-retake-replay");
      await run(root, scriptPath, { transcript: transcriptPath });
      const work = workdirOf(root);
      const productionPath = join(work, "production.json");
      const first = JSON.parse(readFileSync(productionPath, "utf8"));
      expect(coversEarlierTake(first.cutlist)).toBe(true);
      const scenesPath = join(work, REVIEWED_SCENES_BASENAME);
      writeFileSync(scenesPath, reviewedScenesText(readFileSync(productionPath, "utf8"))!);

      const replay = async () => {
        const prior = process.env.OSSCLIP_REPLAY_WORKDIR;
        process.env.OSSCLIP_REPLAY_WORKDIR = work;
        try {
          await produce(join(dir, "take.mp4"), {
            cleanup: "standard",
            libraryDir,
            render: false,
            mezzanine: false,
            youtube: false,
            confirmRepairs: false,
            transcript: transcriptPath,
            workdir: root,
            provider: "mock",
            scenes: scenesPath,
          });
        } finally {
          if (prior === undefined) delete process.env.OSSCLIP_REPLAY_WORKDIR;
          else process.env.OSSCLIP_REPLAY_WORKDIR = prior;
        }
      };

      await replay();
      const replayed = JSON.parse(readFileSync(productionPath, "utf8"));
      expect(replayed.cutlist).toEqual(first.cutlist);
      // Carried forward, so the NEXT Render repeats the pass too.
      expect(replayed.script.retakePass).toBe(1);

      // A project planned before the pass has no field: its replays must not
      // gain cuts under scenes that were reviewed without them (design §1).
      delete replayed.script.retakePass;
      writeFileSync(productionPath, JSON.stringify(replayed, null, 2));
      await replay();
      const legacy = JSON.parse(readFileSync(productionPath, "utf8"));
      expect(coversEarlierTake(legacy.cutlist)).toBe(false);
      expect(legacy.cutlist.some((s: Seg) => s.reason === "retake")).toBe(false);
      expect("retakePass" in legacy.script).toBe(false);
      expect(readFileSync(join(work, "report.txt"), "utf8")).not.toContain("retakes found with the script");
    }, 240_000);
  });

  it("a missing script file fails before any work, naming the path", async () => {
    await expect(run(join(dir, "wd-missing"), join(dir, "nope.md"))).rejects.toThrow(
      `script file not found: ${join(dir, "nope.md")}`,
    );
    expect(vi.mocked(alignCues)).not.toHaveBeenCalled();
  });
});
