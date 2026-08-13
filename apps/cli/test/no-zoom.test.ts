import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { produce } from "../src/produce";

/**
 * `--no-zoom` (field complaint 2026-08-13): the compounded camera motion —
 * idle push (1.05) × alternating cut punch-in (1.07) — on a face-cropped
 * close-up trims the crown by the tail of a low-cut clip, and the only
 * existing relief was per-scene (`autoZoom: false` in the editor). This is
 * the global switch: zoomPlan empties and `staticCamera` rides render-props
 * so the composition can neutralise the punch-in too — one flag, both
 * drivers, same absent-means-default contract as `watermark`.
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

describe.skipIf(!hasFfmpeg)("--no-zoom", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-no-zoom-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: [
          { text: "hello", start: 0.3, end: 0.7 },
          { text: "there", start: 2.5, end: 3.0 },
        ],
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (zoom: boolean | undefined, workdir: string) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        render: false,
        mezzanine: false,
        transcript: join(dir, "transcript.json"),
        workdir: join(dir, workdir),
        zoom,
      });
      return JSON.parse(
        readFileSync(join(result.workdir, "render-props.json"), "utf8"),
      ) as { zoomPlan: unknown[]; staticCamera?: boolean };
    } finally {
      spy.mockRestore();
    }
  };

  it(
    "zoom: false empties the plan and stamps staticCamera into render-props",
    async () => {
      const props = await run(false, "work-off");
      expect(props.zoomPlan).toEqual([]);
      expect(props.staticCamera).toBe(true);
    },
    120_000,
  );

  it(
    "default keeps the idle plan and writes NO staticCamera key — absent means default, byte-compatible with pre-flag props",
    async () => {
      const props = await run(undefined, "work-on");
      expect(props.zoomPlan.length).toBeGreaterThan(0);
      expect("staticCamera" in props).toBe(false);
    },
    120_000,
  );
});
