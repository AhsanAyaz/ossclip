import { describe, expect, it } from "vitest";
import {
  previewVolume,
  sfxPreloadIds,
  sfxToFire,
  SFX_SEEK_JUMP_SEC,
  type SfxPlaybackMarker,
} from "../src/sfxPlayback";

/**
 * The SFX preview's scheduler (Phase 4 follow-up, 2026-08-29).
 *
 * The claim under test: a sound fires exactly when the playhead PLAYS across
 * it — not when it is scrubbed across, not when a seek drops the playhead past
 * a hundred of them, and never twice for one crossing.
 */

const marker = (
  key: string,
  atSec: number,
  extra: Partial<SfxPlaybackMarker> = {},
): SfxPlaybackMarker => ({
  key,
  atSec,
  soundId: key.split("@")[0]!,
  gain: 1,
  muted: false,
  ...extra,
});

/** The lane's own order — `sfxLaneMarkers` sorts by time. */
const LANE: SfxPlaybackMarker[] = [
  marker("ding@0", 1),
  marker("pop@1", 2),
  marker("whoosh@2", 2.05),
  marker("ding@3", 10),
];

const keys = (ms: readonly SfxPlaybackMarker[]): string[] => ms.map((m) => m.key);

describe("sfxToFire", () => {
  it("fires a marker the tick crossed", () => {
    expect(keys(sfxToFire(0.9, 1.02, LANE))).toEqual(["ding@0"]);
  });

  it("fires nothing when the tick crossed no marker", () => {
    expect(sfxToFire(1.02, 1.1, LANE)).toEqual([]);
  });

  it("fires a marker sitting exactly on the current sample, and not again next tick", () => {
    // The half-open `(prev, cur]` rule: the frame boundary a marker lands on
    // belongs to exactly one tick, so a sound cannot double-trigger there.
    expect(keys(sfxToFire(0.97, 1, LANE))).toEqual(["ding@0"]);
    expect(sfxToFire(1, 1.03, LANE)).toEqual([]);
  });

  it("fires every marker inside one tick, in the order they will be heard", () => {
    expect(keys(sfxToFire(1.99, 2.1, LANE))).toEqual(["pop@1", "whoosh@2"]);
  });

  it("skips a MUTED placement instead of playing it silently", () => {
    const lane = [marker("ding@0", 1, { muted: true }), marker("pop@1", 1.01)];
    expect(keys(sfxToFire(0.9, 1.02, lane))).toEqual(["pop@1"]);
  });

  it("fires nothing on a forward SEEK — a jump is not playback", () => {
    // Dropping the playhead from 0:00 to 0:10 would otherwise machine-gun
    // every placement in between.
    expect(sfxToFire(0, 10, LANE)).toEqual([]);
  });

  it("draws the seek line at SFX_SEEK_JUMP_SEC: a gap AT the threshold still plays", () => {
    const lane = [marker("ding@0", 0.5)];
    expect(keys(sfxToFire(0, SFX_SEEK_JUMP_SEC, lane))).toEqual(["ding@0"]);
    expect(sfxToFire(0, SFX_SEEK_JUMP_SEC + 0.001, lane)).toEqual([]);
  });

  it("fires nothing when the playhead did not move (a paused player still emits frames)", () => {
    expect(sfxToFire(1, 1, LANE)).toEqual([]);
  });

  it("fires nothing on a backwards scrub — rewinding past a sound is not hearing it", () => {
    expect(sfxToFire(2.5, 0.5, LANE)).toEqual([]);
    // Not even the marker the rewind landed exactly on.
    expect(sfxToFire(2.5, 1, LANE)).toEqual([]);
  });

  it("fires nothing for an empty lane", () => {
    expect(sfxToFire(0, 0.1, [])).toEqual([]);
  });

  it("returns the markers themselves, so the caller has the gain and the sound", () => {
    const [fired] = sfxToFire(0.9, 1.02, LANE);
    expect(fired).toBe(LANE[0]);
  });
});

describe("previewVolume", () => {
  it("passes an ordinary gain through", () => {
    expect(previewVolume(0.8)).toBe(0.8);
  });

  it("clamps a BOOSTED gain to 1 — the element's ceiling, not the doc's", () => {
    // The doc allows up to 2 and the render honours it; the preview cannot,
    // which is a fidelity limit of HTMLAudioElement rather than a bug.
    expect(previewVolume(2)).toBe(1);
  });

  it("clamps a negative gain to silence", () => {
    expect(previewVolume(-1)).toBe(0);
  });

  it("falls back to 1 for a non-finite gain rather than assigning NaN to volume", () => {
    expect(previewVolume(NaN)).toBe(1);
    expect(previewVolume(Infinity)).toBe(1);
  });

  it("keeps 0 as 0 — an explicitly silenced placement is not a missing one", () => {
    expect(previewVolume(0)).toBe(0);
  });
});

describe("sfxPreloadIds", () => {
  it("gives one id per DISTINCT sound, in first-appearance order", () => {
    expect(sfxPreloadIds(LANE)).toEqual(["ding", "pop", "whoosh"]);
  });

  it("excludes a sound only muted placements use — nothing can fire it", () => {
    const lane = [marker("ding@0", 1, { muted: true }), marker("pop@1", 2)];
    expect(sfxPreloadIds(lane)).toEqual(["pop"]);
  });

  it("keeps a sound that has one muted and one live placement", () => {
    const lane = [marker("ding@0", 1, { muted: true }), marker("ding@3", 3)];
    expect(sfxPreloadIds(lane)).toEqual(["ding"]);
  });

  it("preloads nothing for an empty lane", () => {
    expect(sfxPreloadIds([])).toEqual([]);
  });
});
