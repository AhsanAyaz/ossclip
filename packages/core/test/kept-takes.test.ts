import { describe, expect, it } from "vitest";
import { carveKeptTakes, keptTakeId } from "../src/kept-takes";
import { resolveSplitPoints, SPLIT_MIN_PIECE_SEC, type Split } from "../src/overrides";
import { TimeMap } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";
import type { Segment } from "../src/schema";

/** Source 0..10 with 5..7 originally removed, then KEPT — the canonical
 * one-vetoed-pause shape the retime-preview tests use. The re-kept cutlist
 * is one long keep, so the live clock is source time verbatim. */
const rekept: Segment[] = [{ srcIn: 0, srcOut: 10, kind: "keep" }];
const liveMap = new TimeMap(rekept);

const take = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  kind: "plain",
  layout: "video-top",
  startSec,
  endSec,
});

describe("keptTakeId", () => {
  it("mints from source milliseconds — stable across recuts and veto toggles", () => {
    expect(keptTakeId(5)).toBe("take-kept-5000");
    expect(keptTakeId(5.0004)).toBe("take-kept-5000");
  });
});

describe("carveKeptTakes", () => {
  it("carves the revived stretch out of the annexing take, at the true boundaries", () => {
    // One take covers 0..10 on the live clock; the kept range is source 5..7.
    const { cues, reports } = carveKeptTakes(
      [take("take-1", 0, 10)],
      [{ srcIn: 5, srcOut: 7 }],
      liveMap,
    );
    expect(reports).toEqual([]);
    expect(cues.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["take-1", 0, 5],
      ["take-kept-5000", 5, 7],
      ["take-1", 7, 10],
    ]);
    // The revived block carries its source range — the timeline's revived
    // state keys on this, never on id sniffing.
    expect(cues[1]!.kept).toEqual({ srcIn: 5, srcOut: 7 });
  });

  it("a DISMISSED range carves the same stable block WITHOUT the kept tag — ordinary footage", () => {
    const { cues } = carveKeptTakes(
      [take("take-1", 0, 10)],
      [{ srcIn: 5, srcOut: 7, dismissed: true }],
      liveMap,
    );
    expect(cues[1]!.id).toBe("take-kept-5000");
    expect(cues[1]!.kept).toBeUndefined();
  });

  it("is idempotent — a block produce already carved is not carved again", () => {
    const first = carveKeptTakes([take("take-1", 0, 10)], [{ srcIn: 5, srcOut: 7 }], liveMap);
    const second = carveKeptTakes(first.cues, [{ srcIn: 5, srcOut: 7 }], liveMap);
    expect(second.cues).toEqual(first.cues);
  });

  it("a range at the take's own start leaves no leading sliver", () => {
    const { cues } = carveKeptTakes([take("take-1", 0, 10)], [{ srcIn: 0, srcOut: 2 }], liveMap);
    expect(cues.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["take-kept-0", 0, 2],
      ["take-1", 2, 10],
    ]);
  });

  it("a range under a GRAPHIC cue is left alone with a report — the graphic owns the window", () => {
    const graphic: SceneCue = {
      id: "scene-0",
      kind: "graphic",
      layout: "lower-third",
      component: "TitleCard",
      props: { title: "T" },
      startSec: 4,
      endSec: 8,
    };
    const { cues, reports } = carveKeptTakes([graphic], [{ srcIn: 5, srcOut: 7 }], liveMap);
    expect(cues).toEqual([graphic]);
    expect(reports[0]).toContain('graphic "scene-0"');
  });

  it("a range shorter than the minimum piece carves nothing, out loud", () => {
    const { cues, reports } = carveKeptTakes(
      [take("take-1", 0, 10)],
      [{ srcIn: 5, srcOut: 5 + SPLIT_MIN_PIECE_SEC / 2 }],
      liveMap,
    );
    expect(cues).toHaveLength(1);
    expect(reports[0]).toContain("shorter than");
  });

  it("a range whose material is (still) removed on this clock carves nothing", () => {
    // 5..7 removed on THIS map — toOutput(5.5) is null territory.
    const removedMap = new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 7, srcOut: 10, kind: "keep" },
    ] as Segment[]);
    const { cues, reports } = carveKeptTakes(
      [take("take-1", 0, 8)],
      [{ srcIn: 5.2, srcOut: 6.8 }],
      removedMap,
    );
    expect(cues).toHaveLength(1);
    expect(reports[0]).toContain("not in this cut");
  });
});

describe("resolveSplitPoints", () => {
  const splits: Split[] = [
    { at: 2, id: "2000" },
    { at: 9, src: 9, id: "9000" },
    { src: 6, id: "6000" },
  ];

  it("src wins when present; src-less passes `at` through", () => {
    const { points, reports } = resolveSplitPoints(splits, liveMap);
    expect(reports).toEqual([]);
    expect(points).toEqual([
      { at: 2, id: "2000" },
      { at: 9, id: "9000" },
      { at: 6, id: "6000" },
    ]);
  });

  it("a src inside removed material is inert with a report — never clamped to a seam", () => {
    const removedMap = new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 7, srcOut: 10, kind: "keep" },
    ] as Segment[]);
    const { points, reports } = resolveSplitPoints([{ src: 6, id: "6000" }], removedMap);
    expect(points).toEqual([]);
    expect(reports[0]).toContain('split "6000"');
    expect(reports[0]).toContain("inert");
  });
});

describe("carveKeptTakes — the head-hole case (live drive 2026-08-26)", () => {
  it("a revived removal at the video's head, which no cue annexed, mints a standalone block", () => {
    // The retimed neighbour starts AFTER the revived head (toSource's
    // earlier-preimage rule), so 0..1.5 is a hole on the live clock.
    const neighbour = take("take-0", 1.5, 10);
    const { cues, reports } = carveKeptTakes([neighbour], [{ srcIn: 0, srcOut: 1.5 }], liveMap);
    expect(reports).toEqual([]);
    expect(cues.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["take-kept-0", 0, 1.5],
      ["take-0", 1.5, 10],
    ]);
    expect(cues[0]!.kind).toBe("plain");
    expect(cues[0]!.layout).toBe(neighbour.layout);
    expect(cues[0]!.kept).toEqual({ srcIn: 0, srcOut: 1.5 });
  });

  it("a dismissed head hole mints the block without the kept tag", () => {
    const { cues } = carveKeptTakes(
      [take("take-0", 1.5, 10)],
      [{ srcIn: 0, srcOut: 1.5, dismissed: true }],
      liveMap,
    );
    expect(cues[0]!.id).toBe("take-kept-0");
    expect(cues[0]!.kept).toBeUndefined();
  });
});
