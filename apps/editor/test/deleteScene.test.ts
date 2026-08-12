import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type SceneCue } from "@ossclip/core/browser";
import { deletePlanFor } from "../src/deleteScene";

/** Same minimal graphic cue shape `ghosts.test.ts` uses. */
const cue = (id: string, startSec = 0, endSec = 5): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%", inverted: false },
  startSec,
  endSec,
});

const plainCue = (id: string, startSec = 0, endSec = 5): SceneCue => ({
  ...cue(id, startSec, endSec),
  kind: "plain",
});

const doc = (raw: Record<string, unknown> = {}) => OverrideDocSchema.parse(raw);

describe("deletePlanFor (§139)", () => {
  it("offers BOTH for a live graphic scene, graphic first (the recoverable one)", () => {
    const plan = deletePlanFor(cue("scene-2"), doc());
    expect(plan?.targets).toEqual(["graphic", "take"]);
    expect(plan?.sceneId).toBe("scene-2");
    expect(plan?.isSplitHalf).toBe(false);
  });

  it("offers the take ALONE on a plain take — there is no graphic to drop", () => {
    // The old binding refused outright here, which is the silence §139 is
    // about: the take is deletable, the key just never said so.
    const plan = deletePlanFor(plainCue("scene-3"), doc());
    expect(plan?.targets).toEqual(["take"]);
  });

  it("offers the take ALONE once the graphic is already a ghost", () => {
    const plan = deletePlanFor(cue("scene-2"), doc({ scenes: { "scene-2": { hidden: true } } }));
    expect(plan?.targets).toEqual(["take"]);
  });

  it("offers the graphic ALONE once this exact window is already cut", () => {
    const plan = deletePlanFor(
      cue("scene-2", 10, 15),
      doc({ cuts: [{ startSec: 10, endSec: 15 }] }),
    );
    expect(plan?.targets).toEqual(["graphic"]);
  });

  it("returns null when NOTHING is deletable, so the key opens no empty dialog", () => {
    const plan = deletePlanFor(
      cue("scene-2", 10, 15),
      doc({ scenes: { "scene-2": { hidden: true } }, cuts: [{ startSec: 10, endSec: 15 }] }),
    );
    expect(plan).toBeNull();
  });

  it("returns null with no selected cue at all", () => {
    expect(deletePlanFor(null, doc())).toBeNull();
    expect(deletePlanFor(undefined, doc())).toBeNull();
  });

  it("a SRC-ANCHORED cut at the same window does not suppress the offer", () => {
    // Mirrors `cutChunk`'s own predicate: a src-anchored entry is produce's
    // resolved anchor for a DIFFERENT decision that happens to share these
    // numbers, so the user has not cut THIS window yet.
    const plan = deletePlanFor(
      cue("scene-2", 10, 15),
      doc({ cuts: [{ startSec: 10, endSec: 15, src: { startSec: 20, endSec: 25 } }] }),
    );
    expect(plan?.targets).toEqual(["graphic", "take"]);
  });

  it("a cut at a DIFFERENT window leaves this one offered", () => {
    const plan = deletePlanFor(cue("scene-2", 10, 15), doc({ cuts: [{ startSec: 0, endSec: 5 }] }));
    expect(plan?.targets).toEqual(["graphic", "take"]);
  });

  describe("split halves (§137)", () => {
    it("targets the HALF's own id, and names the ROOT for display", () => {
      const plan = deletePlanFor(cue("scene-6@k1", 36.4, 40), doc());
      expect(plan?.sceneId).toBe("scene-6@k1");
      expect(plan?.rootId).toBe("scene-6");
      expect(plan?.isSplitHalf).toBe(true);
      // The half's OWN post-split window, which is what `cutChunk` removes.
      expect([plan?.startSec, plan?.endSec]).toEqual([36.4, 40]);
    });

    it("a HIDDEN ROOT does not hide the half — `hidden` is not inherited", () => {
      // `effectiveOverride` excludes `hidden` from what a half inherits, so
      // the half still has a graphic of its own to drop.
      const plan = deletePlanFor(
        cue("scene-6@k1", 36.4, 40),
        doc({ scenes: { "scene-6": { hidden: true } } }),
      );
      expect(plan?.targets).toEqual(["graphic", "take"]);
    });

    it("a hidden HALF is read from the half's own entry, not the root's", () => {
      const plan = deletePlanFor(
        cue("scene-6@k1", 36.4, 40),
        doc({ scenes: { "scene-6@k1": { hidden: true } } }),
      );
      expect(plan?.targets).toEqual(["take"]);
    });
  });
});
