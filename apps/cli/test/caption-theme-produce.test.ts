import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TimeMap, type CaptionChoreography, type Transcript } from "@ossclip/core";
import { buildProgram, captionThemeFlag } from "../src/program";
import {
  captionChoreographyCacheKey,
  priorCaptionChoreography,
  resolveChoreographCaptions,
  resolveProductionCaptionTheme,
} from "../src/produce";
import { recordedProduceArgs, setReplayArgv } from "../src/replay-argv";
import { rebuildCaptionTrack } from "../../editor/src/liveCaptionTrack";
import { emptyOverrideDoc } from "@ossclip/core/browser";

describe("captionThemeFlag & CLI option parsing", () => {
  it("parses valid caption theme preset IDs", () => {
    expect(captionThemeFlag("default")).toBe("default");
    expect(captionThemeFlag("founder")).toBe("founder");
    expect(captionThemeFlag("punch")).toBe("punch");
    expect(captionThemeFlag("boxed")).toBe("boxed");
    expect(captionThemeFlag("minimal")).toBe("minimal");
    expect(captionThemeFlag("  founder  ")).toBe("founder");
  });

  it("rejects unknown caption theme presets with an InvalidArgumentError", () => {
    expect(() => captionThemeFlag("neon")).toThrow(/--caption-theme wants one of default, founder, punch, boxed, minimal/);
  });

  it("registers --caption-theme, --choreograph-captions, and --no-choreograph-captions on produce", () => {
    const prog = buildProgram();
    const produceCmd = prog.commands.find((c) => c.name() === "produce")!;
    expect(produceCmd).toBeDefined();
    const flags = produceCmd.options.map((o) => o.long);
    expect(flags).toContain("--caption-theme");
    expect(flags).toContain("--choreograph-captions");
    expect(flags).toContain("--no-choreograph-captions");
  });
});

describe("resolveProductionCaptionTheme & resolveChoreographCaptions", () => {
  it("resolves override > flag > config > default and preserves baseTheme", () => {
    expect(resolveProductionCaptionTheme({})).toEqual({
      theme: "default",
      baseTheme: "default",
    });

    expect(resolveProductionCaptionTheme({ config: "founder" })).toEqual({
      theme: "founder",
      baseTheme: "founder",
      source: "config",
    });

    expect(resolveProductionCaptionTheme({ flag: "punch", config: "founder" })).toEqual({
      theme: "punch",
      baseTheme: "punch",
      source: "flag",
    });

    expect(
      resolveProductionCaptionTheme({
        override: "boxed",
        flag: "punch",
        config: "founder",
      }),
    ).toEqual({
      theme: "boxed",
      baseTheme: "punch",
      source: "override",
    });
  });

  it("warns and falls back to default when config captionTheme is invalid", () => {
    const res = resolveProductionCaptionTheme({ config: "comic-sans" });
    expect(res.theme).toBe("default");
    expect(res.baseTheme).toBe("default");
    expect(res.warning).toMatch(/config captionTheme ignored/);
  });

  it("resolves choreographCaptions with flag beating config", () => {
    expect(resolveChoreographCaptions(undefined, undefined)).toBe(false);
    expect(resolveChoreographCaptions(undefined, "yes")).toBe(false);
    expect(resolveChoreographCaptions(undefined, true)).toBe(true);
    expect(resolveChoreographCaptions(false, true)).toBe(false);
    expect(resolveChoreographCaptions(true, false)).toBe(true);
  });
});

describe("captionChoreographyCacheKey & priorCaptionChoreography", () => {
  it("produces a deterministic cache key that changes when inputs change", () => {
    const base = {
      version: 1,
      aspect: "9:16" as const,
      providerName: "gemini",
      fastModel: "gemini-2.5-flash",
      words: [
        { text: "Stop", srcStartMs: 100 },
        { text: "scrolling", srcStartMs: 400 },
      ],
    };
    const key1 = captionChoreographyCacheKey(base);
    expect(captionChoreographyCacheKey(base)).toBe(key1);
    expect(captionChoreographyCacheKey({ ...base, aspect: "16:9" })).not.toBe(key1);
    expect(captionChoreographyCacheKey({ ...base, providerName: "claude" })).not.toBe(key1);
    expect(
      captionChoreographyCacheKey({
        ...base,
        words: [
          { text: "Stop", srcStartMs: 100 },
          { text: "now", srcStartMs: 400 },
        ],
      }),
    ).not.toBe(key1);
  });

  it("reads priorCaptionChoreography from production.json and tolerates missing or malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-choreo-test-"));
    try {
      expect(priorCaptionChoreography(dir)).toBeUndefined();

      const validChoreo: CaptionChoreography = {
        phrases: [{ startSrcSec: 0.1, endSrcSec: 0.4, role: "hook" }],
        words: { w100: { emphasisScale: 1.2 } },
      };
      writeFileSync(
        join(dir, "production.json"),
        JSON.stringify({ captionChoreography: validChoreo }),
      );
      expect(priorCaptionChoreography(dir)).toEqual(validChoreo);

      writeFileSync(
        join(dir, "production.json"),
        JSON.stringify({ captionChoreography: { phrases: "not-an-array" } }),
      );
      expect(priorCaptionChoreography(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recordedProduceArgs caption pins", () => {
  it("pins --caption-theme when non-default and --choreograph-captions / --no-choreograph-captions", () => {
    setReplayArgv(["produce", "clip.mp4"]);
    const args = recordedProduceArgs({
      captionTheme: "founder",
      choreographCaptions: true,
    });
    expect(args).toContain("--caption-theme");
    expect(args[args.indexOf("--caption-theme") + 1]).toBe("founder");
    expect(args).toContain("--choreograph-captions");
  });

  it("does not pin --caption-theme when default, and pins --no-choreograph-captions when false", () => {
    setReplayArgv(["produce", "clip.mp4"]);
    const args = recordedProduceArgs({
      captionTheme: "default",
      choreographCaptions: false,
    });
    expect(args).not.toContain("--caption-theme");
    expect(args).toContain("--no-choreograph-captions");
  });

  it("does not duplicate flags already present in argv", () => {
    setReplayArgv(["produce", "clip.mp4", "--caption-theme", "punch", "--choreograph-captions"]);
    const args = recordedProduceArgs({
      captionTheme: "founder",
      choreographCaptions: true,
    });
    expect(args.filter((a) => a === "--caption-theme")).toHaveLength(1);
    expect(args.filter((a) => a === "--choreograph-captions")).toHaveLength(1);
  });
});

describe("rebuildCaptionTrack with choreography", () => {
  it("forwards choreography to buildCaptionLines so live editor recuts preserve phrase roles and word emphasis", () => {
    const transcript: Transcript = {
      duration: 2,
      segments: [{ id: 0, start: 0, end: 2, text: "Stop scrolling right now" }],
      words: [
        { text: "Stop", start: 0.1, end: 0.4, confidence: 0.99 },
        { text: "scrolling", start: 0.4, end: 0.8, confidence: 0.99 },
        { text: "right", start: 0.8, end: 1.1, confidence: 0.99 },
        { text: "now", start: 1.1, end: 1.5, confidence: 0.99 },
      ],
    };
    const map = new TimeMap([{ kind: "keep", srcIn: 0, srcOut: 2 }]);
    const choreography: CaptionChoreography = {
      phrases: [
        { startSrcSec: 0.1, endSrcSec: 0.4, role: "hook" },
        { startSrcSec: 0.8, endSrcSec: 1.1, role: "impact" },
      ],
      words: {
        w100: { emphasisScale: 1.25 },
      },
    };
    const rebuilt = rebuildCaptionTrack(transcript, map, emptyOverrideDoc(), {
      breakpoints: [],
      landscape: false,
      choreography,
    });
    expect(rebuilt.lines).toHaveLength(2);
    expect(rebuilt.lines[0]?.role).toBe("hook");
    expect(rebuilt.lines[0]?.words.map((w) => w.text)).toEqual(["Stop", "scrolling"]);
    expect(rebuilt.lines[0]?.words[0]?.emphasisScale).toBe(1.25);
    expect(rebuilt.lines[1]?.role).toBe("impact");
    expect(rebuilt.lines[1]?.words.map((w) => w.text)).toEqual(["right", "now"]);
  });
});
