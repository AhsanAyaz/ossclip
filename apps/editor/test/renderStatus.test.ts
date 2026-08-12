import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  pinnedInfoLines,
  renderCompleteReload,
  renderProgress,
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
