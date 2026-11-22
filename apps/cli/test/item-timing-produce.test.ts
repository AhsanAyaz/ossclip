import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ITEM_LEAD_SEC, TimeMap, wordOutputStart } from "@ossclip/core";
import { produce, type ProduceOptions } from "../src/produce";
import { REVIEWED_SCENES_BASENAME, reviewedScenesText } from "../src/render-replay-args";

/**
 * Word-timed list items through the real `produce` (graphic-editor-modal
 * §4 "Produce", plan Task 4): an override's `itemPins` lands the graphic's
 * items on their pinned words and its auto items on their matched words, on
 * a planner run, a storyboard run and the editor's `--scenes` Render, for
 * plan and added graphics alike; a project without the marker renders as it
 * did. The added-scenes-produce harness: the fixture's transcript, a
 * synthetic take, the mock provider, never rendered. The `--clip` index
 * space the editor's side relies on is clip-edge-repair.test.ts.
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
const GOLDEN = new URL("./fixtures/item-timing/", import.meta.url).pathname;

// The mock plan on fixture.transcript.json: scene-4 is a FlowDiagram on
// words 16-19 ("take becomes a clean", 12.168-14.0895 s) with nodes RAW
// TAKE / CUT / PRODUCED. Word 18 "a" starts at 13.2828, word 19 "clean" at
// 13.6519.
const FLOW_PINS = {
  component: "FlowDiagram",
  pins: [null, { src: 13.2828, text: "CUT" }, { src: 13.6519, text: "PRODUCED" }],
};
// "RAW TAKE" is not said inside the block ("raw" is word 15, before it), so
// the author's text edit to "TAKE" is what gives the auto item a word: the
// matcher re-runs on the edited text (G3) and finds "take" (16).
const FLOW = { props: { nodes: ["TAKE", "CUT", "PRODUCED"] }, itemPins: FLOW_PINS };
// An added list over words 14-21 ("this raw take becomes a clean edit
// automatically"), every item auto. scene-4 sits on those words, so the doc
// hides it, as an author makes room for an add (added-scenes-produce ROOM).
const LIST = {
  id: "added-1",
  component: "BulletList",
  props: { items: ["raw take", "clean edit"] },
  srcStart: 11.2811,
  srcEnd: 15.3957,
};
const LIST_AUTO = { component: "BulletList", pins: [null, null] };

type Cue = {
  id: string;
  kind?: string;
  component?: string;
  props?: Record<string, unknown>;
  reveal?: { itemAtSec: (number | null)[] };
  startSec: number;
  endSec: number;
};
type Word = { text: string; start: number; end: number };

describe.skipIf(!hasFfmpeg)("produce: list items on their pinned and matched words", () => {
  let dir: string;
  let libraryDir: string;
  let lines: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-item-timing-"));
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
  const renderPropsText = (work: string) => readFileSync(join(work, "render-props.json"), "utf8");
  const cueOf = (work: string, id: string): Cue =>
    (JSON.parse(renderPropsText(work)) as { sceneCues: Cue[] }).sceneCues.find((c) => c.id === id)!;
  const writeDoc = (work: string, doc: unknown) => writeFileSync(join(work, "overrides.json"), JSON.stringify(doc));
  /** The editor's Render (edit.ts /api/render): production.json's scenes pinned as `--scenes`. */
  const replay = async (root: string, work: string) => {
    const reviewed = join(work, REVIEWED_SCENES_BASENAME);
    writeFileSync(reviewed, reviewedScenesText(readFileSync(join(work, "production.json"), "utf8")) ?? "[]\n");
    await run(root, { scenes: reviewed, produce: false });
  };
  /** An item's expected time: word `i`'s output start on the run's own clock,
   * less the lead, floored at 0 — assembly's rule (`plannedCue`). The
   * fixture has no repairs, so production.json's words are the run's. */
  const itemAt = (work: string, i: number): number => {
    const p = JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as {
      cutlist: ConstructorParameters<typeof TimeMap>[0];
      transcript: { words: Word[] };
    };
    const at = wordOutputStart(p.transcript.words[i]!, new TimeMap(p.cutlist));
    expect(at).not.toBeNull();
    return Math.max(0, at! - ITEM_LEAD_SEC);
  };

  it("a planner graphic: pinned items on their words, the auto one on its match, kept on the Render replay", async () => {
    const root = join(dir, "wd-planner");
    await run(root);
    const work = workdirOf(root);
    expect(cueOf(work, "scene-4").reveal?.itemAtSec).toEqual([null, null, null]);

    writeDoc(work, { scenes: { "scene-4": FLOW } });
    lines = [];
    await run(root);
    // "TAKE" auto-matches "take" (16) before the first pin; CUT and
    // PRODUCED on "a" (18) and "clean" (19).
    const expected = [itemAt(work, 16), itemAt(work, 18), itemAt(work, 19)];
    let cue = cueOf(work, "scene-4");
    expect(cue.reveal?.itemAtSec).toEqual(expected);
    // A bounding pin and no author `reveal`: forced synced (§3 step 5).
    expect(cue.props?.reveal).toBe("synced");
    expect(lines.filter((l) => l.includes('scene "scene-4"'))).toEqual([]);

    await replay(root, work);
    cue = cueOf(work, "scene-4");
    expect(cue.reveal?.itemAtSec).toEqual(expected);
    expect(cue.props?.reveal).toBe("synced");
  }, 360_000);

  it("a split planner graphic: both halves carry the root's item times", async () => {
    const root = join(dir, "wd-split");
    await run(root);
    const work = workdirOf(root);
    // Split between "becomes" and "a": the second half is scene-4@s1.
    writeDoc(work, { scenes: { "scene-4": FLOW }, splits: [{ id: "s1", src: 13.2828 }] });
    await run(root);
    const expected = [itemAt(work, 16), itemAt(work, 18), itemAt(work, 19)];
    expect(cueOf(work, "scene-4").reveal?.itemAtSec).toEqual(expected);
    expect(cueOf(work, "scene-4@s1").reveal?.itemAtSec).toEqual(expected);
  }, 360_000);

  it("a pin whose word moved: that item is matched by its text and the note is printed, one line", async () => {
    const root = join(dir, "wd-moved");
    await run(root);
    const work = workdirOf(root);
    // A re-transcribe's drift: no word starts within 0.05 s of 13.0 s
    // ("becomes" 12.5823, "a" 13.2828), so pin row 1 turns item 2 auto.
    const moved = { ...FLOW_PINS, pins: [null, { src: 13.0, text: "CUT" }, FLOW_PINS.pins[2]] };
    writeDoc(work, { scenes: { "scene-4": { ...FLOW, itemPins: moved } } });
    lines = [];
    await run(root);
    expect(lines.filter((l) => l.includes('scene "scene-4"'))).toEqual([
      '  ⚠ scene "scene-4" item 2: its word moved',
    ]);
    // Still timed: PRODUCED on its pin, the others by the matcher or the renderer.
    expect(cueOf(work, "scene-4").reveal?.itemAtSec[2]).toEqual(itemAt(work, 19));
  }, 360_000);

  it("an added graphic with the marker: its auto items land on their matched words, unforced", async () => {
    const root = join(dir, "wd-added");
    await run(root);
    const work = workdirOf(root);
    writeDoc(work, {
      scenes: { "scene-4": { hidden: true }, "added-1": { itemPins: LIST_AUTO } },
      addedScenes: [LIST],
    });
    await run(root);
    const cue = cueOf(work, "added-1");
    // "raw take" on "raw" (15), "clean edit" on "clean" (19).
    expect(cue.reveal?.itemAtSec).toEqual([itemAt(work, 15), itemAt(work, 19)]);
    // Auto only: the renderer's syncDecision decides, as today (§3 step 5).
    expect(cue.props?.reveal).toBeUndefined();
  }, 360_000);

  it("a storyboard run: an added list's pinned item on its word", async () => {
    // A storyboard run plans no template graphics, so the covered graphic is
    // an added one (storyboard-produce, "an editor-added graphic over …").
    const root = join(dir, "wd-storyboard");
    await run(root, { storyboard: true });
    const work = workdirOf(root);
    writeDoc(work, {
      scenes: { "added-1": { itemPins: { component: "BulletList", pins: [null, { src: 13.6519, text: "clean edit" }] } } },
      addedScenes: [LIST],
    });
    await run(root, { storyboard: true });
    const cue = cueOf(work, "added-1");
    expect(cue.reveal?.itemAtSec).toEqual([itemAt(work, 15), itemAt(work, 19)]);
    expect(cue.props?.reveal).toBe("synced");
  }, 360_000);

  // Byte-equal to the build before the wiring (AG1): the whole
  // render-props.json, captured on 3a1edd5 with this harness and this doc —
  // edits, a component swap to BulletList, a split, a hide and an added
  // list, none with `itemPins` — with the run's tmp paths taken out, as the
  // clip-edge-repair production.json fixtures are. If an unrelated change
  // (the mock plan, assembly, the theme) moves these bytes, re-capture from
  // the parent of the change; the point is that the marker's absence costs
  // nothing.
  it("a project with overrides and no itemPins: render-props.json byte-equal to before", async () => {
    const root = join(dir, "wd-unmarked");
    await run(root);
    const work = workdirOf(root);
    writeDoc(work, {
      scenes: {
        "scene-0": { component: "BulletList", props: { items: ["Hello", "welcome back"] } },
        "scene-2": { hidden: true },
        "scene-4": { props: { nodes: ["RAW TAKE", "CUT", "PRODUCED", "SHIPPED"] } },
      },
      splits: [{ id: "s1", src: 13.2828 }],
      addedScenes: [{ id: "added-1", component: "BulletList", props: { items: ["show you", "something"] }, srcStart: 6.7278, srcEnd: 8.5681 }],
    });
    await run(root);
    const normalized = renderPropsText(work).split(libraryDir).join("<LIB>").split(dir).join("<DIR>");
    expect(normalized).toBe(readFileSync(join(GOLDEN, "unmarked.render-props.json"), "utf8"));
  }, 360_000);
});
