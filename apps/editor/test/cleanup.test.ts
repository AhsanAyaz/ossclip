import { describe, expect, it } from "vitest";
import { RemovalReasonSchema } from "@ossclip/core";
import type { KeptSpan, Segment } from "@ossclip/core/browser";
import {
  REMOVAL_NO_REASON_COLOR,
  REMOVAL_REASON_COLOR,
  removalLabel,
  removalSeams,
} from "../src/cleanup";

/** Two kept spans with a removal between them — the canonical shape produce
 * writes: a full partition of [0, 20] with one cut at 8..11. */
const spans: KeptSpan[] = [
  { srcIn: 0, srcOut: 8, outIn: 0, outOut: 8 },
  { srcIn: 11, srcOut: 20, outIn: 8, outOut: 17 },
];

const remove = (srcIn: number, srcOut: number, reason?: Segment["reason"]): Segment => ({
  srcIn,
  srcOut,
  kind: "remove",
  ...(reason ? { reason } : {}),
});

describe("removalSeams", () => {
  it("a removal between two kept spans lands on exactly the output boundary they share", () => {
    const seams = removalSeams([remove(8, 11, "pause")], spans);
    expect(seams).toHaveLength(1);
    // srcIn=8 is the first span's srcOut AND inside its closed interval —
    // exact containment answers outOut=8, which is also the second span's
    // outIn: the one seam both kept spans share.
    expect(seams[0]!.outSec).toBe(8);
  });

  it("a removal at the very start clamps to 0", () => {
    const s: KeptSpan[] = [{ srcIn: 2, srcOut: 10, outIn: 0, outOut: 8 }];
    const seams = removalSeams([remove(0, 2, "silence")], s);
    expect(seams[0]!.outSec).toBe(0);
  });

  it("keep spans and zero-width removes draw nothing — nothing was removed there", () => {
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 8, kind: "keep" },
      remove(8, 8, "pause"),
      { srcIn: 8, srcOut: 20, kind: "keep" },
    ];
    expect(removalSeams(cutlist, spans)).toEqual([]);
  });

  it("no spans means NO seams — the restore seam's misleading-0% rule, inherited", () => {
    // `sourceToOutputClamped([], …)` answers 0 as a fallback, not a position;
    // a marker painted there would claim the timeline's start for a removal
    // that never touched it. Absent beats misleading.
    expect(removalSeams([remove(8, 11, "pause")], [])).toEqual([]);
  });

  it("adjacent removals with different reasons share the position but get distinct stack slots", () => {
    // 8..10 (pause) and 10..11 (filler) are contiguous cuts: BOTH edges are
    // inside the removed region, so both clamp to the one seam at out=8 —
    // without stackIndex the second marker would paint exactly over the
    // first and only one would be hoverable.
    const seams = removalSeams([remove(8, 10, "pause"), remove(10, 11, "filler")], spans);
    expect(seams.map((s) => s.outSec)).toEqual([8, 8]);
    expect(seams.map((s) => s.stackIndex)).toEqual([0, 1]);
  });

  it("removals at different positions each start their own stack", () => {
    const seams = removalSeams(
      [remove(0, 0.5, "silence"), remove(8, 11, "pause")],
      [
        { srcIn: 0.5, srcOut: 8, outIn: 0, outOut: 7.5 },
        { srcIn: 11, srcOut: 20, outIn: 7.5, outOut: 16.5 },
      ],
    );
    expect(seams.map((s) => s.stackIndex)).toEqual([0, 0]);
  });

  it("carries the per-reason colour, and the no-reason grey for a reasonless remove", () => {
    const seams = removalSeams([remove(8, 10, "retake"), remove(10, 11)], spans);
    expect(seams[0]!.color).toBe(REMOVAL_REASON_COLOR.retake);
    expect(seams[1]!.color).toBe(REMOVAL_NO_REASON_COLOR);
  });
});

describe("removalLabel", () => {
  it("reads reason first, duration in SOURCE seconds — 'pause · 2.3s removed'", () => {
    expect(removalLabel({ srcIn: 10, srcOut: 12.3, reason: "pause" })).toBe(
      "pause · 2.3s removed",
    );
  });

  it("a reasonless remove states only what is knowable", () => {
    expect(removalLabel({ srcIn: 10, srcOut: 12 })).toBe("2.0s removed");
  });
});

describe("REMOVAL_REASON_COLOR", () => {
  it("is total over the RemovalReason vocabulary — a new reason must fail here, loudly", () => {
    // The Record type already fails typecheck on a missing key; this pins the
    // runtime side against the schema's own options so the two vocabularies
    // cannot drift even through a cast.
    expect(Object.keys(REMOVAL_REASON_COLOR).sort()).toEqual(
      [...RemovalReasonSchema.options].sort(),
    );
  });

  it("every reason gets its OWN colour — a shared hue would merge two categories at a glance", () => {
    const colors = Object.values(REMOVAL_REASON_COLOR);
    expect(new Set(colors).size).toBe(colors.length);
    // And none may collide with the editor's three claimed hues: selection
    // blue, restore red, snap yellow (see the map's doc comment).
    for (const claimed of ["#5b8cff", "#FF5C5C", "#FFE14D", REMOVAL_NO_REASON_COLOR]) {
      expect(colors).not.toContain(claimed);
    }
  });
});
