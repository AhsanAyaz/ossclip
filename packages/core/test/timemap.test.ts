import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TimeMap } from "../src/timemap";
import type { Segment } from "../src/schema";

/** Random full partition of [0, D] into alternating keep/remove segments. */
const partitionArb = fc
  .tuple(
    fc.double({ min: 1, max: 600, noNaN: true }),
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: 24 }),
    fc.boolean(),
  )
  .map(([duration, fractions, startKeep]) => {
    const points = [...new Set(fractions.map((f) => f * duration))].sort((a, b) => a - b);
    const bounds = [0, ...points.filter((p) => p > 0 && p < duration), duration];
    const segments: Segment[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const kind = (i % 2 === 0) === startKeep ? "keep" : "remove";
      segments.push({
        srcIn: bounds[i]!,
        srcOut: bounds[i + 1]!,
        kind,
        ...(kind === "remove" ? { reason: "pause" as const } : {}),
      });
    }
    return { duration, segments };
  });

describe("TimeMap invariants (property-based)", () => {
  it("outputDuration equals the sum of kept spans", () => {
    fc.assert(
      fc.property(partitionArb, ({ segments }) => {
        const map = new TimeMap(segments);
        const kept = segments
          .filter((s) => s.kind === "keep")
          .reduce((acc, s) => acc + (s.srcOut - s.srcIn), 0);
        expect(map.outputDuration).toBeCloseTo(kept, 9);
      }),
    );
  });

  it("roundtrips strictly inside kept spans; projects idempotently at edges", () => {
    fc.assert(
      fc.property(partitionArb, fc.double({ min: 0, max: 1, noNaN: true }), ({ segments }, frac) => {
        const map = new TimeMap(segments);
        for (const sp of map.spans) {
          const t = sp.srcIn + frac * (sp.srcOut - sp.srcIn);
          const out = map.toOutput(t);
          expect(out).not.toBeNull();
          // An output instant at an exact cut boundary has two source
          // preimages, so strict roundtrip is only guaranteed in the interior…
          const interior = t > sp.srcIn && t < sp.srcOut && sp.srcOut - sp.srcIn > 1e-6;
          if (interior) {
            expect(map.toSource(out!)).toBeCloseTo(t, 9);
          }
          // …but the projection identity holds everywhere: whichever preimage
          // toSource picks, it maps back to the same output instant.
          const projected = map.toOutput(map.toSource(out!));
          expect(projected).not.toBeNull();
          expect(projected!).toBeCloseTo(out!, 9);
        }
      }),
    );
  });

  it("toOutput is monotonic over kept time and null inside removals", () => {
    fc.assert(
      fc.property(partitionArb, ({ segments }) => {
        const map = new TimeMap(segments);
        let prev = -Infinity;
        for (const sp of map.spans) {
          for (const t of [sp.srcIn, (sp.srcIn + sp.srcOut) / 2, sp.srcOut]) {
            const out = map.toOutput(t);
            expect(out).not.toBeNull();
            expect(out!).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = out!;
          }
        }
        for (const s of segments) {
          if (s.kind === "remove" && s.srcOut - s.srcIn > 1e-6) {
            const mid = (s.srcIn + s.srcOut) / 2;
            // Midpoints of removed regions map to null (edges may touch kept spans).
            expect(map.toOutput(mid)).toBeNull();
          }
        }
      }),
    );
  });

  it("output time is contiguous: spans tile [0, outputDuration]", () => {
    fc.assert(
      fc.property(partitionArb, ({ segments }) => {
        const map = new TimeMap(segments);
        let cursor = 0;
        for (const sp of map.spans) {
          expect(sp.outIn).toBeCloseTo(cursor, 9);
          cursor = sp.outOut;
        }
        expect(cursor).toBeCloseTo(map.outputDuration, 9);
      }),
    );
  });

  it("toOutputClamped never exceeds bounds and is monotonic everywhere", () => {
    fc.assert(
      fc.property(partitionArb, ({ duration, segments }) => {
        const map = new TimeMap(segments);
        let prev = 0;
        for (let i = 0; i <= 20; i++) {
          const t = (i / 20) * duration;
          const out = map.toOutputClamped(t);
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(map.outputDuration + 1e-9);
          expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = out;
        }
      }),
    );
  });

  it("rejects overlapping cutlists", () => {
    expect(
      () =>
        new TimeMap([
          { srcIn: 0, srcOut: 2, kind: "keep" },
          { srcIn: 1, srcOut: 3, kind: "keep" },
        ]),
    ).toThrow(/overlap/);
  });
});
