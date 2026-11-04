import { describe, expect, it } from "vitest";
import { assembleScenes, ENTRY_LEAD_SEC, ITEM_LEAD_SEC } from "../src/assemble";
import { fillPlainCues } from "../src/fill";
import { TimeMap } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";
import type { Scene } from "../src/scene-schema";

/** 10 words, 0.5 s each, back-to-back: word i covers [i*0.5, i*0.5+0.4]. */
const transcript: Transcript = {
  language: "en",
  words: Array.from({ length: 10 }, (_, i) => ({
    text: `w${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  })),
};
const DURATION = 5;

const identity = new TimeMap([{ srcIn: 0, srcOut: DURATION, kind: "keep" } satisfies Segment]);

const scene = (id: string, startWord: number, endWord: number, extra?: Partial<Scene>): Scene => ({
  id,
  anchor: { startWord, endWord },
  layout: "pip-bubble",
  component: "TitleCard",
  props: { title: `SCENE ${id}` },
  overrides: {},
  ...extra,
});

describe("assembleScenes", () => {
  it("resolves word anchors to output time", () => {
    const { cues } = assembleScenes([scene("a", 2, 5)], transcript, identity);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startSec).toBeCloseTo(1.0, 5);
    expect(cues[0]!.endSec).toBeCloseTo(2.9, 5); // extended to MIN_SCENE if needed; 2.9-1.0=1.9 > 1.2
  });

  it("drops scenes whose anchor words were entirely cut", () => {
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 1, kind: "keep" },
      { srcIn: 1, srcOut: 3, kind: "remove", reason: "user" },
      { srcIn: 3, srcOut: 5, kind: "keep" },
    ];
    const map = new TimeMap(cutlist);
    // words 2..5 span [1.0, 2.9] in source — words 2-5 all inside the cut except w6+
    const { cues, dropped } = assembleScenes([scene("cut", 2, 5)], transcript, map);
    expect(cues).toHaveLength(0);
    expect(dropped[0]).toMatchObject({ id: "cut" });
  });

  it("scenes survive a cleanup-level change via word anchors (PHASE1 regression)", () => {
    // Same scene, two different cutlists: anchors follow the words.
    const lightMap = identity;
    const aggressive: Segment[] = [
      { srcIn: 0, srcOut: 0.95, kind: "keep" },
      { srcIn: 0.95, srcOut: 1.45, kind: "remove", reason: "pause" }, // removes word 2's span start
      { srcIn: 1.45, srcOut: 5, kind: "keep" },
    ];
    const aggMap = new TimeMap(aggressive);
    const s = scene("anchored", 4, 7);
    const a = assembleScenes([s], transcript, lightMap).cues[0]!;
    const b = assembleScenes([s], transcript, aggMap).cues[0]!;
    // Word 4 starts at source 2.0; in the aggressive cut 0.5s was removed before it.
    expect(a.startSec).toBeCloseTo(2.0, 5);
    expect(b.startSec).toBeCloseTo(1.5, 5);
  });

  it("caps scene duration so graphics hand the frame back (FINDINGS §3)", () => {
    // Words 0..9 span the full 5s take — without the cap this cue would too.
    const { cues } = assembleScenes([scene("long", 0, 9)], transcript, identity);
    expect(cues[0]!.endSec - cues[0]!.startSec).toBeLessThanOrEqual(5 + 1e-9);
  });

  it("keeps scenes exclusive and enforces minimum duration", () => {
    const { cues } = assembleScenes(
      [scene("one", 0, 1), scene("two", 1, 2), scene("three", 8, 9)],
      transcript,
      identity,
    );
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i]!.endSec).toBeLessThanOrEqual(cues[i + 1]!.startSec);
    }
    for (const cue of cues) {
      expect(cue.endSec - cue.startSec).toBeGreaterThanOrEqual(0.8 - 1e-9);
    }
  });

  it("merges overrides over props and drops invalid merges", () => {
    const good = scene("g", 0, 3, { overrides: { title: "OVERRIDDEN" } });
    const bad = scene("b", 5, 8, { props: { title: "" } });
    const { cues, dropped } = assembleScenes([good, bad], transcript, identity);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.props!.title).toBe("OVERRIDDEN");
    expect(dropped[0]).toMatchObject({ id: "b" });
  });

  it("assembled graphic cues carry the scene's anchor; plain fill cues carry none", () => {
    // The anchor is the cue's cross-re-plan identity (handoff-edit-anchoring):
    // graphic cues carry their scene's word range, fill cues have no plan
    // anchor and must stay bare so absence keeps meaning "id-only identity".
    const { cues } = assembleScenes([scene("scene-0", 2, 5)], transcript, identity);
    expect(cues[0]!.anchor).toEqual({ startWord: 2, endWord: 5 });
    const filled = fillPlainCues(cues, { outputDurationSec: 10, clipStarts: [0] });
    expect(filled.find((c) => c.kind === "plain")!.anchor).toBeUndefined();
  });

  it("every layout holds through its whole moment (R23 §114), under the 15s ceiling", () => {
    // 20 words at 0.5s each — a 9.9s moment, longer than the old 5s punch-out.
    const long: Transcript = {
      language: "en",
      words: Array.from({ length: 20 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.5,
        end: i * 0.5 + 0.4,
      })),
    };
    const map = new TimeMap([{ srcIn: 0, srcOut: 10, kind: "keep" } satisfies Segment]);
    for (const layout of ["lower-third", "video-top", "graphic-only"] as const) {
      const cue = assembleScenes([scene(`s-${layout}`, 0, 19, { layout })], long, map).cues[0]!;
      // The discussion runs 0 → 9.9s; the card stays for all of it — the
      // launch complaint was cards leaving while the captions still talked
      // about them.
      expect(cue.endSec - cue.startSec).toBeGreaterThan(9);
    }
    // The ceiling still exists: a 25s moment cannot pin one static card up
    // for its whole span.
    const rambling: Transcript = {
      language: "en",
      words: Array.from({ length: 50 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.5,
        end: i * 0.5 + 0.4,
      })),
    };
    const longMap = new TimeMap([{ srcIn: 0, srcOut: 25, kind: "keep" } satisfies Segment]);
    const capped = assembleScenes(
      [scene("capped", 0, 49, { layout: "lower-third" })],
      rambling,
      longMap,
    ).cues[0]!;
    expect(capped.endSec - capped.startSec).toBeCloseTo(15, 5);
  });
});

describe("assembleScenes — legacy plans (no scene.cue) are byte-identical (reveal-timing decision 1)", () => {
  it("a 3-scene plan through a cut assembles exactly as it did before on-cue starts existed", () => {
    // Recorded from the pre-reveal-timing assemble.ts (2026-11-04). A cut,
    // an override merge, an overlap and a de-overlap push are all in here, so
    // any change to the legacy path shows up as a diff against this literal.
    const words = Array.from({ length: 20 }, (_, i) => ({
      text: `w${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    }));
    const map = new TimeMap([
      { srcIn: 0, srcOut: 3, kind: "keep" },
      { srcIn: 3, srcOut: 4, kind: "remove", reason: "pause" },
      { srcIn: 4, srcOut: 10, kind: "keep" },
    ]);
    const scenes: Scene[] = [
      { id: "scene-0", anchor: { startWord: 0, endWord: 3 }, layout: "pip-bubble", component: "TitleCard", props: { title: "HELLO" }, overrides: {} },
      { id: "scene-1", anchor: { startWord: 5, endWord: 9 }, layout: "lower-third", component: "FlowDiagram", props: { nodes: ["IDEA", "BUILD"] }, overrides: { emphasizeLast: false } },
      { id: "scene-2", anchor: { startWord: 8, endWord: 19 }, layout: "graphic-only", component: "ChatMock", props: { messages: [{ from: "user", text: "hi" }, { from: "agent", text: "yo" }] }, overrides: {} },
    ];
    expect(assembleScenes(scenes, { language: "en", words }, map)).toEqual({
      cues: [
        { id: "scene-0", anchor: { startWord: 0, endWord: 3 }, layout: "pip-bubble", component: "TitleCard", props: { title: "HELLO" }, startSec: 0, endSec: 1.9 },
        { id: "scene-1", anchor: { startWord: 5, endWord: 9 }, layout: "lower-third", component: "FlowDiagram", props: { nodes: ["IDEA", "BUILD"], emphasizeLast: false }, startSec: 2.5, endSec: 3.9000000000000004 },
        { id: "scene-2", anchor: { startWord: 8, endWord: 19 }, layout: "graphic-only", component: "ChatMock", props: { messages: [{ from: "user", text: "hi" }, { from: "agent", text: "yo" }] }, startSec: 3.95, endSec: 8.9 },
      ],
      dropped: [],
    });
  });
});

describe("assembleScenes — on-cue start and spoken item times (reveal-timing §2, §3)", () => {
  /**
   * A 50s take (100 words, 0.5s apart) so the floor is the plain
   * MIN_SCENE_SEC (1.2) — under SHORT_TAKE_SEC the floor scales with the
   * runtime and the arithmetic below would stop being readable.
   */
  const long: Transcript = {
    language: "en",
    words: Array.from({ length: 100 }, (_, i) => ({
      text: `w${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    })),
  };
  const longMap = new TimeMap([{ srcIn: 0, srcOut: 50, kind: "keep" } satisfies Segment]);
  const flow = (id: string, startWord: number, endWord: number, cue?: Scene["cue"]): Scene => ({
    id,
    anchor: { startWord, endWord },
    layout: "graphic-only",
    component: "FlowDiagram",
    props: { nodes: ["IDEA", "BUILD"] },
    overrides: {},
    ...(cue ? { cue } : {}),
  });
  const one = (s: Scene, map: TimeMap = longMap) => {
    const { cues } = assembleScenes([s], long, map);
    expect(cues).toHaveLength(1);
    return cues[0]!;
  };

  it("exports the spec's lead-ins", () => {
    expect(ENTRY_LEAD_SEC).toBe(0.3);
    expect(ITEM_LEAD_SEC).toBe(0.15);
  });

  it("a 10s moment whose entry word is at 7.0s starts at 6.7s; its end does not move", () => {
    const legacy = one(flow("s", 0, 19));
    const cued = one(flow("s", 0, 19, { entryWord: 14 }));
    expect(legacy.startSec).toBeCloseTo(0, 9);
    expect(cued.startSec).toBeCloseTo(6.7, 9);
    expect(cued.endSec).toBe(legacy.endSec);
    // No itemWords for a staggering component → every item unmatched: a
    // present all-null reveal, so the renderer paces instead of going legacy.
    expect(cued.reveal).toEqual({ itemAtSec: [null, null] });
  });

  it("an entry word near the moment's end pulls the start back to hold the floor (Review Focus 4)", () => {
    // Entry at 9.5s → 9.2s would leave 0.7s before the 9.9s end.
    const cued = one(flow("s", 0, 19, { entryWord: 19 }));
    expect(cued.endSec).toBeCloseTo(9.9, 9);
    expect(cued.startSec).toBeCloseTo(9.9 - 1.2, 9);
  });

  it("the floor's pull-back never goes before the moment's own start", () => {
    // Moment 9.0 → 9.9s: end − floor (8.7) is before the moment, so the start
    // stays on the moment start and the existing floor loop extends the end.
    const cued = one(flow("s", 18, 19, { entryWord: 19 }));
    const legacy = one(flow("s", 18, 19));
    expect(cued.startSec).toBeCloseTo(9.0, 9);
    // Timing identical to legacy; the only difference is the all-null reveal
    // a cued plan without itemWords carries (it paces rather than going legacy).
    const { reveal, ...timing } = cued;
    expect(timing).toEqual(legacy);
    expect(reveal).toEqual({ itemAtSec: [null, null] });
  });

  it("a stale entry word outside the anchor is clamped into the scene's own words", () => {
    // An anchor edit after planning can leave the cue pointing anywhere —
    // even past the transcript. Clamped to the anchor's last word, the floor
    // then decides, exactly as for a real late entry.
    const cued = one(flow("s", 0, 19, { entryWord: 500 }));
    expect(cued.startSec).toBeCloseTo(9.9 - 1.2, 9);
    expect(cued.endSec).toBeCloseTo(9.9, 9);
  });

  it("a moment longer than the 15s cap keeps its legacy end when the start moves later", () => {
    // 25s moment, entry at 10s. Were the start moved before the legacy loop,
    // the cap would be measured from it and the card would stay until 24.9s.
    const legacy = one(flow("s", 0, 49));
    const cued = one(flow("s", 0, 49, { entryWord: 20 }));
    expect(legacy.endSec).toBeCloseTo(15, 9);
    expect(cued.startSec).toBeCloseTo(9.7, 9);
    expect(cued.endSec).toBe(legacy.endSec);
  });

  it("items carry ABSOLUTE output seconds, each its word's start minus the item lead", () => {
    const cued = one(flow("s", 0, 19, { entryWord: 14, itemWords: [14, 17] }));
    expect(cued.reveal!.itemAtSec).toHaveLength(2);
    expect(cued.reveal!.itemAtSec[0]).toBeCloseTo(6.85, 9);
    expect(cued.reveal!.itemAtSec[1]).toBeCloseTo(8.35, 9);
  });

  it("an unmatched item stays null", () => {
    const cued = one(flow("s", 0, 19, { entryWord: 14, itemWords: [14, null] }));
    expect(cued.reveal!.itemAtSec[0]).toBeCloseTo(6.85, 9);
    expect(cued.reveal!.itemAtSec[1]).toBeNull();
  });

  it("an entry word spoken AFTER an item is legitimate — texts are not always said in order", () => {
    const cued = one(flow("s", 0, 19, { entryWord: 17, itemWords: [14, 17] }));
    expect(cued.startSec).toBeCloseTo(8.2, 9);
    expect(cued.reveal!.itemAtSec[0]).toBeCloseTo(6.85, 9);
  });

  it("a cut entry word falls to the next surviving transcript word in the moment; a cut item is null (Review Focus 1)", () => {
    // Removes source 6.9–7.5 — all of word 14 (7.0–7.4) — so everything
    // after shifts 0.6s earlier.
    const cutMap = new TimeMap([
      { srcIn: 0, srcOut: 6.9, kind: "keep" },
      { srcIn: 6.9, srcOut: 7.5, kind: "remove", reason: "user" },
      { srcIn: 7.5, srcOut: 50, kind: "keep" },
    ]);
    const cued = one(flow("s", 0, 19, { entryWord: 14, itemWords: [14, 17] }), cutMap);
    // Word 15 (source 7.5 → output 6.9) is the first word still spoken after
    // the cut entry — not item word 17 two words later — minus the entry lead.
    expect(cued.startSec).toBeCloseTo(6.6, 9);
    expect(cued.reveal!.itemAtSec[0]).toBeNull();
    expect(cued.reveal!.itemAtSec[1]).toBeCloseTo(7.75, 9);
  });

  it("the fallback is any surviving word, item or not: an earlier item word never becomes the entry", () => {
    const cutMap = new TimeMap([
      { srcIn: 0, srcOut: 6.9, kind: "keep" },
      { srcIn: 6.9, srcOut: 7.5, kind: "remove", reason: "user" },
      { srcIn: 7.5, srcOut: 50, kind: "keep" },
    ]);
    // Item 0 (word 10) survives but is EARLIER than the entry word, so it is
    // not the fallback; word 15, after the entry, is.
    const cued = one(flow("s", 0, 19, { entryWord: 14, itemWords: [10, 14] }), cutMap);
    expect(cued.startSec).toBeCloseTo(6.6, 9);
    expect(cued.reveal!.itemAtSec[0]).toBeCloseTo(4.85, 9);
    expect(cued.reveal!.itemAtSec[1]).toBeNull();
  });

  it("a cut entry word with no surviving word after it in the moment keeps the legacy start", () => {
    // Removes source 8.9–10 — words 18 and 19, the moment's last two.
    const cutMap = new TimeMap([
      { srcIn: 0, srcOut: 8.9, kind: "keep" },
      { srcIn: 8.9, srcOut: 10, kind: "remove", reason: "user" },
      { srcIn: 10, srcOut: 50, kind: "keep" },
    ]);
    const cued = one(flow("s", 0, 19, { entryWord: 18, itemWords: [10, 18] }), cutMap);
    const legacy = one(flow("s", 0, 19), cutMap);
    expect(cued.startSec).toBe(legacy.startSec);
    // Word 20 survives but is outside the moment — never an entry.
    expect(cued.entryAtSec).toBeUndefined();
  });

  it("an item list that no longer matches the rendered items goes all-null (paced), never misaligned", () => {
    // Planned with the CTA keyword — ONE bubble, one item word — then the
    // keyword was removed in the editor: two bubbles render now.
    const chat: Scene = {
      id: "chat",
      anchor: { startWord: 0, endWord: 19 },
      layout: "graphic-only",
      component: "ChatMock",
      props: {
        messages: [
          { from: "user", text: "hi" },
          { from: "agent", text: "yo" },
        ],
        keyword: "agents",
      },
      overrides: { keyword: "" },
      cue: { entryWord: 14, itemWords: [14] },
    };
    const cued = one(chat);
    expect(cued.startSec).toBeCloseTo(6.7, 9);
    // Still present (a new plan → paced, not legacy), one null per bubble.
    expect(cued.reveal).toEqual({ itemAtSec: [null, null] });
    // With the keyword still set, the single item lines up and is kept.
    const intact = one({ ...chat, overrides: {} });
    expect(intact.reveal!.itemAtSec).toHaveLength(1);
  });

  it("cued plans keep every legacy end, the legacy order and no overlap; starts only move later", () => {
    // The pass bar "no scene ends earlier than in the current plan" (spec,
    // Builder-check answers), over overlapping and nested moments — both
    // Task 4 review probes included: a scene nested inside a cued moment
    // (A/B), and a preceding scene pushing a long cued moment (P/Q).
    const plans: Scene[][] = [
      [flow("A", 0, 19, { entryWord: 14 }), flow("B", 12, 15)],
      [flow("P", 0, 9), flow("Q", 8, 57, { entryWord: 20 })],
      [
        flow("s0", 0, 9, { entryWord: 6, itemWords: [6, 8] }),
        flow("s1", 5, 12),
        flow("s2", 11, 30, { entryWord: 28 }),
        flow("s3", 20, 24, { entryWord: 22 }),
        flow("s4", 29, 80, { entryWord: 50, itemWords: [50, 60] }),
        flow("s5", 79, 81, { entryWord: 81 }),
      ],
    ];
    for (const plan of plans) {
      const legacyPlan = plan.map(({ cue: _cue, ...rest }) => rest);
      const legacy = assembleScenes(legacyPlan, long, longMap);
      const cued = assembleScenes(plan, long, longMap);
      expect(cued.cues.map((c) => c.id)).toEqual(legacy.cues.map((c) => c.id));
      expect(cued.dropped).toEqual(legacy.dropped);
      cued.cues.forEach((c, i) => {
        const l = legacy.cues[i]!;
        expect(c.endSec).toBe(l.endSec);
        expect(c.startSec).toBeGreaterThanOrEqual(l.startSec);
        expect(c.endSec - c.startSec).toBeGreaterThan(0);
        const next = cued.cues[i + 1];
        if (next) expect(c.endSec).toBeLessThanOrEqual(next.startSec);
      });
    }
    // Probe 1 specifically: B stays where legacy put it, after A, and A
    // keeps its whole moment's end.
    const [a, b] = assembleScenes(plans[0]!, long, longMap).cues;
    expect(a!.id).toBe("A");
    expect(a!.startSec).toBeCloseTo(6.7, 9);
    expect(a!.endSec).toBeCloseTo(9.9, 9);
    expect(b!.startSec).toBeCloseTo(9.95, 9);
    // Probe 2: Q keeps the end it gets from its pushed legacy start.
    const q = assembleScenes(plans[1]!, long, longMap).cues[1]!;
    expect(q.endSec).toBeCloseTo(19.95, 9);
    expect(q.startSec).toBeCloseTo(9.7, 9);
  });

  it("entryAtSec records the entry word's lead-free output second, only when the start moved", () => {
    // Moved: the preview needs the word itself to re-time from (spec §2) —
    // the start's lead can sit in the previous kept span across a seam.
    const moved = one(flow("s", 0, 19, { entryWord: 14 }));
    expect(moved.entryAtSec).toBeCloseTo(7.0, 9);
    // Floor-pulled is still moved: the entry word is still what it tracks.
    expect(one(flow("s", 0, 19, { entryWord: 19 })).entryAtSec).toBeCloseTo(9.5, 9);
    // Not moved (the floor held it on the legacy start): no key at all, so
    // the cue's timing fields are the legacy cue's exactly.
    expect("entryAtSec" in one(flow("s", 18, 19, { entryWord: 19 }))).toBe(false);
    expect("entryAtSec" in one(flow("s", 0, 19, { entryWord: 0 }))).toBe(false);
    // A legacy plan never grows the key.
    expect("entryAtSec" in one(flow("s", 0, 19))).toBe(false);
  });

  it("a component that does not stagger never carries a reveal", () => {
    const card: Scene = {
      id: "card",
      anchor: { startWord: 0, endWord: 19 },
      layout: "graphic-only",
      component: "TitleCard",
      props: { title: "HELLO" },
      overrides: {},
      cue: { entryWord: 14, itemWords: [14] },
    };
    const cued = one(card);
    expect(cued.startSec).toBeCloseTo(6.7, 9);
    expect(cued.reveal).toBeUndefined();
  });
});
