import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type CaptionLine } from "@ossclip/core/browser";
import { editReducer, initialEditState } from "../src/useEdits";
import { anchorCaptionLines } from "../src/captionAnchors";

/**
 * §137 Task 5 — the EDITOR side of source-anchored overrides.
 *
 * Tasks 2-4 re-keyed the core: caption edits live under `w<sourceMs>` and
 * split halves under a minted id. Until this task the editor still WROTE
 * positional keys, so `applyCaptionEdits` read a key space nothing wrote and
 * every retype silently reverted in front of the user (the field case).
 *
 * `addSplit` is deliberately not re-tested here: Task 3 already minted its id
 * through `mintSplitId` (useEdits.ts), and `useEdits.test.ts` covers it.
 */
describe("editor writes source-anchored caption keys (§137)", () => {
  it("patchCaption stores the edit under the word's source key, not its position", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 1.7675, was: "batch,", text: "Bash," },
    );
    // 1767.5ms rounds to 1768 — the assertion is on the DERIVATION, so a
    // reducer that passed the raw seconds (or the old index) through fails
    // here rather than merely changing shape.
    expect(next.doc.captions).toEqual({ w1768: { text: "Bash,", was: "batch," } });
  });

  it("keys a word at source zero as w0 rather than dropping it", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 0, was: "Claude", text: "CLAWD" },
    );
    expect(next.doc.captions).toEqual({ w0: { text: "CLAWD", was: "Claude" } });
  });

  it("retyping back to the original still clears the override", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w1768: { text: "Bash,", was: "batch," } },
    });
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 1.7675, was: "Bash,", text: "batch," },
    );
    expect(next.doc.captions).toEqual({});
  });

  it("a re-edit under the same source key keeps the BASE guard (R15 §59 survives the re-key)", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 1.7675, text: "Bash,", was: "batch,",
    });
    s = editReducer(s, { type: "patchCaption", srcStart: 1.7675, text: "bash", was: "Bash," });
    expect(s.doc.captions.w1768).toEqual({ text: "bash", was: "batch," });
  });
});

/**
 * The load-path repair (§137). Pure so it can be tested without a server: the
 * fetch stays in `App.tsx`, this decides what the caption lines become.
 */
describe("anchorCaptionLines — repairing a pre-§137 render-props.json", () => {
  /** A line as a legacy file holds it: no `srcStart` on any word. */
  const legacy = (...ws: Array<[string, number, number]>): CaptionLine => ({
    words: ws.map(([text, start, end]) => ({ text, start, end }) as CaptionLine["words"][number]),
    start: ws[0]![1],
    end: ws[ws.length - 1]![2],
  });

  it("backfills srcStart through the file's own spans", () => {
    // One kept span starting 10s into the source: an output instant of 0.09
    // is source 10.09.
    const out = anchorCaptionLines({
      captionLines: [legacy(["Claude", 0.09, 0.47])],
      spans: [{ srcIn: 10, srcOut: 41.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.captionLines![0]!.words[0]!.srcStart).toBeCloseTo(10.09, 6);
  });

  it("repairs baseCaptionLines too — that is the side the retype guard reads", () => {
    // App.tsx merges edits onto `baseCaptionLines ?? captionLines`. Repairing
    // only the live side would leave every edit unanchorable at the exact
    // point it is applied.
    const out = anchorCaptionLines({
      captionLines: [legacy(["Claude", 0.09, 0.47])],
      baseCaptionLines: [legacy(["Claude", 0.09, 0.47])],
      spans: [{ srcIn: 0, srcOut: 31.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.baseCaptionLines![0]!.words[0]!.srcStart).toBeCloseTo(0.09, 6);
  });

  it("leaves the lines ALONE when there are no spans", () => {
    // Load-bearing (§137, carried from Task 1's review): `mapFromKeptSpans([])`
    // maps every output instant to source 0, so backfilling here would give the
    // whole video ONE anchor — the precise failure this plan removes, arriving
    // as a successful-looking migration. Anchorless words are the honest
    // outcome; `applyCaptionEdits` reports the edits that then find no home.
    const lines = [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])];
    const out = anchorCaptionLines({ captionLines: lines, spans: [] });
    expect(out.captionLines).toBeUndefined();
    expect(lines[0]!.words.every((w) => w.srcStart === undefined)).toBe(true);
  });

  it("leaves the lines ALONE when spans is absent entirely", () => {
    const out = anchorCaptionLines({ captionLines: [legacy(["Claude", 0.09, 0.47])] });
    expect(out.captionLines).toBeUndefined();
  });

  it("never re-derives an anchor a word already carries", () => {
    // A file written AFTER §137 has real source times from the map that
    // actually produced them; re-projecting through `spans` would overwrite
    // truth with an approximation.
    const anchored: CaptionLine = {
      words: [{ text: "Claude", start: 0.09, end: 0.47, srcStart: 99 }],
      start: 0.09,
      end: 0.47,
    };
    const out = anchorCaptionLines({
      captionLines: [anchored],
      spans: [{ srcIn: 0, srcOut: 31.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.captionLines![0]!.words[0]!.srcStart).toBe(99);
  });
});
