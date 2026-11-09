import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@ossclip/core";
import { produce } from "../src/produce";

/**
 * 2026-11-08 field report, end to end through the real `produce`: a word the
 * cutlist removes must reach the graphics planner MARKED, never as kept
 * speech — the cut "Rotate" retake came back as a graphic's copy. A filler
 * standard cleanup removes is the cheapest cut word to construct offline.
 */
// The unit job has no ffmpeg (ci.yml) — the analyze/no-zoom/produce-timing
// posture: a produce-driving test skips there instead of failing the gate.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("produce: the graphics planner is told which words are cut", () => {
  let dir: string;
  let libraryDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-plan-cut-"));
    libraryDir = mkdtempSync(join(tmpdir(), "ossclip-empty-library-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    const texts = ["rotate", "your", "um", "keys", "every", "week", "or", "lose", "access", "for", "good"];
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: texts.map((text, i) => ({ text, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6, confidence: 0.99 })),
      }),
    );
  });
  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  });

  it("marks the cut filler in the beat-sheet prompt and keeps the kept words plain", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const users: { schemaName: string; user: string }[] = [];
    const real = MockProvider.prototype.complete;
    vi.spyOn(MockProvider.prototype, "complete").mockImplementation(function (this: MockProvider, req) {
      users.push({ schemaName: req.schemaName, user: req.user });
      return real.call(this, req);
    } as typeof real);
    await produce(join(dir, "take.mp4"), {
      cleanup: "standard",
      libraryDir,
      render: false,
      mezzanine: false,
      youtube: false,
      confirmRepairs: false,
      transcript: join(dir, "transcript.json"),
      workdir: join(dir, "wd"),
      produce: true,
      provider: "mock",
    });
    const beat = users.find((u) => u.schemaName === "beat_sheet");
    expect(beat).toBeDefined();
    expect(beat!.user).toContain("[2]⟦um⟧");
    expect(beat!.user).toContain("[0]rotate [1]your");
    expect(beat!.user).toContain("were CUT from the video");
  });
});
