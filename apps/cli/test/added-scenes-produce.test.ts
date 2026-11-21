import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produce, type ProduceOptions } from "../src/produce";
import { REVIEWED_SCENES_BASENAME, reviewedScenesText } from "../src/render-replay-args";

/**
 * Editor-added graphics through the real `produce` (editor-added-graphics
 * §2, plan Task 4): the entries in `overrides.json` become scenes on every
 * run kind, the doc is their only source, and a bad one is reported rather
 * than failing the run. The storyboard-produce harness: the fixture's
 * transcript, a synthetic take, the mock provider, never rendered. The
 * script, storyboard and `--clip` cases sit with their own harnesses
 * (script-produce, storyboard-produce, replay-keeps-repairs).
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

// fixture.transcript.json: "today" (5) starts at 5.2727 s, "to" (8) ends at
// 7.012 s — the span the editor would store for a selection of words 5-8.
const TITLE = {
  id: "added-1",
  component: "TitleCard",
  props: { title: "Today's demo" },
  srcStart: 5.2727,
  srcEnd: 7.012,
};
// The mock plan leaves no gap a floored cue fits in (its StatCard, scene-2,
// starts on word 8), and the add gesture refuses an overlap (AG2): the doc
// that carries TITLE hides scene-2, as an author would to make room. Without
// the hide, the run drops TITLE as covered (the drift test below).
const ROOM = { "scene-2": { hidden: true } };
// A component this build does not know: the entry must not fail the run (AG3).
const UNKNOWN = { id: "added-2", component: "Nope", props: {}, srcStart: 11.2811, srcEnd: 12.088 };

type Cue = {
  id: string;
  kind?: string;
  component?: string;
  layout: string;
  props?: Record<string, unknown>;
  startSec: number;
  endSec: number;
};
type Scene = { id: string; component: string; layout: string; anchor: { startWord: number; endWord: number } };

describe.skipIf(!hasFfmpeg)("produce: editor-added graphics from overrides.json", () => {
  let dir: string;
  let libraryDir: string;
  let lines: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-added-"));
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
  });

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
  const production = (work: string) =>
    JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as { scenes?: Scene[] };
  const renderProps = (work: string) =>
    JSON.parse(readFileSync(join(work, "render-props.json"), "utf8")) as {
      sceneCues: Cue[];
      baseSceneCues: Cue[];
      addedSceneIssues?: { id: string; reason: string }[];
    };
  const writeDoc = (work: string, doc: unknown) => writeFileSync(join(work, "overrides.json"), JSON.stringify(doc));
  const addedIds = (list: readonly { id: string }[]) => list.map((c) => c.id).filter((id) => id.startsWith("added-"));
  /** The editor's Render (edit.ts /api/render): production.json's scenes pinned as `--scenes`. */
  const replay = async (root: string, work: string) => {
    const reviewed = join(work, REVIEWED_SCENES_BASENAME);
    writeFileSync(reviewed, reviewedScenesText(readFileSync(join(work, "production.json"), "utf8")) ?? "[]\n");
    await run(root, { scenes: reviewed, produce: false });
  };

  it("an entry becomes a cue on a planner run and on the Render replay, once; gone from the doc, gone from the video", async () => {
    const root = join(dir, "wd-planner");
    await run(root);
    const work = workdirOf(root);
    // No `addedScenes` in the doc: no key in render-props (absent-means-none).
    expect("addedSceneIssues" in renderProps(work)).toBe(false);

    writeDoc(work, { scenes: ROOM, addedScenes: [TITLE, UNKNOWN] });
    lines = [];
    await run(root);
    let props = renderProps(work);
    // The invariant (§2): a base cue for every entry not in the issues.
    expect(addedIds(props.baseSceneCues)).toEqual(["added-1"]);
    expect(addedIds(props.sceneCues)).toEqual(["added-1"]);
    const cue = props.sceneCues.find((c) => c.id === "added-1")!;
    expect(cue.component).toBe("TitleCard");
    expect(cue.props?.title).toBe("Today's demo");
    expect(props.addedSceneIssues).toEqual([{ id: "added-2", reason: "graphic type Nope no longer exists" }]);
    expect(lines).toContain("  ⚠ added graphic added-2 not shown: graphic type Nope no longer exists");
    // Anchored on the run's own transcript: words 5-8, whose source starts lie in the span.
    const planned = production(work).scenes!.filter((s) => s.id.startsWith("added-"));
    expect(planned).toEqual([expect.objectContaining({ id: "added-1", anchor: { startWord: 5, endWord: 8 } })]);
    // Produce's own doc write keeps the entries (AG1).
    expect(JSON.parse(readFileSync(join(work, "overrides.json"), "utf8")).addedScenes).toHaveLength(2);

    // The Render pins production.json's scenes, added-1 among them: the doc's
    // entry replaces it rather than doubling it.
    await replay(root, work);
    props = renderProps(work);
    expect(addedIds(props.baseSceneCues)).toEqual(["added-1"]);
    expect(addedIds(production(work).scenes!)).toEqual(["added-1"]);

    // Removed from the doc (undo, Delete): the pinned file still names
    // added-1, and the next Render must not bring it back.
    const reviewedWithAdd = readFileSync(join(work, REVIEWED_SCENES_BASENAME), "utf8");
    expect(reviewedWithAdd).toContain('"added-1"');
    writeDoc(work, {});
    await run(root, { scenes: join(work, REVIEWED_SCENES_BASENAME), produce: false });
    props = renderProps(work);
    expect(addedIds(props.baseSceneCues)).toEqual([]);
    expect(addedIds(props.sceneCues)).toEqual([]);
    expect("addedSceneIssues" in props).toBe(false);
    expect(addedIds(production(work).scenes ?? [])).toEqual([]);
  }, 360_000);

  it("an entry whose every word is cut is reported with assembly's reason, and the run succeeds", async () => {
    const root = join(dir, "wd-cut");
    await run(root);
    const work = workdirOf(root);
    // "this raw take" (14-16), cut the way the editor writes a cut.
    const span = { startSec: 11.2811, endSec: 12.5023 };
    writeDoc(work, {
      cuts: [{ startSec: 0, endSec: 0, src: span }],
      addedScenes: [{ id: "added-1", component: "TitleCard", props: { title: "Raw take" }, srcStart: span.startSec, srcEnd: span.endSec }],
    });
    lines = [];
    await run(root);
    const props = renderProps(work);
    expect(addedIds(props.sceneCues)).toEqual([]);
    expect(props.addedSceneIssues).toEqual([{ id: "added-1", reason: "anchor words were entirely cut" }]);
    expect(lines).toContain("  ⚠ added graphic added-1 not shown: anchor words were entirely cut");
  }, 240_000);

  it("16:9: the variety pass leaves the plan's layouts as they were and the added graphic's own", async () => {
    // A FlowDiagram's default `graphic-only` becomes `blurred-behind` in the
    // landscape remap — the layout of the plan's last graphic, so a variety
    // pass that counted it would cycle it away from what the editor previewed
    // (§2 step 4).
    const root = join(dir, "wd-variety");
    await run(root, { aspect: "16:9" });
    const work = workdirOf(root);
    const layouts = () =>
      production(work)
        .scenes!.filter((s) => !s.id.startsWith("added-"))
        .map((s) => [s.id, s.layout]);
    const without = layouts();
    expect(without.length).toBeGreaterThan(0);

    writeDoc(work, {
      addedScenes: [
        { id: "added-1", component: "FlowDiagram", props: { nodes: ["raw", "clean"] }, srcStart: 5.2727, srcEnd: 7.012 },
      ],
    });
    await run(root, { aspect: "16:9" });
    expect(layouts()).toEqual(without);
    expect(production(work).scenes!.find((s) => s.id === "added-1")!.layout).toBe("blurred-behind");
  }, 240_000);

  // The mock plan on this fixture: scene-2 is a StatCard on words 8-11
  // ("to show you something", output 6.31-8.91 s). Words 8-10 run from
  // "to" (6.7278) to the end of "you" (7.57 + 0.3254).
  const OVER_SCENE_2 = { srcStart: 6.7278, srcEnd: 7.8954 };

  it("over a HIDDEN plan scene's words: the added graphic sits on its own words, not pushed past the hidden one (fix-wave I1)", async () => {
    const root = join(dir, "wd-hidden");
    await run(root);
    const work = workdirOf(root);
    const before = renderProps(work).sceneCues.find((c) => c.id === "scene-2")!;
    expect(before.component).toBe("StatCard");

    // What the editor allowed: scene-2 is hidden, so the add check (live
    // cues, hidden dropped) saw free words.
    writeDoc(work, {
      scenes: { "scene-2": { hidden: true } },
      addedScenes: [{ id: "added-1", component: "TitleCard", props: { title: "Shown here" }, ...OVER_SCENE_2 }],
    });
    lines = [];
    await run(root);
    const props = renderProps(work);
    expect(props.sceneCues.map((c) => c.id)).not.toContain("scene-2");
    const added = props.sceneCues.find((c) => c.id === "added-1")!;
    // Word 8's own output start — the window a one-scene assembly gives, the
    // editor's preview. Assembled with the plan it was pushed past 8.9 s.
    expect(added.startSec).toBeCloseTo(before.startSec, 6);
    expect(added.startSec).toBeLessThan(before.endSec);
    expect(props.baseSceneCues.find((c) => c.id === "added-1")!.startSec).toBeCloseTo(before.startSec, 6);
    expect("addedSceneIssues" in props).toBe(false);
  }, 240_000);

  it("a VISIBLE plan graphic over an added one (drift): the added one is dropped with the reason, the plan one untouched (fix-wave I1)", async () => {
    const root = join(dir, "wd-drift");
    await run(root);
    const work = workdirOf(root);
    const before = renderProps(work).sceneCues.find((c) => c.id === "scene-2")!;

    // A doc the add gesture would have refused — the state a later change
    // (a storyboard shot approved, an unhide) leaves behind.
    writeDoc(work, {
      addedScenes: [{ id: "added-1", component: "TitleCard", props: { title: "Covered" }, ...OVER_SCENE_2 }],
    });
    lines = [];
    await run(root);
    const props = renderProps(work);
    expect(addedIds(props.sceneCues)).toEqual([]);
    const after = props.sceneCues.find((c) => c.id === "scene-2")!;
    expect([after.startSec, after.endSec, after.component]).toEqual([before.startSec, before.endSec, "StatCard"]);
    const reason = "overlaps the graphic \u2018StatCard\u2019 at 0:06: move or remove it";
    expect(props.addedSceneIssues).toEqual([{ id: "added-1", reason }]);
    expect(lines).toContain(`  \u26a0 added graphic added-1 not shown: ${reason}`);
  }, 240_000);

  it("a repeated id and an id that is not added-<n> are skipped, the first occurrence kept (fix-wave M1)", async () => {
    const root = join(dir, "wd-ids");
    await run(root);
    const work = workdirOf(root);
    writeDoc(work, {
      scenes: ROOM,
      addedScenes: [
        TITLE,
        { ...TITLE, props: { title: "Second" }, srcStart: 11.2811, srcEnd: 12.088 },
        { ...TITLE, id: "scene-9", srcStart: 13.6519, srcEnd: 14.5633 },
      ],
    });
    lines = [];
    await run(root);
    const props = renderProps(work);
    expect(addedIds(props.sceneCues)).toEqual(["added-1"]);
    expect(props.sceneCues.find((c) => c.id === "added-1")!.props?.title).toBe("Today's demo");
    expect(props.sceneCues.map((c) => c.id)).not.toContain("scene-9");
    expect(props.addedSceneIssues).toEqual([
      { id: "added-1", reason: "duplicate id" },
      { id: "scene-9", reason: "its id is not an added-graphic id" },
    ]);
  }, 240_000);
});
