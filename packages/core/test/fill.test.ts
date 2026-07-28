import { describe, expect, it } from "vitest";
import { MIN_PLAIN_SEC, fillPlainCues } from "../src/fill";
import type { SceneCue } from "../src/scene-schema";

const graphic = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "L", value: "V" },
  startSec,
  endSec,
});

const windows = (cues: SceneCue[]) => cues.map((c) => [c.startSec, c.endSec] as const);

describe("fillPlainCues", () => {
  it("covers the whole timeline with no overlap and no gap left standing", () => {
    const filled = fillPlainCues([graphic("scene-0", 2, 5), graphic("scene-1", 10, 13)], {
      outputDurationSec: 20,
    });
    // Time-sorted, tiling [0, 20]: each cue starts where the previous ended.
    let cursor = 0;
    for (const [start, end] of windows(filled)) {
      expect(start).toBeCloseTo(cursor, 9);
      expect(end).toBeGreaterThan(start);
      cursor = end;
    }
    expect(cursor).toBeCloseTo(20, 9);
    const plain = filled.filter((c) => c.kind === "plain");
    expect(plain.map((c) => c.id)).toEqual(["take-0", "take-0-1", "take-0-2"]);
    for (const p of plain) {
      expect(p.layout).toBe("full-bleed");
      expect(p.component).toBeUndefined();
      expect(p.props).toBeUndefined();
    }
  });

  it("never straddles a cut: gaps split at every clip start inside them", () => {
    const filled = fillPlainCues([graphic("scene-0", 2, 5)], {
      outputDurationSec: 20,
      clipStarts: [0, 8, 15],
    });
    const plain = filled.filter((c) => c.kind === "plain");
    for (const p of plain) {
      for (const cut of [8, 15]) {
        const straddles = p.startSec < cut - 1e-9 && p.endSec > cut + 1e-9;
        expect(straddles, `${p.id} straddles the cut at ${cut}s`).toBe(false);
      }
    }
    // One plain cue per continuous take: [5,8) in clip 0, [8,15) all of clip
    // 1, [15,20) all of clip 2 — plus [0,2) before the first graphic.
    expect(plain.map((c) => c.id)).toEqual(["take-0", "take-0-1", "take-1", "take-2"]);
  });

  it("drops pieces under MIN_PLAIN_SEC — the assembler's breathing gaps never become blocks", () => {
    const filled = fillPlainCues(
      [graphic("scene-0", 0, 5), graphic("scene-1", 5.05, 10)],
      { outputDurationSec: 10.3 },
    );
    // The 0.05s inter-scene gap and the 0.3s tail are both under the floor.
    expect(filled.filter((c) => c.kind === "plain")).toEqual([]);
    expect(MIN_PLAIN_SEC).toBeGreaterThan(0.3);
  });

  it("keeps ids stable in one clip when a graphic in ANOTHER clip changes", () => {
    const opts = { outputDurationSec: 20, clipStarts: [0, 8] };
    const before = fillPlainCues([graphic("a", 2, 5), graphic("b", 10, 12)], opts);
    const after = fillPlainCues([graphic("a", 2, 5), graphic("b", 11, 13)], opts);
    const clip0 = (cues: SceneCue[]) =>
      cues.filter((c) => c.kind === "plain" && c.startSec < 8).map((c) => [c.id, c.startSec, c.endSec]);
    expect(clip0(after)).toEqual(clip0(before));
  });

  it("a clip's first plain piece keeps the bare take id, so a merge lands back on it", () => {
    const opts = { outputDurationSec: 20, clipStarts: [0, 8] };
    // A graphic splits clip 1 into two pieces…
    const split = fillPlainCues([graphic("a", 10, 12)], opts);
    expect(split.filter((c) => c.kind === "plain").map((c) => c.id)).toEqual([
      "take-0",
      "take-1",
      "take-1-1",
    ]);
    // …deleting it merges them back into ONE piece with the unsuffixed id:
    // an override on `take-1` survives; one on `take-1-1` becomes an orphan.
    const merged = fillPlainCues([], opts);
    expect(merged.map((c) => c.id)).toEqual(["take-0", "take-1"]);
  });

  it("returns the input untouched (sorted) when there is no duration to fill", () => {
    const cues = [graphic("a", 2, 5)];
    expect(fillPlainCues(cues, { outputDurationSec: 0 })).toEqual(cues);
  });
});
