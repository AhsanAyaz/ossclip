import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  isSrcTiming,
  resolveSrcTimingPins,
  resolveTimingPin,
} from "../src/overrides";
import { TimeMap } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";
import type { Segment } from "../src/schema";

/**
 * Source-anchored scene timing (2026-08-26): `scenes[*].timing` was the last
 * old-clock field in the doc, and under a live cleanup veto a dragged block
 * was stored in LIVE seconds against a key that meant LAST RENDER seconds —
 * so it landed seconds away and snapped back. These tests pin the two shapes
 * apart and the resolution posture between them.
 */

const cue = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  layout: "video-top",
  component: "TerminalMock",
  props: {},
  startSec,
  endSec,
});

/** 0–10s and 20–30s of the source kept: output 0–10 is source 0–10, output
 * 10–20 is source 20–30, and source 10–20 is REMOVED (`toOutput` → null). */
const cutlist: Segment[] = [
  { srcIn: 0, srcOut: 10, kind: "keep" },
  { srcIn: 10, srcOut: 20, kind: "remove", reason: "filler" },
  { srcIn: 20, srcOut: 30, kind: "keep" },
];
const map = (): TimeMap => new TimeMap(cutlist);

describe("SceneTimingSchema (the union)", () => {
  it("parses the legacy output-clock shape unchanged", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    expect(doc.scenes["scene-0"]!.timing).toEqual({ startSec: 2, endSec: 6 });
    expect(isSrcTiming(doc.scenes["scene-0"]!.timing!)).toBe(false);
  });

  it("parses the src-anchored shape", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { srcStart: 21.5, srcEnd: 25.25 } } },
    });
    expect(doc.scenes["scene-0"]!.timing).toEqual({ srcStart: 21.5, srcEnd: 25.25 });
    expect(isSrcTiming(doc.scenes["scene-0"]!.timing!)).toBe(true);
  });

  it("a doc written before this arm existed round-trips byte-identically", () => {
    const raw = {
      scenes: {
        "scene-0": { props: { value: "9%" }, elements: {}, timing: { startSec: 2, endSec: 6 } },
      },
    };
    const doc = OverrideDocSchema.parse(raw);
    expect(JSON.parse(JSON.stringify(doc.scenes["scene-0"]!.timing))).toEqual(raw.scenes["scene-0"].timing);
  });

  it("refuses an inverted or zero-width src window — nothing downstream re-orders it", () => {
    for (const timing of [
      { srcStart: 8, srcEnd: 4 },
      { srcStart: 8, srcEnd: 8 },
    ]) {
      expect(() => OverrideDocSchema.parse({ scenes: { s: { timing } } })).toThrow();
    }
  });

  it("refuses a half-shape rather than guessing which clock it meant", () => {
    expect(() =>
      OverrideDocSchema.parse({ scenes: { s: { timing: { startSec: 2, srcEnd: 6 } } } }),
    ).toThrow();
  });
});

describe("resolveTimingPin", () => {
  it("passes a legacy window through verbatim — those numbers are already output", () => {
    expect(resolveTimingPin({ startSec: 2, endSec: 6 }, map())).toEqual({ startSec: 2, endSec: 6 });
  });

  it("maps a src window onto the clock in hand, exactly", () => {
    // Source 21–25 sits in the second kept span, which starts at output 10.
    expect(resolveTimingPin({ srcStart: 21, srcEnd: 25 }, map())).toEqual({
      startSec: 11,
      endSec: 15,
    });
  });

  it("is INERT (null) when either edge sits in material this cut removed", () => {
    expect(resolveTimingPin({ srcStart: 12, srcEnd: 14 }, map())).toBeNull();
    // Half in, half out — never half-resolved, never clamped onto the seam.
    expect(resolveTimingPin({ srcStart: 5, srcEnd: 14 }, map())).toBeNull();
  });
});

describe("resolveSrcTimingPins (the pre-pass)", () => {
  it("hands the SAME doc back when nothing is src-anchored", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    const out = resolveSrcTimingPins(doc, map());
    expect(out.doc).toBe(doc);
    expect(out.reports).toEqual([]);
  });

  it("rewrites src entries to output seconds and leaves legacy ones alone", () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-0": { timing: { srcStart: 21, srcEnd: 25 } },
        "scene-1": { timing: { startSec: 2, endSec: 6 } },
      },
    });
    const out = resolveSrcTimingPins(doc, map());
    expect(out.doc.scenes["scene-0"]!.timing).toEqual({ startSec: 11, endSec: 15 });
    expect(out.doc.scenes["scene-1"]!.timing).toEqual({ startSec: 2, endSec: 6 });
    expect(out.reports).toEqual([]);
    // The caller's doc is never edited in place — it is the user's own data,
    // and these resolved numbers must never reach the overrides.json write.
    expect(doc.scenes["scene-0"]!.timing).toEqual({ srcStart: 21, srcEnd: 25 });
  });

  it("drops an inert pin with a report, keeping the scene's other edits", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "9%" }, timing: { srcStart: 12, srcEnd: 14 } } },
    });
    const out = resolveSrcTimingPins(doc, map());
    expect(out.doc.scenes["scene-0"]!.timing).toBeUndefined();
    expect(out.doc.scenes["scene-0"]!.props).toEqual({ value: "9%" });
    expect(out.reports).toEqual([
      'pinned timing for "scene-0" is not in this cut — pin inert',
    ]);
  });

  it("is what makes a src pin land: pre-pass then merge pins the cue on THIS run's clock", () => {
    // produce's own sequence (`resolveSrcTimingPins(overrideDoc, map)` then
    // `applyOverrides`), asserted at core level.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { srcStart: 21, srcEnd: 25 } } },
    });
    const { cues } = applyOverrides([cue("scene-0", 0, 4)], resolveSrcTimingPins(doc, map()).doc);
    expect(cues[0]!.startSec).toBe(11);
    expect(cues[0]!.endSec).toBe(15);
    expect(cues[0]!.pinned).toBe(true);
  });

  it("an UNRESOLVED src pin reaching applyOverrides is ignored, never guessed at", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { srcStart: 21, srcEnd: 25 } } },
    });
    const { cues } = applyOverrides([cue("scene-0", 0, 4)], doc);
    expect(cues[0]!.startSec).toBe(0);
    expect(cues[0]!.endSec).toBe(4);
    expect(cues[0]!.pinned).toBeFalsy();
  });
});
