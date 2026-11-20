import { describe, expect, it } from "vitest";
import {
  healRecordedProduceArgs,
  isStoryboardCommand,
  renderReplayArgs,
  reviewedScenesText,
} from "../src/render-replay-args";

/**
 * What the editor's Render button replays (2026-08-29).
 *
 * It used to re-run `command.json` VERBATIM, `--produce` included, so every
 * render re-called the LLM. The beat-sheet cache key covers the repaired
 * words and the measured framing — both of which the user's own editor work
 * changes — so the plan came back renumbered and edits anchored to scenes it
 * no longer had were orphaned. A re-render silently rewrote an approved cut,
 * the failure `produce.ts`' §143 note already named once.
 *
 * The editor is the authority for a render started FROM the editor: replay
 * the plan on screen (`--scenes`, no LLM in the loop), not a fresh one.
 * `--produce` stays reachable through the explicit re-plan path.
 */
describe("renderReplayArgs", () => {
  const base = ["produce", "in.mp4", "--produce", "--llm", "claude-cli", "--captions"];

  it("swaps --produce for --scenes <reviewed plan>", () => {
    const args = renderReplayArgs(base, { scenesPath: "/w/scenes-reviewed.json" });
    expect(args).not.toContain("--produce");
    expect(args).toEqual([
      "produce",
      "in.mp4",
      "--llm",
      "claude-cli",
      "--captions",
      "--scenes",
      "/w/scenes-reviewed.json",
    ]);
  });

  it("replan keeps the recorded command exactly — the deliberate fresh plan", () => {
    expect(renderReplayArgs(base, { scenesPath: "/w/s.json", replan: true })).toEqual(base);
  });

  it("a run that never used --produce still gets the reviewed plan pinned", () => {
    // A --scenes or plain run has no LLM to suppress, but its plan can still
    // be renumbered by a re-measure; pinning it is what makes the render
    // reproduce what was reviewed.
    const plain = ["produce", "in.mp4", "--captions"];
    expect(renderReplayArgs(plain, { scenesPath: "/w/s.json" })).toEqual([
      "produce",
      "in.mp4",
      "--captions",
      "--scenes",
      "/w/s.json",
    ]);
  });

  it("an ALREADY --scenes run has its path replaced, never doubled", () => {
    // Two --scenes flags would let commander pick the stale one, which is
    // exactly the plan the editor is not showing.
    const withScenes = ["produce", "in.mp4", "--scenes", "/w/old.json", "--captions"];
    const args = renderReplayArgs(withScenes, { scenesPath: "/w/new.json" });
    expect(args.filter((a) => a === "--scenes")).toHaveLength(1);
    expect(args).toEqual(["produce", "in.mp4", "--captions", "--scenes", "/w/new.json"]);
  });

  it("drops --script and its value when it pins the reviewed plan", () => {
    // `--script` implies a fresh plan and produce refuses it beside --scenes;
    // the script text rides production.json forward instead.
    const withScript = ["produce", "in.mp4", "--script", "/v/egm.md", "--aspect", "16:9"];
    expect(renderReplayArgs(withScript, { scenesPath: "/w/s.json" })).toEqual([
      "produce",
      "in.mp4",
      "--aspect",
      "16:9",
      "--scenes",
      "/w/s.json",
    ]);
  });

  it("drops --storyboard and --assets with its value when it pins the reviewed plan, and keeps both on replan (§168)", () => {
    const sb = ["produce", "in.mp4", "--produce", "--storyboard", "--assets", "/v/assets", "--aspect", "16:9"];
    expect(renderReplayArgs(sb, { scenesPath: "/w/s.json" })).toEqual([
      "produce",
      "in.mp4",
      "--aspect",
      "16:9",
      "--scenes",
      "/w/s.json",
    ]);
    expect(renderReplayArgs(sb, { scenesPath: "/w/s.json", replan: true })).toEqual(sb);
  });

  it("carries --sfx and its level through the --produce swap", () => {
    // Only --produce and --scenes are dropped, and this pins that: --sfx-level
    // is a VALUE option, so a filter that treated it as a bare flag would
    // orphan `meme` into the argv as a stray positional and the replay would
    // die at commander's front door (§129's failure shape).
    const withSfx = ["produce", "in.mp4", "--produce", "--sfx", "--sfx-level", "meme"];
    expect(renderReplayArgs(withSfx, { scenesPath: "/w/s.json" })).toEqual([
      "produce",
      "in.mp4",
      "--sfx",
      "--sfx-level",
      "meme",
      "--scenes",
      "/w/s.json",
    ]);
  });

  it("no reviewed plan on disk means the recorded args ride unchanged", () => {
    // Old workdirs whose production.json predates the scenes array, and any
    // run whose plan could not be written: replaying the recorded command is
    // still better than refusing to render.
    expect(renderReplayArgs(base, {})).toEqual(base);
  });
});

describe("renderReplayArgs: a --clip project (2026-11-08 audit)", () => {
  it("keeps --clip and its --clip-window pin, so the replay slices the same window", () => {
    const recorded = ["produce", "in.mp4", "--produce", "--clip", "60", "--clip-window", "12:340", "--llm", "mock"];
    expect(renderReplayArgs(recorded, { scenesPath: "/wd/scenes-reviewed.json" })).toEqual([
      "produce", "in.mp4", "--clip", "60", "--clip-window", "12:340", "--llm", "mock",
      "--scenes", "/wd/scenes-reviewed.json",
    ]);
  });
});

/**
 * The two halves of a replay the edit server's Render and `ossclip kit`'s
 * refresh share (§162): one heal and one pinned plan, so the kit can never
 * refresh a project the editor could not render.
 */
describe("healRecordedProduceArgs (§129)", () => {
  it("prepends the produce literal a legacy wizard record is missing", () => {
    expect(healRecordedProduceArgs(["in.mp4", "--llm", "mock"])).toEqual(["produce", "in.mp4", "--llm", "mock"]);
  });

  it("leaves a modern record alone, as a copy", () => {
    const recorded = ["produce", "in.mp4"];
    const healed = healRecordedProduceArgs(recorded);
    expect(healed).toEqual(recorded);
    expect(healed).not.toBe(recorded);
  });
});

describe("isStoryboardCommand (§169)", () => {
  it("is true when the recorded argv holds --storyboard, wherever it sits", () => {
    expect(isStoryboardCommand(["produce", "in.mp4", "--storyboard"])).toBe(true);
    expect(isStoryboardCommand(["produce", "--storyboard", "in.mp4", "--assets", "/v/a"])).toBe(true);
  });

  it("is false for any other command, a pinned replay of a storyboard project included", () => {
    expect(isStoryboardCommand(["produce", "in.mp4", "--produce"])).toBe(false);
    expect(isStoryboardCommand(["produce", "in.mp4", "--script", "/v/s.md"])).toBe(false);
    // What a Render records once it has pinned: `--storyboard` already stripped.
    expect(isStoryboardCommand(["produce", "in.mp4", "--scenes", "/w/scenes-reviewed.json"])).toBe(false);
    expect(isStoryboardCommand([])).toBe(false);
  });
});

describe("reviewedScenesText", () => {
  it("is production.json's scenes, pretty-printed with a trailing newline", () => {
    const scenes = [{ id: "scene-0", component: "CardRow" }];
    expect(reviewedScenesText(JSON.stringify({ version: 1, scenes }))).toBe(
      `${JSON.stringify(scenes, null, 2)}\n`,
    );
  });

  it("is undefined when there is no plan to pin", () => {
    expect(reviewedScenesText(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(reviewedScenesText(JSON.stringify({ scenes: [] }))).toBeUndefined();
    expect(reviewedScenesText(JSON.stringify({ scenes: "x" }))).toBeUndefined();
    expect(reviewedScenesText("null")).toBeUndefined();
    expect(reviewedScenesText("{ not json")).toBeUndefined();
  });
});
