import { describe, expect, it } from "vitest";
import { fillPlainCues } from "@ossclip/core/browser";
import { editorTakeClipStarts } from "../src/takeClipStarts";

/**
 * Test 25 (take-framing-identity P0): the editor numbers takes from the clip
 * starts produce wrote, so an edit made on `take-N` in the editor lands on
 * the same footage in the render. A baked veto adds kept-range edges to
 * produce's list that `spans` alone never had.
 */
describe("editorTakeClipStarts (take-framing-identity P0)", () => {
  const spans = [{ outIn: 0 }, { outIn: 10 }];
  const takeIds = (clipStarts: readonly number[]) =>
    fillPlainCues([], { outputDurationSec: 12, clipStarts }).map((c) => c.id);

  it("returns produce's `takeClipStarts` when present, the span starts otherwise", () => {
    expect(editorTakeClipStarts({ spans, takeClipStarts: [0, 4, 6, 10] })).toEqual([0, 4, 6, 10]);
    expect(editorTakeClipStarts({ spans })).toEqual([0, 10]);
    expect(editorTakeClipStarts({})).toEqual([]);
  });

  it("a baked veto: the editor's take ids are produce's", () => {
    // 4 and 6 are a kept range's output edges — in produce's list, not in
    // any span start.
    const produced = [0, 4, 6, 10];
    const ids = takeIds(editorTakeClipStarts({ spans, takeClipStarts: produced }));
    expect(ids).toEqual(["take-0", "take-1", "take-2", "take-3"]);
    expect(ids).toEqual(takeIds(produced));
  });

  it("render-props from an older produce: the span starts, as before", () => {
    expect(takeIds(editorTakeClipStarts({ spans }))).toEqual(["take-0", "take-1"]);
  });

  it("the memo's fallback is exactly today's spans-only call (review focus 1)", () => {
    expect(takeIds(editorTakeClipStarts({ spans }))).toEqual(takeIds(spans.map((s) => s.outIn)));
  });
});
