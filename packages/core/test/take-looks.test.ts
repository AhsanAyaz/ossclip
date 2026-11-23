import { describe, expect, it } from "vitest";
import {
  applyTakeLooks,
  clearTakeLookFields,
  inScope,
  lookAt,
  normalizeTakeLooks,
  pieceSourceRanges,
  setTakeLook,
  type SrcRange,
  type TakeLook,
  type TakeLookEntry,
} from "../src/take-looks";
import {
  applyOverrides,
  atSplitPoints,
  isLookPieceKey,
  OverrideDocSchema,
  splitCues,
} from "../src/overrides";
import { fillPlainCues } from "../src/fill";
import { carveKeptTakes } from "../src/kept-takes";
import { TimeMap } from "../src/timemap";
import type { SceneCue } from "../src/scene-schema";

/** Source 10..20 kept, 20..25 cut, 25..40 kept: output 0..10 plays source
 * 10..20 and output 10..25 plays source 25..40, so output 10 is a seam. */
const seamMap = new TimeMap([
  { srcIn: 10, srcOut: 20, kind: "keep" },
  { srcIn: 20, srcOut: 25, kind: "remove" },
  { srcIn: 25, srcOut: 40, kind: "keep" },
]);

const entry = (srcIn: number, srcOut: number, look: TakeLook): TakeLookEntry => ({ srcIn, srcOut, look });

const take = (id: string, startSec: number, endSec: number, extra: Partial<SceneCue> = {}): SceneCue => ({
  id,
  kind: "plain",
  layout: "full-bleed",
  startSec,
  endSec,
  ...extra,
});

describe("pieceSourceRanges (take-looks-by-source L1)", () => {
  it("a window inside one kept span is one source range", () => {
    expect(pieceSourceRanges({ startSec: 2, endSec: 5 }, seamMap)).toEqual([{ srcIn: 12, srcOut: 15 }]);
  });

  it("a window across a seam is one range per span, each clipped to its span exactly (B7, S7)", () => {
    expect(pieceSourceRanges({ startSec: 8, endSec: 13 }, seamMap)).toEqual([
      { srcIn: 18, srcOut: 20 },
      { srcIn: 25, srcOut: 28 },
    ]);
  });

  it("a window ending exactly on a seam does not touch the next span", () => {
    expect(pieceSourceRanges({ startSec: 4, endSec: 10 }, seamMap)).toEqual([{ srcIn: 14, srcOut: 20 }]);
  });

  it("a kept block plays its revived source on the live clock", () => {
    // The vetoed removal 20..25 kept: one span, so the live clock plays
    // source 10..40 from output 0, and the carved block sits at 10..15.
    const live = new TimeMap([{ srcIn: 10, srcOut: 40, kind: "keep" }]);
    expect(pieceSourceRanges({ startSec: 10, endSec: 15 }, live)).toEqual([{ srcIn: 20, srcOut: 25 }]);
  });

  it("rounds source seconds to the millisecond", () => {
    expect(pieceSourceRanges({ startSec: 2.00049, endSec: 5.0006 }, seamMap)).toEqual([
      { srcIn: 12, srcOut: 15.001 },
    ]);
  });
});

describe("lookAt (L1, m2)", () => {
  const A: TakeLook = { video: { scale: 2 } };
  const B: TakeLook = { captionY: 0.3 };

  it("picks the entry with the largest total overlap", () => {
    const looks = [entry(10, 13, A), entry(13, 20, B)];
    expect(lookAt(looks, [{ srcIn: 12, srcOut: 15 }])).toEqual(B);
    // Totals over ALL ranges: A wins 1 + 2 against B's 1.
    expect(
      lookAt([entry(10, 13, A), entry(13, 20, B), entry(30, 40, A)], [
        { srcIn: 12, srcOut: 14 },
        { srcIn: 38, srcOut: 40 },
      ]),
    ).toEqual(A);
  });

  it("works per entry, not per distinct look: two entries of one look do not add up", () => {
    // A appears twice for 1.5 s each; B once for 2 s. Per entry, B wins.
    const looks = [entry(10, 11.5, A), entry(11.5, 13.5, B), entry(13.5, 15, A)];
    expect(lookAt(looks, [{ srcIn: 10, srcOut: 15 }])).toEqual(B);
  });

  it("ignores overlaps under 1 ms (the floor)", () => {
    expect(lookAt([entry(11, 12.0004, A)], [{ srcIn: 12, srcOut: 15 }])).toEqual({});
    expect(lookAt([entry(11, 12.001, A)], [{ srcIn: 12, srcOut: 15 }])).toEqual(A);
  });

  it("breaks a tie toward the lower srcIn, whatever the input order", () => {
    const ranges = [{ srcIn: 11, srcOut: 13 }];
    expect(lookAt([entry(10, 12, A), entry(12, 14, B)], ranges)).toEqual(A);
    expect(lookAt([entry(12, 14, B), entry(10, 12, A)], ranges)).toEqual(A);
  });

  it("is {} when nothing overlaps, or when there are no looks or no ranges", () => {
    expect(lookAt([entry(30, 40, A)], [{ srcIn: 10, srcOut: 20 }])).toEqual({});
    expect(lookAt([], [{ srcIn: 10, srcOut: 20 }])).toEqual({});
    expect(lookAt([entry(10, 20, A)], [])).toEqual({});
  });

  it("returns a copy, so a caller mutating it cannot edit the stored look", () => {
    const looks = [entry(10, 20, { video: { scale: 2 } })];
    const got = lookAt(looks, [{ srcIn: 10, srcOut: 20 }]);
    got.video!.scale = 3;
    expect(looks[0]!.look.video!.scale).toBe(2);
  });
});

describe("setTakeLook (L1, R4-S10, R6-2, R6-3, R7-3, R7-11)", () => {
  it("sets the patched unit across the hull, and each part keeps its other fields", () => {
    const looks = [
      entry(10, 15, { video: { scale: 2, dx: 5 }, captionY: 0.3 }),
      entry(15, 20, { layout: "pip-bubble", pip: { cornerRadius: 0.5 } }),
    ];
    const out = setTakeLook(looks, [{ srcIn: 12, srcOut: 18 }], { captionScale: 1.5 });
    expect(out).toEqual([
      entry(10, 12, { video: { scale: 2, dx: 5 }, captionY: 0.3 }),
      entry(12, 15, { video: { scale: 2, dx: 5 }, captionY: 0.3, captionScale: 1.5 }),
      entry(15, 18, { layout: "pip-bubble", pip: { cornerRadius: 0.5 }, captionScale: 1.5 }),
      entry(18, 20, { layout: "pip-bubble", pip: { cornerRadius: 0.5 } }),
    ]);
  });

  it("writes over the hull, including material a live cut removed between the ranges (R6-3)", () => {
    const out = setTakeLook([], [
      { srcIn: 12, srcOut: 14 },
      { srcIn: 16, srcOut: 18 },
    ], { captionY: 0.7 });
    expect(out).toEqual([entry(12, 18, { captionY: 0.7 })]);
  });

  it("expands the framing unit from each part's own current values (R7-3)", () => {
    const looks = [
      entry(10, 15, { video: { scale: 2, dx: 5, dy: 1, volume: 0.5 } }),
      entry(15, 20, { video: { scale: 1.5 } }),
    ];
    const out = setTakeLook(looks, [{ srcIn: 10, srcOut: 20 }], { video: { dx: -3 } });
    expect(out).toEqual([
      entry(10, 15, { video: { scale: 2, dx: -3, dy: 1, volume: 0.5 } }),
      entry(15, 20, { video: { scale: 1.5, dx: -3 } }),
    ]);
  });

  it("deletes unit members absent from both the part and the patch, never defaulting them (R7-3)", () => {
    const out = setTakeLook(
      [entry(15, 20, { video: { scale: 1.5 } })],
      [{ srcIn: 10, srcOut: 20 }],
      { video: { dx: -3 }, pip: { x: 0.2 } },
    );
    // 10..15 had nothing: no scale 1, no dy 0, no pip y.
    expect(out[0]).toEqual(entry(10, 15, { video: { dx: -3 }, pip: { x: 0.2 } }));
    expect(Object.hasOwn(out[0]!.look.video!, "scale")).toBe(false);
    expect(Object.hasOwn(out[0]!.look.video!, "dy")).toBe(false);
    expect(Object.hasOwn(out[0]!.look.pip!, "y")).toBe(false);
    expect(Object.hasOwn(out[1]!.look.video!, "dy")).toBe(false);
  });

  it("fragments an entry at both edges of the write", () => {
    const L: TakeLook = { captionY: 0.4 };
    expect(setTakeLook([entry(10, 20, L)], [{ srcIn: 12, srcOut: 15 }], { layout: "video-top" })).toEqual([
      entry(10, 12, L),
      entry(12, 15, { ...L, layout: "video-top" }),
      entry(15, 20, L),
    ]);
  });

  it("coalesces neighbours within 1 ms whose looks are equal, and not past it", () => {
    const L: TakeLook = { captionY: 0.5 };
    expect(setTakeLook([entry(10, 12, L)], [{ srcIn: 12.001, srcOut: 15 }], L)).toEqual([entry(10, 15, L)]);
    expect(setTakeLook([entry(10, 12, L)], [{ srcIn: 12.002, srcOut: 15 }], L)).toEqual([
      entry(10, 12, L),
      entry(12.002, 15, L),
    ]);
  });

  it("stores an explicit full-bleed choice", () => {
    expect(setTakeLook([], [{ srcIn: 1, srcOut: 2 }], { layout: "full-bleed" })).toEqual([
      entry(1, 2, { layout: "full-bleed" }),
    ]);
  });

  it("leaves the looks as they were for no ranges", () => {
    const looks = [entry(10, 20, { captionY: 0.4 })];
    expect(setTakeLook(looks, [], { captionY: 0.9 })).toEqual(looks);
  });
});

describe("clearTakeLookFields (L1)", () => {
  it("is a real reset: the field is gone over the whole piece, the rest stays", () => {
    const L: TakeLook = { video: { scale: 2 }, captionY: 0.4 };
    const out = clearTakeLookFields([entry(10, 20, L)], [{ srcIn: 12, srcOut: 15 }], ["video"]);
    expect(out).toEqual([entry(10, 12, L), entry(12, 15, { captionY: 0.4 }), entry(15, 20, L)]);
    expect(lookAt(out, [{ srcIn: 12, srcOut: 15 }]).video).toBeUndefined();
  });

  it("drops a part left with nothing, across several entries", () => {
    const out = clearTakeLookFields(
      [entry(10, 15, { captionY: 0.4 }), entry(15, 20, { captionY: 0.6, captionScale: 2 })],
      [{ srcIn: 10, srcOut: 20 }],
      ["captionY", "captionScale"],
    );
    expect(out).toEqual([]);
  });
});

/** mulberry32: a fixed seed, so a failure replays exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The look at one source instant: the entry covering it, or {}. */
function lookAtPoint(looks: readonly TakeLookEntry[], t: number): TakeLook {
  return looks.find((e) => e.srcIn <= t && t < e.srcOut)?.look ?? {};
}

function expectInvariants(looks: readonly TakeLookEntry[]): void {
  for (let i = 0; i < looks.length; i++) {
    const e = looks[i]!;
    expect(Number.isFinite(e.srcIn) && Number.isFinite(e.srcOut)).toBe(true);
    expect(e.srcIn).toBeLessThan(e.srcOut);
    expect(Math.abs(e.srcIn * 1000 - Math.round(e.srcIn * 1000))).toBeLessThan(1e-6);
    expect(Math.abs(e.srcOut * 1000 - Math.round(e.srcOut * 1000))).toBeLessThan(1e-6);
    expect(Object.keys(e.look).length).toBeGreaterThan(0);
    if (i > 0) {
      const prev = looks[i - 1]!;
      expect(e.srcIn).toBeGreaterThanOrEqual(prev.srcOut);
      // Nothing left that normalizing would coalesce.
      const touching = Math.round(e.srcIn * 1000) - Math.round(prev.srcOut * 1000) <= 1;
      if (touching) expect(e.look).not.toEqual(prev.look);
    }
  }
  expect(normalizeTakeLooks([...looks])).toEqual(looks);
}

describe("a fixed-seed run of 200 writes", () => {
  it("keeps the invariants, sets what it writes, clears what it clears, and touches nothing outside the hull", () => {
    const rand = rng(20261123);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const sec = () => Math.round(rand() * 100_000) / 1000;
    let looks: TakeLookEntry[] = [];
    for (let step = 0; step < 200; step++) {
      const ranges: SrcRange[] = [];
      for (let n = 1 + Math.floor(rand() * 2); n > 0; n--) {
        const a = sec();
        const b = Math.min(100, a + 0.001 + rand() * 15);
        ranges.push({ srcIn: a, srcOut: Math.round(b * 1000) / 1000 });
      }
      const lo = Math.min(...ranges.map((r) => r.srcIn));
      const hi = Math.max(...ranges.map((r) => r.srcOut));
      const before = looks;
      const probes = Array.from({ length: 12 }, () => rand() * 100);
      if (rand() < 0.7) {
        const patch: TakeLook = pick<TakeLook>([
          { video: { scale: pick([1.2, 2, 2.2]) } },
          { video: { dx: pick([-5, 0, 8]), dy: pick([1, 2]) } },
          { video: { volume: pick([0, 0.5, 1]) } },
          { video: { autoZoom: false } },
          { pip: { x: pick([0.1, 0.4]), y: pick([0.2, 0.6]) } },
          { pip: { cornerRadius: pick([0, 1]) } },
          { layout: pick(["full-bleed", "video-top", "pip-bubble"] as const) },
          { captionY: pick([0.2, 0.8]) },
          { captionScale: pick([0.5, 1.5]), captionY: 0.5 },
        ]);
        looks = setTakeLook(looks, ranges, patch);
        expectInvariants(looks);
        for (const t of probes) {
          const got = lookAtPoint(looks, t);
          if (t >= lo && t < hi) {
            // Every named field holds the patch's value inside the hull.
            for (const k of Object.keys(patch) as (keyof TakeLook)[]) {
              if (k === "video" || k === "pip") expect(got[k]).toMatchObject(patch[k]!);
              else expect(got[k]).toEqual(patch[k]);
            }
          } else {
            expect(got).toEqual(lookAtPoint(before, t));
          }
        }
      } else {
        const fields = pick<(keyof TakeLook)[]>([
          ["video"],
          ["pip"],
          ["layout"],
          ["captionY", "captionScale"],
          ["video", "pip", "layout", "captionY", "captionScale"],
        ]);
        looks = clearTakeLookFields(looks, ranges, fields);
        expectInvariants(looks);
        for (const t of probes) {
          const got = lookAtPoint(looks, t);
          if (t >= lo && t < hi) {
            for (const f of fields) expect(got[f]).toBeUndefined();
          } else {
            expect(got).toEqual(lookAtPoint(before, t));
          }
        }
      }
    }
    // The run did real work: it ends with a non-trivial list.
    expect(looks.length).toBeGreaterThan(3);
  });
});

describe("the takeLooks schema normalizes instead of rejecting (S9, m3)", () => {
  const parse = (takeLooks: unknown) => OverrideDocSchema.parse({ takeLooks }).takeLooks;

  it("is absent when absent: a legacy doc never grows the marker", () => {
    expect(Object.hasOwn(OverrideDocSchema.parse({}), "takeLooks")).toBe(false);
    expect(parse([])).toEqual([]);
  });

  it("drops non-finite, inverted, zero-width, empty-look, invalid and non-entry items", () => {
    const L = { captionY: 0.4 };
    expect(
      parse([
        { srcIn: Infinity, srcOut: 5, look: L },
        { srcIn: Number.NaN, srcOut: 5, look: L },
        { srcIn: 6, srcOut: 5, look: L },
        { srcIn: 5, srcOut: 5.0004, look: L },
        { srcIn: 1, srcOut: 2, look: {} },
        { srcIn: 1, srcOut: 2, look: { video: {} } },
        { srcIn: 1, srcOut: 2, look: { captionY: 5 } },
        { srcIn: 1, srcOut: 2, look: { layout: "nope" } },
        "take-2",
        null,
        { srcIn: 7, srcOut: 8, look: L },
      ]),
    ).toEqual([entry(7, 8, L)]);
  });

  it("keeps only the five look fields and rounds to the millisecond", () => {
    expect(
      parse([{ srcIn: 1.00049, srcOut: 2.0006, look: { captionY: 0.4, timing: { startSec: 0, endSec: 1 }, hidden: true } }]),
    ).toEqual([entry(1, 2.001, { captionY: 0.4 })]);
  });

  it("sorts", () => {
    expect(
      parse([
        { srcIn: 30, srcOut: 40, look: { captionY: 0.1 } },
        { srcIn: 10, srcOut: 20, look: { captionY: 0.2 } },
      ]),
    ).toEqual([entry(10, 20, { captionY: 0.2 }), entry(30, 40, { captionY: 0.1 })]);
  });

  it("resolves an overlap in favour of the LATER entry in input order (m3)", () => {
    const L1 = { captionY: 0.1 };
    const L2 = { captionY: 0.9 };
    expect(parse([{ srcIn: 10, srcOut: 20, look: L1 }, { srcIn: 15, srcOut: 25, look: L2 }])).toEqual([
      entry(10, 15, L1),
      entry(15, 25, L2),
    ]);
    expect(parse([{ srcIn: 15, srcOut: 25, look: L2 }, { srcIn: 10, srcOut: 20, look: L1 }])).toEqual([
      entry(10, 20, L1),
      entry(20, 25, L2),
    ]);
    // Inside: the later one punches a hole and the earlier one survives on both sides.
    expect(parse([{ srcIn: 10, srcOut: 30, look: L1 }, { srcIn: 15, srcOut: 20, look: L2 }])).toEqual([
      entry(10, 15, L1),
      entry(15, 20, L2),
      entry(20, 30, L1),
    ]);
  });

  it("coalesces neighbours within 1 ms whose looks are deep-equal, whatever their key order", () => {
    expect(
      parse([
        { srcIn: 10, srcOut: 12, look: { video: { scale: 2, dx: 1 }, captionY: 0.3 } },
        { srcIn: 12.001, srcOut: 15, look: { captionY: 0.3, video: { dx: 1, scale: 2 } } },
        { srcIn: 15.002, srcOut: 16, look: { captionY: 0.3, video: { dx: 1, scale: 2 } } },
      ]),
    ).toEqual([
      entry(10, 15, { video: { scale: 2, dx: 1 }, captionY: 0.3 }),
      entry(15.002, 16, { video: { scale: 2, dx: 1 }, captionY: 0.3 }),
    ]);
  });

  it("normalizeTakeLooks itself refuses structural garbage without throwing", () => {
    expect(
      normalizeTakeLooks([undefined, 3, { srcIn: "1", srcOut: 2, look: { captionY: 0.4 } }, { srcIn: 1, srcOut: 2 }]),
    ).toEqual([]);
  });
});

describe("inScope (R6-8)", () => {
  it("picks the five look keys and drops undefined values and empty records", () => {
    expect(
      inScope({
        props: { a: 1 },
        elements: {},
        hidden: true,
        video: { scale: 2, dx: undefined },
        pip: {},
        captionY: undefined,
        captionScale: 1.2,
        layout: "video-top",
      }),
    ).toEqual({ video: { scale: 2 }, captionScale: 1.2, layout: "video-top" });
    expect(inScope(undefined)).toEqual({});
    expect(inScope({ props: {}, elements: {}, video: { dx: undefined } })).toEqual({});
  });
});

describe("applyTakeLooks (L2, S13, S14)", () => {
  it("SETs the look fields: a cue arriving framed with no look ends with none", () => {
    const cue = take("take-0", 0, 5, {
      layout: "video-top",
      video: { scale: 2 },
      pip: { x: 0.3 },
      captionY: 0.2,
      captionScale: 1.4,
    });
    const [out] = applyTakeLooks([cue], [], seamMap);
    expect(out).toEqual(take("take-0", 0, 5));
    for (const k of ["video", "pip", "captionY", "captionScale"]) expect(Object.hasOwn(out!, k)).toBe(false);
  });

  it("bases layout on full-bleed, fillPlainCues' own base", () => {
    const looks = [entry(10, 15, { layout: "pip-bubble", video: { scale: 1.3 } })];
    const [a, b] = applyTakeLooks(
      [take("take-0", 0, 5, { layout: "video-top" }), take("take-0-1", 5, 10, { layout: "video-top" })],
      looks,
      seamMap,
    );
    expect(a).toEqual(take("take-0", 0, 5, { layout: "pip-bubble", video: { scale: 1.3 } }));
    expect(b!.layout).toBe("full-bleed");
  });

  it("a kept block shows its own footage's look, never its host's or neighbour's", () => {
    const live = new TimeMap([{ srcIn: 10, srcOut: 40, kind: "keep" }]);
    const looks = [entry(10, 20, { video: { scale: 2 } }), entry(20, 25, { captionY: 0.6 })];
    // The carve copied the host's framing onto the block (`carveKeptTakes`
    // spreads the host); in look mode that copy must not survive.
    const kept = take("take-kept-20000", 10, 15, { video: { scale: 2 }, kept: { srcIn: 20, srcOut: 25 } });
    const [out] = applyTakeLooks([kept], looks, live);
    expect(out).toEqual(take("take-kept-20000", 10, 15, { captionY: 0.6, kept: { srcIn: 20, srcOut: 25 } }));
  });

  it("a half shows the look its own footage carries, across a seam by largest overlap", () => {
    const looks = [entry(18, 20, { captionY: 0.1 }), entry(25, 30, { captionY: 0.9 })];
    const [root, half] = applyTakeLooks(
      [take("take-0", 0, 8, { captionY: 0.1 }), take("take-0@s1", 8, 15, { captionY: 0.1 })],
      looks,
      seamMap,
    );
    // The half plays 18..20 then 25..30: 5 s of 0.9 beats 2 s of 0.1.
    expect(half!.captionY).toBe(0.9);
    expect(root!.captionY).toBeUndefined();
  });

  it("leaves graphic cues untouched, the same object", () => {
    const graphic: SceneCue = {
      id: "scene-1",
      layout: "video-top",
      component: "StatCard",
      props: { value: "1", label: "x" },
      startSec: 0,
      endSec: 5,
      video: { scale: 3 },
    };
    const [out] = applyTakeLooks([graphic], [entry(10, 20, { video: { scale: 1.1 } })], seamMap);
    expect(out).toBe(graphic);
  });
});

describe("isLookPieceKey (R4-S4, R7-5)", () => {
  it.each([
    ["take-2", true],
    ["take-2-1", true],
    ["take-2@s", true],
    ["take-kept-5000", true],
    ["take-kept-5000@s", true],
    ["take-2#orphaned", false],
    ["take-kept-5000#orphaned", false],
    ["scene-1", false],
    ["added-1", false],
  ])("%s → %s", (id, want) => {
    expect(isLookPieceKey(id)).toBe(want);
  });
});

/**
 * Review Focus 1: a legacy doc (no `takeLooks`) resolves exactly as before
 * the look pass existed. The pipeline is produce's take steps in order —
 * fill, carve, split, the second `applyOverrides` — then the gate the two
 * call sites spell (`doc.takeLooks !== undefined`). The fixture is chosen so
 * the pass WOULD change the cues: id-keyed framing, a split half, and a kept
 * block that borrowed its host's framing. So "unchanged" is the gate's doing,
 * not a pass with nothing to say.
 */
describe("a legacy doc skips the look pass (take-looks-by-source N1, Review Focus 1)", () => {
  it("resolves the same cues with the gate as without it", () => {
    // The vetoed removal 10..12 already re-kept: one span on this clock,
    // with its edges among the clip starts as produce passes them.
    const map = new TimeMap([{ srcIn: 0, srcOut: 30, kind: "keep" }]);
    const doc = OverrideDocSchema.parse({
      scenes: {
        "take-0": { video: { scale: 2, dx: 3 } },
        "take-kept-10000": { captionY: 0.3 },
        "take-2": { layout: "video-top", captionScale: 1.5 },
        "take-2@s1": { video: { dy: 4 } },
      },
      splits: [{ id: "s1", at: 20, src: 20 }],
    });
    expect(doc.takeLooks).toBeUndefined();

    const filled = fillPlainCues([], { outputDurationSec: map.outputDuration, clipStarts: [0, 10, 12] });
    const carved = carveKeptTakes(filled, [{ srcIn: 10, srcOut: 12 }], map).cues;
    const split = splitCues(carved, atSplitPoints(doc.splits));
    const { cues: overridden } = applyOverrides(split, doc);

    const gated = doc.takeLooks !== undefined ? applyTakeLooks(overridden, doc.takeLooks, map) : overridden;
    expect(gated).toBe(overridden);
    expect(gated.map((c) => [c.id, c.layout, c.video, c.captionY, c.captionScale])).toEqual([
      ["take-0", "full-bleed", { scale: 2, dx: 3 }, undefined, undefined],
      ["take-kept-10000", "full-bleed", undefined, 0.3, undefined],
      ["take-2", "video-top", undefined, undefined, 1.5],
      ["take-2@s1", "video-top", { dy: 4 }, undefined, 1.5],
    ]);
    // The pass, had it run with no looks, would have stripped all of that.
    expect(applyTakeLooks(overridden, [], map)).not.toEqual(overridden);
  });
});
