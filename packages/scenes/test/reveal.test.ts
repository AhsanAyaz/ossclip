import { describe, expect, it } from "vitest";
import { REVEAL_SPEED_DEFAULT } from "@ossclip/core/browser";
import { enterFrames, enterProgress, entranceStyle, pop } from "../src/anim";
import { revealFrames } from "../src/reveal";

const base = {
  count: 4,
  legacyStepFrames: 6,
  fps: 30,
  durationInFrames: 300,
  cueStartSec: 0,
  props: {},
};

// The latest frame an item can start and still finish entering before the cut.
const LATEST = 300 - enterFrames(30);

const gaps = (xs: readonly number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]!);

describe("revealFrames — legacy", () => {
  it("is today's fixed stagger when nothing reveal-related is set", () => {
    expect(revealFrames(base)).toEqual([0, 6, 12, 18]);
  });

  it("a wrong-length itemAtSec is a NEW plan with edited items: paced, never legacy or misaligned", () => {
    // Spec §7: items added in the editor are paced. 4 items over 0.66 × 285.
    const out = revealFrames({ ...base, itemAtSec: [1, 2, 3] });
    expect(out).toEqual(revealFrames({ ...base, props: { reveal: "paced" } }));
    expect(out).toEqual([0, 63, 125, 188]);
  });

  it("handles zero and one item", () => {
    expect(revealFrames({ ...base, count: 0 })).toEqual([]);
    expect(revealFrames({ ...base, count: 1, props: { pacing: "even" } })).toEqual([0]);
  });
});

describe("revealFrames — paced", () => {
  it("leaves the legacy stagger once any timing prop is set (Review Focus 5)", () => {
    const out = revealFrames({ ...base, props: { pacing: "even" } });
    expect(out).not.toEqual([0, 6, 12, 18]);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(Math.round(REVEAL_SPEED_DEFAULT * LATEST));
  });

  it("even: equal gaps", () => {
    const out = revealFrames({ ...base, props: { pacing: "even", revealSpeed: 0.6 } });
    // 0.6 × (300 − 15) = 171.
    expect(out).toEqual([0, 57, 114, 171]);
  });

  it("accelerate: gaps strictly shrink", () => {
    const g = gaps(revealFrames({ ...base, count: 6, props: { pacing: "accelerate" } }));
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeLessThan(g[i - 1]!);
  });

  it("decelerate: gaps strictly grow", () => {
    const g = gaps(revealFrames({ ...base, count: 6, props: { pacing: "decelerate" } }));
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!);
  });

  it("ease-in-out: first and last gaps longer than every middle gap", () => {
    const g = gaps(revealFrames({ ...base, count: 6, props: { pacing: "ease-in-out" } }));
    const middle = g.slice(1, -1);
    for (const m of middle) {
      expect(g[0]!).toBeGreaterThan(m);
      expect(g[g.length - 1]!).toBeGreaterThan(m);
    }
  });

  it("revealSpeed 1.0: the last item still finishes entering before the cut", () => {
    for (const pacing of ["even", "accelerate", "decelerate", "ease-in-out"]) {
      const out = revealFrames({ ...base, count: 5, props: { pacing, revealSpeed: 1 } });
      expect(Math.max(...out) + enterFrames(30)).toBeLessThanOrEqual(300);
      expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    }
  });

  it("a scene shorter than paced room still lets every item finish (20 frames)", () => {
    for (const pacing of ["even", "accelerate", "decelerate", "ease-in-out"]) {
      const out = revealFrames({
        ...base,
        durationInFrames: 20,
        props: { pacing, revealSpeed: 1 },
      });
      expect(Math.max(...out) + enterFrames(30)).toBeLessThanOrEqual(20);
      expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    }
    // Shorter than one entrance: nothing can finish, so everything starts at 0.
    expect(revealFrames({ ...base, durationInFrames: 10, props: { pacing: "even" } })).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("reveal: paced wins over item times that would sync", () => {
    const out = revealFrames({
      ...base,
      count: 3,
      itemAtSec: [1, 2, 3],
      props: { reveal: "paced", revealSpeed: 0.5 },
    });
    // 0.5 × 285 = 142.5.
    expect(out).toEqual([0, 71, 143]);
  });

  it("auto with too few matches is paced (the shared syncDecision threshold)", () => {
    const out = revealFrames({ ...base, count: 3, itemAtSec: [1, null, null] });
    expect(out).toEqual([0, 94, 188]);
  });

  it("forced synced with no usable item times falls back to paced", () => {
    const paced = revealFrames({ ...base, props: { revealSpeed: 0.5 } });
    expect(revealFrames({ ...base, props: { reveal: "synced", revealSpeed: 0.5 } })).toEqual(
      paced,
    );
    expect(
      revealFrames({
        ...base,
        itemAtSec: [null, null, null, null],
        props: { reveal: "synced", revealSpeed: 0.5 },
      }),
    ).toEqual(paced);
  });
});

describe("revealFrames — synced", () => {
  const synced = { ...base, count: 3, cueStartSec: 9.5 };

  it("puts each item on its word, relative to the cue's final start", () => {
    expect(revealFrames({ ...synced, itemAtSec: [10.0, 11.0, 12.5] })).toEqual([15, 45, 90]);
  });

  it("an item spoken before the final start shows from the first frame", () => {
    expect(revealFrames({ ...synced, itemAtSec: [9.0, 11.0, 12.5] })[0]).toBe(0);
  });

  it("interpolates a middle null strictly between its neighbours", () => {
    const out = revealFrames({
      ...base,
      count: 4,
      cueStartSec: 9.5,
      itemAtSec: [10.0, 11.0, null, 12.5],
    });
    expect(out[1]).toBe(45);
    expect(out[3]).toBe(90);
    expect(out[2]!).toBeGreaterThan(45);
    expect(out[2]!).toBeLessThan(90);
  });

  it("trailing nulls continue past the last match at the paced gap", () => {
    // 4 items, default speed: even paced gap = 0.66 × 285 / 3 = 62.7 frames.
    const out = revealFrames({
      ...base,
      count: 4,
      cueStartSec: 9.5,
      itemAtSec: [10.0, 11.0, 12.5, null],
      props: { reveal: "synced" },
    });
    expect(out).toEqual([15, 45, 90, 153]);
  });

  it("a word said in the last half-second is pulled back so its item finishes entering", () => {
    const out = revealFrames({ ...base, count: 3, itemAtSec: [1, 5, 9.9] });
    expect(out).toEqual([30, 150, LATEST]);
    // Trailing nulls past the end clamp to the same frame.
    const trailing = revealFrames({
      ...base,
      count: 3,
      itemAtSec: [1, 9.5, null],
      props: { reveal: "synced" },
    });
    expect(trailing).toEqual([30, LATEST, LATEST]);
    // And a short synced scene (20 frames) still finishes every item.
    const short = revealFrames({ ...base, durationInFrames: 20, count: 3, itemAtSec: [0, 0.3, 0.6] });
    expect(Math.max(...short) + enterFrames(30)).toBeLessThanOrEqual(20);
  });

  it("forced synced paces leading nulls from the cue start up to the first match", () => {
    const out = revealFrames({
      ...base,
      count: 3,
      cueStartSec: 9.5,
      itemAtSec: [null, 11.0, 12.5],
      props: { reveal: "synced" },
    });
    expect(out).toEqual([0, 45, 90]);
  });
});

describe("enterProgress", () => {
  it("is 0 until the delay, then the same spring shifted by the delay", () => {
    expect(enterProgress(5, 30, 10)).toBe(0);
    expect(enterProgress(18, 30, 10)).toBe(enterProgress(8, 30, 0));
    expect(enterProgress(10 + enterFrames(30), 30, 10)).toBeCloseTo(1, 2);
  });
});

describe("entranceStyle", () => {
  it("undefined is today's pop", () => {
    expect(entranceStyle(undefined, 0.5)).toEqual(pop(0.5));
    expect(entranceStyle("pop", 0.5)).toEqual(pop(0.5));
  });

  it("every style is invisible at 0 and settled at 1", () => {
    for (const s of ["pop", "fade", "rise", "bounce"] as const) {
      expect(entranceStyle(s, 0).opacity).toBe(0);
      expect(entranceStyle(s, 1).opacity).toBe(1);
    }
    expect(entranceStyle("fade", 1).transform).toBeUndefined();
    expect(entranceStyle("bounce", 1).transform).toBe("scale(1)");
  });

  it("bounce overshoots past full size mid-entrance, deterministically", () => {
    const scaleAt = (p: number): number =>
      Number(/scale\(([\d.]+)\)/.exec(String(entranceStyle("bounce", p).transform))![1]);
    const peak = Math.max(...[0.5, 0.6, 0.7, 0.8].map(scaleAt));
    expect(peak).toBeGreaterThan(1);
    expect(entranceStyle("bounce", 0.7)).toEqual(entranceStyle("bounce", 0.7));
  });
});
