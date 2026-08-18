import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  pinnedInfoLines,
  renderCompleteReload,
  renderProgress,
  resumedRenderStateApplies,
  resumeRenderState,
} from "../src/renderStatus";
import { emptyOverrideDoc } from "@ossclip/core/browser";

// A realistic tail of a replayed `produce` run — the exact line shapes the
// pipeline prints (produce.ts and formatUsageLine), which is all the panel
// has to work with.
const RUN = [
  "▸ ingest: mezzanine cached",
  "▸ producing scenes (claude-cli)…",
  "▸ hook: Agents are eating your codebase",
  "▸ llm: 3 calls · 130,749 in / 8,321 out tokens · ~$0.72 · 92s",
  "▸ rendering…",
  "  0%",
  " 10%",
];

describe("renderProgress", () => {
  it("returns the LATEST percentage line", () => {
    expect(renderProgress(RUN)).toBe(10);
    expect(renderProgress([...RUN, " 40%"])).toBe(40);
  });

  it("is null before the render phase prints any percentage", () => {
    expect(renderProgress(RUN.slice(0, 5))).toBeNull();
    expect(renderProgress([])).toBeNull();
  });

  it("ignores percentages embedded in prose — only bare NN% lines count", () => {
    // A stat like "861%" inside a scene log line is content, not progress.
    expect(renderProgress(['▸ StatCard scene-0 value: "861%"'])).toBeNull();
  });

  it("clamps a malformed >100 line rather than overflowing the bar", () => {
    expect(renderProgress(["120%"])).toBe(100);
  });
});

describe("pinnedInfoLines", () => {
  it("pins the provider line and the llm cost line, in print order", () => {
    expect(pinnedInfoLines(RUN)).toEqual([
      "▸ producing scenes (claude-cli)…",
      "▸ llm: 3 calls · 130,749 in / 8,321 out tokens · ~$0.72 · 92s",
    ]);
  });

  it("pins nothing it can't find — a cached replay may print neither", () => {
    expect(pinnedInfoLines(["▸ scenes cached (6)", "  0%"])).toEqual([]);
  });

  it("keeps the cached-run llm line — 'no calls' is honest cost reporting too", () => {
    const lines = ["▸ llm: no calls — repairs and scenes came from the workdir cache"];
    expect(pinnedInfoLines(lines)).toEqual(lines);
  });

  it("takes the LATEST match when a line repeats", () => {
    const twice = [...RUN, "▸ producing scenes (openai)…"];
    expect(pinnedInfoLines(twice)[0]).toBe("▸ producing scenes (openai)…");
  });
});

describe("formatElapsed", () => {
  it("formats m:ss with zero-padded seconds", () => {
    expect(formatElapsed(0, 0)).toBe("0:00");
    expect(formatElapsed(0, 9_000)).toBe("0:09");
    expect(formatElapsed(0, 83_000)).toBe("1:23");
    expect(formatElapsed(0, 600_000)).toBe("10:00");
  });

  it("floors a clock skew at zero instead of printing negative time", () => {
    expect(formatElapsed(5_000, 1_000)).toBe("0:00");
  });
});

describe("renderCompleteReload (PLAN 2026-08-04 Task 4c fix wave, review finding 2)", () => {
  it("loads produce's on-disk doc when the caller was CLEAN — no notice", () => {
    const doc = { ...emptyOverrideDoc(), splits: [{ at: 4.2, id: "4200" }] };
    expect(renderCompleteReload(doc, false)).toEqual({ load: doc, notifyDiscard: false });
  });

  it("STILL loads produce's on-disk doc when the caller was DIRTY — produce's write-back always wins, no field-level merge", () => {
    const doc = { ...emptyOverrideDoc(), splits: [{ at: 4.2, id: "4200" }] };
    const result = renderCompleteReload(doc, true);
    expect(result.load).toBe(doc); // same reference — nothing merged into it
    expect(result.notifyDiscard).toBe(true);
  });

  it("does nothing when the response carried no overrides at all (a workdir with none yet)", () => {
    expect(renderCompleteReload(undefined, true)).toEqual({ load: null, notifyDiscard: false });
    expect(renderCompleteReload(undefined, false)).toEqual({ load: null, notifyDiscard: false });
  });
});

describe("resumeRenderState (2026-08-18: a reload used to discard a finished run's log)", () => {
  it("resumes a RUNNING render, marked resumed, ready for the poll", () => {
    expect(
      resumeRenderState({ running: true, exitCode: null, lines: RUN, startedAt: 1_000 }),
    ).toEqual({ running: true, lines: RUN, startedAt: 1_000, resumed: true });
  });

  it("restores a finished run as a SUCCESS terminal state — no finishedAt, a reload has no honest end stamp", () => {
    const state = resumeRenderState({
      running: false,
      exitCode: 0,
      lines: RUN,
      startedAt: 1_000,
    });
    expect(state).toEqual({
      running: false,
      lines: RUN,
      succeeded: true,
      startedAt: 1_000,
      resumed: true,
    });
    // The auto-reveal guard: a restored success must never read as live.
    expect(state?.resumed).toBe(true);
    expect(state?.finishedAt).toBeUndefined();
  });

  it("restores a failed run with its exit code, and a cancel as cancelled", () => {
    expect(
      resumeRenderState({ running: false, exitCode: 1, lines: RUN, startedAt: 1_000 }),
    ).toEqual({
      running: false,
      lines: RUN,
      failed: 1,
      cancelled: undefined,
      startedAt: 1_000,
      resumed: true,
    });
    expect(
      resumeRenderState({
        running: false,
        exitCode: 143,
        lines: RUN,
        startedAt: 1_000,
        cancelled: true,
      }),
    ).toMatchObject({ failed: 143, cancelled: true, resumed: true });
  });

  it("restores nothing when no run ever started (exitCode null, idle)", () => {
    expect(resumeRenderState({ running: false, exitCode: null, lines: [] })).toBeNull();
    expect(resumeRenderState({ running: false, exitCode: null })).toBeNull();
  });

  it("restores nothing when a run exited but captured no lines — an empty panel is chrome without content", () => {
    expect(resumeRenderState({ running: false, exitCode: 0, lines: [] })).toBeNull();
    expect(resumeRenderState({ running: false, exitCode: 1 })).toBeNull();
  });
});

/**
 * The resume is documented mount-only, but the load it lives in also runs on
 * every project switch (R17 §83) and the server holds the last run's ring
 * buffer until the NEXT render starts. Rendering project A to completion and
 * then opening project B replayed A's "✓ done" row, its log and its cost
 * lines under B — with "Open folder" resolving against B's workdir
 * (2026-08-19 review).
 */
describe("resumedRenderStateApplies", () => {
  it("applies on the FIRST load — mount, or the first project opened from the picker", () => {
    expect(resumedRenderStateApplies(null, "/w/a")).toBe(true);
    expect(resumedRenderStateApplies(null, null)).toBe(true);
  });

  it("applies on a reload of the SAME project — the case the resume exists for", () => {
    expect(resumedRenderStateApplies("/w/a", "/w/a")).toBe(true);
  });

  it("refuses on a SWITCH — whatever the server still holds belongs to the project being left", () => {
    expect(resumedRenderStateApplies("/w/a", "/w/b")).toBe(false);
    // Switching to the picker (no workdir) is a switch too.
    expect(resumedRenderStateApplies("/w/a", null)).toBe(false);
  });
});
