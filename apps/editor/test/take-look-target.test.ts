import { describe, expect, it } from "vitest";
import { TimeMap, type SceneCue } from "@ossclip/core/browser";
import {
  lookCoalesceKey,
  pieceAnchor,
  pieceSelection,
  revalidateSelection,
  selectedPiece,
  walkPiece,
} from "../src/takeLookTarget";
import type { Selection } from "../src/Overlay";

/**
 * The look-mode selection target (take-looks-by-source R6-1, R6-7, R7-1,
 * R7-8; Review Focus 3 and 4): a take piece is named by the source footage
 * it plays, so carved lead and tail pieces sharing an id are told apart, and
 * a cut, keep, undo or ⌘B never moves the selection onto the lead.
 */

const keep = (...ranges: Array<[number, number]>): TimeMap =>
  new TimeMap(ranges.map(([srcIn, srcOut]) => ({ srcIn, srcOut, kind: "keep" as const })));
const plain = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  kind: "plain",
  layout: "full-bleed",
  startSec,
  endSec,
});
const graphic = (id: string, startSec: number, endSec: number): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "X", value: "1" },
  startSec,
  endSec,
});

// One take carved around a kept block: lead and tail share `take-1`
// (`carveKeptTakes`' rule), then a graphic, then another take. Source and
// output agree on this clock.
const CLOCK = keep([0, 30]);
const CUES: SceneCue[] = [
  plain("take-1", 0, 10),
  plain("take-kept-10000", 10, 12),
  plain("take-1", 12, 20),
  graphic("scene-2", 20, 25),
  plain("take-2", 25, 30),
];
const LEAD = CUES[0]!;
const TAIL = CUES[2]!;
const tailSel = (): Selection => ({ sceneId: "take-1", elementId: null, pieceExtent: { srcIn: 12, srcOut: 20 } });

describe("pieceAnchor (R6-1, R7-8)", () => {
  it("is the hull of the source a plain piece plays — across a seam too", () => {
    expect(pieceAnchor(TAIL, CLOCK)).toEqual({ srcIn: 12, srcOut: 20 });
    // [0,2] and [5,30] kept: output 0..7 plays source 0..2 then 5..10.
    expect(pieceAnchor(plain("take-1", 0, 7), keep([0, 2], [5, 30]))).toEqual({ srcIn: 0, srcOut: 10 });
  });

  it("is null with no clock, for a graphic, and for a window that plays nothing", () => {
    expect(pieceAnchor(TAIL, null)).toBeNull();
    expect(pieceAnchor(CUES[3]!, CLOCK)).toBeNull();
    expect(pieceAnchor(plain("take-9", 40, 50), CLOCK)).toBeNull();
  });
});

describe("selectedPiece (R6-1)", () => {
  it("the tail resolves, not the lead that shares its id (R4-S8)", () => {
    expect(selectedPiece(CUES, tailSel(), CLOCK)).toBe(TAIL);
  });

  it("after a live cut in front, the same extent still resolves the same piece", () => {
    // Source 2..5 cut: everything after it moves 3 s earlier.
    const clock = keep([0, 2], [5, 30]);
    const cues = [
      plain("take-1", 0, 7),
      plain("take-kept-10000", 7, 9),
      plain("take-1", 9, 17),
      graphic("scene-2", 17, 22),
      plain("take-2", 22, 27),
    ];
    expect(selectedPiece(cues, tailSel(), clock)).toBe(cues[2]);
  });

  it("footage cut gives null, and revalidation clears the selection", () => {
    // The tail's source 12..20 is gone; nothing else plays any of it.
    const clock = keep([0, 12], [20, 30]);
    const cues = [plain("take-1", 0, 10), plain("take-kept-10000", 10, 12), graphic("scene-2", 12, 17), plain("take-2", 17, 22)];
    expect(selectedPiece(cues, tailSel(), clock)).toBeNull();
    expect(revalidateSelection(tailSel(), cues, clock)).toBeNull();
  });

  it("a tie goes to the earlier startSec (R7-8)", () => {
    const cues = [plain("take-3", 10, 15), plain("take-2", 5, 10)];
    const sel: Selection = { sceneId: "x", elementId: null, pieceExtent: { srcIn: 8, srcOut: 12 } };
    expect(selectedPiece(cues, sel, CLOCK)).toBe(cues[1]);
  });

  it("an overlap under 1 ms counts as none", () => {
    const sel: Selection = { sceneId: "take-1", elementId: null, pieceExtent: { srcIn: 19.9996, srcOut: 20.0004 } };
    expect(selectedPiece([TAIL], sel, CLOCK)).toBeNull();
  });

  it("is null with no extent or no clock — never the lead by id", () => {
    expect(selectedPiece(CUES, { sceneId: "take-1", elementId: null }, CLOCK)).toBeNull();
    expect(selectedPiece(CUES, tailSel(), null)).toBeNull();
  });
});

describe("revalidateSelection (R6-1, R7-1)", () => {
  it("returns the SAME selection when nothing moved, so a functional setSelection settles", () => {
    const sel = tailSel();
    expect(revalidateSelection(sel, CUES, CLOCK)).toBe(sel);
  });

  it("undo of a keep in front: the same extent still resolves the tail (R7-8)", () => {
    // Before the keep: source 2..4 removed, so output is 2 s short.
    const before = keep([0, 2], [4, 30]);
    const beforeCues = [
      plain("take-1", 0, 8),
      plain("take-kept-10000", 8, 10),
      plain("take-1", 10, 18),
      graphic("scene-2", 18, 23),
      plain("take-2", 23, 28),
    ];
    // The keep revives 2..4: a second kept block carves take-1 again.
    const after = keep([0, 30]);
    const afterCues = [
      plain("take-1", 0, 2),
      plain("take-kept-2000", 2, 4),
      plain("take-1", 4, 10),
      plain("take-kept-10000", 10, 12),
      plain("take-1", 12, 20),
      graphic("scene-2", 20, 25),
      plain("take-2", 25, 30),
    ];
    let sel: Selection | null = tailSel();
    sel = revalidateSelection(sel, beforeCues, before);
    expect(selectedPiece(beforeCues, sel!, before)).toBe(beforeCues[2]);
    sel = revalidateSelection(sel!, afterCues, after);
    expect(selectedPiece(afterCues, sel!, after)).toBe(afterCues[4]);
    // Undo: the old cues and clock come back.
    sel = revalidateSelection(sel!, beforeCues, before);
    expect(selectedPiece(beforeCues, sel!, before)).toBe(beforeCues[2]);
    expect(sel).toEqual(tailSel());
  });

  it("⌘B follows the half holding more of the old extent, id and hull (R6-1, R7-1)", () => {
    // ⌘B at source 14 on the tail: `splitCues` names the second half.
    const split = [...CUES.slice(0, 2), plain("take-1", 12, 14), plain("take-1@14000", 14, 20), ...CUES.slice(3)];
    const sel = revalidateSelection(tailSel(), split, CLOCK);
    expect(sel).toEqual({ sceneId: "take-1@14000", elementId: null, pieceExtent: { srcIn: 14, srcOut: 20 } });
    // Undo of the split: the narrower extent still resolves the whole tail,
    // and takes its hull back.
    const undone = revalidateSelection(sel!, CUES, CLOCK);
    expect(undone).toEqual(tailSel());
    // Redo: the larger half again.
    expect(revalidateSelection(undone!, split, CLOCK)).toEqual(sel);
  });

  it("a legacy selection with no extent gets one by id — the first cue with that id (R6-1)", () => {
    expect(revalidateSelection({ sceneId: "take-1", elementId: null }, CUES, CLOCK)).toEqual({
      sceneId: "take-1",
      elementId: null,
      pieceExtent: { srcIn: 0, srcOut: 10 },
    });
  });

  it("a graphic selection, an unknown id (a ghost) and a clockless one are left as they are", () => {
    for (const sel of [
      { sceneId: "scene-2", elementId: "title" },
      { sceneId: "scene-9", elementId: null },
    ] satisfies Selection[]) {
      expect(revalidateSelection(sel, CUES, CLOCK)).toBe(sel);
    }
    const legacy: Selection = { sceneId: "take-1", elementId: null };
    expect(revalidateSelection(legacy, CUES, null)).toBe(legacy);
  });
});

describe("walkPiece (R6-4, R7-8)", () => {
  it("walks piece by piece: lead → kept → TAIL → graphic, never back to the lead's index", () => {
    let sel: Selection | null = pieceSelection(LEAD, CLOCK);
    sel = walkPiece(CUES, sel, 1, CLOCK);
    expect(sel).toEqual({ sceneId: "take-kept-10000", elementId: null, pieceExtent: { srcIn: 10, srcOut: 12 } });
    sel = walkPiece(CUES, sel!, 1, CLOCK);
    expect(sel).toEqual(tailSel());
    // An id walk would find the LEAD's index here and step to the kept block.
    sel = walkPiece(CUES, sel!, 1, CLOCK);
    expect(sel).toEqual({ sceneId: "scene-2", elementId: null });
    expect(walkPiece(CUES, sel!, -1, CLOCK)).toEqual(tailSel());
  });

  it("from the lead, +1 gives the tail when they are neighbours, then the next cue", () => {
    const cues = [plain("take-1", 0, 10), plain("take-1", 10, 20), graphic("scene-2", 20, 25)];
    const fromLead = walkPiece(cues, pieceSelection(cues[0]!, CLOCK), 1, CLOCK);
    expect(fromLead).toEqual({ sceneId: "take-1", elementId: null, pieceExtent: { srcIn: 10, srcOut: 20 } });
    expect(walkPiece(cues, fromLead!, 1, CLOCK)).toEqual({ sceneId: "scene-2", elementId: null });
  });

  it("either end gives null, and so does an extent that no longer resolves", () => {
    expect(walkPiece(CUES, pieceSelection(LEAD, CLOCK), -1, CLOCK)).toBeNull();
    expect(walkPiece(CUES, pieceSelection(CUES[4]!, CLOCK), 1, CLOCK)).toBeNull();
    const gone: Selection = { sceneId: "take-1", elementId: null, pieceExtent: { srcIn: 40, srcOut: 50 } };
    expect(walkPiece(CUES, gone, 1, CLOCK)).toBeNull();
  });
});

describe("lookCoalesceKey (S17, R7-3)", () => {
  it("is per piece and per unit", () => {
    const ranges = [{ srcIn: 12, srcOut: 20 }];
    expect(lookCoalesceKey(ranges, "framing")).toBe("look:12:framing");
    expect(lookCoalesceKey(ranges, "pipPos")).toBe("look:12:pipPos");
  });
});
