import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { produce } from "../src/produce";

/**
 * `--resolution` through a real produce (2026-08-27).
 *
 * The bug this pins cost a 6-minute render before anything caught it: the
 * COMPOSITION is sized from `production.render` (`settings: production.render`
 * in produce.ts) while Remotion additionally applies `scale`, so recording the
 * scaled size in `render` made the render 2160×3840 AND doubled it again —
 * 4320×7680 frames, which h264_videotoolbox refuses outright ("cannot create
 * compression session: -12903"), after every frame had been paid for.
 *
 * The invariant, stated once here: `production.render` describes the FILE (so
 * the exports and the editor do not lie about it, and the mezzanine sizes to
 * it), `render-props.settings` describes the COMPOSITION and stays at the base
 * frame, and `settings × scale === render`.
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

describe.skipIf(!hasFfmpeg)("--resolution", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-resolution-"));
    // A PORTRAIT 4K-ish source, so `auto` has something to keep: 2160 wide is
    // exactly 2× the 1080 base frame.
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=2160x3840:rate=30:duration=4",
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

  const run = async (resolution: "auto" | "1080" | "2160" | undefined, workdir: string) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        render: false,
        mezzanine: false,
        transcript: join(dir, "transcript.json"),
        workdir: join(dir, workdir),
        resolution,
      });
      const production = JSON.parse(
        readFileSync(join(result.workdir, "production.json"), "utf8"),
      ) as { render: { width: number; height: number; fps: number } };
      const props = JSON.parse(
        readFileSync(join(result.workdir, "render-props.json"), "utf8"),
      ) as { settings: { width: number; height: number; fps: number } };
      return { production, props };
    } finally {
      spy.mockRestore();
    }
  };

  it(
    "the default is unchanged: 1080p render, 1080p composition",
    async () => {
      const { production, props } = await run(undefined, "work-default");
      expect(production.render).toEqual({ width: 1080, height: 1920, fps: 30 });
      expect(props.settings.width).toBe(1080);
      expect(props.settings.height).toBe(1920);
    },
    180_000,
  );

  it(
    "auto records the 4K OUTPUT while the composition stays 1080 — the double-scale bug",
    async () => {
      const { production, props } = await run("auto", "work-auto");
      // The file this run describes.
      expect(production.render).toEqual({ width: 2160, height: 3840, fps: 30 });
      // The composition Remotion builds, which `scale: 2` then enlarges ONCE.
      // If this ever equals `production.render`, the render is 4320×7680 and
      // the hardware encoder refuses it at stitch time.
      expect(props.settings.width).toBe(1080);
      expect(props.settings.height).toBe(1920);
    },
    180_000,
  );

  it(
    "an explicit 2160 behaves the same as auto on a 4K source",
    async () => {
      const { production, props } = await run("2160", "work-2160");
      expect(production.render.width).toBe(2160);
      expect(props.settings.width).toBe(1080);
    },
    180_000,
  );
});
