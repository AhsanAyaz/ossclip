import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { coverTextHold, plannedCoverHeadline, priorCoverHeadline } from "../src/cover";
import { produce } from "../src/produce";

/**
 * Field report 2026-11-07 ("Ai Agents Vid"): every cover of a `--review`
 * project shipped without its headline. The review run planned the headline
 * and stopped before the cover step; the editor's Render replays with
 * `--scenes`, which has no beat sheet, so the cover got "" — and `cover.json`
 * then held `text: ""`, keeping every later Render bare too. The headline
 * now lives on `production.json` (`coverHeadline`) and a replay carries it.
 */
describe("plannedCoverHeadline", () => {
  it("a run with a beat sheet uses its coverText, through the 9-word cap", () => {
    expect(plannedCoverHeadline({ hook: "the hook", coverText: "4 tools to build AI agents, no code" }, undefined)).toBe(
      "4 tools to build AI agents, no code",
    );
  });
  it("falls back to the hook when the sheet has no coverText", () => {
    expect(plannedCoverHeadline({ hook: "MOCK HOOK" }, "older headline")).toBe("MOCK HOOK");
  });
  it("a replay (no beat sheet) carries the prior production's headline", () => {
    expect(plannedCoverHeadline(undefined, "4 tools to build AI agents, no code")).toBe(
      "4 tools to build AI agents, no code",
    );
  });
  it("no sheet and no prior headline is no headline", () => {
    expect(plannedCoverHeadline(undefined, undefined)).toBeUndefined();
  });
});

describe("priorCoverHeadline", () => {
  const work = () => mkdtempSync(join(tmpdir(), "ossclip-prior-headline-"));
  it("reads production.json's coverHeadline", () => {
    const w = work();
    writeFileSync(join(w, "production.json"), JSON.stringify({ coverHeadline: "From production" }));
    writeFileSync(join(w, "beatsheet-aaaa.json"), JSON.stringify({ hook: "From sheet" }));
    expect(priorCoverHeadline(w)).toBe("From production");
  });
  it("a project from before the field falls back to its newest cached beat sheet (the stuck Ai Agents Vid)", () => {
    const w = work();
    writeFileSync(join(w, "production.json"), JSON.stringify({ version: 1 }));
    writeFileSync(join(w, "beatsheet-5943b536.json"), JSON.stringify({ hook: "long hook", coverText: "4 tools to build AI agents, no code" }));
    expect(priorCoverHeadline(w)).toBe("4 tools to build AI agents, no code");
  });
  it("nothing on disk is no headline, and a broken sheet is ignored", () => {
    const w = work();
    expect(priorCoverHeadline(w)).toBeUndefined();
    writeFileSync(join(w, "beatsheet-bbbb.json"), "{not json");
    expect(priorCoverHeadline(w)).toBeUndefined();
  });
});

describe("coverTextHold with a carried headline (the stuck project)", () => {
  it("an empty GENERATED cover.json no longer blocks the carried headline", () => {
    expect(
      coverTextHold({
        generated: "4 tools to build AI agents, no code",
        persisted: { text: "", textSource: "beatsheet" },
        reset: false,
      }).text,
    ).toBe("4 tools to build AI agents, no code");
  });
  it("a headline the user typed still wins over the carried one", () => {
    expect(
      coverTextHold({
        generated: "4 tools to build AI agents, no code",
        persisted: { text: "My own words", textSource: "user" },
        reset: false,
      }).text,
    ).toBe("My own words");
  });
});

describe("produce: the headline survives a --review stop and a --scenes replay", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-cover-carry-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    const texts = ["today", "I", "built", "an", "agent", "with", "no", "code"];
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: texts.map((text, i) => ({ text, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6, confidence: 0.99 })),
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("production.json keeps coverHeadline from the planning run through a replay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const base = {
      cleanup: "standard" as const,
      libraryDir: mkdtempSync(join(tmpdir(), "ossclip-empty-library-")),
      render: false,
      mezzanine: false,
      transcript: join(dir, "transcript.json"),
      workdir: join(dir, "wd"),
    };
    const planned = await produce(join(dir, "take.mp4"), { ...base, produce: true, provider: "mock" });
    const read = () =>
      JSON.parse(readFileSync(join(planned.workdir, "production.json"), "utf8")) as {
        coverHeadline?: string;
        scenes?: unknown[];
      };
    expect(read().coverHeadline).toBe("MOCK HOOK");

    // The editor's Render: --scenes, no --produce, no provider.
    const scenesPath = join(dir, "scenes-reviewed.json");
    writeFileSync(scenesPath, JSON.stringify(read().scenes ?? []));
    await produce(join(dir, "take.mp4"), { ...base, scenes: scenesPath });
    expect(read().coverHeadline).toBe("MOCK HOOK");
    vi.restoreAllMocks();
  }, 120_000);
});
