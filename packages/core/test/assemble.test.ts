import { describe, expect, it } from "vitest";
import { assembleScenes } from "../src/assemble";
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
});
