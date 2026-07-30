import { describe, expect, it } from "vitest";
import { frameWindow } from "../src/frames";

/**
 * FINDINGS §115. Adjacent <Sequence> windows must never share a frame: the
 * seconds don't overlap, so the defect is invisible in the timings and shows
 * up only in the render, as one frame carrying two captions / two graphics /
 * two video spans.
 */

/** The old idiom, kept here as the thing these tests exist to prevent. */
const roundedDuration = (startSec: number, endSec: number, fps: number) => ({
  from: Math.round(startSec * fps),
  durationInFrames: Math.max(1, Math.round((endSec - startSec) * fps)),
});

const lastFrame = (w: { from: number; durationInFrames: number }) =>
  w.from + w.durationInFrames - 1;

describe("frameWindow (§115: the end frame comes from the end TIME)", () => {
  it("the real collision: 'your rules.' must not reach into 'And number five'", () => {
    // Verbatim from the render that showed two captions stacked at 46.00s —
    // the pair straddles a cue boundary (full-bleed → blurred-behind), which
    // is why they resolved to different anchors and the overlap was visible.
    const fps = 30;
    const a = frameWindow(45.25, 46.0, fps);
    const b = frameWindow(46.0, 46.76, fps);
    expect(lastFrame(a)).toBeLessThan(b.from);

    // And the old idiom really did collide on this input — if this ever stops
    // being true the regression has lost its teeth.
    const oldA = roundedDuration(45.25, 46.0, fps);
    const oldB = roundedDuration(46.0, 46.76, fps);
    expect(lastFrame(oldA)).toBeGreaterThanOrEqual(oldB.from);
  });

  it("no adjacent pair in the real 77-line caption track shares a frame", () => {
    // Verbatim line spans from the render that showed the defect. The old
    // idiom collided on 8 of these 76 transitions; 3 of those straddled a cue
    // boundary and were visible on screen.
    const fps = 30;
    const lines: Array<[number, number]> = [
      [0.2, 1.29], [1.29, 2.35], [2.35, 3], [3, 3.73], [3.73, 4.8], [4.8, 5.51],
      [5.51, 6.08], [6.08, 7.25], [7.25, 8.19], [8.19, 8.93], [8.93, 10.08],
      [10.08, 10.88], [10.88, 11.96], [11.96, 12.69], [12.69, 13.42], [13.42, 14.37],
      [14.37, 15.17], [15.17, 16.13], [16.13, 17.04], [17.04, 17.97], [17.97, 18.65],
      [18.65, 19.81], [19.81, 20.5], [20.5, 21.31], [21.31, 22.16], [22.16, 22.72],
      [22.72, 23.57], [23.57, 23.98], [23.98, 25.12], [25.12, 25.76], [25.76, 26.69],
      [26.69, 27.54], [27.54, 28.45], [28.45, 29.52], [29.77, 30.79], [30.79, 31.29],
      [31.29, 32.36], [32.36, 32.55], [32.55, 33.69], [33.69, 34.46], [34.46, 35.6],
      [35.6, 36.62], [36.62, 37.22], [37.22, 37.75], [37.75, 38.5], [38.5, 39.14],
      [39.14, 39.76], [39.76, 40.91], [40.91, 41.64], [41.64, 42.44], [42.44, 43.51],
      [43.51, 44.18], [44.18, 45.25], [45.25, 46], [46, 46.76], [46.76, 47.39],
      [47.39, 48.51], [48.51, 49.28], [49.28, 50], [50, 50.63], [50.63, 51.44],
      [51.44, 52.39], [52.39, 53.5], [53.5, 54.44], [54.44, 55.13], [55.13, 55.79],
      [55.79, 56.53], [56.53, 56.9], [56.9, 57.84], [57.84, 58.29], [58.29, 59.3],
      [59.3, 59.74], [59.74, 60.46], [60.46, 61.12], [61.12, 62.28], [62.28, 63],
      [63, 64.167],
    ];
    let collisionsUnderOldIdiom = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const [s, e] = lines[i]!;
      const [ns, ne] = lines[i + 1]!;
      expect(lastFrame(frameWindow(s, e, fps)), `line ${i} (${s}→${e})`).toBeLessThan(
        frameWindow(ns, ne, fps).from,
      );
      if (lastFrame(roundedDuration(s, e, fps)) >= roundedDuration(ns, ne, fps).from) {
        collisionsUnderOldIdiom++;
      }
    }
    expect(collisionsUnderOldIdiom).toBe(8);
  });

  it("holds the no-shared-frame invariant across fps and arbitrary boundaries", () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      let t = 0;
      for (let i = 0; i < 400; i++) {
        // Steps that land all over the frame grid, including exactly on .5 —
        // where the two roundings disagree. Every step is at least one frame
        // long; sub-frame windows are the documented carve-out below.
        const next = t + 1 / fps + ((i * 7919) % 997) / 3000;
        const w = frameWindow(t, next, fps);
        const after = frameWindow(next, next + 0.4, fps);
        expect(lastFrame(w), `fps=${fps} t=${t}`).toBeLessThan(after.from);
        t = next;
      }
    }
  });

  it("a sub-frame window still gets one frame rather than vanishing", () => {
    // The one case that CAN share a frame, on purpose: a window shorter than
    // a frame would otherwise render nothing at all, and a caption that never
    // appears is worse than one that briefly shares a frame with its
    // neighbour.
    const w = frameWindow(10.0, 10.001, 30);
    expect(w.durationInFrames).toBe(1);
    expect(frameWindow(10.0, 10.0, 30).durationInFrames).toBe(1);
  });

  it("start and end are each rounded to the nearest frame", () => {
    expect(frameWindow(1.0, 2.0, 30)).toEqual({ from: 30, durationInFrames: 30 });
    // 1.49 frames of lead-in rounds to 1, not truncated to 0.
    expect(frameWindow(0.049, 1.0, 30).from).toBe(1);
  });
});
