import { describe, expect, it } from "vitest";
import type { CaptionLine } from "../src/captions";
import { livePreviewMap, retimeForPreview, type RetimeablePreviewProps } from "../src/retime-preview";
import type { SceneCue } from "../src/scene-schema";
import type { Segment } from "../src/schema";
import { mapFromKeptSpans, TimeMap } from "../src/timemap";

/**
 * Cut review step 4: the editor's live post-veto preview. The proposal below
 * is the canonical smallest case — one pause between two keeps — because a
 * veto's whole effect is "everything after the revived span shifts later by
 * exactly its length", and a single revive makes that exactness assertable
 * by hand.
 */
const proposal: Segment[] = [
  { srcIn: 0, srcOut: 5, kind: "keep" },
  { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
  { srcIn: 7, srcOut: 10, kind: "keep" },
];

/** The spans the last produce wrote — the proposal APPLIED (pause cut). */
const oldSpans = new TimeMap(proposal).spans;

describe("livePreviewMap (the identity gate and the two clocks)", () => {
  it("empty choices are identity — null, the regression anchor", () => {
    expect(livePreviewMap(proposal, undefined, [], oldSpans)).toBeNull();
    expect(livePreviewMap(proposal, {}, [], oldSpans)).toBeNull();
    expect(livePreviewMap(proposal, { reasons: {}, kept: [] }, [], oldSpans)).toBeNull();
    // A tolerated on-disk `true` restates the default (the schema comment) —
    // it must take the exact early exit, not survive to a map comparison.
    expect(livePreviewMap(proposal, { reasons: { pause: true } }, [], oldSpans)).toBeNull();
  });

  it("choices that change nothing are identity — a kept range overlapping no removal", () => {
    expect(
      livePreviewMap(proposal, { kept: [{ srcIn: 0.5, srcOut: 1 }] }, [], oldSpans),
    ).toBeNull();
  });

  it("a veto already baked into the render-props spans is identity", () => {
    // Last produce ran WITH this veto: its spans already keep the pause.
    const bakedSpans = new TimeMap(
      livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans)!.newMap.spans.map(
        (s) => ({ srcIn: s.srcIn, srcOut: s.srcOut, kind: "keep" as const }),
      ),
    ).spans;
    expect(livePreviewMap(proposal, { reasons: { pause: false } }, [], bakedSpans)).toBeNull();
  });

  it("a live veto answers both clocks: old from the spans, new from the re-kept partition", () => {
    const clocks = livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans);
    expect(clocks).not.toBeNull();
    expect(clocks!.oldMap.outputDuration).toBeCloseTo(8, 9);
    expect(clocks!.newMap.outputDuration).toBeCloseTo(10, 9);
    expect(clocks!.newMap.spans).toEqual([{ srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 }]);
  });

  it("src-anchored user cuts stay subtracted — produce's own ordering, an applied cut never comes back", () => {
    // Last produce applied a user cut at source 8..9 on top of the pause cut.
    const appliedSpans = new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 7, srcOut: 8, kind: "keep" },
      { srcIn: 8, srcOut: 9, kind: "remove", reason: "user", confidence: 1 },
      { srcIn: 9, srcOut: 10, kind: "keep" },
    ]).spans;
    const clocks = livePreviewMap(
      proposal,
      { reasons: { pause: false } },
      [
        // Resolved by a past produce — subtracts.
        { startSec: 5, endSec: 6, src: { startSec: 8, endSec: 9 } },
        // Fresh, src-less — produce's alone to resolve; stays marked-not-applied.
        { startSec: 1, endSec: 2 },
      ],
      appliedSpans,
    );
    expect(clocks!.newMap.spans).toEqual([
      { srcIn: 0, srcOut: 8, outIn: 0, outOut: 8 },
      { srcIn: 9, srcOut: 10, outIn: 8, outOut: 9 },
    ]);
  });

  it("degrades to null on a proposal TimeMap rejects — the lenient /api/cleanup posture, never a crash", () => {
    // Hand-mangled overlap that SURVIVES the re-keep merge: the vetoed
    // silence merges into a 0..6 keep, which then overlaps the un-vetoed
    // filler removal at 5..7 — exactly the shape TimeMap's constructor
    // throws on. (A vetoed span overlapping a keep gets healed by the merge
    // itself, so the overlap must sit on a span the choices leave alone.)
    const mangled: Segment[] = [
      { srcIn: 0, srcOut: 2, kind: "remove", reason: "silence", confidence: 0.9 },
      { srcIn: 1, srcOut: 6, kind: "keep" },
      { srcIn: 5, srcOut: 7, kind: "remove", reason: "filler", confidence: 0.8 },
      { srcIn: 7, srcOut: 10, kind: "keep" },
    ];
    expect(livePreviewMap(mangled, { reasons: { silence: false } }, [], oldSpans)).toBeNull();
  });
});

describe("retimeForPreview (every output-timed prop onto the new clock)", () => {
  const oldMap = mapFromKeptSpans(oldSpans);
  const newMap = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" }]);
  const cue = (id: string, startSec: number, endSec: number): SceneCue => ({
    id,
    kind: "plain",
    layout: "full-bleed",
    startSec,
    endSec,
  });
  const line = (start: number, end: number, srcStart: number): CaptionLine => ({
    start,
    end,
    words: [{ text: "word", start, end, srcStart }],
  });
  const props: RetimeablePreviewProps = {
    outputDurationSec: 8,
    // One line before the revived pause, one after — only the second moves.
    captionLines: [line(1, 2, 1), line(5.5, 6.5, 7.5)],
    sceneCues: [cue("a", 0, 5), cue("b", 5, 8)],
    zoomPlan: [
      { startSec: 0, endSec: 5, from: 1, to: 1.05 },
      { startSec: 5, endSec: 8, from: 1, to: 1.05 },
    ],
    ctaWindow: { startSec: 6, endSec: 7 },
    sourceTextRegions: [{ y: 0.1, h: 0.2, startSec: 6, endSec: 7 }],
  };

  it("a revived pause shifts everything after it by exactly its length, and nothing before it", () => {
    const { fields, reports } = retimeForPreview(props, oldMap, newMap);
    expect(fields.spans).toEqual([{ srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 }]);
    expect(fields.outputDurationSec).toBeCloseTo(10, 9);
    // Before the revive: untouched. STRICTLY after: +2, the pause's exact
    // length. A value exactly AT the old seam keeps the EARLIER preimage
    // (toSource's documented tie-break, timemap.ts) — so a cue or zoom
    // segment that started at the seam now COVERS the revived pause instead
    // of leaving a hole in front of itself, which is the right preview: the
    // pause belongs to the block that follows the cut.
    expect(fields.captionLines[0]).toEqual(line(1, 2, 1));
    expect(fields.captionLines[1]!.start).toBeCloseTo(7.5, 9);
    expect(fields.captionLines[1]!.end).toBeCloseTo(8.5, 9);
    expect(fields.sceneCues[0]!.endSec).toBeCloseTo(5, 9);
    expect(fields.sceneCues[1]!.startSec).toBeCloseTo(5, 9);
    expect(fields.sceneCues[1]!.endSec).toBeCloseTo(10, 9);
    expect(fields.zoomPlan).toEqual([
      { startSec: 0, endSec: 5, from: 1, to: 1.05 },
      { startSec: 5, endSec: 10, from: 1, to: 1.05 },
    ]);
    expect(fields.ctaWindow).toEqual({ startSec: 8, endSec: 9 });
    expect(fields.sourceTextRegions).toEqual([{ y: 0.1, h: 0.2, startSec: 8, endSec: 9 }]);
    // Vetoes only ADD time back, so every old moment survived — no snaps.
    expect(reports).toEqual([]);
  });

  it("caption fidelity: a word at output T on the old clock sits at the source-identical moment on the new one", () => {
    const { fields } = retimeForPreview(props, oldMap, newMap);
    for (let i = 0; i < props.captionLines.length; i++) {
      const before = props.captionLines[i]!.words[0]!;
      const after = fields.captionLines[i]!.words[0]!;
      expect(newMap.toSource(after.start)).toBeCloseTo(oldMap.toSource(before.start), 9);
      // srcStart is SOURCE time (§137's recut-immune key) — carried untouched.
      expect(after.srcStart).toBe(before.srcStart);
    }
  });

  it("punch comes back provably inert while a live re-cut is active", () => {
    const { fields } = retimeForPreview(props, oldMap, newMap);
    // scale 1 renders no visible punch and the empty mask reads all-allowed
    // (punchScalesFor's `allowed[i] !== false`) — every punched turn is 1.
    expect(fields.punch).toEqual({ scale: 1, allowed: [] });
  });

  it("optional props stay absent rather than materialising", () => {
    const bare: RetimeablePreviewProps = {
      outputDurationSec: 8,
      captionLines: [],
      sceneCues: [],
    };
    const { fields } = retimeForPreview(bare, oldMap, newMap);
    expect(fields.zoomPlan).toBeUndefined();
    expect(fields.ctaWindow).toBeUndefined();
    expect(fields.sourceTextRegions).toBeUndefined();
  });

  it("identical clocks retime every value onto itself", () => {
    const { fields, reports } = retimeForPreview(props, oldMap, oldMap);
    expect(fields.outputDurationSec).toBeCloseTo(props.outputDurationSec, 9);
    expect(fields.captionLines).toEqual(props.captionLines);
    expect(fields.sceneCues).toEqual(props.sceneCues);
    expect(fields.zoomPlan).toEqual(props.zoomPlan);
    expect(reports).toEqual([]);
  });

  it("the retracted-veto direction snaps a moment inside the re-cut to the kept edge, and says so", () => {
    // The one direction that REMOVES time: old props were built with the
    // veto live (pause kept, 10s clock), the veto is then retracted — a word
    // inside the pause has no new-clock home and clamps, reported.
    const { fields, reports } = retimeForPreview(
      { outputDurationSec: 10, captionLines: [line(5.5, 6.5, 5.5)], sceneCues: [] },
      newMap,
      oldMap,
    );
    expect(fields.captionLines[0]!.words[0]!.start).toBeCloseTo(5, 9);
    expect(reports.length).toBeGreaterThan(0);
  });
});
