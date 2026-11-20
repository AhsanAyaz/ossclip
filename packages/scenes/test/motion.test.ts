import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTION_POP_SEC,
  ENTER_SEC,
  EXIT_SEC,
  beatStarts,
  bobPx,
  bump,
  caretOn,
  countAt,
  easeInOut,
  easeOutQuad,
  entranceExitSec,
  parseCount,
  popScale,
  typedChars,
} from "../src/motion";

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

// The explainer look's motion (plan Task 3). Every helper is a pure function
// of seconds since the item's start, so a still at frame N is the same file
// on every run — the stills harness depends on it.
describe("popScale", () => {
  it("starts at 0, overshoots, and lands exactly on 1", () => {
    expect(popScale(0)).toBe(0);
    expect(popScale(0.35)).toBe(1);
    expect(popScale(9)).toBe(1);
    expect(Math.max(...[0.2, 0.25, 0.3].map((t) => popScale(t)))).toBeGreaterThan(1);
  });

  it("is 0 before its start and honours a custom duration", () => {
    expect(popScale(-1)).toBe(0);
    expect(popScale(0.5, 0.5)).toBe(1);
    expect(popScale(0.35, 0.5)).toBeGreaterThan(0);
  });
});

describe("easeInOut", () => {
  it("runs 0 → 0.5 → 1 over the duration and clamps outside it", () => {
    expect(easeInOut(0, 1)).toBe(0);
    expect(easeInOut(0.5, 1)).toBeCloseTo(0.5, 10);
    expect(easeInOut(1, 1)).toBe(1);
    expect(easeInOut(-1, 1)).toBe(0);
    expect(easeInOut(5, 1)).toBe(1);
  });

  it("is slow at both ends", () => {
    expect(easeInOut(0.1, 1)).toBeLessThan(0.1);
    expect(easeInOut(0.9, 1)).toBeGreaterThan(0.9);
  });

  it("treats a zero duration as already done rather than dividing by it", () => {
    expect(easeInOut(0, 0)).toBe(1);
  });
});

describe("typedChars", () => {
  it("types at 32 characters a second and stops at the end", () => {
    expect(typedChars(0, 40)).toBe(0);
    expect(typedChars(0.5, 40)).toBe(16);
    expect(typedChars(9, 40)).toBe(40);
    expect(typedChars(-1, 40)).toBe(0);
  });

  it("always answers an integer", () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 10, noNaN: true }), fc.nat(200), (t, total) => {
        const n = typedChars(t, total);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(total);
      }),
    );
  });

  it("does not lose a character to float error on a frame boundary", () => {
    // 3 frames at 30fps is 0.1 s, which is 3.2 chars; 30 frames is exactly 32.
    expect(typedChars(30 / 30, 100)).toBe(32);
    expect(typedChars(15 / 30, 100)).toBe(16);
  });
});

describe("caretOn", () => {
  it("is on for the first half of every second", () => {
    expect(caretOn(0)).toBe(true);
    expect(caretOn(0.49)).toBe(true);
    expect(caretOn(0.5)).toBe(false);
    expect(caretOn(0.99)).toBe(false);
    expect(caretOn(1)).toBe(true);
    expect(caretOn(2.25)).toBe(true);
  });
});

describe("bobPx", () => {
  it("swings ±amplitude around 0 over one period", () => {
    expect(bobPx(0)).toBeCloseTo(0, 10);
    expect(bobPx(0.6)).toBeCloseTo(7, 10);
    expect(bobPx(1.8)).toBeCloseTo(-7, 10);
    expect(bobPx(2.4)).toBeCloseTo(0, 10);
    expect(bobPx(1, 10, 4)).toBeCloseTo(10, 10);
  });
});

describe("bump", () => {
  it("goes 1 → 1.15 → 1 and rests at 1 outside its window", () => {
    expect(bump(-1)).toBe(1);
    expect(bump(0)).toBe(1);
    expect(bump(0.15)).toBeCloseTo(1.15, 10);
    expect(bump(0.3)).toBe(1);
    expect(bump(9)).toBe(1);
  });
});

describe("beatStarts", () => {
  it("spaces items 0.7 s apart from 0.25 s", () => {
    expect(beatStarts(3)).toEqual([0.25, 0.95, 1.65]);
    expect(beatStarts(0)).toEqual([]);
    expect(beatStarts(2, 1, 0)).toEqual([0, 1]);
  });
});

describe("parseCount", () => {
  it("reads grouped digits, signs and suffixes", () => {
    expect(parseCount("4,494")).toEqual({
      prefix: "",
      number: 4494,
      decimals: 0,
      suffix: "",
      grouped: true,
    });
    expect(parseCount("+242%")).toMatchObject({ prefix: "+", number: 242, suffix: "%" });
    expect(parseCount("-1.5k")).toEqual({
      prefix: "-",
      number: 1.5,
      decimals: 1,
      suffix: "k",
      grouped: false,
    });
    for (const s of ["x", "×", "k", "K", "M", "s"]) {
      expect(parseCount(`3${s}`)).toMatchObject({ number: 3, suffix: s });
    }
  });

  it("refuses anything it could not count back to exactly", () => {
    // A leading ×, a unit word, or digits it would reformat (a leading zero,
    // a misplaced group) must stay as written — the count-up only runs when
    // its last frame IS the source string.
    for (const s of ["×3", "5 min", "", "abc", "1,23", "007", "1.2.3", "$5", ".5", "5%%"]) {
      expect(parseCount(s)).toBeNull();
    }
  });
});

describe("countAt", () => {
  it("counts from 0 to the source string and holds there", () => {
    const p = parseCount("4,494")!;
    expect(countAt(p, 0)).toBe("0");
    expect(countAt(p, 1)).toBe("4,494");
    expect(countAt(p, 5)).toBe("4,494");
    expect(countAt(parseCount("+1.5k")!, 2)).toBe("+1.5k");
  });

  it("keeps the source's sign, suffix, grouping and decimals mid-count", () => {
    expect(countAt(parseCount("+242%")!, 0)).toBe("+0%");
    expect(countAt(parseCount("1.50")!, 0)).toBe("0.00");
    expect(countAt(parseCount("12,000,000")!, 0.5)).toMatch(/^\d{1,3}(,\d{3})*$/);
  });

  it("never passes the target and never goes backwards", () => {
    const p = parseCount("4,494")!;
    let prev = -1;
    for (let f = 0; f <= 30; f++) {
      const n = Number(countAt(p, f / 30).replace(/,/g, ""));
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n).toBeLessThanOrEqual(4494);
      prev = n;
    }
  });

  it("round-trips every string parseCount accepts", () => {
    for (const s of ["0", "7", "4494", "4,494", "+242%", "-3x", "9M", "1.05s", "999,999K"]) {
      expect(countAt(parseCount(s)!, 1)).toBe(s);
    }
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
