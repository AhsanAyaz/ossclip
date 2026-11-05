import { describe, expect, it } from "vitest";
import {
  dropSfxNearOverlays,
  OVERLAY_PUBLIC_SUBDIR,
  overlayStagedFile,
  resolveOverlayCues,
} from "../src/overlay-cues";
import type { SfxCue } from "../src/assemble";
import type { OverlayEntrySnapshot, OverlayPlacement, Segment } from "../src/schema";
import { TimeMap } from "../src/timemap";

/**
 * The overlay resolver (spec §Resolve → render props): word-indexed
 * placements → output-timed cues plus their pop sounds. Pure — the TimeMap is
 * built from a literal cutlist and the file/sound lookups are injected.
 */

/** Word i spans [2i, 2i+0.4] in source seconds. */
const say = (texts: string[]): { text: string; start: number; end: number }[] =>
  texts.map((text, i) => ({ text, start: i * 2, end: i * 2 + 0.4 }));

const keepAll = (dur: number): TimeMap => new TimeMap([{ srcIn: 0, srcOut: dur, kind: "keep" } satisfies Segment]);

/** Cut the source span [from, to] — every word inside it maps to null. */
const cutting = (dur: number, from: number, to: number): TimeMap =>
  new TimeMap([
    { srcIn: 0, srcOut: from, kind: "keep" },
    { srcIn: from, srcOut: to, kind: "remove" },
    { srcIn: to, srcOut: dur, kind: "keep" },
  ] satisfies Segment[]);

const gde: OverlayEntrySnapshot = { id: "gde", name: "GDE", names: ["GDE"], kind: "logo", ext: "png" };
const fb: OverlayEntrySnapshot = { id: "fb", name: "Firebase", names: ["Firebase"], kind: "logo", ext: "svg", look: "card" };

const match = (entryId: string, word: number, extra: Partial<OverlayPlacement> = {}): OverlayPlacement => ({
  id: `${entryId}@${word}`,
  entryId,
  word,
  source: "match",
  ...extra,
});

const pop = (id: string): { soundFile: string; gain: number; durationSec?: number } | undefined =>
  id === "pop" ? { soundFile: "sfx/pop.mp3", gain: 0.9, durationSec: 0.3 } : undefined;

describe("overlayStagedFile", () => {
  it("is POSIX-literal library/<id>.<ext>", () => {
    expect(OVERLAY_PUBLIC_SUBDIR).toBe("library");
    expect(overlayStagedFile({ id: "gde", ext: "png" })).toBe("library/gde.png");
  });
});

describe("resolveOverlayCues", () => {
  const words = say(["so", "I", "became", "GDE", "and", "used", "Firebase", "a", "lot", "GDE", "end"]);

  it("resolves word start to output seconds; default duration 1.5 overlay / 2.0 card; entry.look default", () => {
    const out = resolveOverlayCues(
      { entries: [gde, fb], placements: [match("gde", 3), match("fb", 6), match("gde", 9, { look: "card" })] },
      words,
      keepAll(30),
      30,
    );
    expect(out.cues).toEqual([
      { id: "gde@3", file: "library/gde.png", kind: "logo", look: "overlay", atSec: 6, endSec: 7.5 },
      // fb's entry default is card → 2.0s.
      { id: "fb@6", file: "library/fb.svg", kind: "logo", look: "card", atSec: 12, endSec: 14 },
      // A placement's own look outranks the entry's.
      { id: "gde@9", file: "library/gde.png", kind: "logo", look: "card", atSec: 18, endSec: 20 },
    ]);
    expect(out.issues).toEqual([]);
  });

  it("an explicit durationSec wins over the look default", () => {
    const out = resolveOverlayCues(
      { entries: [gde], placements: [match("gde", 3, { durationSec: 4 })] },
      words,
      keepAll(30),
      30,
    );
    expect(out.cues[0]).toMatchObject({ atSec: 6, endSec: 10 });
  });

  it("match placement on a cut word falls forward to the next kept mention", () => {
    // Word 3 (6–6.4s) is cut; the next GDE is word 9 at source 18s → output 17s.
    const out = resolveOverlayCues({ entries: [gde], placements: [match("gde", 3)] }, words, cutting(30, 5.5, 6.5), 29);
    expect(out.cues).toHaveLength(1);
    expect(out.cues[0]).toMatchObject({ id: "gde@3", atSec: 17, endSec: 18.5 });
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([["gde@3", "moved forward"]]);
  });

  it("fall-forward skips a mention another entry's longer name claims (ruling R10)", () => {
    const g: OverlayEntrySnapshot = { id: "google", name: "Google", names: ["Google"], kind: "logo", ext: "png" };
    const ge: OverlayEntrySnapshot = {
      id: "gdexp",
      name: "Google Developers Expert",
      names: ["Google Developers Expert"],
      kind: "logo",
      ext: "png",
    };
    const ws = say(["Google", "then", "Google", "Developers", "Expert", "and", "Google"]);
    // Word 0 is cut; word 2's "Google" belongs to the phrase, so the next real mention is word 6.
    const out = resolveOverlayCues(
      { entries: [g, ge], placements: [match("google", 0)] },
      ws,
      cutting(20, 0, 1),
      19,
    );
    expect(out.cues).toEqual([
      { id: "google@0", file: "library/google.png", kind: "logo", look: "overlay", atSec: 11, endSec: 12.5 },
    ]);
  });

  it('no kept mention → dropped with "cut word"', () => {
    // Cut both GDEs (word 3 at 6s and word 9 at 18s).
    const map = new TimeMap([
      { srcIn: 0, srcOut: 5.5, kind: "keep" },
      { srcIn: 5.5, srcOut: 6.5, kind: "remove" },
      { srcIn: 6.5, srcOut: 17.5, kind: "keep" },
      { srcIn: 17.5, srcOut: 18.5, kind: "remove" },
      { srcIn: 18.5, srcOut: 30, kind: "keep" },
    ] satisfies Segment[]);
    const out = resolveOverlayCues({ entries: [gde], placements: [match("gde", 3)] }, words, map, 28);
    expect(out.cues).toEqual([]);
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([["gde@3", "cut word"]]);
  });

  it("user placement on a cut word moves to the next kept word", () => {
    // User put it on word 1 ("I", 2–2.4s), which is cut; word 2 ("became", 4s → output 3s) is next.
    const out = resolveOverlayCues(
      { entries: [gde], placements: [{ id: "u1", entryId: "gde", word: 1, source: "user" }] },
      words,
      cutting(30, 1.5, 2.5),
      29,
    );
    expect(out.cues[0]).toMatchObject({ id: "u1", atSec: 3 });
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([["u1", "moved forward"]]);
  });

  it("endSec clamped to outputDurationSec", () => {
    const out = resolveOverlayCues({ entries: [gde], placements: [match("gde", 9)] }, words, keepAll(30), 18.8);
    expect(out.cues[0]).toMatchObject({ atSec: 18, endSec: 18.8 });
  });

  it('sound default "pop"; null → no soundCue; unknown sound → cue kept, issue "unknown sound"', () => {
    const silent: OverlayEntrySnapshot = { ...fb, id: "quiet", sound: null };
    const out = resolveOverlayCues(
      {
        entries: [gde, silent],
        placements: [
          match("gde", 3),
          match("quiet", 6),
          match("gde", 9, { sound: null }),
          { id: "u1", entryId: "gde", word: 10, sound: "boing", source: "user" },
        ],
      },
      words,
      keepAll(30),
      30,
      { soundFile: pop },
    );
    expect(out.cues.map((c) => c.id)).toEqual(["gde@3", "quiet@6", "gde@9", "u1"]);
    expect(out.soundCues).toEqual([{ soundFile: "sfx/pop.mp3", atSec: 6, gain: 0.9, durationSec: 0.3 }]);
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([["u1", "unknown sound"]]);
  });

  it('exists false → cue dropped, "missing file"', () => {
    const out = resolveOverlayCues(
      { entries: [gde, fb], placements: [match("gde", 3), match("fb", 6)] },
      words,
      keepAll(30),
      30,
      { exists: (rel) => rel !== "library/gde.png", soundFile: pop },
    );
    expect(out.cues.map((c) => c.id)).toEqual(["fb@6"]);
    // A dropped overlay must not leave its pop behind.
    expect(out.soundCues.map((s) => s.atSec)).toEqual([12]);
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([["gde@3", "missing file"]]);
  });

  it("unknown entry and outside transcript are dropped and reported", () => {
    const out = resolveOverlayCues(
      { entries: [gde], placements: [match("nope", 3), match("gde", 99)] },
      words,
      keepAll(30),
      30,
    );
    expect(out.cues).toEqual([]);
    expect(out.issues.map((i) => [i.placement, i.reason])).toEqual([
      ["nope@3", "unknown entry"],
      ["gde@99", "outside transcript"],
    ]);
  });

  it("cues sorted by atSec", () => {
    const out = resolveOverlayCues(
      { entries: [gde, fb], placements: [match("gde", 9), match("fb", 6), match("gde", 3)] },
      words,
      keepAll(30),
      30,
      { soundFile: pop },
    );
    expect(out.cues.map((c) => c.atSec)).toEqual([6, 12, 18]);
    expect(out.soundCues.map((c) => c.atSec)).toEqual([6, 12, 18]);
  });
});

describe("dropSfxNearOverlays", () => {
  const cue = (atSec: number): SfxCue => ({ soundFile: "sfx/whoosh.mp3", atSec, gain: 1 });

  it("dropSfxNearOverlays drops planned sfx within 0.5s either side, keeps 0.6s away", () => {
    const overlay = [{ soundFile: "sfx/pop.mp3", atSec: 10, gain: 1 }];
    const planned = [cue(9.5), cue(9.4), cue(10.2), cue(10.5), cue(10.6), cue(3)];
    const { kept, dropped } = dropSfxNearOverlays(planned, overlay);
    expect(dropped.map((c) => c.atSec)).toEqual([9.5, 10.2, 10.5]);
    expect(kept.map((c) => c.atSec)).toEqual([9.4, 10.6, 3]);
  });

  it("no overlay sounds → everything kept", () => {
    const { kept, dropped } = dropSfxNearOverlays([cue(1)], []);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});
