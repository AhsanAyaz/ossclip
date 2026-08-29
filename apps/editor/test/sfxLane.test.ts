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

  /**
   * The scene link in the lane (field report, 2026-08-29): the diamond has to
   * sit on the GRAPHIC, and it has to move with it while the user drags the
   * scene — which is why the positions come from the live cue list rather than
   * from anything produce wrote.
   */
  describe("scene-anchored markers", () => {
    const scenes = (entries: Array<[string, number]>) => new Map(entries);

    it("draws at the scene's LIVE start, not at the anchor word", () => {
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
        undefined,
        anchors,
        scenes([["scene-0", 3.5]]),
      );
      expect(markers[0]!.atSec).toBe(3.5);
      // The word is still what the doc stores and what a drag compares against.
      expect(markers[0]!.word).toBe(2);
      expect(markers[0]!.sceneId).toBe("scene-0");
    });

    it("MOVES when the scene moves — the in-session drag, before any render", () => {
      const at = (start: number) =>
        sfxLaneMarkers(
          plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
          undefined,
          anchors,
          scenes([["scene-0", start]]),
        )[0]!.atSec;
      expect(at(0.25)).toBe(0.25);
      expect(at(4.75)).toBe(4.75);
    });

    it("falls back to the word when the scene is gone, and says so by omitting sceneId", () => {
      // `resolveSfxCues`' own fallback, mirrored: the word anchor is required
      // precisely so a deleted graphic costs the sync, not the sound.
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-9" }]),
        undefined,
        anchors,
        scenes([["scene-0", 3.5]]),
      );
      expect(markers[0]!.atSec).toBe(2);
      expect(markers[0]!.sceneId).toBeUndefined();
    });

    it("no scene map at all is the same as every scene being gone", () => {
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
        undefined,
        anchors,
      );
      expect(markers[0]!.atSec).toBe(2);
      expect(markers[0]!.sceneId).toBeUndefined();
    });

    it("a RETIME breaks the link, so the dragged marker stays where it was dropped", () => {
      // `applySfxOverrides` clears `sceneId` on any edit carrying a word; the
      // lane must agree, or the diamond would snap back to the graphic and the
      // drag would look like it never happened.
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
        docSfx({ edits: { "ding@2": { word: 4 } } }),
        anchors,
        scenes([["scene-0", 3.5]]),
      );
      expect(markers[0]!.atSec).toBe(4);
      expect(markers[0]!.sceneId).toBeUndefined();
    });

    it("a gain- or mute-only edit leaves the link intact", () => {
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
        docSfx({ edits: { "ding@2": { gain: 0.2, muted: true } } }),
        anchors,
        scenes([["scene-0", 3.5]]),
      );
      expect(markers[0]).toMatchObject({ atSec: 3.5, sceneId: "scene-0", muted: true });
    });

    it("keeps a scene-anchored marker whose WORD the cut removed", () => {
      // Words 2–3 are gone from `cutMap`, so the word path would drop this —
      // but the graphic is on screen either way (`resolveSfxCues`' rule).
      const markers = sfxLaneMarkers(
        plan([{ soundId: "ding", word: 2, sceneId: "scene-0" }]),
        undefined,
        sfxWordAnchors(WORDS, cutMap()),
        scenes([["scene-0", 1.5]]),
      );
      expect(markers.map((m) => m.atSec)).toEqual([1.5]);
    });

    it("sorts scene-anchored and word-anchored markers together, by time", () => {
      const markers = sfxLaneMarkers(
        plan([
          { soundId: "ding", word: 4, sceneId: "scene-0" },
          { soundId: "pop", word: 3 },
        ]),
        undefined,
        anchors,
        scenes([["scene-0", 1]]),
      );
      expect(markers.map((m) => [m.soundId, m.atSec])).toEqual([
        ["ding", 1],
        ["pop", 3],
      ]);
    });
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
