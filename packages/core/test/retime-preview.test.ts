import { describe, expect, it } from "vitest";
import type { CaptionLine } from "../src/captions";
import {
  cutRangeToOldClock,
  livePreviewMap,
  previewClockMappers,
  retimeForPreview,
  type RetimeablePreviewProps,
} from "../src/retime-preview";
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

describe("previewClockMappers (step 4 follow-up: the point mappers App threads to its surfaces)", () => {
  const clocks = livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans)!;

  it("null clocks are the literal identity, both directions — the no-veto regression anchor", () => {
    const m = previewClockMappers(null);
    for (const t of [0, 0.3, 1.234, 8, 100]) {
      expect(m.toLive(t)).toBe(t);
      expect(m.fromLive(t)).toBe(t);
    }
  });

  it("toLive: a moment past the revived pause lands old + revived on the new clock; before it, unmoved", () => {
    const m = previewClockMappers(clocks);
    // Old output 6 is source 8 — past the revived 2s pause, so the same
    // source instant sits exactly the revived seconds later. This is the
    // transcript's click-to-seek and the timeline's ghost bands: a word (or
    // ghost edge) after a kept pause seeks/draws at old + revived.
    expect(m.toLive(6)).toBeCloseTo(8, 9);
    expect(m.toLive(3)).toBeCloseTo(3, 9);
  });

  it("fromLive: the cover direction — a live playhead names the frame the RENDERED mp4 actually has", () => {
    // The REVERSE of toLive, deliberately: the cover server extracts the
    // `--from final` frame from the finished mp4, whose timeline is the OLD
    // clock, so the live playhead must come BACK to it (App.tsx's CoverPanel
    // call site owns the full argument).
    const m = previewClockMappers(clocks);
    expect(m.fromLive(8)).toBeCloseTo(6, 9);
    // Inside the revived pause the rendered mp4 has no frame at all — the
    // nearest kept edge is the closest one it can honestly serve.
    expect(m.fromLive(6)).toBeCloseTo(5, 9);
    // And the two are inverses over every moment the old clock can express.
    for (const t of [0, 2, 4.9, 5, 6.5, 8]) {
      expect(m.fromLive(m.toLive(t))).toBeCloseTo(t, 9);
    }
  });

  it("hasOldClockPreimage: false exactly inside revived material, true elsewhere — and always true for the identity pair", () => {
    const m = previewClockMappers(clocks);
    // Before the revived pause and after it: real old-clock moments.
    expect(m.hasOldClockPreimage(3)).toBe(true);
    expect(m.hasOldClockPreimage(8)).toBe(true);
    // Inside the revived pause (live 5..7 is source 5..7, which the old map
    // removed): no preimage — the WRITE guard's refusal case.
    expect(m.hasOldClockPreimage(6)).toBe(false);
    // The identity pair never refuses — no veto, nothing revived.
    const identity = previewClockMappers(null);
    for (const t of [0, 3, 6, 100]) expect(identity.hasOldClockPreimage(t)).toBe(true);
  });

  it("hasOldClockPreimage: an instant exactly AT a seam counts as having one — toOutput's inclusive-edge containment (timemap.ts), pinned", () => {
    const m = previewClockMappers(clocks);
    // Live 5 is source 5 (the kept span's srcOut) and live 7 is source 7
    // (the next span's srcIn) — both edges the old map still contains, so a
    // split exactly at the seam is a moment the last render can express.
    expect(m.hasOldClockPreimage(5)).toBe(true);
    expect(m.hasOldClockPreimage(7)).toBe(true);
  });
});

describe("cutRangeToOldClock (the WRITE direction's range half — cutChunk's boundary)", () => {
  const clocks = livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans)!;
  const mappers = previewClockMappers(clocks);

  it("identity mappers answer exact with the inputs untouched — the no-veto regression anchor", () => {
    const range = cutRangeToOldClock(previewClockMappers(null), 2.345, 6.789);
    expect(range).toEqual({ kind: "exact", startSec: 2.345, endSec: 6.789 });
  });

  it("a window entirely in kept material maps exactly: live seconds in, the last render's own seconds out", () => {
    // Live 8..9 is source 8..9, which the old clock kept at 6..7 — the
    // hand-mapped case: everything past the revived 2s pause sits exactly
    // the revived seconds later on the live clock.
    expect(cutRangeToOldClock(mappers, 8, 9)).toEqual({ kind: "exact", startSec: 6, endSec: 7 });
  });

  it("a window straddling a revived edge SHRINKS to what the old clock can express, and says so", () => {
    // Live 4..6: the start is a real old moment (4), the end sits inside the
    // revived pause and clamps to the seam (old 5) — the cut proceeds on the
    // shrunk window rather than being refused, and the report records the
    // trim (remapPoint's "nothing moves without saying so").
    const range = cutRangeToOldClock(mappers, 4, 6);
    expect(range.kind).toBe("shrunk");
    if (range.kind !== "shrunk") throw new Error("unreachable");
    expect(range.startSec).toBeCloseTo(4, 9);
    expect(range.endSec).toBeCloseTo(5, 9);
    expect(range.report).toContain("trimmed to the last render's");
  });

  it("a window entirely inside revived material is degenerate — both ends clamp to the same seam", () => {
    expect(cutRangeToOldClock(mappers, 5.5, 6.5)).toEqual({ kind: "degenerate" });
  });

  it("a window covering the revived span seam to seam is degenerate too — each seam HAS a preimage, but the same one twice (the width-first check order)", () => {
    // Live 5..7 is exactly the revived pause: hasOldClockPreimage answers
    // true at BOTH ends (the inclusive-seam semantics pinned above), yet the
    // mapped window is the single old instant 5..5 — nothing left to cut.
    expect(cutRangeToOldClock(mappers, 5, 7)).toEqual({ kind: "degenerate" });
  });
});

describe("dismissed markers drive the live preview (cut-review rework)", () => {
  const proposal: Segment[] = [
    { srcIn: 0, srcOut: 5, kind: "keep" },
    { srcIn: 5, srcOut: 7, kind: "remove", reason: "retake", confidence: 0.9 },
    { srcIn: 7, srcOut: 10, kind: "keep" },
  ];
  const oldSpans = [
    { srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 },
    { srcIn: 7, srcOut: 10, outIn: 5, outOut: 8 },
  ];

  it("a dismissal alone opens the live clocks — the preview must play the footage", () => {
    const clocks = livePreviewMap(proposal, { dismissed: [{ srcIn: 5, srcOut: 7 }] }, [], oldSpans);
    expect(clocks).not.toBeNull();
    expect(clocks!.newMap.outputDuration).toBe(10);
  });

  it("previewClockMappers.toSourceSec is exact under live clocks and honors the identity fallback", () => {
    const clocks = livePreviewMap(proposal, { dismissed: [{ srcIn: 5, srcOut: 7 }] }, [], oldSpans);
    const live = previewClockMappers(clocks);
    // The re-kept cutlist keeps all of 0..10, so live time IS source time.
    expect(live.toSourceSec!(6)).toBe(6);
    const none = previewClockMappers(null);
    expect(none.toSourceSec).toBeNull();
    const withFallback = previewClockMappers(null, { identityToSource: (s) => s + 100 });
    expect(withFallback.toSourceSec!(2)).toBe(102);
  });
});

/**
 * Cut-review rework (2026-08-26): `cuts[].src` written by the EDITOR is
 * live-applied — the preview subtracts it and the material stops playing.
 * Same canonical proposal as the top of this file (pause at source 5..7, the
 * last render keeping 0..5 + 7..10 on an 8s clock), with a user cut at source
 * 2..3 so every expected number stays hand-mappable.
 */
describe("live user cuts (src written at the gesture) apply in the preview", () => {
  /** What a writer stores now: the old-clock record plus the source anchor. */
  const cut = (startSec: number, endSec: number, src: { startSec: number; endSec: number }) => ({
    startSec,
    endSec,
    src,
  });

  it("a src cut ALONE opens the clocks — no veto needed (the gate the field report hit)", () => {
    const clocks = livePreviewMap(proposal, undefined, [cut(2, 3, { startSec: 2, endSec: 3 })], oldSpans);
    expect(clocks).not.toBeNull();
    // The pause (5..7) stays removed and the user's 2..3 goes too: 8s − 1s.
    expect(clocks!.newMap.outputDuration).toBeCloseTo(7, 9);
    expect(clocks!.newMap.spans).toEqual([
      { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
      { srcIn: 3, srcOut: 5, outIn: 2, outOut: 4 },
      { srcIn: 7, srcOut: 10, outIn: 4, outOut: 7 },
    ]);
  });

  it("with NO cleanup proposal on disk the cut subtracts from the last render's own spans, as keeps", () => {
    // Correction 1 in the plan: an empty proposal used to be an unconditional
    // null, which would have left a cut on a proposal-less workdir invisible.
    const clocks = livePreviewMap([], undefined, [cut(2, 3, { startSec: 2, endSec: 3 })], oldSpans);
    expect(clocks).not.toBeNull();
    expect(clocks!.newMap.spans).toEqual([
      { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
      { srcIn: 3, srcOut: 5, outIn: 2, outOut: 4 },
      { srcIn: 7, srcOut: 10, outIn: 4, outOut: 7 },
    ]);
  });

  it("a src cut a past produce ALREADY applied is identity — the widened gate's own regression anchor", () => {
    // The stale-cutlist risk the plan pins: the cut's source range is absent
    // from `oldSpans` (produce removed it), so subtracting it from those spans
    // changes nothing — `subtractRangesFromCutlist` is set-like — and the
    // `mapsClose` exit returns null rather than a phantom re-cut.
    expect(
      livePreviewMap([], undefined, [cut(5, 6, { startSec: 5.5, endSec: 6.5 })], oldSpans),
    ).toBeNull();
  });

  it("a veto with no proposal to apply it to is still null — the pre-rework early exit", () => {
    expect(livePreviewMap([], { reasons: { pause: false } }, [], oldSpans)).toBeNull();
  });

  it("a zero-width src range never counts as a live edit", () => {
    expect(
      livePreviewMap(proposal, undefined, [cut(2, 2, { startSec: 2, endSec: 2 })], oldSpans),
    ).toBeNull();
  });

  it("toLive CLAMPS at an old instant a live cut removed — the playhead-continuity consumer", () => {
    const clocks = livePreviewMap(proposal, undefined, [cut(2, 3, { startSec: 2, endSec: 3 })], oldSpans)!;
    const m = previewClockMappers(clocks);
    // Old output 2.5 is source 2.5, which the live cut removed: both edges of
    // the removed span land on new output 2, so the clamp is exact and
    // deterministic — App's playhead seeks to the seam rather than nowhere.
    expect(m.toLive(2.5)).toBeCloseTo(2, 9);
    // Untouched either side of it.
    expect(m.toLive(1)).toBeCloseTo(1, 9);
    expect(m.toLive(4)).toBeCloseTo(3, 9);
  });

  it("retimeForPreview DROPS a cue the cut collapsed, and says so", () => {
    const clocks = livePreviewMap(proposal, undefined, [cut(2, 3, { startSec: 2, endSec: 3 })], oldSpans)!;
    const { fields, reports } = retimeForPreview(
      {
        outputDurationSec: 8,
        captionLines: [],
        sceneCues: [
          { id: "a", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 2 },
          // Exactly the removed window — nothing of it survives.
          { id: "gone", kind: "plain", layout: "full-bleed", startSec: 2, endSec: 3 },
          { id: "c", kind: "plain", layout: "full-bleed", startSec: 3, endSec: 8 },
        ],
      },
      clocks.oldMap,
      clocks.newMap,
    );
    expect(fields.sceneCues.map((c) => c.id)).toEqual(["a", "c"]);
    expect(reports).toContain('scene "gone" removed from the live preview by a cut');
  });

  it("oldToSourceSec resolves through the OLD map — the transcript panel's window, not the player's", () => {
    const clocks = livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans)!;
    const m = previewClockMappers(clocks);
    // Old output 6 is source 8 (the last render kept 7..10 at output 5..8),
    // while the SAME number on the live clock is source 6 — exactly the
    // revived seconds apart, which is the bug the two mappers keep apart.
    expect(m.oldToSourceSec!(6)).toBeCloseTo(8, 9);
    expect(m.toSourceSec!(6)).toBeCloseTo(6, 9);
  });

  it("oldToSourceSec shares the identity pair's fallback — and its null", () => {
    expect(previewClockMappers(null).oldToSourceSec).toBeNull();
    const withFallback = previewClockMappers(null, { identityToSource: (s) => s + 100 });
    // With no live re-cut the two clocks ARE one, so both mappers answer with
    // the caller's spans-backed conversion.
    expect(withFallback.oldToSourceSec!(2)).toBe(102);
    expect(withFallback.oldToSourceSec).toBe(withFallback.toSourceSec);
  });
});

describe("the whole preview pipeline yields only playable spans (§ADK crash, 2026-08-31)", () => {
  // The full editor path with the real crash data: a "Delete this chunk" cut
  // whose src was rounded to 3 decimals at the write boundary, applied by
  // livePreviewMap + retimeForPreview to a cutlist carrying full float
  // precision. Every span the pipeline hands the player must survive
  // EdlVideo's per-frame rounding — trimBefore === trimAfter is a Remotion
  // THROW that blanks the Player, which is how the bug shipped: the units
  // around each stage were green while the composed pipeline emitted a
  // 125µs span. This test composes the stages.
  const adkCutlist: Segment[] = [
    { srcIn: 0, srcOut: 3.9701880000000003, kind: "keep" },
    { srcIn: 3.9701880000000003, srcOut: 4.884438, kind: "remove", reason: "silence", confidence: 0.9 },
    { srcIn: 4.884438, srcOut: 6.659125, kind: "keep" },
    { srcIn: 6.659125, srcOut: 7.71825, kind: "remove", reason: "silence", confidence: 0.9 },
    { srcIn: 7.71825, srcOut: 94.58, kind: "keep" },
  ];
  const adkSpans = new TimeMap(adkCutlist).spans;

  it("a 3-decimal-rounded delete leaves every span at least one frame long at any real fps", () => {
    const cut = {
      startSec: 3.9701880000000003,
      endSec: 5.744875,
      src: { startSec: 3.97, endSec: 6.659 }, // exactly what the gesture saved
    };
    const clocks = livePreviewMap(adkCutlist, undefined, [cut], adkSpans);
    expect(clocks).not.toBeNull();
    const { fields } = retimeForPreview(
      { outputDurationSec: new TimeMap(adkCutlist).outputDuration, captionLines: [], sceneCues: [] },
      clocks!.oldMap,
      clocks!.newMap,
    );
    for (const fps of [24, 25, 30, 60]) {
      for (const sp of fields.spans) {
        expect(Math.round(sp.srcOut * fps)).toBeGreaterThan(Math.round(sp.srcIn * fps));
      }
    }
  });
});
