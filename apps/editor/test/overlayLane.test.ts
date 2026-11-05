import { describe, expect, it } from "vitest";
import {
  mapFromKeptSpans,
  OverrideDocSchema,
  type OverlayEntrySnapshot,
  type OverlayPlacement,
  type Word,
} from "@ossclip/core/browser";
import {
  overlayDefaultDurationSec,
  overlayLaneMarkers,
  overlayMediaUrl,
  overlayPreview,
  overlaySeekSec,
  type OverlayPlan,
} from "../src/overlayLane";

/**
 * The overlay lane's data layer (overlay-library spec §Editor). The claim
 * under test: the lane is the plan ∩ overrides merge resolved by THE
 * resolver produce renders with (`resolveOverlayCues`), so a chip sits
 * exactly where the render will put the picture — fall-forward included —
 * and a removed match stays drawable as a restorable ghost.
 */

/** Six words a second apart, SOURCE time; "GDE" said twice. */
const WORDS: Word[] = [
  { text: "I'm", start: 0, end: 0.5 },
  { text: "a", start: 1, end: 1.5 },
  { text: "GDE", start: 2, end: 2.5 },
  { text: "and", start: 3, end: 3.5 },
  { text: "GDE", start: 4, end: 4.5 },
  { text: "rocks", start: 5, end: 5.5 },
];

const identityMap = () => mapFromKeptSpans([{ srcIn: 0, srcOut: 6, outIn: 0, outOut: 6 }]);
/** Word 2 (2s–3s) cut: everything after slides 1s earlier. */
const cutWord2 = () =>
  mapFromKeptSpans([
    { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
    { srcIn: 3, srcOut: 6, outIn: 2, outOut: 5 },
  ]);

const GDE: OverlayEntrySnapshot = { id: "gde", name: "GDE", names: ["GDE"], kind: "logo", ext: "png" };
const FB: OverlayEntrySnapshot = { id: "fb", name: "Firebase", names: ["Firebase"], kind: "logo", ext: "svg", look: "card" };

const plan = (placements: OverlayPlacement[], entries: OverlayEntrySnapshot[] = [GDE, FB]): OverlayPlan => ({
  entries,
  placements,
});
const MATCH: OverlayPlacement = { id: "gde@2", entryId: "gde", word: 2, source: "match" };

const layer = (overlays: unknown) => OverrideDocSchema.parse({ overlays }).overlays;

describe("overlayLaneMarkers", () => {
  it("draws the plan and the user's added placements, in time order", () => {
    const markers = overlayLaneMarkers(
      plan([MATCH]),
      layer({ added: [{ id: "fb-0", entryId: "fb", word: 0, source: "user" }] }),
      WORDS,
      identityMap(),
    );
    expect(markers.map((m) => [m.id, m.atSec, m.endSec, m.look, m.added, m.removed])).toEqual([
      // The entry's own look, card → the 2.0s card default.
      ["fb-0", 0, 2, "card", true, false],
      ["gde@2", 2, 3.5, "overlay", false, false],
    ]);
    expect(markers[0]!.file).toBe("library/fb.svg");
    expect(markers[1]!.sound).toBe("pop");
  });

  it("keeps a REMOVED match as a ghost, where it would have played", () => {
    const markers = overlayLaneMarkers(
      plan([MATCH]),
      layer({ edits: { "gde@2": { removed: true, look: "card" } } }),
      WORDS,
      identityMap(),
    );
    // The ghost draws with the user's other edits applied, so a restore
    // puts back what they had, not the plan's bare version.
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ id: "gde@2", removed: true, look: "card", atSec: 2, endSec: 4 });
  });

  it("falls a match on a cut word forward to the next kept mention (the resolver's rule)", () => {
    const markers = overlayLaneMarkers(plan([MATCH]), undefined, WORDS, cutWord2());
    // Word 4 ("GDE", source 4s) lands at output 3s.
    expect(markers.map((m) => [m.id, m.atSec, m.word])).toEqual([["gde@2", 3, 2]]);
  });

  it("drops a placement with nowhere to go rather than parking it at zero", () => {
    const user: OverlayPlacement = { id: "gde-5", entryId: "gde", word: 5, source: "user" };
    const cutTail = mapFromKeptSpans([{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }]);
    expect(overlayLaneMarkers(plan([]), layer({ added: [user] }), WORDS, cutTail)).toEqual([]);
  });

  it("reads the layer's entry snapshot over the plan's (a tray swap re-snapshots)", () => {
    const swapped = { ...GDE, ext: "gif" as const, kind: "gif" as const };
    const markers = overlayLaneMarkers(plan([MATCH]), layer({ entries: [swapped] }), WORDS, identityMap());
    expect(markers[0]!.file).toBe("library/gde.gif");
  });

  it("shows the stored duration and an explicit silence", () => {
    const markers = overlayLaneMarkers(
      plan([MATCH]),
      layer({ edits: { "gde@2": { durationSec: 3, sound: null } } }),
      WORDS,
      identityMap(),
    );
    expect(markers[0]).toMatchObject({ durationSec: 3, sound: null, endSec: 5 });
  });

  it("is empty with no map or no words, and draws added placements with no plan", () => {
    expect(overlayLaneMarkers(plan([MATCH]), undefined, WORDS, null)).toEqual([]);
    expect(
      overlayLaneMarkers(null, layer({ added: [{ id: "gde-1", entryId: "gde", word: 1, source: "user" }], entries: [GDE] }), WORDS, identityMap()),
    ).toHaveLength(1);
  });
});

describe("overlayPreview", () => {
  const SOUNDS = [{ id: "pop", whenToUse: "", tags: [], gain: 0.8, packName: "starter" }];

  it("re-points files at the workdir copy under /media/ and drops removed ones", () => {
    const out = overlayPreview(
      plan([MATCH, { id: "fb@0", entryId: "fb", word: 0, source: "match" }]),
      layer({ edits: { "fb@0": { removed: true } } }),
      WORDS,
      identityMap(),
      SOUNDS,
    );
    expect(out.cues).toEqual([
      { id: "gde@2", file: "/media/library/gde.png", kind: "logo", look: "overlay", atSec: 2, endSec: 3.5 },
    ]);
  });

  it("turns each pop into an sfx-preview marker keyed by sound id, silent ones skipped", () => {
    const out = overlayPreview(
      plan([MATCH, { id: "gde@4", entryId: "gde", word: 4, source: "match", sound: null }]),
      undefined,
      WORDS,
      identityMap(),
      SOUNDS,
    );
    expect(out.sounds).toEqual([{ key: "overlay:0", atSec: 2, soundId: "pop", gain: 0.8, muted: false }]);
  });

  it("plays silent (no marker) when the sound is not installed", () => {
    expect(overlayPreview(plan([MATCH]), undefined, WORDS, identityMap(), []).sounds).toEqual([]);
  });

  it("is empty without a map", () => {
    expect(overlayPreview(plan([MATCH]), undefined, WORDS, null, SOUNDS)).toEqual({ cues: [], sounds: [] });
  });
});

describe("overlayDefaultDurationSec", () => {
  it("agrees with the resolver's own default for each look", () => {
    const markers = overlayLaneMarkers(
      plan([MATCH, { id: "fb@4", entryId: "fb", word: 4, source: "match" }]),
      undefined,
      WORDS,
      identityMap(),
    );
    for (const m of markers) expect(m.endSec - m.atSec).toBeCloseTo(overlayDefaultDurationSec(m.look));
  });

  it("keeps the entry's own sound as the toggle's way back", () => {
    const whoosh = { ...GDE, sound: "whoosh" };
    const markers = overlayLaneMarkers(
      plan([{ ...MATCH, sound: null }], [whoosh]),
      undefined,
      WORDS,
      identityMap(),
    );
    expect(markers[0]).toMatchObject({ sound: null, defaultSound: "whoosh" });
  });
});

describe("overlayMediaUrl", () => {
  it("serves the staged copy through /media/", () => {
    expect(overlayMediaUrl("library/gde.png")).toBe("/media/library/gde.png");
  });
});

describe("overlaySeekSec (overlay-transform: a chip click seeks into the window)", () => {
  it("lands 0.4s in, past the entrance pop", () => {
    expect(overlaySeekSec({ atSec: 2, endSec: 3.5 })).toBeCloseTo(2.4, 9);
  });
  it("never overshoots a short window — capped at its middle", () => {
    expect(overlaySeekSec({ atSec: 2, endSec: 2.5 })).toBeCloseTo(2.25, 9);
  });
});

