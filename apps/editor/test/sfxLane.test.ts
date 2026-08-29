import { describe, expect, it } from "vitest";
import { mapFromKeptSpans, OverrideDocSchema, type Word } from "@ossclip/core/browser";
import {
  nearestSfxWord,
  sfxAudioUrl,
  sfxLaneMarkers,
  sfxWordAnchors,
  type SfxPlan,
} from "../src/sfxLane";

/**
 * The SFX lane's data layer (Phase 4, 2026-08-29).
 *
 * The claim under test throughout: the lane is the PLAN ∩ OVERRIDES merge —
 * the same pairing `applySfxOverrides` renders from — and never render-props'
 * resolved cues, which carry no muted placement to draw a ghost from and get
 * renumbered by every re-plan.
 */

/** Five words a second apart, in SOURCE time. */
const WORDS: Word[] = [
  { text: "we", start: 0, end: 0.5 },
  { text: "ship", start: 1, end: 1.5 },
  { text: "sound", start: 2, end: 2.5 },
  { text: "every", start: 3, end: 3.5 },
  { text: "friday", start: 4, end: 4.5 },
];

/** An uncut clip: output time IS source time. */
const identityMap = () =>
  mapFromKeptSpans([{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }]);

/** Words 2–3 (2s–4s) removed: everything after slides 2s earlier. */
const cutMap = () =>
  mapFromKeptSpans([
    { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
    { srcIn: 4, srcOut: 5, outIn: 2, outOut: 3 },
  ]);

const plan = (placements: SfxPlan["placements"]): SfxPlan => ({ level: "normal", placements });

const docSfx = (sfx: unknown) => OverrideDocSchema.parse({ sfx }).sfx;

describe("sfxWordAnchors", () => {
  it("gives every word its output instant", () => {
    expect(sfxWordAnchors(WORDS, identityMap())).toEqual([
      { word: 0, atSec: 0 },
      { word: 1, atSec: 1 },
      { word: 2, atSec: 2 },
      { word: 3, atSec: 3 },
      { word: 4, atSec: 4 },
    ]);
  });

  it("drops words the cut removed and re-times the survivors", () => {
    // Words 2 and 3 are gone; "friday" moved from 4s to 2s. The INDEX is
    // preserved — it is what the doc stores, and a renumbered lane would edit
    // the wrong placement.
    expect(sfxWordAnchors(WORDS, cutMap())).toEqual([
      { word: 0, atSec: 0 },
      { word: 1, atSec: 1 },
      { word: 4, atSec: 2 },
    ]);
  });

  it("has nothing to place with no map at all", () => {
    // Malformed/absent spans: an empty lane, never a wall of markers at zero.
    expect(sfxWordAnchors(WORDS, null)).toEqual([]);
  });
});

describe("nearestSfxWord", () => {
  const anchors = sfxWordAnchors(WORDS, identityMap());

  it("snaps to the nearest word's index", () => {
    expect(nearestSfxWord(anchors, 2.4)).toBe(2);
    expect(nearestSfxWord(anchors, 2.6)).toBe(3);
  });

  it("clamps past both ends rather than refusing", () => {
    expect(nearestSfxWord(anchors, -10)).toBe(0);
    expect(nearestSfxWord(anchors, 99)).toBe(4);
  });

  it("keeps the EARLIER word on an exact tie", () => {
    expect(nearestSfxWord(anchors, 2.5)).toBe(2);
  });

  it("answers null when no word survived the cut", () => {
    expect(nearestSfxWord([], 1)).toBeNull();
  });
});

describe("sfxLaneMarkers", () => {
  const anchors = sfxWordAnchors(WORDS, identityMap());

  it("draws the model's plan when the user has touched nothing", () => {
    const markers = sfxLaneMarkers(
      plan([{ soundId: "ding", word: 2, rationale: "the point lands" }]),
      undefined,
      anchors,
    );
    expect(markers).toEqual([
      {
        key: "ding@2",
        kind: "planned",
        soundId: "ding",
        word: 2,
        gain: 1,
        muted: false,
        atSec: 2,
        planned: { soundId: "ding", word: 2 },
      },
    ]);
  });

  it("draws nothing at all — not an empty plan — when the production has no sfx", () => {
    expect(sfxLaneMarkers(null, docSfx({ added: [{ id: "ding-1", soundId: "ding", word: 1 }] }), anchors))
      .toEqual([]);
  });

  it("applies a retime, a swap and a gain from the edit layer, keeping the plan's key", () => {
    const markers = sfxLaneMarkers(
      plan([{ soundId: "ding", word: 2, gain: 0.5 }]),
      docSfx({ edits: { "ding@2": { word: 4, soundId: "vine-boom", gain: 1.5 } } }),
      anchors,
    );
    // The KEY is still the plan's `${soundId}@${word}` — content-derived, so a
    // swap+drag does not re-key the edit out from under itself.
    expect(markers[0]).toEqual({
      key: "ding@2",
      kind: "planned",
      soundId: "vine-boom",
      word: 4,
      gain: 1.5,
      muted: false,
      atSec: 4,
      planned: { soundId: "ding", word: 2, gain: 0.5 },
    });
  });

  it("keeps a MUTED placement in the lane as a ghost", () => {
    // The whole reason the lane cannot be drawn from render-props' cues: a
    // mute has no cue, and the ghost is what makes it restorable.
    const markers = sfxLaneMarkers(
      plan([{ soundId: "ding", word: 2 }]),
      docSfx({ edits: { "ding@2": { muted: true } } }),
      anchors,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.muted).toBe(true);
    expect(markers[0]!.atSec).toBe(2);
  });

  it("appends the user's own placements, marked as theirs", () => {
    const markers = sfxLaneMarkers(
      plan([{ soundId: "ding", word: 3 }]),
      docSfx({ added: [{ id: "pop-1", soundId: "pop", word: 1, gain: 0.25 }] }),
      anchors,
    );
    // Time order, like the list `applySfxOverrides` hands the resolver.
    expect(markers.map((m) => [m.key, m.kind, m.atSec])).toEqual([
      ["pop-1", "added", 1],
      ["ding@3", "planned", 3],
    ]);
    // An added placement has no plan to restate, so it carries no `planned`
    // record — which is what routes its edits to the other write path.
    expect(markers[0]!.planned).toBeUndefined();
  });

  it("drops a placement whose word the cut removed", () => {
    // `resolveSfxCues` drops it too ("it would fire over speech that never
    // motivated it"), so drawing it would promise an effect no render plays.
    const markers = sfxLaneMarkers(
      plan([
        { soundId: "ding", word: 2 },
        { soundId: "pop", word: 4 },
      ]),
      undefined,
      sfxWordAnchors(WORDS, cutMap()),
    );
    expect(markers.map((m) => m.key)).toEqual(["pop@4"]);
    // …and at its NEW output instant, not the source second it was planned at.
    expect(markers[0]!.atSec).toBe(2);
  });

  it("drops a placement pointing past the end of the transcript", () => {
    expect(sfxLaneMarkers(plan([{ soundId: "ding", word: 99 }]), undefined, anchors)).toEqual([]);
  });

  it("gives a duplicate key's edit to the FIRST placement only", () => {
    // `applySfxOverrides`' duplicate-key rule: the twin draws as planned
    // rather than as a second copy of somebody else's edit.
    const markers = sfxLaneMarkers(
      plan([
        { soundId: "ding", word: 1 },
        { soundId: "ding", word: 1 },
      ]),
      docSfx({ edits: { "ding@1": { word: 4 } } }),
      anchors,
    );
    expect(markers.map((m) => m.word)).toEqual([1, 4]);
  });

  it("ignores an edit key nothing in the plan answers to", () => {
    // The stale-key case (a re-plan dropped the placement): produce reports
    // it; the lane simply has nothing to draw for it, and must not invent a
    // marker out of an override alone.
    const markers = sfxLaneMarkers(
      plan([{ soundId: "ding", word: 1 }]),
      docSfx({ edits: { "gone@7": { word: 2 } } }),
      anchors,
    );
    expect(markers.map((m) => m.key)).toEqual(["ding@1"]);
  });
});

describe("sfxAudioUrl", () => {
  it("addresses a sound by ID — the server resolves the file", () => {
    expect(sfxAudioUrl("vine-boom")).toBe("/api/sfx/audio?id=vine-boom");
  });

  it("encodes the id rather than pasting it into the query", () => {
    // Ids are slugs today (`SfxSoundSchema`), so this is belt-and-braces — but
    // the URL is built here, and a query builder that trusts its input is how
    // the next id vocabulary breaks it.
    expect(sfxAudioUrl("a b&c=d")).toBe("/api/sfx/audio?id=a%20b%26c%3Dd");
  });
});
