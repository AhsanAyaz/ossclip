import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTION_POP_SEC, ENTER_SEC, EXIT_SEC, easeOutQuad, entranceExitSec } from "../src/motion";

describe("easeOutQuad", () => {
  it("is the exit's existing curve: 0→0, 1→1, fast start", () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
    expect(easeOutQuad(0.5)).toBe(0.75);
  });
});

describe("entranceExitSec", () => {
  it("gives a normal cue the full durations", () => {
    // MIN_SCENE_SEC is 1.2 and both ends total 0.6 — the common case has slack.
    expect(entranceExitSec(1.2)).toEqual({ enterSec: ENTER_SEC, exitSec: EXIT_SEC });
  });

  it("gives a cue exactly as long as both ends the full durations, unshrunk", () => {
    expect(entranceExitSec(ENTER_SEC + EXIT_SEC)).toEqual({
      enterSec: ENTER_SEC,
      exitSec: EXIT_SEC,
    });
  });

  it("shrinks both proportionally when the cue cannot hold both", () => {
    const { enterSec, exitSec } = entranceExitSec(0.3);
    expect(enterSec).toBeCloseTo(0.15, 10);
    expect(exitSec).toBeCloseTo(0.15, 10);
  });

  // The property itself, not two examples of it: two INDEPENDENT clamps can
  // still sum past the duration, and that failure — entrance and exit
  // overlapping, opacities multiplying into a dip mid-life — is invisible in
  // a still and obvious in motion.
  it("never lets the two ends sum past the duration", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 60, noNaN: true }), (durationSec) => {
        const { enterSec, exitSec } = entranceExitSec(durationSec);
        expect(enterSec).toBeGreaterThanOrEqual(0);
        expect(exitSec).toBeGreaterThanOrEqual(0);
        expect(enterSec + exitSec).toBeLessThanOrEqual(durationSec + 1e-9);
      }),
    );
  });

  it("returns zeros for a degenerate cue rather than negatives", () => {
    // A zero or negative duration should not exist, but a graphic that
    // renders static beats one that throws mid-render.
    expect(entranceExitSec(0)).toEqual({ enterSec: 0, exitSec: 0 });
    expect(entranceExitSec(-1)).toEqual({ enterSec: 0, exitSec: 0 });
  });
});

describe("the caption pop duration", () => {
  it("is four frames at 30fps — long enough to read as a rise, not a step", () => {
    expect(CAPTION_POP_SEC * 30).toBeCloseTo(4, 0);
  });
});

describe("no CSS transitions in the render path", () => {
  // Remotion renders by seeking to a frame and screenshotting it — no
  // wall-clock time passes, so a CSS transition animates in the editor's
  // real-time <Player> and SNAPS in the rendered file. CaptionTrack shipped
  // exactly that: a 60ms transition the render never played. This scan pins
  // the bug CLASS, not the one instance.
  it("finds no `transition:` style property under packages/scenes/src", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(path, "utf8");
          // The CSS property shape (`transition: "…"`), not the word — prose
          // like "layout transitions" in comments must not trip this.
          if (/\btransition\s*:\s*["'`]/.test(src)) offenders.push(entry.name);
        }
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    expect(offenders).toEqual([]);
  });
});
