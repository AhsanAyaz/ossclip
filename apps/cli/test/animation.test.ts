import { describe, expect, it, vi } from "vitest";
import {
  ansi,
  formatTimecode,
  renderProgressBar,
  StageAnimator,
  RenderTimelineHUD,
  printProductionCompleteBanner,
} from "../src/ui/animation";

describe("CLI Animation & UI engine", () => {
  describe("formatTimecode", () => {
    it("formats 0 seconds properly", () => {
      expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    });

    it("formats fractional seconds with frame accuracy", () => {
      // 1.5 seconds at 30 fps = 45 frames -> 1 sec, 15 frames
      expect(formatTimecode(1.5, 30)).toBe("00:00:01:15");
    });

    it("formats minutes and hours", () => {
      // 3661.1 seconds = 1h 1m 1s 3 frames at 30fps
      expect(formatTimecode(3661.1, 30)).toBe("01:01:01:03");
    });
  });

  describe("renderProgressBar", () => {
    it("renders empty bar at 0 progress", () => {
      const bar = renderProgressBar(0, 10);
      expect(bar).toContain("░░░░░░░░░░");
    });

    it("renders full bar at 1.0 progress", () => {
      const bar = renderProgressBar(1.0, 10);
      expect(bar).not.toContain("░");
      expect(bar).toContain("█");
    });

    it("renders intermediate progress with custom styles", () => {
      const bar = renderProgressBar(0.5, 20, { gradient: "emerald" });
      expect(bar).toBeDefined();
      expect(bar.length).toBeGreaterThan(0);
    });

    it("clamps negative and out-of-range progress", () => {
      const barNegative = renderProgressBar(-0.5, 10);
      expect(barNegative).toContain("░░░░░░░░░░");

      const barOverflow = renderProgressBar(2.0, 10);
      expect(barOverflow).not.toContain("░");
    });
  });

  describe("StageAnimator & RenderTimelineHUD in non-TTY mode", () => {
    it("safely starts and stops without crashing when non-interactive", () => {
      const stage = new StageAnimator("TEST", "testing subtitle", "audio");
      stage.start();
      stage.update("new subtitle");
      stage.stop("Finished!");

      const hud = new RenderTimelineHUD({
        totalDurationSec: 30,
        sceneNames: ["CodeDiff", "StatCard"],
        fps: 30,
      });
      hud.start();
      hud.setProgress(0.5);
      hud.stop();
    });
  });

  describe("printProductionCompleteBanner", () => {
    it("prints a rich summary box to console.log", () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logs.push(args.join(" "));
      });

      printProductionCompleteBanner({
        outPath: "output.mp4",
        coverPath: "output.cover.jpg",
        sourceDurationSec: 60,
        outputDurationSec: 40,
        sceneCount: 3,
        llmProvider: "gemini",
        renderTimeSec: 10,
      });

      spy.mockRestore();

      const combined = logs.join("\n");
      expect(combined).toContain("MASTER REEL PRODUCED SUCCESSFULLY");
      expect(combined).toContain("output.mp4");
      expect(combined).toContain("output.cover.jpg");
      expect(combined).toContain("Gemini 3.7 Flash");
      expect(combined).toContain("40.0s");
      expect(combined).toContain("-33% dead air");
    });
  });
});
