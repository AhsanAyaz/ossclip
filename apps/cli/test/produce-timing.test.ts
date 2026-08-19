import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { produce } from "../src/produce";

/**
 * The first test that EXECUTES produce() (FINDINGS §140). Until now the whole
 * produce path was guarded only by source-text regexes in this directory —
 * and both §137 Criticals sat on exactly that untested path. This harness is
 * deliberately hermetic about the expensive dependencies: the transcript is
 * INJECTED (no whisper binary, no model download), there is no --produce (no
 * LLM), and no render (no headless Chrome) — but everything else is real:
 * real ffmpeg concat of a real folder input, real silence/level analysis,
 * real workdir artifacts on disk.
 *
 * A folder input on purpose: `concatFolder` is the one ffmpeg-phase call this
 * hermetic setup can reach, so the per-phase timing assertion below is about
 * a REAL measured phase, not a stub.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("produce() — behavioural harness", () => {
  let dir: string;
  let clips: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-produce-timing-"));
    clips = join(dir, "clips");
    mkdirSync(clips);
    // Two tiny synthetic takes — video and a sine-burst audio track (produce
    // refuses a silent source: "no audio stream — nothing to cut by").
    for (const [name, freq] of [
      ["a-first.mp4", "440"],
      ["b-second.mp4", "660"],
    ] as const) {
      execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
        "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=2`,
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
        "-shortest", "-y", join(clips, name),
      ]);
    }
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: [
          { text: "hello", start: 0.4, end: 0.8 },
          { text: "world", start: 0.9, end: 1.3 },
          { text: "again", start: 2.4, end: 2.9 },
        ],
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "a no-render folder run reports per-phase timings and prints the time line",
    async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        const result = await produce(clips, {
          cleanup: "standard",
          render: false,
          mezzanine: false,
          transcript: join(dir, "transcript.json"),
          workdir: join(dir, "work"),
        });
        expect(result.rendered).toBe(false);
        // The ffmpeg phase (folder concat) actually ran and was measured…
        expect(result.phaseTimings.ffmpeg).toBeGreaterThan(0);
        // …and the phases this run never entered are ABSENT, not zero — a
        // cached/injected transcript must not read as a 0ms whisper run.
        expect(result.phaseTimings.transcribe).toBeUndefined();
        expect(result.phaseTimings.llm).toBeUndefined();
        expect(result.phaseTimings.render).toBeUndefined();
        // The run-log breakdown, in the ▸ voice, with the measured phase in it.
        const timeLine = logs.find((l) => l.startsWith("▸ time: total "));
        expect(timeLine).toBeDefined();
        expect(timeLine).toContain("ffmpeg");
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );

  it(
    "a --review run says the editor is opening instead of the --no-render skip + edit hint",
    async () => {
      // Step 1's report flagged the redundancy: on --review the editor opens
      // itself right after produce returns, so "skipping render" plus an
      // `ossclip edit …` hint told the user to do what was already happening.
      // Warm re-run of the same workdir, so this costs the caches, not a
      // second full analysis.
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        const result = await produce(clips, {
          cleanup: "standard",
          render: false,
          review: true,
          mezzanine: false,
          transcript: join(dir, "transcript.json"),
          workdir: join(dir, "work"),
        });
        expect(result.rendered).toBe(false);
        expect(
          logs.find((l) => l.includes("review: opening the editor")),
        ).toBeDefined();
        expect(logs.find((l) => l.includes("skipping render (--no-render)"))).toBeUndefined();
        expect(logs.find((l) => l.startsWith("▸ edit it:"))).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    },
    120_000,
  );
});
