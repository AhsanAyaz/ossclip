import { describe, expect, it } from "vitest";
import { renderReplayArgs } from "../src/render-replay-args";

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
